import {
  captureManagedPath,
  createTrustedRootContext,
  getRegisteredTrustedRoots,
  readManagedFile,
  readManagedText,
  revalidateManagedPath,
  toManagedRelativePath,
} from "./path-safety.js";
import { exportSqliteRecords } from "./sqlite.js";
import type { BackupBundle, ScanResult, SessionEntry } from "./types.js";

export async function exportSessionBackup(scan: ScanResult, session: SessionEntry): Promise<BackupBundle> {
  const registered = getRegisteredTrustedRoots(scan.root);
  const trustedRoot = registered?.root ?? await createTrustedRootContext(scan.root.rootPath);
  const sessionFiles = await Promise.all(
    session.fileTargets.map(async (target) => {
      if (target.compressed) {
        return {
          path: target.relativePath,
          text: (await readManagedFile(trustedRoot, target.relativePath)).toString("base64"),
          encoding: "base64" as const,
        };
      }

        return {
          path: target.relativePath,
          text: await readManagedText(trustedRoot, target.relativePath),
        encoding: "utf8" as const,
      };
    }),
  );
  const shellSnapshots = await Promise.all(
    (scan.shellSnapshots.filesById.get(session.id) ?? []).map(async (target) => ({
      path: target.relativePath,
      text: await readManagedText(trustedRoot, target.relativePath),
    })),
  );

  if (registered?.sqliteHome) {
    for (const sqlitePath of [scan.root.sqlitePath, scan.root.logsSqlitePath, scan.root.goalsSqlitePath]) {
      if (!sqlitePath) continue;
      const snapshot = await captureManagedPath(
        registered.sqliteHome,
        toManagedRelativePath(registered.sqliteHome, sqlitePath),
        { expectedKind: "file", allowMissing: false },
      );
      await revalidateManagedPath(registered.sqliteHome, snapshot);
    }
  }

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
    globalStateRefs: [
      ...(scan.globalState.refsById.get(session.id) ?? []),
      ...(scan.globalState.exactKeyRefsById.get(session.id) ?? []),
    ],
    shellSnapshots,
    sqlite: exportSqliteRecords(scan.root.sqlitePath, session.id, scan.root.logsSqlitePath, scan.root.goalsSqlitePath),
  };
}
