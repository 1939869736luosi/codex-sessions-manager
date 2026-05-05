import crypto from "node:crypto";
import path from "node:path";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

import { deleteSessions, buildDeletePreview } from "./delete.js";
import { restoreGlobalStateReferences } from "./global-state.js";
import { buildJsonl, safeJsonParse, splitJsonLines } from "./jsonl.js";
import { resolveSessions } from "./query.js";
import { scanCodexRoot } from "./scan.js";
import {
  collectSqliteDeletionCounts,
  assertNoSqliteRestoreKeyConflicts,
  exportSqliteRecordsForRestore,
  restoreSqliteRecords,
  sumSqliteDeletionCounts,
} from "./sqlite.js";
import type {
  HistoryRecord,
  ScanResult,
  SessionEntry,
  SessionIndexRecord,
  TrashBundle,
  TrashDeleteResult,
  TrashEntrySummary,
  TrashPurgeResult,
  TrashRestoreResult,
} from "./types.js";

const TOOL_VERSION = "0.3.1";
const TRASH_DIR_NAME = ".codex-sessions-trash";

function getTrashDir(rootPath: string): string {
  return path.join(rootPath, TRASH_DIR_NAME);
}

function createTrashId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${crypto.randomUUID()}`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

interface FileSnapshot {
  absolutePath: string;
  existed: boolean;
  bytes: Uint8Array | null;
}

async function captureFileSnapshot(absolutePath: string): Promise<FileSnapshot> {
  try {
    return {
      absolutePath,
      existed: true,
      bytes: new Uint8Array(await readFile(absolutePath)),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return {
        absolutePath,
        existed: false,
        bytes: null,
      };
    }

    throw error;
  }
}

async function restoreFileSnapshot(snapshot: FileSnapshot): Promise<void> {
  if (!snapshot.existed) {
    await rm(snapshot.absolutePath, { force: true });
    return;
  }

  await mkdir(path.dirname(snapshot.absolutePath), { recursive: true });
  await writeFile(snapshot.absolutePath, snapshot.bytes ?? new Uint8Array());
}

async function rollbackFileSnapshots(snapshots: FileSnapshot[]): Promise<void> {
  const errors: string[] = [];

  for (const snapshot of snapshots) {
    try {
      await restoreFileSnapshot(snapshot);
    } catch (error) {
      errors.push(`${snapshot.absolutePath}: ${formatError(error)}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`回收站 manifest 缺少有效字段：${label}`);
  }
}

function assertSafeTrashRelativePath(relativePath: string, label: string): void {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error(`回收站 manifest 路径无效：${label}`);
  }

  if (path.isAbsolute(relativePath)) {
    throw new Error(`回收站 manifest 路径不能是绝对路径：${label}=${relativePath}`);
  }

  const normalized = path.normalize(relativePath);
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`回收站 manifest 路径不能离开 root：${label}=${relativePath}`);
  }
}

function safeRootPath(rootPath: string, relativePath: string): string {
  assertSafeTrashRelativePath(relativePath, "restore.path");
  const targetPath = path.resolve(rootPath, relativePath);
  const normalizedRoot = path.resolve(rootPath);
  if (targetPath !== normalizedRoot && !targetPath.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`回收站 manifest 路径不能离开 root：${relativePath}`);
  }
  return targetPath;
}

async function readTrashBundle(entryDir: string): Promise<TrashBundle> {
  const manifestPath = path.join(entryDir, "manifest.json");
  try {
    return JSON.parse(await readFile(manifestPath, "utf8")) as TrashBundle;
  } catch (error) {
    throw new Error(`回收站 manifest 无法读取或解析：${manifestPath}: ${formatError(error)}`);
  }
}

function validateTrashBundle(bundle: TrashBundle): void {
  if (!bundle || typeof bundle !== "object") {
    throw new Error("回收站 manifest 格式无效。");
  }

  if (!bundle.manifest || typeof bundle.manifest !== "object") {
    throw new Error("回收站 manifest 缺少 manifest。");
  }

  assertArray(bundle.manifest.sessionIds, "manifest.sessionIds");
  assertArray(bundle.manifest.sessions, "manifest.sessions");
  assertArray(bundle.sessionFiles, "sessionFiles");
  assertArray(bundle.shellSnapshots, "shellSnapshots");
  assertArray(bundle.sessionIndexRecords, "sessionIndexRecords");
  assertArray(bundle.historyRecords, "historyRecords");
  assertArray(bundle.globalStateRefs, "globalStateRefs");
  assertArray(bundle.sqlite?.state?.threads, "sqlite.state.threads");
  assertArray(bundle.sqlite?.state?.logs, "sqlite.state.logs");
  assertArray(bundle.sqlite?.state?.threadSpawnEdges, "sqlite.state.threadSpawnEdges");
  assertArray(bundle.sqlite?.state?.agentJobItems, "sqlite.state.agentJobItems");
  assertArray(bundle.sqlite?.state?.threadDynamicTools, "sqlite.state.threadDynamicTools");
  assertArray(bundle.sqlite?.state?.stage1Outputs, "sqlite.state.stage1Outputs");
  assertArray(bundle.sqlite?.state?.threadGoals, "sqlite.state.threadGoals");
  assertArray(bundle.sqlite?.dedicatedLogs, "sqlite.dedicatedLogs");

  for (const file of bundle.sessionFiles) {
    assertSafeTrashRelativePath(file.path, `sessionFiles:${file.sessionId}`);
  }

  for (const file of bundle.shellSnapshots) {
    assertSafeTrashRelativePath(file.path, `shellSnapshots:${file.sessionId}`);
  }

  const sessionFilePaths = new Set(bundle.sessionFiles.map((file) => `${file.sessionId}:${file.path}`));
  const shellSnapshotPaths = new Set(bundle.shellSnapshots.map((file) => `${file.sessionId}:${file.path}`));
  for (const session of bundle.manifest.sessions) {
    if (!bundle.manifest.sessionIds.includes(session.sessionId)) {
      throw new Error(`回收站 manifest 中 session 不一致：${session.sessionId}`);
    }

    for (const relativePath of session.originalRelativePaths) {
      assertSafeTrashRelativePath(relativePath, `manifest.sessions.originalRelativePaths:${session.sessionId}`);
      if (!sessionFilePaths.has(`${session.sessionId}:${relativePath}`)) {
        throw new Error(`回收站 manifest 缺少 session 文件数据：${relativePath}`);
      }
    }

    for (const relativePath of session.shellSnapshotRelativePaths) {
      assertSafeTrashRelativePath(relativePath, `manifest.sessions.shellSnapshotRelativePaths:${session.sessionId}`);
      if (!shellSnapshotPaths.has(`${session.sessionId}:${relativePath}`)) {
        throw new Error(`回收站 manifest 缺少 shell snapshot 数据：${relativePath}`);
      }
    }
  }
}

function summarizeBundle(bundle: TrashBundle): TrashEntrySummary {
  return {
    trashId: bundle.manifest.trashId,
    createdAt: bundle.manifest.createdAt,
    rootPath: bundle.manifest.rootPath,
    sessionIds: bundle.manifest.sessionIds,
    sessions: bundle.manifest.sessions,
  };
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value);
  }

  const record = value as Record<string, unknown>;
  return JSON.stringify(
    Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((next, key) => {
        next[key] = record[key];
        return next;
      }, {}),
  );
}

function recordKey(record: Record<string, unknown>, table: keyof TrashBundle["sqlite"]["state"] | "dedicatedLogs"): string {
  if (table === "threads" && record.id) return String(record.id);
  if ((table === "logs" || table === "dedicatedLogs") && record.id) return String(record.id);
  if (table === "threadSpawnEdges" && record.child_thread_id) return String(record.child_thread_id);
  if (table === "agentJobItems" && record.job_id && record.item_id) return `${String(record.job_id)}:${String(record.item_id)}`;
  if (table === "threadDynamicTools" && record.thread_id && record.position !== undefined) {
    return `${String(record.thread_id)}:${String(record.position)}`;
  }
  if (table === "stage1Outputs" && record.thread_id) return String(record.thread_id);
  if (table === "threadGoals" && record.thread_id) return String(record.thread_id);
  return stableStringify(record);
}

function dedupeRows(
  rows: Record<string, unknown>[],
  table: keyof TrashBundle["sqlite"]["state"] | "dedicatedLogs",
): Record<string, unknown>[] {
  const byKey = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    byKey.set(recordKey(row, table), row);
  }

  return [...byKey.values()];
}

function dedupeTrashBundle(bundle: TrashBundle): TrashBundle {
  return {
    ...bundle,
    sqlite: {
      state: {
        threads: dedupeRows(bundle.sqlite.state.threads, "threads"),
        logs: dedupeRows(bundle.sqlite.state.logs, "logs"),
        threadSpawnEdges: dedupeRows(bundle.sqlite.state.threadSpawnEdges, "threadSpawnEdges"),
        agentJobItems: dedupeRows(bundle.sqlite.state.agentJobItems, "agentJobItems"),
        threadDynamicTools: dedupeRows(bundle.sqlite.state.threadDynamicTools, "threadDynamicTools"),
        stage1Outputs: dedupeRows(bundle.sqlite.state.stage1Outputs, "stage1Outputs"),
        threadGoals: dedupeRows(bundle.sqlite.state.threadGoals, "threadGoals"),
      },
      dedicatedLogs: dedupeRows(bundle.sqlite.dedicatedLogs, "dedicatedLogs"),
    },
  };
}

async function readTrashEntries(rootPath: string): Promise<Array<{ dir: string; bundle: TrashBundle }>> {
  const trashDir = getTrashDir(rootPath);
  if (!(await pathExists(trashDir))) {
    return [];
  }

  const entries = await readdir(trashDir, { withFileTypes: true });
  const bundles: Array<{ dir: string; bundle: TrashBundle }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".tmp-")) {
      continue;
    }

    const dir = path.join(trashDir, entry.name);
    try {
      const bundle = await readTrashBundle(dir);
      validateTrashBundle(bundle);
      bundles.push({ dir, bundle });
    } catch {
      continue;
    }
  }

  return bundles.sort((left, right) => right.bundle.manifest.createdAt.localeCompare(left.bundle.manifest.createdAt));
}

function resolveTrashEntry(
  entries: Array<{ dir: string; bundle: TrashBundle }>,
  idOrSessionId: string,
): { dir: string; bundle: TrashBundle } {
  const matches = entries.filter(
    (entry) =>
      entry.bundle.manifest.trashId === idOrSessionId ||
      entry.bundle.manifest.trashId.startsWith(idOrSessionId) ||
      entry.bundle.manifest.sessionIds.includes(idOrSessionId) ||
      entry.bundle.manifest.sessionIds.some((sessionId) => sessionId.startsWith(idOrSessionId)),
  );

  if (matches.length === 0) {
    throw new Error(`找不到回收站记录：${idOrSessionId}`);
  }

  if (matches.length > 1) {
    throw new Error(`回收站记录不唯一：${idOrSessionId}`);
  }

  return matches[0];
}

async function resolveTrashEntryForRestore(
  rootPath: string,
  idOrSessionId: string,
): Promise<{ dir: string; bundle: TrashBundle }> {
  const entries = await readTrashEntries(rootPath);
  try {
    return resolveTrashEntry(entries, idOrSessionId);
  } catch (error) {
    const trashDir = getTrashDir(rootPath);
    try {
      const dirs = (await readdir(trashDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && (entry.name === idOrSessionId || entry.name.startsWith(idOrSessionId)))
        .map((entry) => path.join(trashDir, entry.name));

      if (dirs.length === 1) {
        const bundle = await readTrashBundle(dirs[0]);
        validateTrashBundle(bundle);
        return { dir: dirs[0], bundle };
      }

      if (dirs.length > 1) {
        throw new Error(`回收站记录不唯一：${idOrSessionId}`);
      }
    } catch (manifestError) {
      if (manifestError instanceof Error && manifestError.message.includes("回收站 manifest")) {
        throw manifestError;
      }
      if ((manifestError as NodeJS.ErrnoException)?.code === "ENOENT") {
        throw error;
      }
      throw manifestError;
    }

    throw error;
  }
}

async function writeFileIfMissing(rootPath: string, relativePath: string, text: string): Promise<boolean> {
  const targetPath = safeRootPath(rootPath, relativePath);
  if (await pathExists(targetPath)) {
    return false;
  }

  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, text, "utf8");
  return true;
}

async function appendJsonlRecords<T>(
  filePath: string | null,
  records: T[],
  getSessionId: (record: T) => string | null,
): Promise<number> {
  if (!filePath || records.length === 0) {
    return 0;
  }

  let existingText = "";
  try {
    existingText = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }

  const existingLines = existingText ? splitJsonLines(existingText) : [];
  const existingKeys = new Set(existingLines.map((line) => JSON.stringify(safeJsonParse<T>(line) ?? line)));
  const nextLines: string[] = [];

  for (const record of records) {
    if (!getSessionId(record)) {
      continue;
    }

    const key = JSON.stringify(record);
    if (existingKeys.has(key)) {
      continue;
    }

    existingKeys.add(key);
    nextLines.push(key);
  }

  if (nextLines.length === 0) {
    return 0;
  }

  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, buildJsonl([...existingLines, ...nextLines]), "utf8");
  return nextLines.length;
}

async function buildTrashBundle(scan: ScanResult, sessions: SessionEntry[], trashId: string): Promise<TrashBundle> {
  const preview = buildDeletePreview(scan, sessions);
  const sessionIds = sessions.map((session) => session.id);
  const sqlite = sessions.map((session) => exportSqliteRecordsForRestore(scan.root.sqlitePath, session.id, scan.root.logsSqlitePath));

  return dedupeTrashBundle({
    manifest: {
      trashId,
      createdAt: new Date().toISOString(),
      rootPath: scan.root.rootPath,
      toolVersion: TOOL_VERSION,
      sessionIds,
      sessions: sessions.map((session) => ({
        sessionId: session.id,
        title: session.title,
        cwd: session.cwd,
        model: session.model,
        rolloutPath: session.rolloutPath,
        projectPath: session.projectPath,
        projectName: session.projectName,
        projectKey: session.projectKey,
        originalRelativePaths: session.fileTargets.map((target) => target.relativePath),
        shellSnapshotRelativePaths: (scan.shellSnapshots.filesById.get(session.id) ?? []).map((target) => target.relativePath),
      })),
      preview,
    },
    sessionFiles: (
      await Promise.all(
        sessions.flatMap((session) =>
          session.fileTargets.map(async (target) => ({
            sessionId: session.id,
            path: target.relativePath,
            text: await readFile(target.absolutePath, "utf8"),
          })),
        ),
      )
    ).flat(),
    shellSnapshots: (
      await Promise.all(
        sessions.flatMap((session) =>
          (scan.shellSnapshots.filesById.get(session.id) ?? []).map(async (target) => ({
            sessionId: session.id,
            path: target.relativePath,
            text: await readFile(target.absolutePath, "utf8"),
          })),
        ),
      )
    ).flat(),
    sessionIndexRecords: sessions.flatMap((session) => scan.sessionIndex.matchingRecordsById.get(session.id) ?? []),
    historyRecords: sessions.flatMap((session) => scan.history.matchingRecordsById.get(session.id) ?? []),
    globalStateRefs: sessions.flatMap((session) => scan.globalState.refsById.get(session.id) ?? []),
    sqlite: {
      state: {
        threads: sqlite.flatMap((bundle) => bundle.state.threads),
        logs: sqlite.flatMap((bundle) => bundle.state.logs),
        threadSpawnEdges: sqlite.flatMap((bundle) => bundle.state.threadSpawnEdges),
        agentJobItems: sqlite.flatMap((bundle) => bundle.state.agentJobItems),
        threadDynamicTools: sqlite.flatMap((bundle) => bundle.state.threadDynamicTools),
        stage1Outputs: sqlite.flatMap((bundle) => bundle.state.stage1Outputs),
        threadGoals: sqlite.flatMap((bundle) => bundle.state.threadGoals),
      },
      dedicatedLogs: sqlite.flatMap((bundle) => bundle.dedicatedLogs),
    },
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addConflict(
  conflictsBySession: Map<string, Set<string>>,
  sessionId: string,
  surface: string,
): void {
  const surfaces = conflictsBySession.get(sessionId) ?? new Set<string>();
  surfaces.add(surface);
  conflictsBySession.set(sessionId, surfaces);
}

async function assertNoRestoreConflicts(scan: ScanResult, bundle: TrashBundle): Promise<void> {
  const conflictsBySession = new Map<string, Set<string>>();

  for (const file of bundle.sessionFiles) {
    if (await pathExists(safeRootPath(scan.root.rootPath, file.path))) {
      addConflict(conflictsBySession, file.sessionId, "session JSONL");
    }
  }

  for (const file of bundle.shellSnapshots) {
    if (await pathExists(safeRootPath(scan.root.rootPath, file.path))) {
      addConflict(conflictsBySession, file.sessionId, "shell snapshot");
    }
  }

  for (const sessionId of bundle.manifest.sessionIds) {
    if ((scan.sessionIndex.lineCountById.get(sessionId) ?? 0) > 0) {
      addConflict(conflictsBySession, sessionId, "session_index");
    }

    if ((scan.history.lineCountById.get(sessionId) ?? 0) > 0) {
      addConflict(conflictsBySession, sessionId, "history");
    }

    if ((scan.globalState.refsById.get(sessionId)?.length ?? 0) > 0) {
      addConflict(conflictsBySession, sessionId, "global state");
    }
  }

  if (scan.globalState.warning && bundle.globalStateRefs.length > 0) {
    for (const sessionId of bundle.manifest.sessionIds) {
      addConflict(conflictsBySession, sessionId, "global state unreadable");
    }
  }

  assertNoSqliteRestoreKeyConflicts(scan.root.sqlitePath, scan.root.logsSqlitePath, bundle.sqlite);

  const sqliteCounts = collectSqliteDeletionCounts(
    scan.root.sqlitePath,
    bundle.manifest.sessionIds,
    scan.root.logsSqlitePath,
  );
  for (const sessionId of bundle.manifest.sessionIds) {
    if (sumSqliteDeletionCounts(sqliteCounts.get(sessionId) ?? {
      threadRows: 0,
      logRows: 0,
      spawnEdgeRows: 0,
      assignedAgentJobs: 0,
      dynamicToolRows: 0,
      stage1Rows: 0,
      threadGoalRows: 0,
    }) > 0) {
      addConflict(conflictsBySession, sessionId, "SQLite");
    }
  }

  if (conflictsBySession.size > 0) {
    const details = [...conflictsBySession.entries()]
      .map(([sessionId, surfaces]) => `${sessionId}: ${[...surfaces].sort().join(", ")}`)
      .join("; ");
    throw new Error(`恢复冲突：live session already exists (${details})`);
  }

}

async function captureRestoreSnapshots(scan: ScanResult, bundle: TrashBundle): Promise<FileSnapshot[]> {
  const paths = new Set<string>();

  for (const file of [...bundle.sessionFiles, ...bundle.shellSnapshots]) {
    paths.add(safeRootPath(scan.root.rootPath, file.path));
  }

  paths.add(scan.root.sessionIndexPath ?? path.join(scan.root.rootPath, "session_index.jsonl"));
  paths.add(scan.root.historyPath ?? path.join(scan.root.rootPath, "history.jsonl"));
  paths.add(scan.root.globalStatePath ?? path.join(scan.root.rootPath, ".codex-global-state.json"));

  if (scan.root.sqlitePath) {
    paths.add(scan.root.sqlitePath);
  }

  if (scan.root.logsSqlitePath) {
    paths.add(scan.root.logsSqlitePath);
  }

  return Promise.all([...paths].map((absolutePath) => captureFileSnapshot(absolutePath)));
}

export async function moveSessionsToTrash(scan: ScanResult, sessions: SessionEntry[]): Promise<TrashDeleteResult> {
  const trashId = createTrashId();
  const trashRoot = getTrashDir(scan.root.rootPath);
  const trashDir = path.join(trashRoot, trashId);
  const tempTrashDir = path.join(trashRoot, `.tmp-${trashId}`);
  let trashEntryCommitted = false;
  let bundle: TrashBundle | null = null;

  let deletion;
  try {
    await mkdir(tempTrashDir, { recursive: true });

    bundle = await buildTrashBundle(scan, sessions, trashId);
    await writeFile(path.join(tempTrashDir, "manifest.json"), `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    await mkdir(path.join(tempTrashDir, "sessions"), { recursive: true });
    for (const session of bundle.manifest.sessions) {
      await writeFile(
        path.join(tempTrashDir, "sessions", `${session.sessionId}.json`),
        `${JSON.stringify(session, null, 2)}\n`,
        "utf8",
      );
    }

    await rename(tempTrashDir, trashDir);
    trashEntryCommitted = true;
    deletion = await deleteSessions(scan, sessions);
  } catch (error) {
    if (trashEntryCommitted) {
      throw new Error(
        `移入回收站失败：live 删除失败，但回收站记录已保留：${trashId}。原始错误：${formatError(error)}`,
      );
    }

    try {
      await rm(tempTrashDir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new Error(
        `移入回收站失败，原始操作失败且回收站临时记录清理失败：${formatError(cleanupError)}。原始错误：${formatError(error)}`,
      );
    }

    throw new Error(`移入回收站失败，已清理回收站临时记录：${formatError(error)}`);
  }

  if (!bundle) {
    throw new Error("移入回收站失败，未生成回收站记录。");
  }

  return {
    trashEntry: summarizeBundle(bundle),
    deletion,
  };
}

export async function listTrashEntries(rootPath: string): Promise<TrashEntrySummary[]> {
  return (await readTrashEntries(rootPath)).map((entry) => summarizeBundle(entry.bundle));
}

export async function restoreTrashEntry(rootArg: string | undefined, idOrSessionId: string): Promise<TrashRestoreResult> {
  const scan = await scanCodexRoot(rootArg);
  const entry = await resolveTrashEntryForRestore(scan.root.rootPath, idOrSessionId);
  const bundle = entry.bundle;
  const warnings: string[] = [];
  let restoredSessionFiles = 0;
  let restoredShellSnapshots = 0;
  let snapshots: FileSnapshot[] = [];

  validateTrashBundle(bundle);
  if (path.resolve(bundle.manifest.rootPath) !== path.resolve(scan.root.rootPath)) {
    throw new Error(`回收站记录来自不同 root：${bundle.manifest.rootPath}`);
  }

  await assertNoRestoreConflicts(scan, bundle);
  snapshots = await captureRestoreSnapshots(scan, bundle);

  try {
    for (const file of bundle.sessionFiles) {
      if (await writeFileIfMissing(scan.root.rootPath, file.path, file.text)) {
        restoredSessionFiles += 1;
      }
    }

    for (const file of bundle.shellSnapshots) {
      if (await writeFileIfMissing(scan.root.rootPath, file.path, file.text)) {
        restoredShellSnapshots += 1;
      }
    }

    const restoredSessionIndexRecords = await appendJsonlRecords<SessionIndexRecord>(
      scan.root.sessionIndexPath ?? path.join(scan.root.rootPath, "session_index.jsonl"),
      bundle.sessionIndexRecords,
      (record) => record.id ?? null,
    );
    const restoredHistoryRecords = await appendJsonlRecords<HistoryRecord>(
      scan.root.historyPath ?? path.join(scan.root.rootPath, "history.jsonl"),
      bundle.historyRecords,
      (record) => record.session_id ?? null,
    );
    const restoredGlobalStateRefs = await restoreGlobalStateReferences(
      scan.root.globalStatePath ?? path.join(scan.root.rootPath, ".codex-global-state.json"),
      bundle.globalStateRefs,
    );
    const sqliteRestore = restoreSqliteRecords(scan.root.sqlitePath, scan.root.logsSqlitePath, bundle.sqlite);
    if (sqliteRestore.skipped.total > 0) {
      warnings.push(`SQLite 有 ${sqliteRestore.skipped.total} 条记录未恢复，详见 skippedSqliteRows。`);
    }

    return {
      trashEntry: summarizeBundle(bundle),
      restoredSessionIds: bundle.manifest.sessionIds,
      restoredSessionFiles,
      restoredShellSnapshots,
      restoredSessionIndexRecords,
      restoredHistoryRecords,
      restoredGlobalStateRefs,
      restoredSqliteRows: sqliteRestore.restored,
      skippedSqliteRows: sqliteRestore.skipped,
      skippedSqliteTables: sqliteRestore.skippedTables,
      warnings,
    };
  } catch (error) {
    try {
      await rollbackFileSnapshots(snapshots);
    } catch (rollbackError) {
      throw new Error(`恢复失败，回滚也失败：${formatError(rollbackError)}。原始错误：${formatError(error)}`);
    }

    throw new Error(`恢复失败，已回滚已写入内容：${formatError(error)}`);
  }
}

export async function purgeTrashEntry(rootArg: string | undefined, idOrSessionId: string): Promise<TrashPurgeResult> {
  const scan = await scanCodexRoot(rootArg);
  const entry = resolveTrashEntry(await readTrashEntries(scan.root.rootPath), idOrSessionId);
  await rm(entry.dir, { recursive: true, force: true });
  return {
    trashEntry: summarizeBundle(entry.bundle),
    purged: true,
  };
}

export function resolveSessionsForTrash(scan: ScanResult, sessionIds: string[]): SessionEntry[] {
  return resolveSessions(scan, sessionIds);
}
