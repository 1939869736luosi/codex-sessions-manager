import { buildDeletePreview } from "./delete.js";
import { buildSessionFamily } from "./family.js";
import { sumSqliteDeletionCounts } from "./sqlite.js";
import type {
  ScanResult,
  SessionEntry,
  SessionResidueAudit,
  SessionResidueAuditStatus,
  SessionTitleCandidate,
} from "./types.js";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    model: null,
    cwd: null,
    rolloutPath: null,
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
    ...scan.shellSnapshots.filesById.keys(),
    ...scan.globalState.refsById.keys(),
    ...scan.globalState.possibleUnknownRefsById.keys(),
  ]);
}

function findSession(scan: ScanResult, sessionId: string): SessionEntry | null {
  return scan.sessions.find((session) => session.id === sessionId) ?? null;
}

function resolveAuditSession(scan: ScanResult, input: string): SessionEntry {
  const sessionId = input.trim();
  if (!sessionId) {
    throw new Error("audit 需要 1 个 session-id。");
  }

  const exact = findSession(scan, sessionId);
  if (exact) {
    return exact;
  }

  const knownIds = collectKnownIds(scan);
  if (knownIds.includes(sessionId)) {
    return emptySessionEntry(sessionId);
  }

  const prefixedIds = knownIds.filter((id) => id.startsWith(sessionId));
  if (prefixedIds.length === 1) {
    return findSession(scan, prefixedIds[0]) ?? emptySessionEntry(prefixedIds[0]);
  }

  if (prefixedIds.length > 1) {
    throw new Error(`会话 ID 前缀不唯一：${sessionId}`);
  }

  if (isSessionId(sessionId)) {
    return emptySessionEntry(sessionId);
  }

  throw new Error(`找不到会话或本地残留：${sessionId}`);
}

function pushStatus(statuses: SessionResidueAuditStatus[], status: SessionResidueAuditStatus): void {
  if (!statuses.includes(status)) {
    statuses.push(status);
  }
}

function buildStatus(options: {
  hasAnyResidue: boolean;
  rawSessionFiles: number;
  sqliteRows: number;
  sessionIndexRows: number;
  historyRows: number;
  possibleUnknownGlobalStateRefs: number;
  brokenRelations: number;
}): SessionResidueAuditStatus[] {
  const statuses: SessionResidueAuditStatus[] = [];

  if (!options.hasAnyResidue && options.brokenRelations === 0) {
    return ["clean"];
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

  return statuses;
}

function describeCurrentState(session: SessionEntry, hasAnyResidue: boolean, hasOriginalRollout: boolean): SessionResidueAudit["currentState"] {
  if (!hasAnyResidue) {
    return {
      kind: "clean",
      archived: false,
      hasOriginalRollout: false,
      message: "未发现这个会话的本地残留。",
    };
  }

  if (hasOriginalRollout) {
    return {
      kind: session.kind,
      archived: session.archived,
      hasOriginalRollout,
      message: session.archived
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
  const session = resolveAuditSession(scan, sessionId);
  const preview = buildDeletePreview(scan, [session]);
  const item = preview.items[0];
  const family = buildSessionFamily(scan, session);
  const sqliteRows = sumSqliteDeletionCounts(item.sqlite);
  const knownGlobalStateRefs = scan.globalState.refsById.get(session.id) ?? [];
  const unknownGlobalStateRefs = scan.globalState.possibleUnknownRefsById.get(session.id) ?? [];
  const threadSpawnEdges = scan.sqlite.threadSpawnEdges.filter(
    (edge) => edge.parentThreadId === session.id || edge.childThreadId === session.id,
  );
  const parentIds = uniqueSorted(threadSpawnEdges.filter((edge) => edge.childThreadId === session.id).map((edge) => edge.parentThreadId));
  const childIds = uniqueSorted(threadSpawnEdges.filter((edge) => edge.parentThreadId === session.id).map((edge) => edge.childThreadId));
  const familyMemberIds = uniqueSorted([session.id, ...family.familyMembers.map((node) => node.sessionId)]);
  const rawSessionFiles = item.filePaths.length;
  const hasAnyResidue =
    rawSessionFiles +
      item.shellSnapshotFiles.length +
      item.sessionIndexRows +
      item.historyRows +
      sqliteRows +
      item.globalStateRefs +
      item.possibleUnknownGlobalStateRefs +
      threadSpawnEdges.length >
    0;
  const statuses = buildStatus({
    hasAnyResidue,
    rawSessionFiles,
    sqliteRows,
    sessionIndexRows: item.sessionIndexRows,
    historyRows: item.historyRows,
    possibleUnknownGlobalStateRefs: item.possibleUnknownGlobalStateRefs,
    brokenRelations: family.brokenRelations.length,
  });
  const warnings = uniqueSorted([
    ...scan.warnings,
    ...family.warnings,
    ...(unknownGlobalStateRefs.length > 0
      ? [`global-state 有 ${unknownGlobalStateRefs.length} 个未知位置引用，工具不会自动修改。`]
      : []),
  ]);
  const recommendedNextCommand = hasAnyResidue
    ? `codex-sessions delete ${quoteShellArg(session.id)} --root ${quoteShellArg(scan.root.rootPath)}`
    : null;

  return {
    sessionId: session.id,
    title: session.title,
    displayTitle: session.displayTitle,
    rootPath: scan.root.rootPath,
    overallStatus: statuses,
    currentState: describeCurrentState(session, hasAnyResidue, rawSessionFiles > 0),
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
    recommendedNextCommandNote: recommendedNextCommand
      ? "这是预览命令，不会删除；只有用户加 --yes 才会真的删除。"
      : null,
  };
}
