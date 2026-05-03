import { readFile } from "node:fs/promises";

import { exportSqliteRecords } from "./sqlite.js";
import type { BackupBundle, ScanResult, SessionEntry } from "./types.js";

export async function exportSessionBackup(scan: ScanResult, session: SessionEntry): Promise<BackupBundle> {
  const sessionFiles = await Promise.all(
    session.fileTargets.map(async (target) => ({
      path: target.relativePath,
      text: await readFile(target.absolutePath, "utf8"),
    })),
  );

  return {
    manifest: {
      exportedAt: new Date().toISOString(),
      sessionId: session.id,
      title: session.title,
      archived: session.archived,
      rolloutPath: session.rolloutPath,
      cwd: session.cwd,
      model: session.model,
    },
    sessionFiles,
    sessionIndexRecords: scan.sessionIndex.matchingRecordsById.get(session.id) ?? [],
    historyRecords: scan.history.matchingRecordsById.get(session.id) ?? [],
    sqlite: exportSqliteRecords(scan.root.sqlitePath, session.id, scan.root.logsSqlitePath),
  };
}
