import { readFile, rm, writeFile } from "node:fs/promises";

import { filterJsonLines, safeJsonParse, splitJsonLines } from "./jsonl.js";
import {
  collectSqliteDeletionCounts,
  collectSqliteDeletionTotals,
  deleteSessionsFromSqlite,
  validateSqliteDeletion,
} from "./sqlite.js";
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
  );
  const sqliteTotals = collectSqliteDeletionTotals(scan.root.sqlitePath, sessionIds, scan.root.logsSqlitePath);

  const items: DeletePreviewItem[] = sessions.map((session) => ({
    sessionId: session.id,
    title: session.title,
    archived: session.archived,
    filePaths: session.fileTargets.map((target) => target.relativePath),
    sessionIndexRows: session.sessionIndexCount,
    historyRows: session.historyCount,
    sqlite: sqliteCountsById.get(session.id) ?? emptySqliteCounts(),
  }));

  return {
    items,
    totals: {
      sessionFiles: items.reduce((sum, item) => sum + item.filePaths.length, 0),
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

async function restoreDeletedFiles(
  deletedFiles: Array<{
    target: SessionFileTarget;
    bytes: Uint8Array;
  }>,
): Promise<void> {
  for (const fileSnapshot of deletedFiles) {
    await writeFile(fileSnapshot.target.absolutePath, fileSnapshot.bytes);
  }
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
  const sqliteCounts = validateSqliteDeletion(scan.root.sqlitePath, targetIds, scan.root.logsSqlitePath);

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

      return {
        sessionId: session.id,
        title: session.title,
        filePathsRemaining: fileChecks.filter((value): value is string => Boolean(value)),
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
  const fileSnapshots = await Promise.all(
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
  const originalSessionIndexText = await readOptionalText(scan.root.sessionIndexPath);
  const originalHistoryText = await readOptionalText(scan.root.historyPath);

  const sessionIndexResult = filterJsonLines<SessionIndexRecord>(
    originalSessionIndexText,
    (record) => !record?.id || !targetIds.has(record.id),
  );
  const historyResult = filterJsonLines<HistoryRecord>(
    originalHistoryText,
    (record) => !record?.session_id || !targetIds.has(record.session_id),
  );

  let sessionIndexWritten = false;
  let historyWritten = false;
  const deletedFiles: Array<{ target: SessionFileTarget; bytes: Uint8Array }> = [];

  try {
    if (scan.root.sessionIndexPath && originalSessionIndexText !== null) {
      await writeFile(scan.root.sessionIndexPath, sessionIndexResult.text, "utf8");
      sessionIndexWritten = true;
    }

    if (scan.root.historyPath && originalHistoryText !== null) {
      await writeFile(scan.root.historyPath, historyResult.text, "utf8");
      historyWritten = true;
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

    if (scan.root.sqlitePath || scan.root.logsSqlitePath) {
      deleteSessionsFromSqlite(scan.root.sqlitePath, [...targetIds], scan.root.logsSqlitePath);
    }
  } catch (error) {
    if (historyWritten && scan.root.historyPath && originalHistoryText !== null) {
      await writeFile(scan.root.historyPath, originalHistoryText, "utf8");
    }

    if (sessionIndexWritten && scan.root.sessionIndexPath && originalSessionIndexText !== null) {
      await writeFile(scan.root.sessionIndexPath, originalSessionIndexText, "utf8");
    }

    if (deletedFiles.length > 0) {
      await restoreDeletedFiles(deletedFiles);
    }

    throw new Error(`删除失败，已尝试回滚：${error instanceof Error ? error.message : String(error)}`);
  }

  return {
    preview,
    validation: await validateDeletion(scan, sessions),
  };
}

export async function cleanupStaleIndexes(scan: ScanResult): Promise<CleanupResult> {
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

  if (scan.root.sessionIndexPath && scan.sessionIndex.text !== null) {
    await writeFile(scan.root.sessionIndexPath, sessionIndexResult.text, "utf8");
  }

  if (scan.root.historyPath && scan.history.text !== null) {
    await writeFile(scan.root.historyPath, historyResult.text, "utf8");
  }

  return {
    staleSessionIds,
    removedSessionIndexRows: sessionIndexResult.removedCount,
    removedHistoryRows: historyResult.removedCount,
  };
}

export async function cleanupSessionIndexes(
  scan: ScanResult,
  sessions: SessionEntry[],
): Promise<SessionIndexCleanupResult> {
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

  if (scan.root.sessionIndexPath && scan.sessionIndex.text !== null) {
    await writeFile(scan.root.sessionIndexPath, sessionIndexResult.text, "utf8");
  }

  if (scan.root.historyPath && scan.history.text !== null) {
    await writeFile(scan.root.historyPath, historyResult.text, "utf8");
  }

  return {
    sessionIds: targetIds,
    removedSessionIndexRows: sessionIndexResult.removedCount,
    removedHistoryRows: historyResult.removedCount,
  };
}
