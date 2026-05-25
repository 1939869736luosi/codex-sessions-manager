import { readFile, rm, writeFile } from "node:fs/promises";

import {
  collectExactKeyGlobalStateReferences,
  collectGlobalStateReferences,
  collectPossibleUnknownGlobalStateReferences,
  removeGlobalStateReferences,
  toExactKeyPreview,
} from "./global-state.js";
import { buildDeleteFamilyWarnings } from "./family.js";
import { filterJsonLines, safeJsonParse, splitJsonLines } from "./jsonl.js";
import { scanShellSnapshots } from "./shell-snapshots.js";
import {
  collectSqliteDeletionCounts,
  collectSqliteDeletionTotals,
  deleteSessionsFromSqlite,
  validateSqliteDeletion,
} from "./sqlite.js";
import { DeleteSessionsError } from "./types.js";
import type {
  CleanupResult,
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
  SessionIndexRecord,
  SqliteDeletionCounts,
} from "./types.js";

function sumSqliteCounts(counts: SqliteDeletionCounts): number {
  return (
    counts.threadRows +
    counts.logRows +
    counts.spawnEdgeRows +
    counts.assignedAgentJobs +
    counts.dynamicToolRows +
    counts.stage1Rows +
    counts.threadGoalRows
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

async function readOptionalText(filePath: string | null): Promise<string | null> {
  if (!filePath) {
    return null;
  }

  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }

    throw error;
  }
}

export function buildDeletePreview(scan: ScanResult, sessions: SessionEntry[]): DeletePreview {
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

  const items: DeletePreviewItem[] = sessions.map((session) => ({
    sessionId: session.id,
    title: session.title,
    archived: session.archived,
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
  }));

  return {
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
      sqliteRows: sumSqliteCounts(sqliteTotals),
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
  deletedFiles: Array<{
    target: Pick<SessionFileTarget | ShellSnapshotFile, "absolutePath">;
    bytes: Uint8Array;
  }>,
): Promise<void> {
  for (const fileSnapshot of deletedFiles) {
    await writeFile(fileSnapshot.target.absolutePath, fileSnapshot.bytes);
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
  const targetIds = sessions.map((session) => session.id);
  const [sessionIndexText, historyText] = await Promise.all([
    readOptionalText(scan.root.sessionIndexPath),
    readOptionalText(scan.root.historyPath),
  ]);
  const globalStateRefs = collectGlobalStateReferencesForValidation(await readOptionalText(scan.root.globalStatePath));
  const shellSnapshotFiles = await scanShellSnapshots(scan.root.shellSnapshotsDir, scan.root.rootPath);
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
            await readFile(target.absolutePath);
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
      };
    }),
  );
}

export async function deleteSessions(
  scan: ScanResult,
  sessions: SessionEntry[],
): Promise<DeleteExecutionResult> {
  const targetIds = new Set(sessions.map((session) => session.id));
  const preview = buildDeletePreview(scan, sessions);
  try {
    assertNoUnknownOnlyCleanup(preview);
  } catch (error) {
    throw new DeleteSessionsError(formatDeleteError(error), {
      liveDeleteStarted: false,
      liveDeleteRolledBack: false,
      cause: error,
    });
  }

  let liveDeleteStarted = false;
  let fileSnapshots: Array<{ target: SessionFileTarget; bytes: Uint8Array | null }>;
  let shellSnapshotSnapshots: Array<{ target: ShellSnapshotFile; bytes: Uint8Array | null }>;
  let originalSessionIndexText: string | null;
  let originalHistoryText: string | null;
  const originalGlobalStateText = scan.globalState.text;
  let sessionIndexResult: ReturnType<typeof filterJsonLines<SessionIndexRecord>>;
  let historyResult: ReturnType<typeof filterJsonLines<HistoryRecord>>;

  try {
    fileSnapshots = await Promise.all(
      sessions.flatMap((session) =>
        session.fileTargets.map(async (target) => ({
          target,
          bytes: await (async () => {
            try {
              return new Uint8Array(await readFile(target.absolutePath));
            } catch (error) {
              if (isMissingFileError(error)) {
                return null;
              }

              throw error;
            }
          })(),
        })),
      ),
    );
    const shellSnapshotTargets = sessions.flatMap((session) => scan.shellSnapshots.filesById.get(session.id) ?? []);
    shellSnapshotSnapshots = await Promise.all(
      shellSnapshotTargets.map(async (target) => ({
        target,
        bytes: await (async () => {
          try {
            return new Uint8Array(await readFile(target.absolutePath));
          } catch (error) {
            if (isMissingFileError(error)) {
              return null;
            }

            throw error;
          }
        })(),
      })),
    );
    originalSessionIndexText = await readOptionalText(scan.root.sessionIndexPath);
    originalHistoryText = await readOptionalText(scan.root.historyPath);

    sessionIndexResult = filterJsonLines<SessionIndexRecord>(
      originalSessionIndexText,
      (record) => !record?.id || !targetIds.has(record.id),
    );
    historyResult = filterJsonLines<HistoryRecord>(
      originalHistoryText,
      (record) => !record?.session_id || !targetIds.has(record.session_id),
    );
  } catch (error) {
    throw new DeleteSessionsError(formatDeleteError(error), {
      liveDeleteStarted: false,
      liveDeleteRolledBack: false,
      cause: error,
    });
  }

  let sessionIndexWritten = false;
  let historyWritten = false;
  let globalStateWritten = false;
  const deletedFiles: Array<{ target: Pick<SessionFileTarget | ShellSnapshotFile, "absolutePath">; bytes: Uint8Array }> = [];

  try {
    liveDeleteStarted = true;
    if (scan.root.sessionIndexPath && originalSessionIndexText !== null && sessionIndexResult.removedCount > 0) {
      await writeFile(scan.root.sessionIndexPath, sessionIndexResult.text, "utf8");
      sessionIndexWritten = true;
    }

    if (scan.root.historyPath && originalHistoryText !== null && historyResult.removedCount > 0) {
      await writeFile(scan.root.historyPath, historyResult.text, "utf8");
      historyWritten = true;
    }

    if (scan.root.globalStatePath && originalGlobalStateText !== null) {
      const globalStateResult = await removeGlobalStateReferences(scan.root.globalStatePath, targetIds, {
        expectedText: originalGlobalStateText,
      });
      globalStateWritten = globalStateResult.removedCount > 0;
    }

    for (const fileSnapshot of fileSnapshots) {
      try {
        await rm(fileSnapshot.target.absolutePath, { force: true });

        if (fileSnapshot.bytes) {
          deletedFiles.push({
            target: fileSnapshot.target,
            bytes: fileSnapshot.bytes,
          });
        }
      } catch (error) {
        if (isMissingFileError(error)) {
          continue;
        }

        throw error;
      }
    }

    for (const fileSnapshot of shellSnapshotSnapshots) {
      try {
        await rm(fileSnapshot.target.absolutePath, { force: true });

        if (fileSnapshot.bytes) {
          deletedFiles.push({
            target: fileSnapshot.target,
            bytes: fileSnapshot.bytes,
          });
        }
      } catch (error) {
        if (isMissingFileError(error)) {
          continue;
        }

        throw error;
      }
    }

    if (scan.root.sqlitePath || scan.root.logsSqlitePath || scan.root.goalsSqlitePath) {
      deleteSessionsFromSqlite(scan.root.sqlitePath, [...targetIds], scan.root.logsSqlitePath, scan.root.goalsSqlitePath);
    }
  } catch (error) {
    if (globalStateWritten && scan.root.globalStatePath && originalGlobalStateText !== null) {
      await writeFile(scan.root.globalStatePath, originalGlobalStateText, "utf8");
    }

    if (historyWritten && scan.root.historyPath && originalHistoryText !== null) {
      await writeFile(scan.root.historyPath, originalHistoryText, "utf8");
    }

    if (sessionIndexWritten && scan.root.sessionIndexPath && originalSessionIndexText !== null) {
      await writeFile(scan.root.sessionIndexPath, originalSessionIndexText, "utf8");
    }

    if (deletedFiles.length > 0) {
      await restoreDeletedFiles(deletedFiles);
    }

    throw new DeleteSessionsError(`删除失败，已尝试回滚：${formatDeleteError(error)}`, {
      liveDeleteStarted,
      liveDeleteRolledBack: true,
      cause: error,
    });
  }

  return {
    preview,
    validation: await validateDeletion(scan, sessions),
    confirmed: true,
  };
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

export async function cleanupStaleIndexes(scan: ScanResult): Promise<CleanupResult> {
  const preview = previewCleanupStaleIndexes(scan);
  const staleSet = new Set(preview.staleSessionIds);
  const sessionIndexResult = filterJsonLines<SessionIndexRecord>(
    scan.sessionIndex.text,
    (record) => !record?.id || !staleSet.has(record.id),
  );
  const historyResult = filterJsonLines<HistoryRecord>(
    scan.history.text,
    (record) => !record?.session_id || !staleSet.has(record.session_id),
  );

  if (scan.root.sessionIndexPath && scan.sessionIndex.text !== null) {
    await writeFile(scan.root.sessionIndexPath, sessionIndexResult.text, "utf8");
  }

  if (scan.root.historyPath && scan.history.text !== null) {
    await writeFile(scan.root.historyPath, historyResult.text, "utf8");
  }

  return preview;
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
): Promise<SessionIndexCleanupResult> {
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

  if (scan.root.sessionIndexPath && scan.sessionIndex.text !== null) {
    await writeFile(scan.root.sessionIndexPath, sessionIndexResult.text, "utf8");
  }

  if (scan.root.historyPath && scan.history.text !== null) {
    await writeFile(scan.root.historyPath, historyResult.text, "utf8");
  }

  return preview;
}
