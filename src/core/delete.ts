import { lstat, rm } from "node:fs/promises";

import {
  collectExactKeyGlobalStateReferences,
  collectGlobalStateReferences,
  collectPossibleUnknownGlobalStateReferences,
  buildGlobalStateRemoval,
  removeGlobalStateReferences,
  toExactKeyPreview,
} from "./global-state.js";
import { buildDeleteFamilyWarnings } from "./family.js";
import { assertConfirmedSessionSelection, assertDestructivePlatformSupported } from "./destructive-policy.js";
import { filterJsonLines, safeJsonParse, splitJsonLines } from "./jsonl.js";
import {
  acquireMutationLock,
  assertCanonicalSessionIds,
  atomicWriteManagedFileIfUnchanged,
  atomicWriteManagedTextIfUnchanged,
  MutationSafetyError,
  type MutationLock,
} from "./mutation-safety.js";
import {
  captureManagedPath,
  createTrustedRootContext,
  getRegisteredTrustedRoots,
  requireMutationTrustedRoots,
  readManagedFile,
  readManagedText,
  revalidateManagedPath,
  toManagedRelativePath,
  type ManagedPathSnapshot,
  type TrustedRootContext,
} from "./path-safety.js";
import { scanShellSnapshots } from "./shell-snapshots.js";
import { createRecoveryFileTransition, type OperationRecoveryPayloadV1 } from "./recovery.js";
import { resolveSessions } from "./query.js";
import { scanCodexRoot } from "./scan.js";
import {
  collectSqliteDeletionCounts,
  collectSqliteDeletionTotals,
  collectDedicatedLogRecords,
  assertDedicatedLogRecoveryPayloadBounds,
  dedicatedLogKeysFromRecords,
  deleteDedicatedLogRows,
  encodeSqliteRecordsForJson,
  deleteGoalRows,
  deleteStateRows,
  exportSqliteRecordsForRestore,
  reconcileSqliteRecordsForRecovery,
  restoreDedicatedLogRecords,
  validateSqliteDeletion,
  inspectSessionMemoryLink,
} from "./sqlite.js";
import { DeleteSessionsError } from "./types.js";
import type {
  CleanupResult,
  CleanupExecutionResult,
  DeleteExecutionResult,
  DeletePreview,
  DeletePreviewItem,
  DeleteValidationItem,
  HistoryRecord,
  ScanResult,
  SessionEntry,
  SessionFileTarget,
  ShellSnapshotFile,
  SessionIndexCleanupResult,
  SessionIndexCleanupExecutionResult,
  SessionIndexRecord,
  SqliteDeletionCounts,
  MutationErrorCode,
} from "./types.js";

const MUTATION_ERROR_CODES = new Set<MutationErrorCode>([
  "UNSAFE_PATH",
  "STALE_PLAN",
  "MALFORMED_ID",
  "ACTIVE_SESSION",
  "RECOVERY_REQUIRED",
  "POST_COMMIT_VERIFY_FAILED",
]);

function structuredErrorCode(error: unknown, fallback: MutationErrorCode): MutationErrorCode {
  if (error && typeof error === "object" && "code" in error) {
    const code = String(error.code) as MutationErrorCode;
    if (MUTATION_ERROR_CODES.has(code)) return code;
  }
  return fallback;
}

function sumSqliteCounts(counts: SqliteDeletionCounts, includeDedicatedLogs = false): number {
  return (
    counts.threadRows +
    counts.spawnEdgeRows +
    counts.assignedAgentJobs +
    counts.dynamicToolRows +
    counts.stage1Rows +
    counts.threadGoalRows +
    (includeDedicatedLogs ? counts.logRows : 0)
  );
}

function emptySqliteCounts(): SqliteDeletionCounts {
  return {
    threadRows: 0,
    logRows: 0,
    spawnEdgeRows: 0,
    assignedAgentJobs: 0,
    dynamicToolRows: 0,
    stage1Rows: 0,
    threadGoalRows: 0,
  };
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function formatDeleteError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getReadTrustedRoot(scan: ScanResult): Promise<TrustedRootContext> {
  return getRegisteredTrustedRoots(scan.root)?.root ?? createTrustedRootContext(scan.root.rootPath);
}

function getMutationTrustedRoot(scan: ScanResult): TrustedRootContext {
  return requireMutationTrustedRoots(scan).root;
}

async function assertDeleteSelectionCurrent(
  scan: ScanResult,
  targetIds: ReadonlySet<string>,
  preview: DeletePreview,
  allowActive: boolean | undefined,
): Promise<void> {
  const refreshedScan = await scanCodexRoot(scan.root.rootPath);
  const originalRoots = requireMutationTrustedRoots(scan);
  const refreshedRoots = requireMutationTrustedRoots(refreshedScan);
  const sameIdentity = (
    left: TrustedRootContext | null,
    right: TrustedRootContext | null,
  ): boolean => left === null || right === null
    ? left === right
    : left.realPath === right.realPath
      && left.identity.dev === right.identity.dev
      && left.identity.ino === right.identity.ino;
  if (
    !sameIdentity(originalRoots.root, refreshedRoots.root)
    || !sameIdentity(originalRoots.sqliteHome, refreshedRoots.sqliteHome)
  ) {
    throw new MutationSafetyError(
      "STALE_PLAN",
      "trusted Codex root or SQLite home identity changed after preview",
    );
  }
  const refreshedSessions = resolveSessions(refreshedScan, [...targetIds]);
  assertConfirmedSessionSelection(refreshedSessions.map((session) => session.id), refreshedSessions, {
    allowActive,
  });
  const refreshedPreview = buildDeletePreview(refreshedScan, refreshedSessions);
  if (JSON.stringify(refreshedPreview) !== JSON.stringify(preview)) {
    throw new MutationSafetyError(
      "STALE_PLAN",
      "selected session surfaces or active/archive state changed after preview",
    );
  }
}

async function readOptionalManagedText(
  context: TrustedRootContext,
  filePath: string | null,
): Promise<string | null> {
  if (!filePath) return null;
  try {
    return await readManagedText(context, toManagedRelativePath(context, filePath));
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function assertScannedFileUnchanged(
  context: TrustedRootContext,
  target: Pick<SessionFileTarget | ShellSnapshotFile, "relativePath" | "size" | "lastModified" | "device" | "inode">,
  snapshot: ManagedPathSnapshot,
): Promise<void> {
  if (!snapshot.exists) return;
  const current = await lstat(snapshot.absolutePath);
  if (
    current.size !== target.size
    || (target.lastModified !== null && current.mtimeMs !== target.lastModified)
    || (target.device !== undefined && current.dev !== target.device)
    || (target.inode !== undefined && current.ino !== target.inode)
  ) {
    throw new MutationSafetyError("STALE_PLAN", `managed file changed after scan: ${target.relativePath}`);
  }
  await revalidateManagedPath(context, snapshot);
}

export function buildDeletePreview(
  scan: ScanResult,
  sessions: SessionEntry[],
  options: { dedicatedLogsRetained?: boolean } = {},
): DeletePreview {
  const dedicatedLogsRetained = options.dedicatedLogsRetained ?? false;
  const sessionIds = sessions.map((session) => session.id);
  const sqliteCountsById = collectSqliteDeletionCounts(
    scan.root.sqlitePath,
    sessionIds,
    scan.root.logsSqlitePath,
    scan.root.goalsSqlitePath,
  );
  const sqliteTotals = collectSqliteDeletionTotals(
    scan.root.sqlitePath,
    sessionIds,
    scan.root.logsSqlitePath,
    scan.root.goalsSqlitePath,
  );

  const items: DeletePreviewItem[] = sessions.map((session) => {
    const hasActiveRollout = session.fileTargets.some((target) => target.bucket === "sessions");
    const hasArchivedRollout = session.fileTargets.some((target) => target.bucket === "archived_sessions");
    const storageConflict = hasActiveRollout && hasArchivedRollout;

    return {
    sessionId: session.id,
    title: session.title,
    archived: session.archived,
    storageConflict,
    warnings: storageConflict
      ? ["同一 session ID 同时存在于 sessions 和 archived_sessions；这是异常重复状态，不会自动选择或扩展其他会话。"]
      : [],
    filePaths: session.fileTargets.map((target) => target.relativePath),
    shellSnapshotFiles: (scan.shellSnapshots.filesById.get(session.id) ?? []).map((target) => target.relativePath),
    globalStateRefs: scan.globalState.refsById.get(session.id)?.length ?? 0,
    exactKeyGlobalStateRefs: scan.globalState.exactKeyRefsById.get(session.id)?.length ?? 0,
    exactKeyGlobalStateRefPaths: (scan.globalState.exactKeyRefsById.get(session.id) ?? []).map((ref) => ref.path),
    exactKeyGlobalStateRefsDetail: (scan.globalState.exactKeyRefsById.get(session.id) ?? []).map(toExactKeyPreview),
    possibleUnknownGlobalStateRefs: scan.globalState.possibleUnknownRefsById.get(session.id)?.length ?? 0,
    possibleUnknownGlobalStateRefPaths: (scan.globalState.possibleUnknownRefsById.get(session.id) ?? []).map((ref) => ref.path),
    sessionIndexRows: session.sessionIndexCount,
    historyRows: session.historyCount,
    sqlite: sqliteCountsById.get(session.id) ?? emptySqliteCounts(),
  };
  });

  return {
    memoryRetained: true,
    dedicatedLogsRetained,
    retainedSurfaces: [
      ...(dedicatedLogsRetained ? ["dedicated logs"] : []),
      "memories SQLite",
      "MEMORY.md",
      "memory_summary.md",
      "memory skills",
    ],
    items,
    familyWarnings: buildDeleteFamilyWarnings(scan, sessions),
    totals: {
      sessionFiles: items.reduce((sum, item) => sum + item.filePaths.length, 0),
      shellSnapshotFiles: items.reduce((sum, item) => sum + item.shellSnapshotFiles.length, 0),
      globalStateRefs: items.reduce((sum, item) => sum + item.globalStateRefs, 0),
      exactKeyGlobalStateRefs: items.reduce((sum, item) => sum + item.exactKeyGlobalStateRefs, 0),
      possibleUnknownGlobalStateRefs: items.reduce((sum, item) => sum + item.possibleUnknownGlobalStateRefs, 0),
      sessionIndexRows: items.reduce((sum, item) => sum + item.sessionIndexRows, 0),
      historyRows: items.reduce((sum, item) => sum + item.historyRows, 0),
      sqliteRows: sumSqliteCounts(sqliteTotals, !dedicatedLogsRetained),
    },
  };
}

function countSessionIndexRows(text: string | null, sessionId: string): number {
  if (!text) {
    return 0;
  }

  return splitJsonLines(text).filter((line) => safeJsonParse<SessionIndexRecord>(line)?.id === sessionId).length;
}

function countHistoryRows(text: string | null, sessionId: string): number {
  if (!text) {
    return 0;
  }

  return splitJsonLines(text).filter((line) => safeJsonParse<HistoryRecord>(line)?.session_id === sessionId).length;
}

function collectGlobalStateReferencesForValidation(text: string | null): {
  refsById: ReturnType<typeof collectGlobalStateReferences>;
  exactKeyRefsById: ReturnType<typeof collectExactKeyGlobalStateReferences>;
  possibleUnknownRefsById: ReturnType<typeof collectGlobalStateReferences>;
  warning: string | null;
} {
  try {
    return {
      refsById: collectGlobalStateReferences(text),
      exactKeyRefsById: collectExactKeyGlobalStateReferences(text),
      possibleUnknownRefsById: collectPossibleUnknownGlobalStateReferences(text),
      warning: null,
    };
  } catch (error) {
    return {
      refsById: new Map(),
      exactKeyRefsById: new Map(),
      possibleUnknownRefsById: new Map(),
      warning: `global state 无法解析：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function restoreDeletedFiles(
  trustedRoot: TrustedRootContext,
  deletedFiles: Array<{
    target: Pick<SessionFileTarget | ShellSnapshotFile, "relativePath">;
    bytes: Uint8Array;
  }>,
): Promise<void> {
  for (const fileSnapshot of deletedFiles) {
    await atomicWriteManagedFileIfUnchanged(
      trustedRoot,
      fileSnapshot.target.relativePath,
      null,
      fileSnapshot.bytes,
    );
  }
}

function hasOnlyIneligibleUnknownGlobalState(item: DeletePreviewItem): boolean {
  return (
    item.possibleUnknownGlobalStateRefs > 0 &&
    item.filePaths.length === 0 &&
    item.shellSnapshotFiles.length === 0 &&
    item.globalStateRefs === 0 &&
    item.exactKeyGlobalStateRefs === 0 &&
    item.sessionIndexRows === 0 &&
    item.historyRows === 0 &&
    sumSqliteCounts(item.sqlite) === 0
  );
}

function assertNoUnknownOnlyCleanup(preview: DeletePreview): void {
  const refused = preview.items.filter(hasOnlyIneligibleUnknownGlobalState);
  if (refused.length === 0) {
    return;
  }

  const details = refused
    .map((item) => `${item.sessionId}: ${item.possibleUnknownGlobalStateRefPaths.join(", ")}`)
    .join("; ");
  throw new Error(
    `拒绝删除 unknown global-state：这些引用不符合 P11 exact-key 规则，只能报告不能删除。先运行 audit 查看路径，再只处理 P11 认可的 exact-key：${details}`,
  );
}

export async function validateDeletion(
  scan: ScanResult,
  sessions: SessionEntry[],
): Promise<DeleteValidationItem[]> {
  const trustedRoot = await getReadTrustedRoot(scan);
  const targetIds = sessions.map((session) => session.id);
  const [sessionIndexText, historyText] = await Promise.all([
    readOptionalManagedText(trustedRoot, scan.root.sessionIndexPath),
    readOptionalManagedText(trustedRoot, scan.root.historyPath),
  ]);
  const globalStateRefs = collectGlobalStateReferencesForValidation(
    await readOptionalManagedText(trustedRoot, scan.root.globalStatePath),
  );
  const validationWarnings: string[] = [];
  const shellSnapshotFiles = await scanShellSnapshots(
    scan.root.shellSnapshotsDir,
    scan.root.rootPath,
    trustedRoot,
    validationWarnings,
  );
  const sqliteCounts = validateSqliteDeletion(
    scan.root.sqlitePath,
    targetIds,
    scan.root.logsSqlitePath,
    scan.root.goalsSqlitePath,
  );

  return Promise.all(
    sessions.map(async (session) => {
      const fileChecks = await Promise.all(
        session.fileTargets.map(async (target) => {
          try {
            const snapshot = await captureManagedPath(trustedRoot, target.relativePath, {
              expectedKind: "file",
              allowMissing: true,
            });
            if (snapshot.exists) {
              await readManagedFile(trustedRoot, target.relativePath);
            }
            if (!snapshot.exists) return null;
            return target.relativePath;
          } catch (error) {
            if (isMissingFileError(error)) {
              return null;
            }

            throw error;
          }
        }),
      );
      const knownRefs = globalStateRefs.refsById.get(session.id) ?? [];
      const exactKeyRefs = globalStateRefs.exactKeyRefsById.get(session.id) ?? [];
      const possibleUnknownGlobalStateRefs = globalStateRefs.possibleUnknownRefsById.get(session.id) ?? [];
      const warnings = [
        ...validationWarnings,
        ...(globalStateRefs.warning ? [globalStateRefs.warning] : []),
        ...(exactKeyRefs.length > 0
          ? [`global state 仍有 ${exactKeyRefs.length} 个 P11 exact-key 引用，需先预览并显式确认。`]
          : []),
        ...(possibleUnknownGlobalStateRefs.length > 0
          ? [`global state 存在 ${possibleUnknownGlobalStateRefs.length} 个未知位置引用，工具不会自动修改。`]
          : []),
      ];

      return {
        sessionId: session.id,
        title: session.title,
        filePathsRemaining: fileChecks.filter((value): value is string => Boolean(value)),
        shellSnapshotFilesRemaining: (shellSnapshotFiles.get(session.id) ?? []).map((target) => target.relativePath),
        globalStateRefsRemaining: globalStateRefs.warning ? -1 : knownRefs.length,
        exactKeyGlobalStateRefsRemaining: globalStateRefs.warning ? -1 : exactKeyRefs.length,
        exactKeyGlobalStateRefPaths: exactKeyRefs.map((ref) => ref.path),
        possibleUnknownGlobalStateRefsRemaining: globalStateRefs.warning ? -1 : possibleUnknownGlobalStateRefs.length,
        possibleUnknownGlobalStateRefPaths: possibleUnknownGlobalStateRefs.map((ref) => ref.path),
        globalStateWarning: globalStateRefs.warning,
        warnings,
        sessionIndexRowsRemaining: countSessionIndexRows(sessionIndexText, session.id),
        historyRowsRemaining: countHistoryRows(historyText, session.id),
        sqlite: sqliteCounts.get(session.id) ?? emptySqliteCounts(),
        memoryLink: inspectSessionMemoryLink(
          scan.root.memoriesSqlitePath,
          session.id,
          session.thread?.memoryMode === "enabled"
            ? true
            : session.thread?.memoryMode === "disabled"
              ? false
              : "unknown",
        ),
      };
    }),
  );
}

function verificationScope(dedicatedLogsRetained: boolean) {
  return {
    sessionFiles: true,
    shellSnapshots: true,
    sessionIndex: true,
    history: true,
    globalState: true,
    sqlite: true,
    retainedSurfaces: [
      ...(dedicatedLogsRetained ? ["dedicated logs"] : []),
      "unknown global-state references",
      "memory",
      "remote-control",
    ],
  };
}

function deletionVerificationStatus(
  validation: DeleteValidationItem[],
  dedicatedLogsRetained: boolean,
): "passed" | "partial" | "failed" {
  let partial = false;
  for (const item of validation) {
    const sqliteRemaining =
      item.sqlite.threadRows
      + item.sqlite.spawnEdgeRows
      + item.sqlite.assignedAgentJobs
      + item.sqlite.dynamicToolRows
      + item.sqlite.stage1Rows
      + item.sqlite.threadGoalRows
      + (dedicatedLogsRetained ? 0 : item.sqlite.logRows);
    if (
      item.filePathsRemaining.length > 0
      || item.shellSnapshotFilesRemaining.length > 0
      || item.globalStateRefsRemaining > 0
      || item.exactKeyGlobalStateRefsRemaining > 0
      || item.sessionIndexRowsRemaining > 0
      || item.historyRowsRemaining > 0
      || sqliteRemaining > 0
    ) {
      return "failed";
    }
    if (
      item.globalStateWarning
      || item.possibleUnknownGlobalStateRefsRemaining !== 0
      || item.warnings.length > 0
    ) {
      partial = true;
    }
  }
  return partial ? "partial" : "passed";
}

async function captureSqlitePaths(scan: ScanResult): Promise<Array<{
  context: TrustedRootContext;
  snapshot: ManagedPathSnapshot;
}>> {
  const paths = [scan.root.sqlitePath, scan.root.logsSqlitePath, scan.root.goalsSqlitePath].filter(
    (value): value is string => Boolean(value),
  );
  if (paths.length === 0) return [];
  const context = requireMutationTrustedRoots(scan).sqliteHome;
  if (!context) {
    throw new MutationSafetyError("UNSAFE_PATH", "destructive operation requires the registered SQLite trusted root");
  }
  return Promise.all(paths.map(async (filePath) => ({
    context,
    snapshot: await captureManagedPath(context, toManagedRelativePath(context, filePath), {
      expectedKind: "file",
      allowMissing: false,
    }),
  })));
}

export async function deleteSessions(
  scan: ScanResult,
  sessions: SessionEntry[],
  options: {
    lock?: MutationLock;
    allowActive?: boolean;
    recoveryKind?: "delete" | "trash";
    recoveryTrash?: OperationRecoveryPayloadV1["trash"];
  } = {},
): Promise<DeleteExecutionResult> {
  assertConfirmedSessionSelection(
    sessions.map((session) => session.id),
    sessions,
    { allowActive: options.allowActive },
  );
  assertCanonicalSessionIds(sessions.map((session) => session.id));
  const trustedRoot = getMutationTrustedRoot(scan);
  const targetIds = new Set(sessions.map((session) => session.id));
  const preview = buildDeletePreview(scan, sessions);
  try {
    assertNoUnknownOnlyCleanup(preview);
  } catch (error) {
    throw new DeleteSessionsError(`删除失败，未执行 mutation：${formatDeleteError(error)}`, {
      code: structuredErrorCode(error, "UNSAFE_PATH"),
      liveDeleteStarted: false,
      liveDeleteRolledBack: false,
      cause: error,
    });
  }

  let liveDeleteStarted = false;
  let fileSnapshots: Array<{ target: SessionFileTarget; snapshot: ManagedPathSnapshot; bytes: Uint8Array | null }>;
  let shellSnapshotSnapshots: Array<{ target: ShellSnapshotFile; snapshot: ManagedPathSnapshot; bytes: Uint8Array | null }>;
  let originalSessionIndexText: string | null;
  let originalHistoryText: string | null;
  const originalGlobalStateText = scan.globalState.text;
  let sessionIndexResult: ReturnType<typeof filterJsonLines<SessionIndexRecord>>;
  let historyResult: ReturnType<typeof filterJsonLines<HistoryRecord>>;
  let sqliteSnapshots: Awaited<ReturnType<typeof captureSqlitePaths>>;
  let sqliteRecoveryBundle: ReturnType<typeof exportSqliteRecordsForRestore>["state"];
  let dedicatedLogRecoveryRows: Record<string, unknown>[] = [];
  let encodedDedicatedLogRecoveryRows: Record<string, unknown>[] = [];
  let globalStateAfterText: string | null = originalGlobalStateText;
  let lock: MutationLock | undefined = options.lock;
  const ownsLock = !lock;

  try {
    lock ??= await acquireMutationLock(
      trustedRoot,
      "delete",
      [...targetIds],
      requireMutationTrustedRoots(scan).sqliteHome,
    );
    await lock.setStage("prepared");
    await assertDeleteSelectionCurrent(scan, targetIds, preview, options.allowActive);
    fileSnapshots = await Promise.all(
      sessions.flatMap((session) =>
        session.fileTargets.map(async (target) => {
          const snapshot = await captureManagedPath(trustedRoot, target.relativePath, {
            expectedKind: "file",
            allowMissing: true,
          });
          await assertScannedFileUnchanged(trustedRoot, target, snapshot);
          return {
            target,
            snapshot,
            bytes: snapshot.exists ? new Uint8Array(await readManagedFile(trustedRoot, target.relativePath)) : null,
          };
        }),
      ),
    );
    const shellSnapshotTargets = sessions.flatMap((session) => scan.shellSnapshots.filesById.get(session.id) ?? []);
    shellSnapshotSnapshots = await Promise.all(
      shellSnapshotTargets.map(async (target) => {
        const snapshot = await captureManagedPath(trustedRoot, target.relativePath, {
          expectedKind: "file",
          allowMissing: true,
        });
        await assertScannedFileUnchanged(trustedRoot, target, snapshot);
        return {
          target,
          snapshot,
          bytes: snapshot.exists ? new Uint8Array(await readManagedFile(trustedRoot, target.relativePath)) : null,
        };
      }),
    );
    originalSessionIndexText = await readOptionalManagedText(trustedRoot, scan.root.sessionIndexPath);
    originalHistoryText = await readOptionalManagedText(trustedRoot, scan.root.historyPath);
    if (scan.root.globalStatePath) {
      await captureManagedPath(trustedRoot, toManagedRelativePath(trustedRoot, scan.root.globalStatePath), {
        expectedKind: "file",
        allowMissing: false,
      });
    }
    sqliteSnapshots = await captureSqlitePaths(scan);
    const sqliteBundles = sessions.map((session) =>
      exportSqliteRecordsForRestore(
        scan.root.sqlitePath,
        session.id,
        null,
        scan.root.goalsSqlitePath,
      ).state);
    sqliteRecoveryBundle = {
      threads: sqliteBundles.flatMap((bundle) => bundle.threads),
      logs: [],
      threadSpawnEdges: sqliteBundles.flatMap((bundle) => bundle.threadSpawnEdges),
      agentJobItems: sqliteBundles.flatMap((bundle) => bundle.agentJobItems),
      threadDynamicTools: sqliteBundles.flatMap((bundle) => bundle.threadDynamicTools),
      stage1Outputs: sqliteBundles.flatMap((bundle) => bundle.stage1Outputs),
      threadGoals: sqliteBundles.flatMap((bundle) => bundle.threadGoals),
    };
    if (options.recoveryKind !== "trash") {
      dedicatedLogRecoveryRows = collectDedicatedLogRecords(scan.root.logsSqlitePath, [...targetIds]);
      encodedDedicatedLogRecoveryRows = encodeSqliteRecordsForJson(dedicatedLogRecoveryRows);
      assertDedicatedLogRecoveryPayloadBounds(encodedDedicatedLogRecoveryRows);
    }

    sessionIndexResult = filterJsonLines<SessionIndexRecord>(
      originalSessionIndexText,
      (record) => !record?.id || !targetIds.has(record.id),
    );
    historyResult = filterJsonLines<HistoryRecord>(
      originalHistoryText,
      (record) => !record?.session_id || !targetIds.has(record.session_id),
    );
    if (originalGlobalStateText !== null) {
      globalStateAfterText = buildGlobalStateRemoval(originalGlobalStateText, targetIds).nextText;
    }
  } catch (error) {
    if (lock && ownsLock) {
      await lock.release("rolled_back", { phase: "preparing", error: formatDeleteError(error) }).catch(() => undefined);
    }
    throw new DeleteSessionsError(`删除失败，未执行 mutation：${formatDeleteError(error)}`, {
      code: structuredErrorCode(error, "UNSAFE_PATH"),
      liveDeleteStarted: false,
      liveDeleteRolledBack: false,
      cause: error,
    });
  }

  let sessionIndexWritten = false;
  let historyWritten = false;
  let globalStateWritten = false;
  let sqliteMutationStarted = false;
  let dedicatedLogsDeleted = false;
  const deletedFiles: Array<{ target: Pick<SessionFileTarget | ShellSnapshotFile, "relativePath">; bytes: Uint8Array }> = [];

  try {
    const registered = requireMutationTrustedRoots(scan);
    const sqliteContext = registered.sqliteHome;
    if ((scan.root.sqlitePath || scan.root.goalsSqlitePath || scan.root.logsSqlitePath) && !sqliteContext) {
      throw new MutationSafetyError("UNSAFE_PATH", "destructive operation requires the registered SQLite trusted root");
    }
    const recoveryFiles = [
      ...fileSnapshots.map((entry) =>
        createRecoveryFileTransition(entry.target.relativePath, entry.bytes, null)),
      ...shellSnapshotSnapshots.map((entry) =>
        createRecoveryFileTransition(entry.target.relativePath, entry.bytes, null)),
      ...(scan.root.sessionIndexPath && originalSessionIndexText !== null
        ? [createRecoveryFileTransition(
            toManagedRelativePath(trustedRoot, scan.root.sessionIndexPath),
            originalSessionIndexText,
            sessionIndexResult.text,
          )]
        : []),
      ...(scan.root.historyPath && originalHistoryText !== null
        ? [createRecoveryFileTransition(
            toManagedRelativePath(trustedRoot, scan.root.historyPath),
            originalHistoryText,
            historyResult.text,
          )]
        : []),
      ...(scan.root.globalStatePath && originalGlobalStateText !== null && globalStateAfterText !== null
        ? [createRecoveryFileTransition(
            toManagedRelativePath(trustedRoot, scan.root.globalStatePath),
            originalGlobalStateText,
            globalStateAfterText,
          )]
        : []),
    ];
    await lock!.writeRecoveryPayload({
      schemaVersion: "codex-sessions-recovery.v1",
      operationId: lock!.operationId,
      kind: options.recoveryKind ?? "delete",
      strategy: "rollback",
      rootRealPath: trustedRoot.realPath,
      targetIds: [...targetIds],
      files: recoveryFiles,
      ...(options.recoveryTrash ? { trash: options.recoveryTrash } : {}),
      ...(sqliteContext
        ? {
            sqlite: {
              sqliteHomeRealPath: sqliteContext.realPath,
              sqliteHomeIdentity: { dev: sqliteContext.identity.dev, ino: sqliteContext.identity.ino },
              stateRelativePath: scan.root.sqlitePath
                ? toManagedRelativePath(sqliteContext, scan.root.sqlitePath)
                : null,
              goalsRelativePath: scan.root.goalsSqlitePath
                ? toManagedRelativePath(sqliteContext, scan.root.goalsSqlitePath)
                : null,
              logsRelativePath: options.recoveryKind !== "trash" && scan.root.logsSqlitePath
                ? toManagedRelativePath(sqliteContext, scan.root.logsSqlitePath)
                : null,
              records: sqliteRecoveryBundle as unknown as Record<string, unknown>,
              dedicatedLogRecords: encodedDedicatedLogRecoveryRows,
            },
          }
        : {}),
    } satisfies OperationRecoveryPayloadV1);
    // The recovery journal can take long enough for active/archive state to
    // change. Recheck at the final boundary before the first user-data write.
    await assertDeleteSelectionCurrent(scan, targetIds, preview, options.allowActive);
    liveDeleteStarted = true;
    await lock!.setStage("committing");
    if (scan.root.sessionIndexPath && originalSessionIndexText !== null && sessionIndexResult.removedCount > 0) {
      await lock!.checkpoint("session-index", "started");
      await atomicWriteManagedTextIfUnchanged(
        trustedRoot,
        toManagedRelativePath(trustedRoot, scan.root.sessionIndexPath),
        originalSessionIndexText,
        sessionIndexResult.text,
      );
      sessionIndexWritten = true;
      await lock!.checkpoint("session-index", "committed");
    }

    if (scan.root.historyPath && originalHistoryText !== null && historyResult.removedCount > 0) {
      await lock!.checkpoint("history", "started");
      await atomicWriteManagedTextIfUnchanged(
        trustedRoot,
        toManagedRelativePath(trustedRoot, scan.root.historyPath),
        originalHistoryText,
        historyResult.text,
      );
      historyWritten = true;
      await lock!.checkpoint("history", "committed");
    }

    if (scan.root.globalStatePath && originalGlobalStateText !== null) {
      await lock!.checkpoint("global-state", "started");
      const globalStateResult = await removeGlobalStateReferences(scan.root.globalStatePath, targetIds, {
        expectedText: originalGlobalStateText,
        trustedRoot,
      });
      globalStateWritten = globalStateResult.removedCount > 0;
      await lock!.checkpoint("global-state", "committed", { changed: globalStateWritten });
    }

    for (const fileSnapshot of fileSnapshots) {
      try {
        await lock!.checkpoint("session-file", "started", { relativePath: fileSnapshot.target.relativePath });
        await revalidateManagedPath(trustedRoot, fileSnapshot.snapshot);
        await rm(fileSnapshot.snapshot.absolutePath, { force: true });

        if (fileSnapshot.bytes) {
          deletedFiles.push({
            target: fileSnapshot.target,
            bytes: fileSnapshot.bytes,
          });
        }
        await lock!.checkpoint("session-file", "committed", { relativePath: fileSnapshot.target.relativePath });
      } catch (error) {
        if (isMissingFileError(error)) {
          continue;
        }

        throw error;
      }
    }

    for (const fileSnapshot of shellSnapshotSnapshots) {
      try {
        await lock!.checkpoint("shell-snapshot", "started", { relativePath: fileSnapshot.target.relativePath });
        await revalidateManagedPath(trustedRoot, fileSnapshot.snapshot);
        await rm(fileSnapshot.snapshot.absolutePath, { force: true });

        if (fileSnapshot.bytes) {
          deletedFiles.push({
            target: fileSnapshot.target,
            bytes: fileSnapshot.bytes,
          });
        }
        await lock!.checkpoint("shell-snapshot", "committed", { relativePath: fileSnapshot.target.relativePath });
      } catch (error) {
        if (isMissingFileError(error)) {
          continue;
        }

        throw error;
      }
    }

    if (scan.root.sqlitePath || scan.root.goalsSqlitePath || scan.root.logsSqlitePath) {
      for (const entry of sqliteSnapshots) {
        await revalidateManagedPath(entry.context, entry.snapshot);
      }
      sqliteMutationStarted = true;
      if (scan.root.goalsSqlitePath && scan.root.goalsSqlitePath !== scan.root.sqlitePath) {
        await lock!.checkpoint("sqlite-goals", "started");
        deleteGoalRows(scan.root.goalsSqlitePath, [...targetIds]);
        await lock!.checkpoint("sqlite-goals", "committed");
      }
      await lock!.checkpoint("sqlite-state", "started");
      deleteStateRows(scan.root.sqlitePath, [...targetIds]);
      if (options.recoveryKind !== "trash" && scan.root.logsSqlitePath) {
        deleteDedicatedLogRows(
          scan.root.logsSqlitePath,
          [...targetIds],
          dedicatedLogKeysFromRecords(dedicatedLogRecoveryRows),
          dedicatedLogRecoveryRows,
        );
        dedicatedLogsDeleted = true;
      }
      await lock!.checkpoint("sqlite-state", "committed");
    }
  } catch (error) {
    try {
      if (sqliteMutationStarted) {
        if (dedicatedLogsDeleted) {
          restoreDedicatedLogRecords(scan.root.logsSqlitePath, dedicatedLogRecoveryRows);
        }
        reconcileSqliteRecordsForRecovery(
          scan.root.sqlitePath,
          scan.root.goalsSqlitePath,
          sqliteRecoveryBundle,
        );
      }
      if (globalStateWritten && scan.root.globalStatePath && originalGlobalStateText !== null) {
        await atomicWriteManagedTextIfUnchanged(
          trustedRoot,
          toManagedRelativePath(trustedRoot, scan.root.globalStatePath),
          globalStateAfterText,
          originalGlobalStateText,
        );
      }
      if (historyWritten && scan.root.historyPath && originalHistoryText !== null) {
        await atomicWriteManagedTextIfUnchanged(
          trustedRoot,
          toManagedRelativePath(trustedRoot, scan.root.historyPath),
          historyResult.text,
          originalHistoryText,
        );
      }
      if (sessionIndexWritten && scan.root.sessionIndexPath && originalSessionIndexText !== null) {
        await atomicWriteManagedTextIfUnchanged(
          trustedRoot,
          toManagedRelativePath(trustedRoot, scan.root.sessionIndexPath),
          sessionIndexResult.text,
          originalSessionIndexText,
        );
      }
      if (deletedFiles.length > 0) {
        await restoreDeletedFiles(trustedRoot, deletedFiles);
      }
      if (ownsLock) await lock!.release("rolled_back", { error: formatDeleteError(error) });
    } catch (rollbackError) {
      if (ownsLock) {
        await lock!.release("recovery_required", {
          error: formatDeleteError(error),
          rollbackError: formatDeleteError(rollbackError),
        }).catch(() => undefined);
      }
      throw new DeleteSessionsError(
        `删除失败，回滚也失败；RECOVERY_REQUIRED：${formatDeleteError(rollbackError)}。原始错误：${formatDeleteError(error)}`,
        { code: "RECOVERY_REQUIRED", liveDeleteStarted, liveDeleteRolledBack: false, cause: error },
      );
    }

    throw new DeleteSessionsError(`删除失败，已回滚：${formatDeleteError(error)}`, {
      code: structuredErrorCode(error, "UNSAFE_PATH"),
      liveDeleteStarted,
      liveDeleteRolledBack: true,
      cause: error,
    });
  }

  await lock!.setStage("verifying");
  try {
    const validation = await validateDeletion(scan, sessions);
    const verificationStatus = deletionVerificationStatus(validation, options.recoveryKind === "trash");
    const warnings = verificationStatus === "passed"
      ? []
      : ["操作已完成，但验证未覆盖或未清除所有报告项；请查看 verificationScope 与 validation。"];
    if (ownsLock) await lock!.release("committed", { verificationStatus });
    return {
      preview,
      validation,
      confirmed: true,
      operationStatus: "committed",
      verificationStatus,
      verificationScope: verificationScope(options.recoveryKind === "trash"),
      warnings,
      errorCode: verificationStatus === "failed" ? "POST_COMMIT_VERIFY_FAILED" : null,
    };
  } catch (error) {
    if (ownsLock) await lock!.release("committed", { verificationStatus: "failed", error: formatDeleteError(error) });
    return {
      preview,
      validation: [],
      confirmed: true,
      operationStatus: "committed",
      verificationStatus: "failed",
      verificationScope: verificationScope(options.recoveryKind === "trash"),
      warnings: [`操作已完成，但验证失败：${formatDeleteError(error)}`],
      errorCode: "POST_COMMIT_VERIFY_FAILED",
    };
  }
}

export function previewCleanupStaleIndexes(scan: ScanResult): CleanupResult {
  const staleSessionIds = scan.sessions.filter((session) => session.kind === "stale").map((session) => session.id);
  const staleSet = new Set(staleSessionIds);

  const sessionIndexResult = filterJsonLines<SessionIndexRecord>(
    scan.sessionIndex.text,
    (record) => !record?.id || !staleSet.has(record.id),
  );
  const historyResult = filterJsonLines<HistoryRecord>(
    scan.history.text,
    (record) => !record?.session_id || !staleSet.has(record.session_id),
  );

  return {
    staleSessionIds,
    removedSessionIndexRows: sessionIndexResult.removedCount,
    removedHistoryRows: historyResult.removedCount,
  };
}

async function rewriteSessionIndexes(
  scan: ScanResult,
  sessionIds: string[],
  nextSessionIndexText: string,
  nextHistoryText: string,
  kind: "cleanup-stale" | "cleanup-index",
  assertBeforeCommit?: () => Promise<void>,
): Promise<{ verificationStatus: "passed" | "failed"; warnings: string[] }> {
  assertCanonicalSessionIds(sessionIds);
  const trustedRoot = getMutationTrustedRoot(scan);
  const [currentSessionIndexText, currentHistoryText] = await Promise.all([
    readOptionalManagedText(trustedRoot, scan.root.sessionIndexPath),
    readOptionalManagedText(trustedRoot, scan.root.historyPath),
  ]);
  if (currentSessionIndexText !== scan.sessionIndex.text || currentHistoryText !== scan.history.text) {
    throw new MutationSafetyError("STALE_PLAN", "session indexes changed after scan; run the preview again");
  }

  const lock = await acquireMutationLock(
    trustedRoot,
    kind,
    sessionIds,
    requireMutationTrustedRoots(scan).sqliteHome,
  );
  let sessionIndexWritten = false;
  let historyWritten = false;
  try {
    const recoveryFiles = [
      ...(scan.root.sessionIndexPath && currentSessionIndexText !== null
        ? [createRecoveryFileTransition(
            toManagedRelativePath(trustedRoot, scan.root.sessionIndexPath),
            currentSessionIndexText,
            nextSessionIndexText,
          )]
        : []),
      ...(scan.root.historyPath && currentHistoryText !== null
        ? [createRecoveryFileTransition(
            toManagedRelativePath(trustedRoot, scan.root.historyPath),
            currentHistoryText,
            nextHistoryText,
          )]
        : []),
    ];
    await lock.writeRecoveryPayload({
      schemaVersion: "codex-sessions-recovery.v1",
      operationId: lock.operationId,
      kind,
      strategy: "rollforward",
      rootRealPath: trustedRoot.realPath,
      targetIds: sessionIds,
      files: recoveryFiles,
    } satisfies OperationRecoveryPayloadV1);
    await assertBeforeCommit?.();
    await lock.setStage("committing");
    if (scan.root.sessionIndexPath && currentSessionIndexText !== null) {
      await lock.checkpoint("session-index", "started");
      await atomicWriteManagedTextIfUnchanged(
        trustedRoot,
        toManagedRelativePath(trustedRoot, scan.root.sessionIndexPath),
        currentSessionIndexText,
        nextSessionIndexText,
      );
      sessionIndexWritten = true;
      await lock.checkpoint("session-index", "committed");
    }
    if (scan.root.historyPath && currentHistoryText !== null) {
      await lock.checkpoint("history", "started");
      await atomicWriteManagedTextIfUnchanged(
        trustedRoot,
        toManagedRelativePath(trustedRoot, scan.root.historyPath),
        currentHistoryText,
        nextHistoryText,
      );
      historyWritten = true;
      await lock.checkpoint("history", "committed");
    }
    await lock.setStage("verifying");
    const verification = await verifySessionIndexesRemoved(scan, sessionIds);
    await lock.release("committed", {
      verificationStatus: verification.verificationStatus,
      warnings: verification.warnings,
    });
    return verification;
  } catch (error) {
    try {
      if (historyWritten && scan.root.historyPath && currentHistoryText !== null) {
        await atomicWriteManagedTextIfUnchanged(
          trustedRoot,
          toManagedRelativePath(trustedRoot, scan.root.historyPath),
          nextHistoryText,
          currentHistoryText,
        );
      }
      if (sessionIndexWritten && scan.root.sessionIndexPath && currentSessionIndexText !== null) {
        await atomicWriteManagedTextIfUnchanged(
          trustedRoot,
          toManagedRelativePath(trustedRoot, scan.root.sessionIndexPath),
          nextSessionIndexText,
          currentSessionIndexText,
        );
      }
      await lock.release("rolled_back", { error: formatDeleteError(error) });
    } catch (rollbackError) {
      await lock.release("recovery_required", {
        error: formatDeleteError(error),
        rollbackError: formatDeleteError(rollbackError),
      }).catch(() => undefined);
      throw new MutationSafetyError(
        "RECOVERY_REQUIRED",
        `index cleanup failed and rollback failed: ${formatDeleteError(rollbackError)}; original: ${formatDeleteError(error)}`,
      );
    }
    throw error;
  }
}

async function verifySessionIndexesRemoved(
  scan: ScanResult,
  sessionIds: string[],
): Promise<{ verificationStatus: "passed" | "failed"; warnings: string[] }> {
  try {
    const trustedRoot = await getReadTrustedRoot(scan);
    const [sessionIndexText, historyText] = await Promise.all([
      readOptionalManagedText(trustedRoot, scan.root.sessionIndexPath),
      readOptionalManagedText(trustedRoot, scan.root.historyPath),
    ]);
    const remaining = sessionIds.flatMap((sessionId) => {
      const sessionIndexRows = countSessionIndexRows(sessionIndexText, sessionId);
      const historyRows = countHistoryRows(historyText, sessionId);
      return sessionIndexRows > 0 || historyRows > 0
        ? [`${sessionId}: session_index=${sessionIndexRows}, history=${historyRows}`]
        : [];
    });
    return remaining.length === 0
      ? { verificationStatus: "passed", warnings: [] }
      : {
          verificationStatus: "failed",
          warnings: [`操作已完成，但索引验证仍发现目标记录：${remaining.join("; ")}`],
        };
  } catch (error) {
    return {
      verificationStatus: "failed",
      warnings: [`操作已完成，但索引验证失败：${formatDeleteError(error)}`],
    };
  }
}

export async function cleanupStaleIndexes(scan: ScanResult): Promise<CleanupExecutionResult> {
  assertDestructivePlatformSupported();
  const preview = previewCleanupStaleIndexes(scan);
  const refreshedPreview = previewCleanupStaleIndexes(await scanCodexRoot(scan.root.rootPath));
  if (JSON.stringify(refreshedPreview) !== JSON.stringify(preview)) {
    throw new MutationSafetyError("STALE_PLAN", "stale-session index targets changed after preview");
  }
  const staleSet = new Set(preview.staleSessionIds);
  const sessionIndexResult = filterJsonLines<SessionIndexRecord>(
    scan.sessionIndex.text,
    (record) => !record?.id || !staleSet.has(record.id),
  );
  const historyResult = filterJsonLines<HistoryRecord>(
    scan.history.text,
    (record) => !record?.session_id || !staleSet.has(record.session_id),
  );

  const verification = await rewriteSessionIndexes(
    scan,
    preview.staleSessionIds,
    sessionIndexResult.text,
    historyResult.text,
    "cleanup-stale",
    async () => {
      const finalPreview = previewCleanupStaleIndexes(await scanCodexRoot(scan.root.rootPath));
      if (JSON.stringify(finalPreview) !== JSON.stringify(preview)) {
        throw new MutationSafetyError("STALE_PLAN", "stale-session targets changed before commit");
      }
    },
  );

  return {
    ...preview,
    operationStatus: "committed",
    verificationStatus: verification.verificationStatus,
    verificationScope: {
      sessionFiles: false,
      shellSnapshots: false,
      sessionIndex: true,
      history: true,
      globalState: false,
      sqlite: false,
      operationJournal: true,
      retainedSurfaces: ["session files", "global state", "SQLite", "memory", "logs_N.sqlite"],
    },
    warnings: verification.warnings,
    errorCode: verification.verificationStatus === "failed" ? "POST_COMMIT_VERIFY_FAILED" : null,
  };
}

export function previewCleanupSessionIndexes(
  scan: ScanResult,
  sessions: SessionEntry[],
): SessionIndexCleanupResult {
  const targetIds = sessions.map((session) => session.id);
  const targetSet = new Set(targetIds);

  const sessionIndexResult = filterJsonLines<SessionIndexRecord>(
    scan.sessionIndex.text,
    (record) => !record?.id || !targetSet.has(record.id),
  );
  const historyResult = filterJsonLines<HistoryRecord>(
    scan.history.text,
    (record) => !record?.session_id || !targetSet.has(record.session_id),
  );

  return {
    sessionIds: targetIds,
    removedSessionIndexRows: sessionIndexResult.removedCount,
    removedHistoryRows: historyResult.removedCount,
  };
}

export async function cleanupSessionIndexes(
  scan: ScanResult,
  sessions: SessionEntry[],
  options: { allowActive?: boolean } = {},
): Promise<SessionIndexCleanupExecutionResult> {
  assertConfirmedSessionSelection(
    sessions.map((session) => session.id),
    sessions,
    { allowActive: options.allowActive },
  );
  const preview = previewCleanupSessionIndexes(scan, sessions);
  const targetSet = new Set(preview.sessionIds);
  const sessionIndexResult = filterJsonLines<SessionIndexRecord>(
    scan.sessionIndex.text,
    (record) => !record?.id || !targetSet.has(record.id),
  );
  const historyResult = filterJsonLines<HistoryRecord>(
    scan.history.text,
    (record) => !record?.session_id || !targetSet.has(record.session_id),
  );

  const refreshedScan = await scanCodexRoot(scan.root.rootPath);
  const refreshedSessions = resolveSessions(refreshedScan, preview.sessionIds);
  assertConfirmedSessionSelection(preview.sessionIds, refreshedSessions, { allowActive: options.allowActive });
  if (
    JSON.stringify(previewCleanupSessionIndexes(refreshedScan, refreshedSessions))
    !== JSON.stringify(preview)
  ) {
    throw new MutationSafetyError("STALE_PLAN", "selected session index targets or active/archive state changed after preview");
  }

  const verification = await rewriteSessionIndexes(
    scan,
    preview.sessionIds,
    sessionIndexResult.text,
    historyResult.text,
    "cleanup-index",
    async () => {
      const finalScan = await scanCodexRoot(scan.root.rootPath);
      const finalSessions = resolveSessions(finalScan, preview.sessionIds);
      assertConfirmedSessionSelection(preview.sessionIds, finalSessions, { allowActive: options.allowActive });
      if (
        JSON.stringify(previewCleanupSessionIndexes(finalScan, finalSessions))
        !== JSON.stringify(preview)
      ) {
        throw new MutationSafetyError(
          "STALE_PLAN",
          "selected session index targets or active/archive state changed before commit",
        );
      }
    },
  );

  return {
    ...preview,
    operationStatus: "committed",
    verificationStatus: verification.verificationStatus,
    verificationScope: {
      sessionFiles: false,
      shellSnapshots: false,
      sessionIndex: true,
      history: true,
      globalState: false,
      sqlite: false,
      operationJournal: true,
      retainedSurfaces: ["session files", "global state", "SQLite", "memory", "logs_N.sqlite"],
    },
    warnings: verification.warnings,
    errorCode: verification.verificationStatus === "failed" ? "POST_COMMIT_VERIFY_FAILED" : null,
  };
}
