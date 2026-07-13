import { buildDeletePreview } from "./delete.js";
import { buildSessionFamily } from "./family.js";
import { toExactKeyPreview } from "./global-state.js";
import { deriveSourceInfo } from "./sources.js";
import { collectSqliteDeletionTotals, collectSqliteSessionIds, sumSqliteDeletionCounts } from "./sqlite.js";
import type {
  DeleteFamilyWarning,
  DeletePreview,
  DeletePreviewItem,
  RootDeletePreview,
  RootDeletePreviewCounts,
  RootResidueAudit,
  RootResidueCandidate,
  RootResidueCandidateSource,
  RootResidueCandidateStatus,
  ScanResult,
  SessionEntry,
  SessionResidueAudit,
  SessionResidueAuditStatus,
  SessionTitleCandidate,
} from "./types.js";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ROOT_AUDIT_SAFETY_NOTICE = "候选不是删除清单；每条候选只说明需要继续核验，不能直接当成应该删除。";
export const ROOT_PREVIEW_SAFETY_NOTICE =
  "候选不是删除清单；这是只读预览，不会删除，也没有建议删除任何 session；真正删除必须另行指定 ID 并显式确认。";
const ROOT_RESIDUE_STATUS_VALUES = new Set<RootResidueCandidateStatus>([
  "absent",
  "clean",
  "present",
  "partial",
  "broken-family",
  "risky-global-state",
  "db-only",
  "index-only",
  "partial-residue",
  "global-state-exact-key",
  "global-state-unknown",
  "shell-snapshot-residue",
  "index-residue",
  "sqlite-residue",
  "missing-parent-edge",
  "missing-child-edge",
]);
const ROOT_RESIDUE_SOURCE_ALIASES: Record<string, RootResidueCandidateSource> = {
  "rollout-files": "rollout_files",
  rollout_files: "rollout_files",
  "shell-snapshot": "shell_snapshots",
  "shell-snapshots": "shell_snapshots",
  shell_snapshot: "shell_snapshots",
  shell_snapshots: "shell_snapshots",
  "session-index": "session_index",
  session_index: "session_index",
  history: "history",
  sqlite: "sqlite",
  "global-state-known": "global_state_known",
  global_state_known: "global_state_known",
  "global-state-exact-key": "global_state_exact_key",
  global_state_exact_key: "global_state_exact_key",
  "global-state-unknown": "global_state_unknown",
  global_state_unknown: "global_state_unknown",
  "thread-spawn-edge": "thread_spawn_edges",
  "thread-spawn-edges": "thread_spawn_edges",
  thread_spawn_edge: "thread_spawn_edges",
  thread_spawn_edges: "thread_spawn_edges",
};

function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function emptySessionEntry(id: string): SessionEntry {
  const titleCandidates: SessionTitleCandidate[] = [{ source: "id", title: id }];
  const sourceInfo = deriveSourceInfo({
    source: null,
    threadSource: null,
    agentRole: null,
    agentNickname: null,
    agentPath: null,
  });

  return {
    id,
    displayTitle: id,
    indexTitle: null,
    sqliteTitle: null,
    firstUserMessage: null,
    titleSource: "id",
    titleMismatch: false,
    titleCandidates,
    title: id,
    kind: "stale",
    archived: false,
    projectPath: null,
    projectName: "unknown",
    projectKey: "unknown",
    createdAt: null,
    updatedAt: null,
    recencyAt: null,
    recencyAtMs: null,
    historyMode: "unknown",
    model: null,
    modelProvider: null,
    cwd: null,
    rolloutPath: null,
    sourceKind: sourceInfo.sourceKind,
    sourceInfo,
    source: null,
    threadSource: null,
    agentRole: null,
    agentNickname: null,
    agentPath: null,
    previewSummary: "未发现本地会话记录",
    historyPreview: [],
    totalFileSize: 0,
    fileTargets: [],
    hasThread: false,
    hasSessionIndex: false,
    hasHistory: false,
    sessionIndexCount: 0,
    historyCount: 0,
    thread: null,
  };
}

function collectKnownIds(scan: ScanResult): string[] {
  return uniqueSorted([
    ...scan.sessions.map((session) => session.id),
    ...scan.sessionIndex.latestById.keys(),
    ...scan.history.lineCountById.keys(),
    ...scan.shellSnapshots.filesById.keys(),
    ...scan.globalState.refsById.keys(),
    ...scan.globalState.exactKeyRefsById.keys(),
    ...scan.globalState.possibleUnknownRefsById.keys(),
    ...scan.sqlite.threadSpawnEdges.flatMap((edge) => [edge.parentThreadId, edge.childThreadId]),
  ]);
}

function findSession(scan: ScanResult, sessionId: string): SessionEntry | null {
  return scan.sessions.find((session) => session.id === sessionId) ?? null;
}

function resolveAuditSession(scan: ScanResult, input: string): { session: SessionEntry; knownLocally: boolean } {
  const sessionId = input.trim();
  if (!sessionId) {
    throw new Error("audit 需要 1 个 session-id。");
  }

  const exact = findSession(scan, sessionId);
  if (exact) {
    return { session: exact, knownLocally: true };
  }

  const knownIds = collectKnownIds(scan);
  if (knownIds.includes(sessionId)) {
    return { session: emptySessionEntry(sessionId), knownLocally: true };
  }

  const prefixedIds = knownIds.filter((id) => id.startsWith(sessionId));
  if (prefixedIds.length === 1) {
    return {
      session: findSession(scan, prefixedIds[0]) ?? emptySessionEntry(prefixedIds[0]),
      knownLocally: true,
    };
  }

  if (prefixedIds.length > 1) {
    throw new Error(`会话 ID 前缀不唯一：${sessionId}`);
  }

  if (isSessionId(sessionId)) {
    return { session: emptySessionEntry(sessionId), knownLocally: false };
  }

  throw new Error(`找不到会话或本地残留：${sessionId}`);
}

function pushStatus(statuses: SessionResidueAuditStatus[], status: SessionResidueAuditStatus): void {
  if (!statuses.includes(status)) {
    statuses.push(status);
  }
}

function buildStatus(options: {
  knownLocally: boolean;
  hasAnyResidue: boolean;
  rawSessionFiles: number;
  sqliteRows: number;
  sessionIndexRows: number;
  historyRows: number;
  possibleUnknownGlobalStateRefs: number;
  brokenRelations: number;
  storageConflict: boolean;
}): SessionResidueAuditStatus[] {
  const statuses: SessionResidueAuditStatus[] = [];

  if (!options.hasAnyResidue && options.brokenRelations === 0) {
    return options.knownLocally ? ["clean"] : ["absent"];
  }

  if (options.rawSessionFiles > 0) {
    pushStatus(statuses, "present");
  } else {
    pushStatus(statuses, "partial");
  }

  if (options.rawSessionFiles === 0 && options.sqliteRows > 0) {
    pushStatus(statuses, "db-only");
  }

  if (options.rawSessionFiles === 0 && (options.sessionIndexRows > 0 || options.historyRows > 0)) {
    pushStatus(statuses, "index-only");
  }

  if (options.possibleUnknownGlobalStateRefs > 0) {
    pushStatus(statuses, "risky-global-state");
  }

  if (options.brokenRelations > 0) {
    pushStatus(statuses, "broken-family");
  }

  if (options.storageConflict) {
    pushStatus(statuses, "storage-conflict");
  }

  return statuses;
}

function describeCurrentState(
  session: SessionEntry,
  knownLocally: boolean,
  hasAnyResidue: boolean,
  hasOriginalRollout: boolean,
  storageConflict: boolean,
): SessionResidueAudit["currentState"] {
  if (!knownLocally && !hasAnyResidue) {
    return {
      kind: "absent",
      archived: false,
      hasOriginalRollout: false,
      message: "未发现这个 ID 的本地记录或残留。",
    };
  }

  if (!hasAnyResidue) {
    return {
      kind: "clean",
      archived: false,
      hasOriginalRollout: false,
      message: "这个 ID 在本机记录中出现过，但当前没有发现本地残留。",
    };
  }

  if (hasOriginalRollout) {
    return {
      kind: session.kind,
      archived: session.archived,
      hasOriginalRollout,
      message: storageConflict
        ? "同一 session ID 同时存在于 sessions 和 archived_sessions；这是异常重复状态，不能视为正常归档。"
        : session.archived
        ? "原始会话文件仍在 archived_sessions，本地还有完整或近似完整记录。"
        : "原始会话文件仍在 sessions，本地会话仍明确存在。",
    };
  }

  return {
    kind: session.kind,
    archived: session.archived,
    hasOriginalRollout,
    message: "原始会话文件已不在当前扫描结果中，但其他本地位置仍有记录；这可能是官方 UI 归档或删除后的残留。",
  };
}

export function buildSessionResidueAudit(scan: ScanResult, sessionId: string): SessionResidueAudit {
  const { session, knownLocally } = resolveAuditSession(scan, sessionId);
  const preview = buildDeletePreview(scan, [session]);
  const item = preview.items[0];
  const family = buildSessionFamily(scan, session);
  const sqliteRows = sumSqliteDeletionCounts(item.sqlite) + item.sqlite.logRows;
  const knownGlobalStateRefs = scan.globalState.refsById.get(session.id) ?? [];
  const exactKeyGlobalStateRefs = scan.globalState.exactKeyRefsById.get(session.id) ?? [];
  const unknownGlobalStateRefs = scan.globalState.possibleUnknownRefsById.get(session.id) ?? [];
  const threadSpawnEdges = scan.sqlite.threadSpawnEdges.filter(
    (edge) => edge.parentThreadId === session.id || edge.childThreadId === session.id,
  );
  const parentIds = uniqueSorted(threadSpawnEdges.filter((edge) => edge.childThreadId === session.id).map((edge) => edge.parentThreadId));
  const childIds = uniqueSorted(threadSpawnEdges.filter((edge) => edge.parentThreadId === session.id).map((edge) => edge.childThreadId));
  const familyMemberIds = uniqueSorted([session.id, ...family.familyMembers.map((node) => node.sessionId)]);
  const rawSessionFiles = item.filePaths.length;
  const hasArchivedRollout = session.fileTargets.some((target) => target.bucket === "archived_sessions");
  const hasActiveRollout = session.fileTargets.some((target) => target.bucket === "sessions");
  const storageConflict = hasActiveRollout && hasArchivedRollout;
  const hasAnyResidue =
    rawSessionFiles +
      item.shellSnapshotFiles.length +
      item.sessionIndexRows +
      item.historyRows +
      sqliteRows +
      item.globalStateRefs +
      item.exactKeyGlobalStateRefs +
      item.possibleUnknownGlobalStateRefs +
      threadSpawnEdges.length >
    0;
  const statuses = buildStatus({
    knownLocally,
    hasAnyResidue,
    rawSessionFiles,
    sqliteRows,
    sessionIndexRows: item.sessionIndexRows,
    historyRows: item.historyRows,
    possibleUnknownGlobalStateRefs: item.possibleUnknownGlobalStateRefs,
    brokenRelations: family.brokenRelations.length,
    storageConflict,
  });
  const hasOnlyDedicatedLogResidue =
    item.sqlite.logRows > 0
    && rawSessionFiles === 0
    && item.shellSnapshotFiles.length === 0
    && item.sessionIndexRows === 0
    && item.historyRows === 0
    && sumSqliteDeletionCounts(item.sqlite) === 0
    && item.globalStateRefs === 0
    && item.exactKeyGlobalStateRefs === 0
    && item.possibleUnknownGlobalStateRefs === 0
    && threadSpawnEdges.length === 0;
  const warnings = uniqueSorted([
    ...scan.warnings,
    ...family.warnings,
    ...(unknownGlobalStateRefs.length > 0
      ? [`global-state 有 ${unknownGlobalStateRefs.length} 个未知位置引用，工具不会自动修改。`]
      : []),
    ...(exactKeyGlobalStateRefs.length > 0
      ? [`global-state 有 ${exactKeyGlobalStateRefs.length} 个 P11 exact-key 引用；只能在 delete 预览后显式确认删除。`]
      : []),
    ...(item.sqlite.logRows > 0
      ? [hasOnlyDedicatedLogResidue
          ? `SQLite logs 有 ${item.sqlite.logRows} 行 logs-only 残留；当前只读报告，不支持单独自动删除。`
          : `SQLite logs 有 ${item.sqlite.logRows} 行精确关联记录；permanent delete 会删除，trash 会保留到 final purge。`]
      : []),
    ...item.warnings,
  ]);
  const recommendedNextCommand = hasAnyResidue && !hasOnlyDedicatedLogResidue && (!hasArchivedRollout || storageConflict)
    ? `codex-sessions delete ${quoteShellArg(session.id)} --root ${quoteShellArg(scan.root.rootPath)}`
    : null;
  const recommendedNextCommandNote = hasOnlyDedicatedLogResidue
    ? "这是 logs-only 残留；当前只读报告，不提供直接删除命令。"
    : hasArchivedRollout && !storageConflict
    ? "这是归档会话的本地存储清单；归档内容保留是正常行为，不是残留，不建议因此清理。"
    : recommendedNextCommand
    ? "这是预览命令，不会删除；只有用户加 --yes 才会真的删除。"
    : knownLocally
      ? "不需要处理，当前没有发现本地残留。"
      : "不需要处理，当前没有发现这个 ID 的本地记录或残留。";

  return {
    sessionId: session.id,
    title: session.title,
    displayTitle: session.displayTitle,
    knownLocally,
    rootPath: scan.root.rootPath,
    overallStatus: statuses,
    currentState: describeCurrentState(session, knownLocally, hasAnyResidue, rawSessionFiles > 0, storageConflict),
    surfaces: {
      rolloutFiles: {
        present: rawSessionFiles > 0,
        count: rawSessionFiles,
        paths: item.filePaths,
        buckets: session.fileTargets.map((target) => target.bucket),
      },
      shellSnapshots: {
        present: item.shellSnapshotFiles.length > 0,
        count: item.shellSnapshotFiles.length,
        paths: item.shellSnapshotFiles,
      },
      sessionIndex: {
        present: item.sessionIndexRows > 0,
        count: item.sessionIndexRows,
      },
      history: {
        present: item.historyRows > 0,
        count: item.historyRows,
      },
      sqlite: {
        present: sqliteRows > 0,
        count: sqliteRows,
        rows: sqliteRows,
        counts: item.sqlite,
        hasThread: session.hasThread,
        archived: session.thread?.archived ?? session.archived,
      },
      globalStateKnown: {
        present: item.globalStateRefs > 0,
        count: item.globalStateRefs,
        paths: knownGlobalStateRefs.map((ref) => ref.path),
      },
      globalStateExactKey: {
        present: item.exactKeyGlobalStateRefs > 0,
        count: item.exactKeyGlobalStateRefs,
        paths: exactKeyGlobalStateRefs.map((ref) => ref.path),
        refs: exactKeyGlobalStateRefs.map(toExactKeyPreview),
      },
      globalStateUnknown: {
        present: item.possibleUnknownGlobalStateRefs > 0,
        count: item.possibleUnknownGlobalStateRefs,
        paths: unknownGlobalStateRefs.map((ref) => ref.path),
      },
      threadSpawnEdges: {
        present: threadSpawnEdges.length > 0,
        count: threadSpawnEdges.length,
        asParent: childIds.length,
        asChild: parentIds.length,
        edges: threadSpawnEdges.map((edge) => ({
          parentThreadId: edge.parentThreadId,
          childThreadId: edge.childThreadId,
          status: edge.status,
        })),
      },
    },
    counts: {
      rawSessionFiles,
      shellSnapshotFiles: item.shellSnapshotFiles.length,
      sessionIndexRows: item.sessionIndexRows,
      historyRows: item.historyRows,
      sqliteRows,
      knownGlobalStateRefs: item.globalStateRefs,
      exactKeyGlobalStateRefs: item.exactKeyGlobalStateRefs,
      possibleUnknownGlobalStateRefs: item.possibleUnknownGlobalStateRefs,
      threadSpawnEdges: threadSpawnEdges.length,
      familyMembers: familyMemberIds.length,
      brokenRelations: family.brokenRelations.length,
    },
    familySummary: {
      isFamilyMember: familyMemberIds.length > 1 || family.edges.length > 0,
      rootId: family.root.sessionId,
      parentIds,
      childIds,
      familyMemberIds,
      edgeCount: family.edges.length,
      brokenRelationCount: family.brokenRelations.length,
    },
    brokenRelations: family.brokenRelations,
    warnings,
    recommendedNextCommand,
    recommendedNextCommandNote,
  };
}

function collectRootCandidateIds(scan: ScanResult): {
  ids: string[];
  warnings: string[];
} {
  const warnings: string[] = [];
  let sqliteIds: string[] = [];

  try {
    sqliteIds = collectSqliteSessionIds(scan.root.sqlitePath, scan.root.logsSqlitePath, scan.root.goalsSqlitePath);
  } catch (error) {
    warnings.push(`读取 SQLite session 引用失败：${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    ids: uniqueSorted([...collectKnownIds(scan), ...sqliteIds]),
    warnings,
  };
}

function pushRootStatus(statuses: RootResidueCandidateStatus[], status: RootResidueCandidateStatus): void {
  if (!statuses.includes(status)) {
    statuses.push(status);
  }
}

function collectSources(audit: SessionResidueAudit): RootResidueCandidateSource[] {
  const sources: RootResidueCandidateSource[] = [];

  if (audit.counts.rawSessionFiles > 0) sources.push("rollout_files");
  if (audit.counts.shellSnapshotFiles > 0) sources.push("shell_snapshots");
  if (audit.counts.sessionIndexRows > 0) sources.push("session_index");
  if (audit.counts.historyRows > 0) sources.push("history");
  if (audit.counts.sqliteRows > 0) sources.push("sqlite");
  if (audit.counts.knownGlobalStateRefs > 0) sources.push("global_state_known");
  if (audit.counts.exactKeyGlobalStateRefs > 0) sources.push("global_state_exact_key");
  if (audit.counts.possibleUnknownGlobalStateRefs > 0) sources.push("global_state_unknown");
  if (audit.counts.threadSpawnEdges > 0) sources.push("thread_spawn_edges");

  return sources;
}

function hasResidueWithoutRollout(audit: SessionResidueAudit): boolean {
  return (
    audit.counts.rawSessionFiles === 0 &&
    audit.counts.shellSnapshotFiles +
      audit.counts.sessionIndexRows +
      audit.counts.historyRows +
      audit.counts.sqliteRows +
      audit.counts.knownGlobalStateRefs +
      audit.counts.exactKeyGlobalStateRefs +
      audit.counts.possibleUnknownGlobalStateRefs +
      audit.counts.threadSpawnEdges >
      0
  );
}

function rootStatuses(audit: SessionResidueAudit): RootResidueCandidateStatus[] {
  const statuses: RootResidueCandidateStatus[] = [...audit.overallStatus];
  const noRollout = audit.counts.rawSessionFiles === 0;

  if (hasResidueWithoutRollout(audit)) {
    pushRootStatus(statuses, "partial-residue");
  }

  if (noRollout && audit.counts.possibleUnknownGlobalStateRefs > 0) {
    pushRootStatus(statuses, "global-state-unknown");
  }

  if (noRollout && audit.counts.exactKeyGlobalStateRefs > 0) {
    pushRootStatus(statuses, "global-state-exact-key");
  }

  if (noRollout && audit.counts.shellSnapshotFiles > 0) {
    pushRootStatus(statuses, "shell-snapshot-residue");
  }

  if (noRollout && (audit.counts.sessionIndexRows > 0 || audit.counts.historyRows > 0)) {
    pushRootStatus(statuses, "index-residue");
  }

  if (noRollout && audit.counts.sqliteRows > 0) {
    pushRootStatus(statuses, "sqlite-residue");
  }

  if (audit.brokenRelations.some((relation) => relation.parentThreadId === audit.sessionId && relation.missingParentSession)) {
    pushRootStatus(statuses, "missing-parent-edge");
  }

  if (audit.brokenRelations.some((relation) => relation.childThreadId === audit.sessionId && relation.missingChildSession)) {
    pushRootStatus(statuses, "missing-child-edge");
  }

  return statuses;
}

function buildRecommendedAuditCommand(scan: ScanResult, sessionId: string): string {
  return `codex-sessions audit ${quoteShellArg(sessionId)} --root ${quoteShellArg(scan.root.rootPath)}`;
}

function buildRecommendedPreviewCommand(scan: ScanResult, sessionId: string): string {
  return `codex-sessions delete ${quoteShellArg(sessionId)} --root ${quoteShellArg(scan.root.rootPath)}`;
}

function toRootResidueCandidate(
  scan: ScanResult,
  audit: SessionResidueAudit,
  includeDetails: boolean,
): RootResidueCandidate {
  const rootWarnings = new Set(scan.warnings);
  const allWarnings = uniqueSorted(audit.warnings.filter((warning) => !rootWarnings.has(warning)));
  const warnings = includeDetails ? allWarnings : allWarnings.slice(0, 5);
  return {
    sessionId: audit.sessionId,
    statuses: rootStatuses(audit),
    sources: collectSources(audit),
    surfaces: {
      rolloutFiles: audit.counts.rawSessionFiles,
      shellSnapshots: audit.counts.shellSnapshotFiles,
      sessionIndexRows: audit.counts.sessionIndexRows,
      historyRows: audit.counts.historyRows,
      sqliteRows: audit.counts.sqliteRows,
      dedicatedLogRows: audit.surfaces.sqlite.counts.logRows,
      knownGlobalStateRefs: audit.counts.knownGlobalStateRefs,
      exactKeyGlobalStateRefs: audit.counts.exactKeyGlobalStateRefs,
      possibleUnknownGlobalStateRefs: audit.counts.possibleUnknownGlobalStateRefs,
      threadSpawnEdges: audit.counts.threadSpawnEdges,
    },
    family: {
      isFamilyMember: audit.familySummary.isFamilyMember,
      brokenFamily: audit.familySummary.brokenRelationCount > 0,
      rootId: audit.familySummary.rootId,
      parentIds: audit.familySummary.parentIds,
      childIds: audit.familySummary.childIds,
      familyMemberCount: audit.familySummary.familyMemberIds.length,
      brokenRelationCount: audit.familySummary.brokenRelationCount,
    },
    warningSummary: {
      total: allWarnings.length,
      returned: warnings.length,
      omitted: allWarnings.length - warnings.length,
    },
    warnings,
    recommendedAuditCommand: buildRecommendedAuditCommand(scan, audit.sessionId),
  };
}

function toPreviewCounts(item: DeletePreviewItem): RootDeletePreviewCounts {
  return {
    rolloutFiles: item.filePaths.length,
    shellSnapshots: item.shellSnapshotFiles.length,
    sessionIndexRows: item.sessionIndexRows,
    historyRows: item.historyRows,
    sqliteRows: sumSqliteDeletionCounts(item.sqlite) + item.sqlite.logRows,
    dedicatedLogRows: item.sqlite.logRows,
    knownGlobalStateRefs: item.globalStateRefs,
    exactKeyGlobalStateRefs: item.exactKeyGlobalStateRefs,
    possibleUnknownGlobalStateRefs: item.possibleUnknownGlobalStateRefs,
    threadSpawnEdges: item.sqlite.spawnEdgeRows,
  };
}

function aggregatePreviewCounts(
  scan: ScanResult,
  preview: DeletePreview,
  sessions: SessionEntry[],
): RootDeletePreviewCounts {
  const sqliteTotals = collectSqliteDeletionTotals(
    scan.root.sqlitePath,
    sessions.map((session) => session.id),
    scan.root.logsSqlitePath,
    scan.root.goalsSqlitePath,
  );

  return {
    rolloutFiles: preview.totals.sessionFiles,
    shellSnapshots: preview.totals.shellSnapshotFiles,
    sessionIndexRows: preview.totals.sessionIndexRows,
    historyRows: preview.totals.historyRows,
    sqliteRows: sumSqliteDeletionCounts(sqliteTotals) + sqliteTotals.logRows,
    dedicatedLogRows: sqliteTotals.logRows,
    knownGlobalStateRefs: preview.totals.globalStateRefs,
    exactKeyGlobalStateRefs: preview.totals.exactKeyGlobalStateRefs,
    possibleUnknownGlobalStateRefs: preview.totals.possibleUnknownGlobalStateRefs,
    threadSpawnEdges: sqliteTotals.spawnEdgeRows,
  };
}

function warningsForSession(
  preview: DeletePreview,
  sessionId: string,
  includeDetails: boolean,
): DeleteFamilyWarning[] {
  return preview.familyWarnings
    .filter((warning) => warning.sessionId === sessionId)
    .map((warning) => ({
      ...warning,
      warnings: includeDetails ? warning.warnings : warning.warnings.slice(0, 5),
    }));
}

function summarizeFamilyWarnings(
  familyWarnings: DeleteFamilyWarning[],
  includeDetails: boolean,
): RootDeletePreview["familyWarningSummary"] {
  const brokenRelationKeys = uniqueSorted(
    familyWarnings.flatMap((warning) =>
      warning.brokenRelations.map((relation) => `${relation.parentThreadId}->${relation.childThreadId}`),
    ),
  );
  const warnings = uniqueSorted(familyWarnings.flatMap((warning) => warning.warnings));

  return {
    candidatesWithFamilyWarnings: uniqueSorted(familyWarnings.map((warning) => warning.sessionId)).length,
    unselectedParentIds: uniqueSorted(familyWarnings.flatMap((warning) => warning.unselectedParentIds)),
    unselectedChildIds: uniqueSorted(familyWarnings.flatMap((warning) => warning.unselectedChildIds)),
    unselectedFamilyMemberIds: uniqueSorted(familyWarnings.flatMap((warning) => warning.unselectedFamilyMemberIds)),
    missingParentIds: uniqueSorted(familyWarnings.flatMap((warning) => warning.missingParentIds)),
    missingChildIds: uniqueSorted(familyWarnings.flatMap((warning) => warning.missingChildIds)),
    brokenRelationCount: brokenRelationKeys.length,
    warningCount: warnings.length,
    warnings: includeDetails ? warnings : warnings.slice(0, 5),
  };
}

function isDefaultRootResidueCandidate(candidate: RootResidueCandidate): boolean {
  return (
    candidate.statuses.includes("partial-residue") ||
    candidate.statuses.includes("broken-family") ||
    candidate.statuses.includes("missing-parent-edge") ||
    candidate.statuses.includes("missing-child-edge")
  );
}

function riskScore(candidate: RootResidueCandidate): number {
  let score = 0;
  if (candidate.statuses.includes("missing-parent-edge") || candidate.statuses.includes("missing-child-edge")) score += 1000;
  if (candidate.statuses.includes("broken-family")) score += 900;
  if (candidate.statuses.includes("global-state-unknown")) score += 800;
  if (candidate.statuses.includes("global-state-exact-key")) score += 750;
  if (candidate.statuses.includes("risky-global-state")) score += 700;
  if (candidate.statuses.includes("db-only")) score += 600;
  if (candidate.statuses.includes("sqlite-residue")) score += 500;
  if (candidate.statuses.includes("shell-snapshot-residue")) score += 400;
  if (candidate.statuses.includes("index-only")) score += 300;
  if (candidate.statuses.includes("index-residue")) score += 250;
  if (candidate.statuses.includes("partial-residue")) score += 100;

  return (
    score +
    candidate.surfaces.sqliteRows +
    candidate.surfaces.possibleUnknownGlobalStateRefs +
    candidate.surfaces.exactKeyGlobalStateRefs +
    candidate.surfaces.knownGlobalStateRefs +
    candidate.surfaces.shellSnapshots +
    candidate.surfaces.sessionIndexRows +
    candidate.surfaces.historyRows +
    candidate.surfaces.threadSpawnEdges
  );
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return 50;
  }

  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("--limit 必须是正整数。");
  }

  return limit;
}

function normalizeStatusFilter(values: string[] | undefined): RootResidueCandidateStatus[] {
  const statuses = uniqueSorted((values ?? []).map((value) => value.trim()).filter(Boolean));

  for (const status of statuses) {
    if (!ROOT_RESIDUE_STATUS_VALUES.has(status as RootResidueCandidateStatus)) {
      throw new Error(`不支持的 audit-root status：${status}`);
    }
  }

  return statuses as RootResidueCandidateStatus[];
}

function normalizeSourceFilter(values: string[] | undefined): RootResidueCandidateSource[] {
  const sources: RootResidueCandidateSource[] = [];

  for (const value of values ?? []) {
    const normalized = ROOT_RESIDUE_SOURCE_ALIASES[value.trim()];
    if (!normalized) {
      throw new Error(`不支持的 audit-root source：${value}`);
    }
    sources.push(normalized);
  }

  return uniqueSorted(sources) as RootResidueCandidateSource[];
}

function matchesRootResidueFilters(
  candidate: RootResidueCandidate,
  filters: {
    statuses: RootResidueCandidateStatus[];
    sources: RootResidueCandidateSource[];
  },
): boolean {
  const statusMatches =
    filters.statuses.length === 0 ||
    filters.statuses.some((status) => candidate.statuses.includes(status));
  const sourceMatches =
    filters.sources.length === 0 ||
    filters.sources.some((source) => candidate.sources.includes(source));

  return statusMatches && sourceMatches;
}

function countBy(values: Iterable<string>): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return Object.fromEntries(
    [...counts.entries()].sort((left, right) => {
      const countDiff = right[1] - left[1];
      return countDiff || left[0].localeCompare(right[0]);
    }),
  );
}

export function buildRootResidueAudit(
  scan: ScanResult,
  options: {
    limit?: number;
    includeAll?: boolean;
    statuses?: string[];
    sources?: string[];
    includeDetails?: boolean;
  } = {},
): RootResidueAudit {
  const limit = normalizeLimit(options.limit);
  const filters = {
    statuses: normalizeStatusFilter(options.statuses),
    sources: normalizeSourceFilter(options.sources),
    includeAll: options.includeAll ?? false,
  };
  const collected = collectRootCandidateIds(scan);
  const candidatesBeforeFilter = collected.ids
    .map((id) => toRootResidueCandidate(scan, buildSessionResidueAudit(scan, id), options.includeDetails ?? false))
    .filter((candidate) => filters.includeAll || isDefaultRootResidueCandidate(candidate))
    .sort((left, right) => {
      const scoreDiff = riskScore(right) - riskScore(left);
      return scoreDiff || left.sessionId.localeCompare(right.sessionId);
    });
  const candidates = candidatesBeforeFilter.filter((candidate) => matchesRootResidueFilters(candidate, filters));
  const returned = candidates.slice(0, limit);
  const allWarnings = uniqueSorted([...scan.warnings, ...collected.warnings]);
  const warnings = options.includeDetails ? allWarnings : allWarnings.slice(0, 5);

  return {
    rootPath: scan.root.rootPath,
    safetyNotice: ROOT_AUDIT_SAFETY_NOTICE,
    filters,
    totalCandidatesBeforeFilter: candidatesBeforeFilter.length,
    totalCandidatesAfterFilter: candidates.length,
    totalCandidates: candidates.length,
    returnedCandidates: returned.length,
    limit,
    byStatus: countBy(candidates.flatMap((candidate) => candidate.statuses)),
    bySource: countBy(candidates.flatMap((candidate) => candidate.sources)),
    candidates: returned,
    warningSummary: {
      total: allWarnings.length,
      returned: warnings.length,
      omitted: allWarnings.length - warnings.length,
    },
    warnings,
  };
}

export function buildRootDeletePreview(
  scan: ScanResult,
  options: {
    limit?: number;
    includeAll?: boolean;
    statuses?: string[];
    sources?: string[];
    includeDetails?: boolean;
  } = {},
): RootDeletePreview {
  const audit = buildRootResidueAudit(scan, options);
  const sessions = audit.candidates.map((candidate) => findSession(scan, candidate.sessionId) ?? emptySessionEntry(candidate.sessionId));
  const preview = buildDeletePreview(scan, sessions);
  const previewItemsById = new Map(preview.items.map((item) => [item.sessionId, item]));
  const candidates = audit.candidates.map((candidate) => {
    const previewItem = previewItemsById.get(candidate.sessionId);
    if (!previewItem) {
      throw new Error(`无法生成 preview：缺少候选 ${candidate.sessionId}。`);
    }

    const deleteSupported = !(
      candidate.surfaces.dedicatedLogRows > 0
      && candidate.surfaces.rolloutFiles === 0
      && candidate.surfaces.shellSnapshots === 0
      && candidate.surfaces.sessionIndexRows === 0
      && candidate.surfaces.historyRows === 0
      && candidate.surfaces.sqliteRows === candidate.surfaces.dedicatedLogRows
      && candidate.surfaces.knownGlobalStateRefs === 0
      && candidate.surfaces.exactKeyGlobalStateRefs === 0
      && candidate.surfaces.possibleUnknownGlobalStateRefs === 0
      && candidate.surfaces.threadSpawnEdges === 0
    );
    const previewOnlyCommand = deleteSupported
      ? buildRecommendedPreviewCommand(scan, candidate.sessionId)
      : candidate.recommendedAuditCommand;

    return {
      sessionId: candidate.sessionId,
      statuses: candidate.statuses,
      sources: candidate.sources,
      previewCounts: toPreviewCounts(previewItem),
      familyWarnings: warningsForSession(preview, candidate.sessionId, options.includeDetails ?? false),
      recommendedAuditCommand: candidate.recommendedAuditCommand,
      previewOnlyCommand,
      recommendedPreviewCommand: previewOnlyCommand,
      deleteSupported,
      deleteUnsupportedReason: deleteSupported ? null : "logs-only 当前只读报告，不支持直接删除。",
    };
  });

  return {
    rootPath: audit.rootPath,
    safetyNotice: ROOT_PREVIEW_SAFETY_NOTICE,
    filters: audit.filters,
    totalCandidatesBeforeFilter: audit.totalCandidatesBeforeFilter,
    totalCandidatesAfterFilter: audit.totalCandidatesAfterFilter,
    previewedCandidates: audit.returnedCandidates,
    omittedCandidates: Math.max(0, audit.totalCandidatesAfterFilter - audit.returnedCandidates),
    limit: audit.limit,
    aggregatePreview: aggregatePreviewCounts(scan, preview, sessions),
    familyWarningSummary: summarizeFamilyWarnings(preview.familyWarnings, options.includeDetails ?? false),
    candidates,
    warningSummary: audit.warningSummary,
    warnings: audit.warnings,
  };
}
