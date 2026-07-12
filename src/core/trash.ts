import crypto from "node:crypto";
import path from "node:path";
import { chmod, lstat, readdir } from "node:fs/promises";

import { deleteSessions, buildDeletePreview } from "./delete.js";
import { assertConfirmedSessionSelection, assertDestructivePlatformSupported } from "./destructive-policy.js";
import {
  buildGlobalStateRestoration,
  findExistingExactKeyGlobalStatePaths,
  restoreGlobalStateReferences,
} from "./global-state.js";
import { buildJsonl, safeJsonParse, splitJsonLines } from "./jsonl.js";
import {
  acquireMutationLock,
  assertCanonicalSessionIds,
  atomicWriteManagedFileIfUnchanged,
  atomicWriteManagedText,
  atomicWriteManagedTextIfUnchanged,
  ensureManagedDirectory,
  MutationSafetyError,
  removeManagedPath,
  renameManagedPath,
  type MutationLock,
} from "./mutation-safety.js";
import {
  captureManagedPath,
  createTrustedRootContext,
  requireMutationTrustedRoots,
  readManagedFile,
  reconstructManagedPath,
  revalidateManagedPath,
  toManagedRelativePath,
  type ManagedPathSnapshot,
  type TrustedRootContext,
} from "./path-safety.js";
import { resolveSessions } from "./query.js";
import { createRecoveryFileTransition, type OperationRecoveryPayloadV1 } from "./recovery.js";
import { scanCodexRoot } from "./scan.js";
import {
  collectSqliteDeletionCounts,
  collectDedicatedLogKeys,
  deleteDedicatedLogRows,
  assertNoSqliteRestoreKeyConflicts,
  decodeSqliteRecordBundleFromJson,
  decodeSqliteRecordsFromJson,
  encodeSqliteRecordBundleForJson,
  encodeSqliteRecordsForJson,
  exportSqliteRecordsForRestore,
  restoreSqliteRecords,
  sumSqliteDeletionCounts,
  validateRestoredSqliteRecords,
} from "./sqlite.js";
import { DeleteSessionsError } from "./types.js";
import { TOOL_VERSION } from "../version.js";
import type {
  GlobalStateReference,
  HistoryRecord,
  ScanResult,
  SessionEntry,
  SessionFileTarget,
  SessionIndexRecord,
  TrashBundle,
  TrashDeleteResult,
  TrashDuplicateSessionSummary,
  TrashEntrySummary,
  TrashPurgeResult,
  TrashRestoreResult,
} from "./types.js";

const TRASH_DIR_NAME = ".codex-sessions-trash";

async function getTrustedRoot(rootPath: string): Promise<TrustedRootContext> {
  return createTrustedRootContext(rootPath);
}

async function assertTrashRootSafe(
  context: TrustedRootContext,
  allowMissing = true,
): Promise<void> {
  await captureManagedPath(context, TRASH_DIR_NAME, {
    expectedKind: "directory",
    allowMissing,
  });
}

function trashRelativePath(...parts: string[]): string {
  return path.join(TRASH_DIR_NAME, ...parts);
}

function createTrashId(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${crypto.randomUUID()}`;
}

interface FileSnapshot {
  relativePath: string;
  snapshot: ManagedPathSnapshot;
  existed: boolean;
  bytes: Uint8Array | null;
  originalHash: string | null;
  writeAttempted: boolean;
  postWriteSnapshot?: ManagedPathSnapshot;
  postWriteHash?: string;
  postWriteBytes?: Uint8Array;
}

function contentHash(contents: Uint8Array | string): string {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

async function captureFileSnapshot(
  context: TrustedRootContext,
  relativePath: string,
): Promise<FileSnapshot> {
  const snapshot = await captureManagedPath(context, relativePath, {
    expectedKind: "file",
    allowMissing: true,
  });
  const bytes = snapshot.exists
    ? new Uint8Array(await readManagedFile(context, snapshot.relativePath))
    : null;
  await revalidateManagedPath(context, snapshot);
  return {
    relativePath: snapshot.relativePath,
    snapshot,
    existed: snapshot.exists,
    bytes,
    originalHash: bytes ? contentHash(bytes) : null,
    writeAttempted: false,
  };
}

async function assertOriginalSnapshotCurrent(
  context: TrustedRootContext,
  snapshot: FileSnapshot,
): Promise<void> {
  await revalidateManagedPath(context, snapshot.snapshot);
  if (!snapshot.existed) return;
  const currentBytes = new Uint8Array(await readManagedFile(context, snapshot.relativePath));
  await revalidateManagedPath(context, snapshot.snapshot);
  if (contentHash(currentBytes) !== snapshot.originalHash) {
    throw new MutationSafetyError("STALE_PLAN", `managed file content changed after snapshot: ${snapshot.relativePath}`);
  }
}

async function markSnapshotWritten(
  context: TrustedRootContext,
  snapshot: FileSnapshot,
): Promise<void> {
  const postWriteSnapshot = await captureManagedPath(context, snapshot.relativePath, {
    expectedKind: "file",
    allowMissing: false,
  });
  const currentBytes = new Uint8Array(await readManagedFile(context, snapshot.relativePath));
  await revalidateManagedPath(context, postWriteSnapshot);
  snapshot.postWriteSnapshot = postWriteSnapshot;
  snapshot.postWriteHash = contentHash(currentBytes);
  snapshot.postWriteBytes = currentBytes;
}

async function assertOperationWriteCurrent(
  context: TrustedRootContext,
  snapshot: FileSnapshot,
): Promise<void> {
  if (!snapshot.postWriteSnapshot || !snapshot.postWriteHash) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", `cannot prove restore write state: ${snapshot.relativePath}`);
  }
  await revalidateManagedPath(context, snapshot.postWriteSnapshot);
  const currentBytes = new Uint8Array(await readManagedFile(context, snapshot.relativePath));
  await revalidateManagedPath(context, snapshot.postWriteSnapshot);
  if (contentHash(currentBytes) !== snapshot.postWriteHash) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", `managed file changed after restore write: ${snapshot.relativePath}`);
  }
}

async function restoreFileSnapshot(
  context: TrustedRootContext,
  snapshot: FileSnapshot,
): Promise<void> {
  await assertOperationWriteCurrent(context, snapshot);
  if (!snapshot.existed) {
    await removeManagedPath(context, snapshot.relativePath, {
      expectedKind: "file",
      allowMissing: true,
    });
    return;
  }

  await atomicWriteManagedFileIfUnchanged(
    context,
    snapshot.relativePath,
    snapshot.postWriteBytes ?? null,
    snapshot.bytes ?? new Uint8Array(),
  );
}

async function rollbackFileSnapshots(
  context: TrustedRootContext,
  snapshots: FileSnapshot[],
): Promise<void> {
  const errors: string[] = [];

  for (const snapshot of [...snapshots].reverse()) {
    if (!snapshot.writeAttempted) continue;
    try {
      await restoreFileSnapshot(context, snapshot);
    } catch (error) {
      errors.push(`${snapshot.relativePath}: ${formatError(error)}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }
}

async function enforceManagedMode(
  context: TrustedRootContext,
  relativePath: string,
  mode: number,
): Promise<void> {
  if (process.platform === "win32") return;
  const snapshot = await captureManagedPath(context, relativePath, {
    expectedKind: "directory",
    allowMissing: false,
  });
  await revalidateManagedPath(context, snapshot);
  await chmod(snapshot.absolutePath, mode);
  const updated = await captureManagedPath(context, relativePath, {
    expectedKind: "directory",
    allowMissing: false,
  });
  if (((updated.identity?.mode ?? 0) & 0o777) !== mode) {
    throw new MutationSafetyError("UNSAFE_PATH", `无法把敏感目录权限设为 ${mode.toString(8)}：${updated.absolutePath}`);
  }
}

async function secureTrashDirectories(context: TrustedRootContext): Promise<void> {
  await ensureManagedDirectory(context, TRASH_DIR_NAME, 0o700);
  await enforceManagedMode(context, TRASH_DIR_NAME, 0o700);
  await ensureManagedDirectory(context, trashRelativePath(".operations"), 0o700);
  await enforceManagedMode(context, trashRelativePath(".operations"), 0o700);
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`回收站 manifest 缺少有效字段：${label}`);
  }
}

function assertSafeTrashRelativePath(relativePath: string, label: string): string {
  if (typeof relativePath !== "string" || !relativePath.trim()) {
    throw new Error(`回收站 manifest 路径无效：${label}`);
  }

  if (
    relativePath.includes("\0")
    || path.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || /^[A-Za-z]:/u.test(relativePath)
  ) {
    throw new Error(`回收站 manifest 路径不能是绝对路径：${label}=${relativePath}`);
  }

  const components = relativePath.split(/[\\/]/u);
  if (components.some((component) => !component || component === "." || component === "..")) {
    throw new Error(`回收站 manifest 路径不能离开 root：${label}=${relativePath}`);
  }
  const canonical = path.join(...components);
  const separatorNormalized = relativePath.replace(/[\\/]/gu, path.sep);
  if (separatorNormalized !== canonical) {
    throw new Error(`回收站 manifest 路径不是规范相对路径：${label}=${relativePath}`);
  }
  return canonical;
}

async function readTrashBundle(
  relativeEntryDir: string,
  context: TrustedRootContext,
): Promise<{ bundle: TrashBundle; manifestSnapshot: ManagedPathSnapshot; manifestHash: string }> {
  const manifestRelativePath = path.join(relativeEntryDir, "manifest.json");
  const manifestSnapshot = await captureManagedPath(context, manifestRelativePath, {
    expectedKind: "file",
    allowMissing: false,
  });
  try {
    const bytes = new Uint8Array(await readManagedFile(context, manifestSnapshot.relativePath));
    await revalidateManagedPath(context, manifestSnapshot);
    const bundle = JSON.parse(Buffer.from(bytes).toString("utf8")) as TrashBundle;
    bundle.sqlite = {
      state: decodeSqliteRecordBundleFromJson(bundle.sqlite.state),
      dedicatedLogs: decodeSqliteRecordsFromJson(bundle.sqlite.dedicatedLogs),
    };
    return {
      bundle,
      manifestSnapshot,
      manifestHash: contentHash(bytes),
    };
  } catch (error) {
    throw new Error(`回收站 manifest 无法读取或解析：${manifestSnapshot.absolutePath}: ${formatError(error)}`);
  }
}

async function assertManagedSnapshotContentHash(
  context: TrustedRootContext,
  snapshot: ManagedPathSnapshot,
  expectedHash: string,
  label: string,
): Promise<void> {
  await revalidateManagedPath(context, snapshot);
  const currentBytes = new Uint8Array(await readManagedFile(context, snapshot.relativePath));
  await revalidateManagedPath(context, snapshot);
  if (contentHash(currentBytes) !== expectedHash) {
    throw new MutationSafetyError("STALE_PLAN", `${label} content changed after planning: ${snapshot.relativePath}`);
  }
}

function validateTrashBundle(bundle: TrashBundle): void {
  if (!bundle || typeof bundle !== "object") {
    throw new Error("回收站 manifest 格式无效。");
  }

  if (!bundle.manifest || typeof bundle.manifest !== "object") {
    throw new Error("回收站 manifest 缺少 manifest。");
  }
  if (
    typeof bundle.manifest.trashId !== "string"
    || !bundle.manifest.trashId
    || typeof bundle.manifest.createdAt !== "string"
    || typeof bundle.manifest.rootPath !== "string"
    || !bundle.manifest.rootPath
    || typeof bundle.manifest.toolVersion !== "string"
  ) {
    throw new Error("回收站 manifest 缺少有效的 trashId、createdAt、rootPath 或 toolVersion。");
  }

  assertArray(bundle.manifest.sessionIds, "manifest.sessionIds");
  assertArray(bundle.manifest.sessions, "manifest.sessions");
  assertArray(bundle.manifest.preview?.items, "manifest.preview.items");
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
  if (bundle.manifest.sessionIds.length === 0) {
    throw new Error("回收站 manifest 至少需要一个 session ID。");
  }
  assertCanonicalSessionIds(bundle.manifest.sessionIds);
  if (new Set(bundle.manifest.sessionIds).size !== bundle.manifest.sessionIds.length) {
    throw new Error("回收站 manifest 包含重复 session ID。");
  }
  const sessionIds = new Set(bundle.manifest.sessionIds);
  const manifestSessions = new Map<string, TrashBundle["manifest"]["sessions"][number]>();

  for (const session of bundle.manifest.sessions) {
    assertCanonicalSessionIds([session.sessionId]);
    if (!sessionIds.has(session.sessionId)) {
      throw new Error(`回收站 manifest 中 session 不一致：${session.sessionId}`);
    }
    if (manifestSessions.has(session.sessionId)) {
      throw new Error(`回收站 manifest 包含重复 session 元数据：${session.sessionId}`);
    }
    assertArray(session.originalRelativePaths, `manifest.sessions.originalRelativePaths:${session.sessionId}`);
    assertArray(session.shellSnapshotRelativePaths, `manifest.sessions.shellSnapshotRelativePaths:${session.sessionId}`);
    manifestSessions.set(session.sessionId, session);
  }
  if (manifestSessions.size !== sessionIds.size) {
    throw new Error("回收站 manifest 的 sessionIds 与 sessions 元数据不完整对应。");
  }

  for (const file of bundle.sessionFiles) {
    if (
      typeof file?.text !== "string"
      || (file.encoding !== undefined && file.encoding !== "utf8" && file.encoding !== "base64")
    ) {
      throw new Error(`回收站 manifest session 文件内容或 encoding 无效：${String(file?.path)}`);
    }
    const canonicalPath = assertSafeTrashRelativePath(file.path, `sessionFiles:${file.sessionId}`);
    assertCanonicalSessionIds([file.sessionId]);
    const session = manifestSessions.get(file.sessionId);
    if (!session || !session.originalRelativePaths.includes(file.path)) {
      throw new Error(`回收站 manifest 包含未声明或跨 session 的 session 文件：${file.sessionId}:${file.path}`);
    }
    const topLevel = canonicalPath.split(path.sep)[0];
    if (topLevel !== "sessions" && topLevel !== "archived_sessions") {
      throw new Error(`回收站 manifest session 文件不在白名单目录：${file.path}`);
    }
  }

  for (const file of bundle.shellSnapshots) {
    if (typeof file?.text !== "string") {
      throw new Error(`回收站 manifest shell snapshot 内容无效：${String(file?.path)}`);
    }
    const canonicalPath = assertSafeTrashRelativePath(file.path, `shellSnapshots:${file.sessionId}`);
    assertCanonicalSessionIds([file.sessionId]);
    const session = manifestSessions.get(file.sessionId);
    if (!session || !session.shellSnapshotRelativePaths.includes(file.path)) {
      throw new Error(`回收站 manifest 包含未声明或跨 session 的 shell snapshot：${file.sessionId}:${file.path}`);
    }
    if (canonicalPath.split(path.sep)[0] !== "shell_snapshots") {
      throw new Error(`回收站 manifest shell snapshot 不在白名单目录：${file.path}`);
    }
  }

  const sessionFilePaths = new Set(bundle.sessionFiles.map((file) => `${file.sessionId}:${file.path}`));
  const shellSnapshotPaths = new Set(bundle.shellSnapshots.map((file) => `${file.sessionId}:${file.path}`));
  if (sessionFilePaths.size !== bundle.sessionFiles.length || shellSnapshotPaths.size !== bundle.shellSnapshots.length) {
    throw new Error("回收站 manifest 包含重复 restore 文件路径。");
  }
  for (const session of bundle.manifest.sessions) {
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

  assertExactKeyRefsCoveredByBundle(bundle);

  const assertOwned = (sessionId: unknown, label: string): void => {
    if (typeof sessionId !== "string" || !sessionIds.has(sessionId)) {
      throw new Error(`回收站 manifest ${label} 指向未声明 session：${String(sessionId)}`);
    }
  };
  for (const record of bundle.sessionIndexRecords) {
    assertOwned(record?.id, "sessionIndexRecords.id");
  }
  for (const record of bundle.historyRecords) {
    assertOwned(record?.session_id, "historyRecords.session_id");
  }
  for (const ref of bundle.globalStateRefs) {
    if (!ref || typeof ref !== "object") {
      throw new Error("回收站 manifest globalStateRefs 项必须是对象。");
    }
    assertOwned(ref?.sessionId, "globalStateRefs.sessionId");
    if (typeof ref.path !== "string" || !ref.path || ref.path.includes("\0")) {
      throw new Error(`回收站 manifest globalStateRefs.path 无效：${String(ref.path)}`);
    }
    if (!["array-value", "object-key", "object-string-value"].includes(ref.kind)) {
      throw new Error(`回收站 manifest globalStateRefs.kind 无效：${String(ref.kind)}`);
    }
    if (ref.safetyClass !== "known" && ref.safetyClass !== "promoted-exact-key") {
      throw new Error(`回收站 manifest globalStateRefs.safetyClass 无效：${String(ref.safetyClass)}`);
    }
    if (ref.safetyClass === "promoted-exact-key") {
      const container = ref.ruleId === "electronPromptHistoryByThreadId"
        ? "prompt-history"
        : ref.ruleId === "heartbeatThreadPermissionsById"
          ? "heartbeat-thread-permissions-by-id"
          : null;
      const expectedPath = container
        ? `$.electron-persisted-atom-state.${container}.${ref.sessionId}`
        : null;
      if (
        !expectedPath
        || ref.path !== expectedPath
        || ref.kind !== "object-key"
        || typeof ref.valueShape !== "string"
        || !Number.isSafeInteger(ref.byteEstimate)
        || Number(ref.byteEstimate) < 0
        || typeof ref.reason !== "string"
        || !ref.reason
      ) {
        throw new Error(`回收站 manifest promoted exact-key globalStateRef schema 无效：${ref.path}`);
      }
    } else {
      const pinnedPath = /^\$\.pinned-thread-ids\[\d+\]$/u.test(ref.path)
        && ref.kind === "array-value"
        && ref.value === ref.sessionId;
      const objectKeyPath = (
        ref.path === `$.queued-follow-ups.${ref.sessionId}`
        || ref.path === `$.diffViewThreadSettings.${ref.sessionId}`
      ) && ref.kind === "object-key";
      if (!pinnedPath && !objectKeyPath) {
        throw new Error(`回收站 manifest known globalStateRef 路径或类型无效：${ref.path}`);
      }
      if (
        ref.ruleId !== undefined
        || ref.valueShape !== undefined
        || ref.byteEstimate !== undefined
        || ref.reason !== undefined
      ) {
        throw new Error(`回收站 manifest known globalStateRef 含不允许的 exact-key 字段：${ref.path}`);
      }
    }
  }
  for (const row of bundle.sqlite.state.threads) assertOwned(row.id, "sqlite.state.threads.id");
  for (const row of [...bundle.sqlite.state.logs, ...bundle.sqlite.dedicatedLogs]) {
    assertOwned(row.thread_id, "sqlite.logs.thread_id");
  }
  for (const row of bundle.sqlite.state.threadSpawnEdges) {
    if (!sessionIds.has(String(row.parent_thread_id)) && !sessionIds.has(String(row.child_thread_id))) {
      throw new Error("回收站 manifest sqlite.threadSpawnEdges 未关联任何声明 session。");
    }
  }
  for (const row of bundle.sqlite.state.agentJobItems) {
    assertOwned(row.assigned_thread_id, "sqlite.state.agentJobItems.assigned_thread_id");
  }
  for (const row of bundle.sqlite.state.threadDynamicTools) {
    assertOwned(row.thread_id, "sqlite.state.threadDynamicTools.thread_id");
  }
  for (const row of bundle.sqlite.state.stage1Outputs) {
    assertOwned(row.thread_id, "sqlite.state.stage1Outputs.thread_id");
  }
  for (const row of bundle.sqlite.state.threadGoals) {
    assertOwned(row.thread_id, "sqlite.state.threadGoals.thread_id");
  }

}

function isPromotedExactKeyRef(ref: GlobalStateReference): boolean {
  return Boolean(ref.ruleId && ref.safetyClass === "promoted-exact-key");
}

function assertExactKeyRefsCoveredByBundle(bundle: TrashBundle): void {
  const sessionIds = new Set(bundle.manifest.sessionIds);
  const expectedKeys = new Set<string>();
  const refsByKey = new Set(
    bundle.globalStateRefs
      .filter(isPromotedExactKeyRef)
      .map((ref) => `${ref.sessionId}\0${ref.path}\0${ref.ruleId}`),
  );

  for (const item of bundle.manifest.preview.items) {
    const details = item.exactKeyGlobalStateRefsDetail ?? [];
    if (item.exactKeyGlobalStateRefs !== details.length) {
      throw new Error(`回收站 manifest 缺少 exact-key preview 明细：${item.sessionId}`);
    }

    for (const detail of details) {
      const key = `${detail.sessionId}\0${detail.path}\0${detail.ruleId}`;
      expectedKeys.add(key);
      if (!refsByKey.has(key)) {
        throw new Error(`回收站 manifest 缺少 exact-key global-state 数据：${detail.path}`);
      }
    }
  }

  const seenRefs = new Set<string>();
  for (const ref of bundle.globalStateRefs.filter(isPromotedExactKeyRef)) {
    const key = `${ref.sessionId}\0${ref.path}\0${ref.ruleId}`;
    if (!sessionIds.has(ref.sessionId) || !expectedKeys.has(key)) {
      throw new Error(`回收站 manifest 包含未预览的 exact-key global-state 数据：${ref.path}`);
    }

    if (seenRefs.has(key)) {
      throw new Error(`回收站 manifest 包含重复 exact-key global-state 数据：${ref.path}`);
    }
    seenRefs.add(key);
  }
}

function summarizeBundle(bundle: TrashBundle): TrashEntrySummary {
  return {
    trashId: bundle.manifest.trashId,
    createdAt: bundle.manifest.createdAt,
    rootPath: bundle.manifest.rootPath,
    sessionIds: bundle.manifest.sessionIds,
    sessions: bundle.manifest.sessions,
    status: "valid",
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

function sqliteRestorePayload(bundle: TrashBundle): TrashBundle["sqlite"] {
  return {
    state: {
      ...bundle.sqlite.state,
      logs: [],
    },
    dedicatedLogs: [],
  };
}

export function trashEntryMatches(entry: Pick<TrashEntrySummary, "trashId" | "sessionIds">, idOrSessionId: string): boolean {
  return (
    entry.trashId === idOrSessionId ||
    entry.trashId.startsWith(idOrSessionId) ||
    entry.sessionIds.includes(idOrSessionId) ||
    entry.sessionIds.some((sessionId) => sessionId.startsWith(idOrSessionId))
  );
}

export function summarizeTrashDuplicateSessions(entries: TrashEntrySummary[]): TrashDuplicateSessionSummary[] {
  const trashIdsBySessionId = new Map<string, string[]>();

  for (const entry of entries) {
    for (const sessionId of entry.sessionIds) {
      const trashIds = trashIdsBySessionId.get(sessionId) ?? [];
      trashIds.push(entry.trashId);
      trashIdsBySessionId.set(sessionId, trashIds);
    }
  }

  return [...trashIdsBySessionId.entries()]
    .filter(([, trashIds]) => trashIds.length > 1)
    .map(([sessionId, trashIds]) => ({
      sessionId,
      count: trashIds.length,
      trashIds,
    }));
}

function formatAmbiguousTrashEntryError(idOrSessionId: string, matches: TrashEntrySummary[]): string {
  const details = matches.map((entry) => `${entry.trashId} (${entry.sessionIds.join(", ")})`).join("; ");
  return `回收站记录不唯一：${idOrSessionId}。匹配 ${matches.length} 条：${details}。restore / purge 写操作必须使用精确 trashId。`;
}

interface TrashEntryRecord {
  relativeDir: string;
  dir: string;
  summary: TrashEntrySummary;
  bundle: TrashBundle | null;
  entrySnapshot: ManagedPathSnapshot | null;
  manifestSnapshot: ManagedPathSnapshot | null;
  manifestHash: string | null;
}

async function readTrashEntries(rootPath: string): Promise<TrashEntryRecord[]> {
  const context = await getTrustedRoot(rootPath);
  const trashSnapshot = await captureManagedPath(context, TRASH_DIR_NAME, {
    expectedKind: "directory",
    allowMissing: true,
  });
  if (!trashSnapshot.exists) return [];
  const entries = await readdir(trashSnapshot.absolutePath, { withFileTypes: true });
  await revalidateManagedPath(context, trashSnapshot);
  const records: TrashEntryRecord[] = [];

  for (const entry of entries) {
    if (
      entry.name.startsWith(".tmp-")
      || entry.name === ".operations"
      || entry.name === ".operation.lock"
    ) {
      continue;
    }

    const relativeDir = trashRelativePath(entry.name);
    try {
      const entrySnapshot = await captureManagedPath(context, relativeDir, {
        expectedKind: "directory",
        allowMissing: false,
      });
      const { bundle, manifestSnapshot, manifestHash } = await readTrashBundle(relativeDir, context);
      validateTrashBundle(bundle);
      if (bundle.manifest.trashId !== entry.name) {
        throw new Error(`回收站 manifest trashId 与目录不一致：${bundle.manifest.trashId} != ${entry.name}`);
      }
      await revalidateManagedPath(context, manifestSnapshot);
      await revalidateManagedPath(context, entrySnapshot);
      records.push({
        relativeDir,
        dir: entrySnapshot.absolutePath,
        summary: summarizeBundle(bundle),
        bundle,
        entrySnapshot,
        manifestSnapshot,
        manifestHash,
      });
    } catch (error) {
      records.push({
        relativeDir,
        dir: reconstructManagedPath(context, relativeDir).absolutePath,
        summary: {
          trashId: entry.name,
          createdAt: "",
          rootPath: context.lexicalPath,
          sessionIds: [],
          sessions: [],
          status: "invalid",
          invalidReason: formatError(error),
        },
        bundle: null,
        entrySnapshot: null,
        manifestSnapshot: null,
        manifestHash: null,
      });
    }
  }

  await revalidateManagedPath(context, trashSnapshot);
  return records.sort((left, right) => {
    const leftKey = left.summary.createdAt || left.summary.trashId;
    const rightKey = right.summary.createdAt || right.summary.trashId;
    return rightKey.localeCompare(leftKey);
  });
}

function resolveTrashEntry(
  entries: TrashEntryRecord[],
  idOrSessionId: string,
): TrashEntryRecord & {
  bundle: TrashBundle;
  entrySnapshot: ManagedPathSnapshot;
  manifestSnapshot: ManagedPathSnapshot;
  manifestHash: string;
} {
  const exact = entries.find((entry) => entry.summary.trashId === idOrSessionId);
  if (exact?.summary.status === "invalid") {
    throw new Error(`回收站记录无效，拒绝 restore / purge：${idOrSessionId}: ${exact.summary.invalidReason ?? "unknown manifest error"}`);
  }
  if (exact?.bundle && exact.entrySnapshot && exact.manifestSnapshot && exact.manifestHash) {
    return exact as TrashEntryRecord & {
      bundle: TrashBundle;
      entrySnapshot: ManagedPathSnapshot;
      manifestSnapshot: ManagedPathSnapshot;
      manifestHash: string;
    };
  }

  const matches = entries.filter(
    (entry) => entry.summary.status === "valid" && trashEntryMatches(entry.summary, idOrSessionId),
  );

  if (matches.length === 0) {
    throw new Error(`找不到回收站记录：${idOrSessionId}`);
  }

  if (matches.length > 1) {
    throw new Error(formatAmbiguousTrashEntryError(idOrSessionId, matches.map((entry) => entry.summary)));
  }

  throw new MutationSafetyError("MALFORMED_ID", `restore / purge 写操作必须使用精确 trashId：${matches[0].summary.trashId}`);
}

async function resolveTrashEntryForRestore(
  rootPath: string,
  idOrSessionId: string,
): Promise<ReturnType<typeof resolveTrashEntry>> {
  return resolveTrashEntry(await readTrashEntries(rootPath), idOrSessionId);
}

function decodeStoredText(text: string, encoding?: "utf8" | "base64"): string | Buffer {
  return encoding === "base64" ? Buffer.from(text, "base64") : text;
}

async function writeStoredFileIfMissing(
  context: TrustedRootContext,
  snapshot: FileSnapshot,
  relativePath: string,
  text: string,
  encoding?: "utf8" | "base64",
): Promise<boolean> {
  assertSafeTrashRelativePath(relativePath, "restore.path");
  if (snapshot.relativePath !== reconstructManagedPath(context, relativePath).relativePath) {
    throw new MutationSafetyError("STALE_PLAN", `restore target changed after snapshot: ${relativePath}`);
  }
  await assertOriginalSnapshotCurrent(context, snapshot);
  if (snapshot.existed) {
    return false;
  }

  const contents = decodeStoredText(text, encoding);
  await atomicWriteManagedFileIfUnchanged(context, snapshot.relativePath, null, contents, 0o600);
  snapshot.writeAttempted = true;
  await markSnapshotWritten(context, snapshot);
  return true;
}

async function appendJsonlRecords<T>(
  context: TrustedRootContext,
  snapshot: FileSnapshot,
  records: T[],
  getSessionId: (record: T) => string | null,
): Promise<number> {
  if (records.length === 0) {
    return 0;
  }

  await assertOriginalSnapshotCurrent(context, snapshot);
  const existingText = snapshot.existed
    ? Buffer.from(snapshot.bytes ?? new Uint8Array()).toString("utf8")
    : "";

  const built = buildAppendedJsonl(existingText, records, getSessionId);
  if (built.addedCount === 0) {
    return 0;
  }

  await atomicWriteManagedTextIfUnchanged(
    context,
    snapshot.relativePath,
    snapshot.existed ? existingText : null,
    built.nextText,
    0o600,
  );
  snapshot.writeAttempted = true;
  await markSnapshotWritten(context, snapshot);
  return built.addedCount;
}

function buildAppendedJsonl<T>(
  existingText: string,
  records: T[],
  getSessionId: (record: T) => string | null,
): { nextText: string; addedCount: number } {

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

  return {
    nextText: buildJsonl([...existingLines, ...nextLines]),
    addedCount: nextLines.length,
  };
}

async function readTrashSessionFile(
  context: TrustedRootContext,
  target: SessionFileTarget,
): Promise<{
  sessionId: string;
  path: string;
  text: string;
  encoding: "utf8" | "base64";
}> {
  const bytes = await readScannedManagedFile(context, target);
  if (target.compressed) {
    return {
      sessionId: target.id,
      path: target.relativePath,
      text: Buffer.from(bytes).toString("base64"),
      encoding: "base64",
    };
  }

  return {
    sessionId: target.id,
    path: target.relativePath,
    text: Buffer.from(bytes).toString("utf8"),
    encoding: "utf8",
  };
}

async function readScannedManagedFile(
  context: TrustedRootContext,
  target: Pick<SessionFileTarget, "relativePath" | "size" | "lastModified" | "device" | "inode">,
): Promise<Uint8Array> {
  const snapshot = await captureManagedPath(context, target.relativePath, {
    expectedKind: "file",
    allowMissing: false,
  });
  const before = await lstat(snapshot.absolutePath);
  if (
    before.size !== target.size
    || (target.lastModified !== null && before.mtimeMs !== target.lastModified)
    || (target.device !== undefined && before.dev !== target.device)
    || (target.inode !== undefined && before.ino !== target.inode)
  ) {
    throw new MutationSafetyError("STALE_PLAN", `managed file changed after scan: ${target.relativePath}`);
  }
  const bytes = new Uint8Array(await readManagedFile(context, snapshot.relativePath));
  const after = await lstat(snapshot.absolutePath);
  await revalidateManagedPath(context, snapshot);
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    throw new MutationSafetyError("STALE_PLAN", `managed file changed while being read: ${target.relativePath}`);
  }
  return bytes;
}

async function buildTrashBundle(scan: ScanResult, sessions: SessionEntry[], trashId: string): Promise<TrashBundle> {
  const trustedRoot = requireMutationTrustedRoots(scan).root;
  const preview = buildDeletePreview(scan, sessions);
  const sessionIds = sessions.map((session) => session.id);
  const sqliteSnapshots = await captureRestoreSqlitePaths(scan);
  for (const entry of sqliteSnapshots) {
    await revalidateManagedPath(entry.context, entry.snapshot);
  }
  const sqlite = sessions.map((session) =>
    exportSqliteRecordsForRestore(scan.root.sqlitePath, session.id, null, scan.root.goalsSqlitePath),
  );
  for (const entry of sqliteSnapshots) {
    await revalidateManagedPath(entry.context, entry.snapshot);
  }

  return dedupeTrashBundle({
    manifest: {
      trashId,
      createdAt: new Date().toISOString(),
      rootPath: trustedRoot.realPath,
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
          session.fileTargets.map((target) => readTrashSessionFile(trustedRoot, target)),
        ),
      )
    ).flat(),
    shellSnapshots: (
      await Promise.all(
        sessions.flatMap((session) =>
          (scan.shellSnapshots.filesById.get(session.id) ?? []).map(async (target) => {
            const text = Buffer.from(await readScannedManagedFile(trustedRoot, target)).toString("utf8");
            return {
              sessionId: session.id,
              path: target.relativePath,
              text,
            };
          }),
        ),
      )
    ).flat(),
    sessionIndexRecords: sessions.flatMap((session) => scan.sessionIndex.matchingRecordsById.get(session.id) ?? []),
    historyRecords: sessions.flatMap((session) => scan.history.matchingRecordsById.get(session.id) ?? []),
    globalStateRefs: sessions.flatMap((session) => [
      ...(scan.globalState.refsById.get(session.id) ?? []),
      ...(scan.globalState.exactKeyRefsById.get(session.id) ?? []),
    ]),
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

async function assertNoRestoreConflicts(
  scan: ScanResult,
  bundle: TrashBundle,
  trustedRoot: TrustedRootContext,
): Promise<void> {
  const conflictsBySession = new Map<string, Set<string>>();
  const exactKeyRefs = bundle.globalStateRefs.filter(isPromotedExactKeyRef);

  for (const file of bundle.sessionFiles) {
    const snapshot = await captureManagedPath(trustedRoot, file.path, {
      expectedKind: "file",
      allowMissing: true,
    });
    if (snapshot.exists) {
      addConflict(conflictsBySession, file.sessionId, "session JSONL");
    }
  }

  for (const file of bundle.shellSnapshots) {
    const snapshot = await captureManagedPath(trustedRoot, file.path, {
      expectedKind: "file",
      allowMissing: true,
    });
    if (snapshot.exists) {
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

    if ((scan.globalState.exactKeyRefsById.get(sessionId)?.length ?? 0) > 0) {
      addConflict(conflictsBySession, sessionId, "global state exact-key");
    }
  }

  if (scan.globalState.warning && bundle.globalStateRefs.length > 0) {
    for (const sessionId of bundle.manifest.sessionIds) {
      addConflict(conflictsBySession, sessionId, "global state unreadable");
    }
  }

  if (!scan.globalState.warning && scan.globalState.text && exactKeyRefs.length > 0) {
    for (const ref of findExistingExactKeyGlobalStatePaths(scan.globalState.text, exactKeyRefs)) {
      addConflict(conflictsBySession, ref.sessionId, "global state exact-key");
    }
  }

  assertNoSqliteRestoreKeyConflicts(
    scan.root.sqlitePath,
    null,
    scan.root.goalsSqlitePath,
    sqliteRestorePayload(bundle),
  );

  const sqliteCounts = collectSqliteDeletionCounts(
    scan.root.sqlitePath,
    bundle.manifest.sessionIds,
    null,
    scan.root.goalsSqlitePath,
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

async function captureRestoreSnapshots(
  scan: ScanResult,
  bundle: TrashBundle,
  trustedRoot: TrustedRootContext,
): Promise<FileSnapshot[]> {
  const relativePaths = new Set<string>();

  for (const file of [...bundle.sessionFiles, ...bundle.shellSnapshots]) {
    relativePaths.add(reconstructManagedPath(trustedRoot, file.path).relativePath);
  }

  relativePaths.add(
    scan.root.sessionIndexPath
      ? toManagedRelativePath(trustedRoot, scan.root.sessionIndexPath)
      : "session_index.jsonl",
  );
  relativePaths.add(
    scan.root.historyPath
      ? toManagedRelativePath(trustedRoot, scan.root.historyPath)
      : "history.jsonl",
  );
  relativePaths.add(
    scan.root.globalStatePath
      ? toManagedRelativePath(trustedRoot, scan.root.globalStatePath)
      : ".codex-global-state.json",
  );

  return Promise.all(
    [...relativePaths].map((relativePath) => captureFileSnapshot(trustedRoot, relativePath)),
  );
}

async function captureRestoreSqlitePaths(scan: ScanResult): Promise<Array<{
  context: TrustedRootContext;
  snapshot: ManagedPathSnapshot;
}>> {
  const paths = [scan.root.sqlitePath, scan.root.goalsSqlitePath]
    .filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
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

export async function moveSessionsToTrash(
  scan: ScanResult,
  sessions: SessionEntry[],
  options: { allowActive?: boolean } = {},
): Promise<TrashDeleteResult> {
  const sessionIds = sessions.map((session) => session.id);
  assertConfirmedSessionSelection(sessionIds, sessions, { allowActive: options.allowActive });
  assertCanonicalSessionIds(sessionIds);
  const trustedRoot = requireMutationTrustedRoots(scan).root;
  await assertTrashRootSafe(trustedRoot, true);
  await secureTrashDirectories(trustedRoot);
  const trashId = createTrashId();
  const trashRelative = trashRelativePath(trashId);
  const tempTrashRelative = trashRelativePath(`.tmp-${trashId}`);
  let trashEntryCommitted = false;
  let bundle: TrashBundle | null = null;
  let lock: MutationLock | null = null;

  let deletion;
  try {
    lock = await acquireMutationLock(
      trustedRoot,
      "trash",
      sessionIds,
      requireMutationTrustedRoots(scan).sqliteHome,
    );
    const recoveryTrash: NonNullable<OperationRecoveryPayloadV1["trash"]> = {
      entryRelativePath: trashRelative,
      temporaryRelativePath: tempTrashRelative,
    };
    await lock.writeRecoveryPayload({
      schemaVersion: "codex-sessions-recovery.v1",
      operationId: lock.operationId,
      kind: "trash",
      strategy: "rollback",
      rootRealPath: trustedRoot.realPath,
      targetIds: sessionIds,
      files: [],
      trash: recoveryTrash,
    } satisfies OperationRecoveryPayloadV1);
    await secureTrashDirectories(trustedRoot);
    await lock.setStage("prepared", { trashId });
    await ensureManagedDirectory(trustedRoot, tempTrashRelative);
    await enforceManagedMode(trustedRoot, tempTrashRelative, 0o700);

    bundle = await buildTrashBundle(scan, sessions, trashId);
    validateTrashBundle(bundle);
    const storedBundle: TrashBundle = {
      ...bundle,
      sqlite: {
        state: encodeSqliteRecordBundleForJson(bundle.sqlite.state),
        dedicatedLogs: encodeSqliteRecordsForJson(bundle.sqlite.dedicatedLogs),
      },
    };
    const manifestText = `${JSON.stringify(storedBundle, null, 2)}\n`;
    await atomicWriteManagedText(
      trustedRoot,
      path.join(tempTrashRelative, "manifest.json"),
      manifestText,
    );
    await ensureManagedDirectory(trustedRoot, path.join(tempTrashRelative, "sessions"));
    await enforceManagedMode(trustedRoot, path.join(tempTrashRelative, "sessions"), 0o700);
    for (const session of bundle.manifest.sessions) {
      const metadataName = `${crypto.createHash("sha256").update(session.sessionId).digest("hex")}.json`;
      await atomicWriteManagedText(
        trustedRoot,
        path.join(tempTrashRelative, "sessions", metadataName),
        `${JSON.stringify(session, null, 2)}\n`,
      );
    }

    recoveryTrash.manifestSha256 = contentHash(manifestText);
    await lock.writeRecoveryPayload({
      schemaVersion: "codex-sessions-recovery.v1",
      operationId: lock.operationId,
      kind: "trash",
      strategy: "rollback",
      rootRealPath: trustedRoot.realPath,
      targetIds: sessionIds,
      files: [],
      trash: recoveryTrash,
    } satisfies OperationRecoveryPayloadV1);

    await renameManagedPath(trustedRoot, tempTrashRelative, trashRelative);
    trashEntryCommitted = true;
    await lock.setStage("committing", { trashId, trashEntryCommitted: true });
    await lock.checkpoint("trash-entry", "committed", { trashId });
    deletion = await deleteSessions(scan, sessions, {
      lock,
      allowActive: options.allowActive,
      recoveryKind: "trash",
      recoveryTrash,
    });
    await lock.release("committed", {
      trashId,
      verificationStatus: deletion.verificationStatus,
    });
  } catch (error) {
    if (trashEntryCommitted) {
      const errorMessage = formatError(error);
      if (error instanceof DeleteSessionsError && (!error.liveDeleteStarted || error.liveDeleteRolledBack)) {
        try {
          await removeManagedPath(trustedRoot, trashRelative, { expectedKind: "directory", recursive: true });
          await lock?.release("rolled_back", { trashId, error: errorMessage });
        } catch (cleanupError) {
          await lock?.release("recovery_required", {
            trashId,
            error: errorMessage,
            cleanupError: formatError(cleanupError),
          }).catch(() => undefined);
          throw new MutationSafetyError(
            "RECOVERY_REQUIRED",
            `移入回收站失败：live 删除已回滚，但回收站记录清理失败：${trashId}。清理错误：${formatError(cleanupError)}。原始错误：${errorMessage}`,
          );
        }

        throw new Error(`移入回收站失败：live 删除已回滚，回收站记录已清理：${trashId}。原始错误：${errorMessage}`);
      }

      await lock?.release("recovery_required", { trashId, error: errorMessage }).catch(() => undefined);
      throw new MutationSafetyError(
        "RECOVERY_REQUIRED",
        `移入回收站失败：live 删除失败，但回收站记录已保留：${trashId}。原始错误：${errorMessage}`,
      );
    }

    try {
      await removeManagedPath(trustedRoot, tempTrashRelative, {
        expectedKind: "directory",
        recursive: true,
        allowMissing: true,
      });
      await lock?.release("rolled_back", { trashId, error: formatError(error) });
    } catch (cleanupError) {
      await lock?.release("recovery_required", {
        trashId,
        error: formatError(error),
        cleanupError: formatError(cleanupError),
      }).catch(() => undefined);
      throw new MutationSafetyError(
        "RECOVERY_REQUIRED",
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
    operationStatus: deletion.operationStatus,
    verificationStatus: deletion.verificationStatus,
    verificationScope: { ...deletion.verificationScope, trashEntry: true },
    warnings: deletion.warnings,
    errorCode: deletion.errorCode,
  };
}

export async function listTrashEntries(rootPath: string): Promise<TrashEntrySummary[]> {
  return (await readTrashEntries(rootPath)).map((entry) => entry.summary);
}

export async function restoreTrashEntry(rootArg: string | undefined, idOrSessionId: string): Promise<TrashRestoreResult> {
  assertDestructivePlatformSupported();
  const scan = await scanCodexRoot(rootArg);
  const trustedRoot = requireMutationTrustedRoots(scan).root;
  const trashRoot = await captureManagedPath(trustedRoot, TRASH_DIR_NAME, {
    expectedKind: "directory",
    allowMissing: true,
  });
  if (!trashRoot.exists) {
    throw new Error(`找不到回收站记录：${idOrSessionId}`);
  }
  await secureTrashDirectories(trustedRoot);
  const entry = await resolveTrashEntryForRestore(scan.root.rootPath, idOrSessionId);
  const bundle = entry.bundle;
  const warnings: string[] = [];
  let restoredSessionFiles = 0;
  let restoredShellSnapshots = 0;
  let snapshots: FileSnapshot[] = [];
  let sqliteSnapshots: Awaited<ReturnType<typeof captureRestoreSqlitePaths>> = [];
  let restoredSessionIndexRecords = 0;
  let restoredHistoryRecords = 0;
  let restoredGlobalStateRefs = 0;
  let sqliteRestore: ReturnType<typeof restoreSqliteRecords> | null = null;
  let phase: "pre_commit" | "commit_in_progress" | "committed" = "pre_commit";
  let lock: MutationLock | null = null;

  validateTrashBundle(bundle);
  if (bundle.manifest.trashId !== idOrSessionId) {
    throw new MutationSafetyError("MALFORMED_ID", `restore 写操作必须使用精确 trashId：${bundle.manifest.trashId}`);
  }
  const manifestRoot = await createTrustedRootContext(bundle.manifest.rootPath).catch(() => null);
  if (!manifestRoot || manifestRoot.realPath !== trustedRoot.realPath) {
    throw new Error(`回收站记录来自不同 root：${bundle.manifest.rootPath}`);
  }

  try {
    lock = await acquireMutationLock(
      trustedRoot,
      "restore",
      bundle.manifest.sessionIds,
      requireMutationTrustedRoots(scan).sqliteHome,
    );
    await secureTrashDirectories(trustedRoot);
    await lock.setStage("prepared", { trashId: bundle.manifest.trashId });
    await revalidateManagedPath(trustedRoot, entry.entrySnapshot);
    await assertManagedSnapshotContentHash(
      trustedRoot,
      entry.manifestSnapshot,
      entry.manifestHash,
      "trash manifest",
    );
    await assertNoRestoreConflicts(scan, bundle, trustedRoot);
    snapshots = await captureRestoreSnapshots(scan, bundle, trustedRoot);
    sqliteSnapshots = await captureRestoreSqlitePaths(scan);
    for (const sqliteSnapshot of sqliteSnapshots) {
      await revalidateManagedPath(sqliteSnapshot.context, sqliteSnapshot.snapshot);
    }
    const snapshotByPath = new Map(snapshots.map((snapshot) => [snapshot.relativePath, snapshot]));
    const findSnapshot = (relativePath: string): FileSnapshot => {
      const normalized = reconstructManagedPath(trustedRoot, relativePath).relativePath;
      const snapshot = snapshotByPath.get(normalized);
      if (!snapshot) {
        throw new MutationSafetyError("RECOVERY_REQUIRED", `缺少 restore file snapshot：${normalized}`);
      }
      return snapshot;
    };

    const sessionIndexRelativePath = scan.root.sessionIndexPath
      ? toManagedRelativePath(trustedRoot, scan.root.sessionIndexPath)
      : "session_index.jsonl";
    const historyRelativePath = scan.root.historyPath
      ? toManagedRelativePath(trustedRoot, scan.root.historyPath)
      : "history.jsonl";
    const globalStatePath = scan.root.globalStatePath ?? path.join(scan.root.rootPath, ".codex-global-state.json");
    const globalStateRelativePath = toManagedRelativePath(trustedRoot, globalStatePath);
    const sessionIndexSnapshot = findSnapshot(sessionIndexRelativePath);
    const historySnapshot = findSnapshot(historyRelativePath);
    const globalStateSnapshot = findSnapshot(globalStateRelativePath);
    const sessionIndexBefore = sessionIndexSnapshot.existed
      ? Buffer.from(sessionIndexSnapshot.bytes ?? new Uint8Array()).toString("utf8")
      : "";
    const historyBefore = historySnapshot.existed
      ? Buffer.from(historySnapshot.bytes ?? new Uint8Array()).toString("utf8")
      : "";
    const globalStateBefore = globalStateSnapshot.existed
      ? Buffer.from(globalStateSnapshot.bytes ?? new Uint8Array()).toString("utf8")
      : null;
    const sessionIndexBuilt = buildAppendedJsonl(
      sessionIndexBefore,
      bundle.sessionIndexRecords,
      (record) => record.id ?? null,
    );
    const historyBuilt = buildAppendedJsonl(
      historyBefore,
      bundle.historyRecords,
      (record) => record.session_id ?? null,
    );
    const globalStateBuilt = buildGlobalStateRestoration(globalStateBefore, bundle.globalStateRefs);
    const sessionIndexAfter = sessionIndexBuilt.addedCount > 0 ? sessionIndexBuilt.nextText : sessionIndexSnapshot.bytes;
    const historyAfter = historyBuilt.addedCount > 0 ? historyBuilt.nextText : historySnapshot.bytes;
    const globalStateAfter = globalStateBuilt.restoredCount > 0 ? globalStateBuilt.nextText : globalStateSnapshot.bytes;
    const registered = requireMutationTrustedRoots(scan);
    const sqliteContext = registered.sqliteHome;
    if ((scan.root.sqlitePath || scan.root.goalsSqlitePath) && !sqliteContext) {
      throw new MutationSafetyError("UNSAFE_PATH", "destructive operation requires the registered SQLite trusted root");
    }
    await lock.writeRecoveryPayload({
      schemaVersion: "codex-sessions-recovery.v1",
      operationId: lock.operationId,
      kind: "restore",
      strategy: "rollforward",
      rootRealPath: trustedRoot.realPath,
      targetIds: bundle.manifest.sessionIds,
      files: [
        ...bundle.sessionFiles.map((file) => {
          const snapshot = findSnapshot(file.path);
          return createRecoveryFileTransition(
            snapshot.relativePath,
            snapshot.bytes,
            decodeStoredText(file.text, file.encoding),
          );
        }),
        ...bundle.shellSnapshots.map((file) => {
          const snapshot = findSnapshot(file.path);
          return createRecoveryFileTransition(snapshot.relativePath, snapshot.bytes, file.text);
        }),
        createRecoveryFileTransition(sessionIndexRelativePath, sessionIndexSnapshot.bytes, sessionIndexAfter),
        createRecoveryFileTransition(historyRelativePath, historySnapshot.bytes, historyAfter),
        createRecoveryFileTransition(globalStateRelativePath, globalStateSnapshot.bytes, globalStateAfter),
      ],
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
              records: sqliteRestorePayload(bundle).state as unknown as Record<string, unknown>,
            },
          }
        : {}),
    } satisfies OperationRecoveryPayloadV1);

    await lock.setStage("committing", { trashId: bundle.manifest.trashId });
    phase = "commit_in_progress";
    for (const file of bundle.sessionFiles) {
      await lock.checkpoint("session-file", "started", { relativePath: file.path });
      if (await writeStoredFileIfMissing(trustedRoot, findSnapshot(file.path), file.path, file.text, file.encoding)) {
        restoredSessionFiles += 1;
      }
      await lock.checkpoint("session-file", "committed", { relativePath: file.path });
    }

    for (const file of bundle.shellSnapshots) {
      await lock.checkpoint("shell-snapshot", "started", { relativePath: file.path });
      if (await writeStoredFileIfMissing(trustedRoot, findSnapshot(file.path), file.path, file.text)) {
        restoredShellSnapshots += 1;
      }
      await lock.checkpoint("shell-snapshot", "committed", { relativePath: file.path });
    }

    await lock.checkpoint("session-index", "started");
    restoredSessionIndexRecords = await appendJsonlRecords<SessionIndexRecord>(
      trustedRoot,
      findSnapshot(sessionIndexRelativePath),
      bundle.sessionIndexRecords,
      (record) => record.id ?? null,
    );
    await lock.checkpoint("session-index", "committed");
    await lock.checkpoint("history", "started");
    restoredHistoryRecords = await appendJsonlRecords<HistoryRecord>(
      trustedRoot,
      findSnapshot(historyRelativePath),
      bundle.historyRecords,
      (record) => record.session_id ?? null,
    );
    await lock.checkpoint("history", "committed");
    await lock.checkpoint("global-state", "started");
    await assertOriginalSnapshotCurrent(trustedRoot, globalStateSnapshot);
    restoredGlobalStateRefs = await restoreGlobalStateReferences(
      globalStatePath,
      bundle.globalStateRefs,
      { trustedRoot, relativePath: globalStateRelativePath },
    );
    if (restoredGlobalStateRefs > 0) {
      globalStateSnapshot.writeAttempted = true;
      await markSnapshotWritten(trustedRoot, globalStateSnapshot);
    }
    await lock.checkpoint("global-state", "committed", { changed: restoredGlobalStateRefs > 0 });
    for (const sqliteSnapshot of sqliteSnapshots) {
      await revalidateManagedPath(sqliteSnapshot.context, sqliteSnapshot.snapshot);
    }
    await lock.checkpoint("sqlite", "started");
    sqliteRestore = restoreSqliteRecords(
      scan.root.sqlitePath,
      null,
      scan.root.goalsSqlitePath,
      sqliteRestorePayload(bundle),
    );
    phase = "committed";
    await lock.checkpoint("sqlite", "committed");
    await lock.setStage("verifying", { trashId: bundle.manifest.trashId });
    for (const sqliteSnapshot of sqliteSnapshots) {
      await revalidateManagedPath(sqliteSnapshot.context, sqliteSnapshot.snapshot);
    }
    validateRestoredSqliteRecords(
      scan.root.sqlitePath,
      scan.root.goalsSqlitePath,
      sqliteRestorePayload(bundle).state,
      sqliteRestore.skippedTables,
    );
    if (sqliteRestore.skipped.total > 0) {
      warnings.push(`SQLite 有 ${sqliteRestore.skipped.total} 条记录未恢复，详见 skippedSqliteRows。`);
    }
    const retainedLogRows = bundle.sqlite.state.logs.length + bundle.sqlite.dedicatedLogs.length;
    if (retainedLogRows > 0) {
      warnings.push(`manifest 中 ${retainedLogRows} 条 logs 按只读保留策略未恢复。`);
    }
    for (const snapshot of snapshots) {
      if (snapshot.writeAttempted) {
        await assertOperationWriteCurrent(trustedRoot, snapshot);
      }
    }
    await assertManagedSnapshotContentHash(
      trustedRoot,
      entry.manifestSnapshot,
      entry.manifestHash,
      "trash manifest",
    );
    const verificationStatus = sqliteRestore.skipped.total > 0 ? "partial" : "passed";
    await lock.release("committed", {
      trashId: bundle.manifest.trashId,
      restoredSessionFiles,
      restoredShellSnapshots,
      restoredSqliteRows: sqliteRestore.restored.total,
      skippedSqliteRows: sqliteRestore.skipped,
      skippedSqliteTables: sqliteRestore.skippedTables,
      retainedLogRows,
      verificationStatus,
    });

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
      operationStatus: "committed",
      verificationStatus,
      verificationScope: {
        sessionFiles: true,
        shellSnapshots: true,
        sessionIndex: true,
        history: true,
        globalState: true,
        sqlite: true,
        trashEntry: true,
        operationJournal: true,
        retainedSurfaces: ["logs_N.sqlite", "memories SQLite", "MEMORY.md", "memory_summary.md", "remote-control"],
      },
      warnings,
      errorCode: null,
    };
  } catch (error) {
    if (phase === "pre_commit") {
      await lock?.release("rolled_back", {
        trashId: bundle.manifest.trashId,
        error: formatError(error),
      }).catch(() => undefined);
      throw error;
    }

    if (phase === "committed") {
      if (!sqliteRestore) {
        await lock?.release("recovery_required", {
          trashId: bundle.manifest.trashId,
          error: formatError(error),
          reason: "committed restore is missing its SQLite result",
        }).catch(() => undefined);
        throw new MutationSafetyError("RECOVERY_REQUIRED", "restore committed state cannot be described safely");
      }
      try {
        await lock?.release("committed", {
          trashId: bundle.manifest.trashId,
          verificationStatus: "failed",
          error: formatError(error),
        });
      } catch (releaseError) {
        await lock?.release("recovery_required", {
          trashId: bundle.manifest.trashId,
          error: formatError(error),
          releaseError: formatError(releaseError),
        }).catch(() => undefined);
        throw new MutationSafetyError(
          "RECOVERY_REQUIRED",
          `restore 已提交，但无法完成 journal：${formatError(releaseError)}`,
        );
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
        operationStatus: "committed",
        verificationStatus: "failed",
        verificationScope: {
          sessionFiles: true,
          shellSnapshots: true,
          sessionIndex: true,
          history: true,
          globalState: true,
          sqlite: true,
          trashEntry: true,
          operationJournal: true,
          retainedSurfaces: ["logs_N.sqlite", "memories SQLite", "MEMORY.md", "memory_summary.md", "remote-control"],
        },
        warnings: [...warnings, `恢复操作已完成，但提交后验证失败：${formatError(error)}`],
        errorCode: "POST_COMMIT_VERIFY_FAILED",
      };
    }

    const rollbackErrors: string[] = [];
    if (error && typeof error === "object" && "code" in error && error.code === "RECOVERY_REQUIRED") {
      rollbackErrors.push(`SQLite or journal: ${formatError(error)}`);
    }
    try {
      await rollbackFileSnapshots(trustedRoot, snapshots);
    } catch (rollbackError) {
      rollbackErrors.push(`files: ${formatError(rollbackError)}`);
    }

    if (rollbackErrors.length > 0) {
      await lock?.release("recovery_required", {
        trashId: bundle.manifest.trashId,
        error: formatError(error),
        rollbackErrors,
      }).catch(() => undefined);
      throw new MutationSafetyError(
        "RECOVERY_REQUIRED",
        `恢复失败，回滚也失败：${rollbackErrors.join("; ")}。原始错误：${formatError(error)}`,
      );
    }

    await lock?.release("rolled_back", {
      trashId: bundle.manifest.trashId,
      error: formatError(error),
    });
    throw new Error(`恢复失败，已回滚已写入内容：${formatError(error)}`);
  }
}

export async function purgeTrashEntry(rootArg: string | undefined, idOrSessionId: string): Promise<TrashPurgeResult> {
  assertDestructivePlatformSupported();
  const scan = await scanCodexRoot(rootArg);
  const trustedRoot = requireMutationTrustedRoots(scan).root;
  const trashRoot = await captureManagedPath(trustedRoot, TRASH_DIR_NAME, {
    expectedKind: "directory",
    allowMissing: true,
  });
  if (!trashRoot.exists) {
    throw new Error(`找不到回收站记录：${idOrSessionId}`);
  }
  await secureTrashDirectories(trustedRoot);
  const allTrashEntries = await readTrashEntries(scan.root.rootPath);
  const entry = resolveTrashEntry(allTrashEntries, idOrSessionId);
  if (entry.bundle.manifest.trashId !== idOrSessionId) {
    throw new MutationSafetyError("MALFORMED_ID", `purge 写操作必须使用精确 trashId：${entry.bundle.manifest.trashId}`);
  }
  const sqliteContext = requireMutationTrustedRoots(scan).sqliteHome;
  const sessionIdsInOtherTrashEntries = new Set(
    allTrashEntries
      .filter((candidate) => candidate.bundle && candidate.bundle.manifest.trashId !== entry.bundle.manifest.trashId)
      .flatMap((candidate) => candidate.bundle?.manifest.sessionIds ?? []),
  );
  const dedicatedLogTargetIds = entry.bundle.manifest.sessionIds.filter((sessionId) => {
    const live = scan.sessions.find((session) => session.id === sessionId);
    return !sessionIdsInOtherTrashEntries.has(sessionId) && (!live || (
      live.fileTargets.length === 0
      && !live.hasThread
      && !live.hasSessionIndex
      && !live.hasHistory
    ));
  });
  const dedicatedLogKeys = collectDedicatedLogKeys(scan.root.logsSqlitePath, dedicatedLogTargetIds);
  const logsSnapshot = scan.root.logsSqlitePath && sqliteContext
    ? await captureManagedPath(
        sqliteContext,
        toManagedRelativePath(sqliteContext, scan.root.logsSqlitePath),
        { expectedKind: "file", allowMissing: false },
      )
    : null;
  const lock = await acquireMutationLock(
    trustedRoot,
    "purge",
    entry.bundle.manifest.sessionIds,
    sqliteContext,
  );
  let phase: "pre_commit" | "commit_in_progress" | "committed" = "pre_commit";
  const quarantineRelativePath = trashRelativePath(".operations", `${lock.operationId}.purge`);
  const result = (
    verificationStatus: "passed" | "failed",
    warnings: string[],
  ): TrashPurgeResult => ({
    trashEntry: summarizeBundle(entry.bundle),
    purged: true,
    operationStatus: "committed",
    verificationStatus,
    verificationScope: {
      sessionFiles: false,
      shellSnapshots: false,
      sessionIndex: false,
      history: false,
      globalState: false,
      sqlite: Boolean(scan.root.logsSqlitePath),
      trashEntry: true,
      operationJournal: true,
      retainedSurfaces: [
        ...(dedicatedLogTargetIds.length < entry.bundle.manifest.sessionIds.length ? ["dedicated logs for restored live sessions"] : []),
        "memory",
      ],
    },
    warnings,
    errorCode: verificationStatus === "failed" ? "POST_COMMIT_VERIFY_FAILED" : null,
  });
  try {
    await secureTrashDirectories(trustedRoot);
    await lock.setStage("prepared", { trashId: entry.bundle.manifest.trashId });
    await revalidateManagedPath(trustedRoot, entry.entrySnapshot);
    await assertManagedSnapshotContentHash(
      trustedRoot,
      entry.manifestSnapshot,
      entry.manifestHash,
      "trash manifest",
    );
    await lock.writeRecoveryPayload({
      schemaVersion: "codex-sessions-recovery.v1",
      operationId: lock.operationId,
      kind: "purge",
      strategy: "rollforward",
      rootRealPath: trustedRoot.realPath,
      targetIds: entry.bundle.manifest.sessionIds,
      files: [],
      trash: {
        entryRelativePath: entry.relativeDir,
        quarantineRelativePath,
        manifestSha256: entry.manifestHash,
      },
      ...(sqliteContext
        ? {
            sqlite: {
              sqliteHomeRealPath: sqliteContext.realPath,
              sqliteHomeIdentity: { dev: sqliteContext.identity.dev, ino: sqliteContext.identity.ino },
              stateRelativePath: null,
              goalsRelativePath: null,
              logsRelativePath: scan.root.logsSqlitePath
                ? toManagedRelativePath(sqliteContext, scan.root.logsSqlitePath)
                : null,
              records: {
                threads: [], logs: [], threadSpawnEdges: [], agentJobItems: [],
                threadDynamicTools: [], stage1Outputs: [], threadGoals: [],
              },
              dedicatedLogRecords: [],
              dedicatedLogTargetIds,
              dedicatedLogKeys,
            },
          }
        : {}),
    } satisfies OperationRecoveryPayloadV1);
    if (scan.root.logsSqlitePath && logsSnapshot && sqliteContext) {
      await revalidateManagedPath(sqliteContext, logsSnapshot);
      const currentScan = await scanCodexRoot(rootArg);
      const becameLive = dedicatedLogTargetIds.filter((sessionId) => {
        const live = currentScan.sessions.find((session) => session.id === sessionId);
        return Boolean(live && (
          live.fileTargets.length > 0 || live.hasThread || live.hasSessionIndex || live.hasHistory
        ));
      });
      if (becameLive.length > 0) {
        throw new MutationSafetyError("STALE_PLAN", `purge targets became live after preview: ${becameLive.join(", ")}`);
      }
      const currentTrashEntries = await readTrashEntries(currentScan.root.rootPath);
      const appearedInOtherTrash = dedicatedLogTargetIds.filter((sessionId) =>
        currentTrashEntries.some((candidate) =>
          candidate.bundle
          && candidate.bundle.manifest.trashId !== entry.bundle.manifest.trashId
          && candidate.bundle.manifest.sessionIds.includes(sessionId)));
      if (appearedInOtherTrash.length > 0) {
        throw new MutationSafetyError(
          "STALE_PLAN",
          `purge targets gained another recoverable trash entry: ${appearedInOtherTrash.join(", ")}`,
        );
      }
    }
    await lock.setStage("committing", { trashId: entry.bundle.manifest.trashId });
    phase = "commit_in_progress";
    if (scan.root.logsSqlitePath && logsSnapshot && sqliteContext) {
      await lock.checkpoint("purge-logs", "started", { targetCount: dedicatedLogTargetIds.length });
      deleteDedicatedLogRows(scan.root.logsSqlitePath, dedicatedLogTargetIds, dedicatedLogKeys);
      await lock.checkpoint("purge-logs", "committed", { targetCount: dedicatedLogTargetIds.length });
    }
    await lock.checkpoint("purge-quarantine", "started", { trashId: entry.bundle.manifest.trashId });
    await renameManagedPath(trustedRoot, entry.relativeDir, quarantineRelativePath);
    await lock.checkpoint("purge-quarantine", "committed", { trashId: entry.bundle.manifest.trashId });
    await lock.checkpoint("purge-remove", "started", { quarantineRelativePath });
    await removeManagedPath(
      trustedRoot,
      quarantineRelativePath,
      { expectedKind: "directory", recursive: true, allowMissing: false },
    );
    await lock.checkpoint("purge-remove", "committed", { quarantineRelativePath });
    phase = "committed";
    await lock.setStage("verifying", { trashId: entry.bundle.manifest.trashId });
    const [entryAfter, quarantineAfter] = await Promise.all([
      captureManagedPath(trustedRoot, entry.relativeDir, { expectedKind: "directory", allowMissing: true }),
      captureManagedPath(trustedRoot, quarantineRelativePath, { expectedKind: "directory", allowMissing: true }),
    ]);
    if (entryAfter.exists || quarantineAfter.exists) {
      await lock.release("committed", {
        trashId: entry.bundle.manifest.trashId,
        verificationStatus: "failed",
      });
      return result(
        "failed",
        ["永久清除已经完成，但提交后验证发现回收站路径仍然存在；请检查 verificationScope。"],
      );
    }
    if (scan.root.logsSqlitePath) {
      const remaining = collectSqliteDeletionCounts(
        scan.root.sqlitePath,
        dedicatedLogTargetIds,
        scan.root.logsSqlitePath,
        scan.root.goalsSqlitePath,
      );
      if ([...remaining.values()].some((counts) => counts.logRows > 0)) {
        await lock.release("committed", {
          trashId: entry.bundle.manifest.trashId,
          verificationStatus: "failed",
        });
        return result("failed", ["永久清除已经完成，但关联日志仍然存在。"]);
      }
    }
    await lock.release("committed", {
      trashId: entry.bundle.manifest.trashId,
      verificationStatus: "passed",
    });
    return result("passed", []);
  } catch (error) {
    if (phase === "committed") {
      try {
        await lock.release("committed", {
          trashId: entry.bundle.manifest.trashId,
          verificationStatus: "failed",
          error: formatError(error),
        });
      } catch (releaseError) {
        await lock.release("recovery_required", {
          trashId: entry.bundle.manifest.trashId,
          error: formatError(error),
          releaseError: formatError(releaseError),
        }).catch(() => undefined);
        throw new MutationSafetyError("RECOVERY_REQUIRED", `purge 已提交，但无法完成 journal：${formatError(releaseError)}`);
      }
      return result(
        "failed",
        [`永久清除已经完成，但提交后验证失败：${formatError(error)}`],
      );
    }
    await lock.release(phase === "commit_in_progress" ? "recovery_required" : "rolled_back", {
      trashId: entry.bundle.manifest.trashId,
      error: formatError(error),
    }).catch(() => undefined);
    if (phase === "commit_in_progress") {
      throw new MutationSafetyError("RECOVERY_REQUIRED", `purge 可能部分完成：${formatError(error)}`);
    }
    throw error;
  }
}

export function resolveSessionsForTrash(scan: ScanResult, sessionIds: string[]): SessionEntry[] {
  return resolveSessions(scan, sessionIds);
}
