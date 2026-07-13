import crypto from "node:crypto";
import path from "node:path";
import { readdir } from "node:fs/promises";

import { assertDestructivePlatformSupported } from "./destructive-policy.js";
import {
  MutationSafetyError,
  finalizeInterruptedMutation,
  readInterruptedMutation,
  renameManagedPath,
  type InterruptedMutation,
  type MutationOperationKind,
} from "./mutation-safety.js";
import {
  captureManagedPath,
  createTrustedRootContext,
  getRegisteredTrustedRoots,
  readManagedFile,
  reconstructManagedPath,
  revalidateManagedPath,
  type TrustedRootContext,
} from "./path-safety.js";
import { atomicWriteManagedFile, removeManagedPath } from "./mutation-safety.js";
import type { MutationResultMetadata, VerificationScope, VerificationStatus } from "./types.js";
import {
  type DedicatedLogKey,
  MAX_DEDICATED_LOG_ENCODED_BYTES,
  MAX_DEDICATED_LOG_PURGE_KEYS,
  assertDedicatedLogKeyPayloadBounds,
  MAX_DEDICATED_LOG_RECOVERY_ROWS,
  deleteDedicatedLogRowsByKeys,
  classifyDedicatedLogKeyPresence,
  decodeSqliteRecordsFromJson,
  reconcileDedicatedLogRecordsForRecovery,
  reconcileSqliteRecordsForRecovery,
  type SqliteRecordBundle,
} from "./sqlite.js";
import { expandCodexPath } from "./root.js";
import { scanCodexRoot } from "./scan.js";

export type RecoveryOperationKind = MutationOperationKind;
const RECOVERY_OPERATION_KINDS = new Set<RecoveryOperationKind>([
  "delete",
  "trash",
  "restore",
  "purge",
  "cleanup-index",
  "cleanup-stale",
]);

export interface RecoveryFileState {
  exists: boolean;
  sha256: string | null;
  dataBase64: string | null;
}

export interface RecoveryFileTransition {
  relativePath: string;
  before: RecoveryFileState;
  after: RecoveryFileState;
}

export interface OperationRecoveryPayloadV1 {
  schemaVersion: "codex-sessions-recovery.v1";
  operationId: string;
  kind: RecoveryOperationKind;
  strategy: "rollback" | "rollforward";
  rootRealPath: string;
  targetIds: string[];
  files: RecoveryFileTransition[];
  sqlite?: {
    sqliteHomeRealPath: string;
    sqliteHomeIdentity: { dev: number; ino: number };
    stateRelativePath: string | null;
    goalsRelativePath: string | null;
    logsRelativePath?: string | null;
    records: Record<string, unknown>;
    dedicatedLogRecords?: Record<string, unknown>[];
    dedicatedLogTargetIds?: string[];
    dedicatedLogKeys?: DedicatedLogKey[];
  };
  trash?: {
    entryRelativePath?: string;
    temporaryRelativePath?: string;
    quarantineRelativePath?: string;
    manifestSha256?: string;
  };
}

export interface RecoveryStatus {
  pending: boolean;
  operationId: string | null;
  kind: string | null;
  stage: string | null;
  targetIds: string[];
  hasRecoveryPayload: boolean;
  checkpoints: InterruptedMutation["journal"]["checkpoints"];
  invalidReason: string | null;
}

export interface RecoveryExecutionResult extends MutationResultMetadata {
  operationId: string;
  kind: string;
  recoveredBy: "rollback" | "rollforward" | "finalize-committed" | "finalize-rolled-back";
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export function createRecoveryFileState(contents: string | Uint8Array | null): RecoveryFileState {
  if (contents === null) {
    return { exists: false, sha256: null, dataBase64: null };
  }
  const bytes = typeof contents === "string" ? Buffer.from(contents, "utf8") : Buffer.from(contents);
  return {
    exists: true,
    sha256: sha256(bytes),
    dataBase64: bytes.toString("base64"),
  };
}

export function createRecoveryFileTransition(
  relativePath: string,
  before: string | Uint8Array | null,
  after: string | Uint8Array | null,
): RecoveryFileTransition {
  return {
    relativePath,
    before: createRecoveryFileState(before),
    after: createRecoveryFileState(after),
  };
}

function assertFileState(value: unknown, label: string): asserts value is RecoveryFileState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", `${label} is not an object`);
  }
  const state = value as Partial<RecoveryFileState>;
  if (typeof state.exists !== "boolean") {
    throw new MutationSafetyError("RECOVERY_REQUIRED", `${label}.exists is invalid`);
  }
  if (state.exists) {
    if (!/^[0-9a-f]{64}$/u.test(state.sha256 ?? "") || typeof state.dataBase64 !== "string") {
      throw new MutationSafetyError("RECOVERY_REQUIRED", `${label} is missing its hash or recovery bytes`);
    }
    const bytes = Buffer.from(state.dataBase64, "base64");
    if (sha256(bytes) !== state.sha256) {
      throw new MutationSafetyError("RECOVERY_REQUIRED", `${label} recovery bytes do not match their hash`);
    }
  } else if (state.sha256 !== null || state.dataBase64 !== null) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", `${label} has bytes for a missing file`);
  }
}

export function parseOperationRecoveryPayload(
  value: unknown,
  interrupted: Pick<InterruptedMutation, "operationId" | "kind" | "targetIds">
    & Partial<Pick<InterruptedMutation, "journal">>,
): OperationRecoveryPayloadV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", "operation recovery payload is missing or invalid");
  }
  const payload = value as Partial<OperationRecoveryPayloadV1>;
  if (
    payload.schemaVersion !== "codex-sessions-recovery.v1"
    || payload.operationId !== interrupted.operationId
    || payload.kind !== interrupted.kind
    || !RECOVERY_OPERATION_KINDS.has(payload.kind as RecoveryOperationKind)
    || (payload.strategy !== "rollback" && payload.strategy !== "rollforward")
    || typeof payload.rootRealPath !== "string"
    || !Array.isArray(payload.targetIds)
    || JSON.stringify(payload.targetIds) !== JSON.stringify(interrupted.targetIds)
    || !Array.isArray(payload.files)
  ) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", "operation recovery payload does not match its lock");
  }
  const relativePaths = new Set<string>();
  for (const [index, transition] of payload.files.entries()) {
    if (!transition || typeof transition !== "object" || typeof transition.relativePath !== "string") {
      throw new MutationSafetyError("RECOVERY_REQUIRED", `recovery files[${index}] is invalid`);
    }
    assertFileState(transition.before, `recovery files[${index}].before`);
    assertFileState(transition.after, `recovery files[${index}].after`);
    if (relativePaths.has(transition.relativePath)) {
      throw new MutationSafetyError("RECOVERY_REQUIRED", `duplicate recovery file path: ${transition.relativePath}`);
    }
    relativePaths.add(transition.relativePath);
  }
  if (payload.sqlite) {
    if (
      !interrupted.journal
      || payload.sqlite.sqliteHomeRealPath !== interrupted.journal.sqliteHomeRealPath
      || JSON.stringify(payload.sqlite.sqliteHomeIdentity) !== JSON.stringify(interrupted.journal.sqliteHomeIdentity)
    ) {
      throw new MutationSafetyError(
        "RECOVERY_REQUIRED",
        "SQLite recovery root identity does not match the identity fixed in the operation lock and journal",
      );
    }
    if (
      payload.sqlite.dedicatedLogTargetIds !== undefined
      && (
        !Array.isArray(payload.sqlite.dedicatedLogTargetIds)
        || payload.sqlite.dedicatedLogTargetIds.some((id) => (
          typeof id !== "string" || !interrupted.targetIds.includes(id)
        ))
      )
    ) {
      throw new MutationSafetyError("RECOVERY_REQUIRED", "dedicated logs recovery targets exceed the locked target ids");
    }
    const dedicatedLogRecords = payload.sqlite.dedicatedLogRecords ?? [];
    const dedicatedLogKeys = payload.sqlite.dedicatedLogKeys ?? [];
    if (
      payload.sqlite.logsRelativePath
      && payload.strategy === "rollforward"
      && payload.sqlite.dedicatedLogKeys === undefined
    ) {
      throw new MutationSafetyError("RECOVERY_REQUIRED", "rollforward logs recovery is missing fixed row keys");
    }
    if (
      !Array.isArray(dedicatedLogRecords)
      || !Array.isArray(dedicatedLogKeys)
      || dedicatedLogRecords.length > MAX_DEDICATED_LOG_RECOVERY_ROWS
      || dedicatedLogKeys.length > MAX_DEDICATED_LOG_PURGE_KEYS
      || Buffer.byteLength(JSON.stringify(dedicatedLogRecords), "utf8") > MAX_DEDICATED_LOG_ENCODED_BYTES
    ) {
      throw new MutationSafetyError("RECOVERY_REQUIRED", "dedicated logs recovery payload exceeds safe bounds");
    }
    const seenLogIds = new Set<string>();
    for (const record of dedicatedLogRecords) {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new MutationSafetyError("RECOVERY_REQUIRED", "dedicated logs recovery record is invalid");
      }
      const row = record as Record<string, unknown>;
      const key = typeof row.id === "string" || typeof row.id === "number" ? String(row.id) : "";
      if (!key || typeof row.thread_id !== "string" || !interrupted.targetIds.includes(row.thread_id) || seenLogIds.has(key)) {
        throw new MutationSafetyError("RECOVERY_REQUIRED", "dedicated logs recovery record does not match locked targets");
      }
      seenLogIds.add(key);
    }
    const seenKeyIds = new Set<string>();
    assertDedicatedLogKeyPayloadBounds(dedicatedLogKeys as DedicatedLogKey[], "RECOVERY_REQUIRED");
    for (const key of dedicatedLogKeys) {
      const rawKeyId = key && typeof key === "object" ? (key as DedicatedLogKey).id : null;
      const keyId = typeof rawKeyId === "string" || typeof rawKeyId === "number" ? String(rawKeyId) : "";
      const threadId = key && typeof key === "object" ? (key as DedicatedLogKey).threadId : null;
      if (!keyId || typeof threadId !== "string" || !interrupted.targetIds.includes(threadId) || seenKeyIds.has(keyId)) {
        throw new MutationSafetyError("RECOVERY_REQUIRED", "dedicated logs recovery key does not match locked targets");
      }
      seenKeyIds.add(keyId);
    }
  }
  return payload as OperationRecoveryPayloadV1;
}

async function readCurrentState(
  context: TrustedRootContext,
  relativePath: string,
): Promise<RecoveryFileState> {
  const snapshot = await captureManagedPath(context, relativePath, {
    expectedKind: "file",
    allowMissing: true,
  });
  if (!snapshot.exists) return createRecoveryFileState(null);
  const bytes = await readManagedFile(context, snapshot.relativePath);
  await revalidateManagedPath(context, snapshot);
  return createRecoveryFileState(bytes);
}

function sameState(left: RecoveryFileState, right: RecoveryFileState): boolean {
  return left.exists === right.exists && left.sha256 === right.sha256;
}

async function applyState(
  context: TrustedRootContext,
  relativePath: string,
  desired: RecoveryFileState,
): Promise<void> {
  if (!desired.exists) {
    await removeManagedPath(context, relativePath, { expectedKind: "file", allowMissing: true });
    return;
  }
  await atomicWriteManagedFile(context, relativePath, Buffer.from(desired.dataBase64!, "base64"), 0o600);
}

export async function reconcileRecoveryFiles(
  context: TrustedRootContext,
  payload: OperationRecoveryPayloadV1,
): Promise<void> {
  for (const transition of payload.files) {
    const desired = payload.strategy === "rollback" ? transition.before : transition.after;
    const alternate = payload.strategy === "rollback" ? transition.after : transition.before;
    const current = await readCurrentState(context, transition.relativePath);
    if (sameState(current, desired)) continue;
    if (!sameState(current, alternate)) {
      throw new MutationSafetyError(
        "RECOVERY_REQUIRED",
        `managed file has an unrecognized third state; refusing recovery: ${transition.relativePath}`,
      );
    }
    await applyState(context, transition.relativePath, desired);
    const verified = await readCurrentState(context, transition.relativePath);
    if (!sameState(verified, desired)) {
      throw new MutationSafetyError("RECOVERY_REQUIRED", `file recovery verification failed: ${transition.relativePath}`);
    }
  }
}

function parseSqliteRecordBundle(value: unknown): SqliteRecordBundle {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", "SQLite recovery records are invalid");
  }
  const record = value as Partial<SqliteRecordBundle>;
  for (const key of [
    "threads",
    "logs",
    "threadSpawnEdges",
    "agentJobItems",
    "threadDynamicTools",
    "stage1Outputs",
    "threadGoals",
  ] as const) {
    if (!Array.isArray(record[key]) || !record[key]!.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
      throw new MutationSafetyError("RECOVERY_REQUIRED", `SQLite recovery records.${key} is invalid`);
    }
  }
  const decodeSqliteJsonValue = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(decodeSqliteJsonValue);
    if (!item || typeof item !== "object") return item;
    const object = item as Record<string, unknown>;
    if (
      object.type === "Buffer"
      && Array.isArray(object.data)
      && object.data.every((byte) => Number.isInteger(byte) && Number(byte) >= 0 && Number(byte) <= 255)
      && Object.keys(object).every((key) => key === "type" || key === "data")
    ) {
      return Buffer.from(object.data as number[]);
    }
    return Object.fromEntries(
      Object.entries(object).map(([key, nested]) => [key, decodeSqliteJsonValue(nested)]),
    );
  };
  return decodeSqliteJsonValue(record) as SqliteRecordBundle;
}

async function reconcileRecoverySqlite(
  payload: OperationRecoveryPayloadV1,
  protectedPurgeLogTargetIds: Set<string>,
): Promise<{
  retainedDedicatedLogTargetIds: string[];
  protectedButAlreadyDeletedLogTargetIds: string[];
}> {
  if (!payload.sqlite) {
    return { retainedDedicatedLogTargetIds: [], protectedButAlreadyDeletedLogTargetIds: [] };
  }
  const retainedDedicatedLogTargetIds: string[] = [];
  const protectedButAlreadyDeletedLogTargetIds: string[] = [];
  const sqliteContext = await createTrustedRootContext(payload.sqlite.sqliteHomeRealPath);
  if (
    sqliteContext.realPath !== payload.sqlite.sqliteHomeRealPath
    || payload.sqlite.sqliteHomeIdentity?.dev !== sqliteContext.identity.dev
    || payload.sqlite.sqliteHomeIdentity?.ino !== sqliteContext.identity.ino
  ) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", "SQLite recovery root identity changed");
  }
  const statePath = payload.sqlite.stateRelativePath
    ? reconstructManagedPath(sqliteContext, payload.sqlite.stateRelativePath).absolutePath
    : null;
  const goalsPath = payload.sqlite.goalsRelativePath
    ? reconstructManagedPath(sqliteContext, payload.sqlite.goalsRelativePath).absolutePath
    : null;
  const logsPath = payload.sqlite.logsRelativePath
    ? reconstructManagedPath(sqliteContext, payload.sqlite.logsRelativePath).absolutePath
    : null;
  for (const relativePath of [payload.sqlite.stateRelativePath, payload.sqlite.goalsRelativePath, payload.sqlite.logsRelativePath]) {
    if (!relativePath) continue;
    await captureManagedPath(sqliteContext, relativePath, { expectedKind: "file", allowMissing: false });
  }
  reconcileSqliteRecordsForRecovery(statePath, goalsPath, parseSqliteRecordBundle(payload.sqlite.records));
  const dedicatedLogRecords = payload.sqlite.dedicatedLogRecords ?? [];
  if (payload.strategy === "rollback") {
    reconcileDedicatedLogRecordsForRecovery(logsPath, decodeSqliteRecordsFromJson(dedicatedLogRecords));
  } else if (logsPath) {
    const keys = payload.sqlite.dedicatedLogKeys ?? [];
    const unprotectedKeys = keys.filter((key) => !protectedPurgeLogTargetIds.has(key.threadId));
    deleteDedicatedLogRowsByKeys(logsPath, unprotectedKeys);
    if (classifyDedicatedLogKeyPresence(logsPath, unprotectedKeys) !== "absent") {
      throw new MutationSafetyError("RECOVERY_REQUIRED", "purge log rows remained after idempotent recovery");
    }
    const protectedKeysByTarget = new Map<string, DedicatedLogKey[]>();
    for (const key of keys) {
      if (!protectedPurgeLogTargetIds.has(key.threadId)) continue;
      const targetKeys = protectedKeysByTarget.get(key.threadId) ?? [];
      targetKeys.push(key);
      protectedKeysByTarget.set(key.threadId, targetKeys);
    }
    for (const [sessionId, protectedKeys] of [...protectedKeysByTarget.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const protectedPresence = classifyDedicatedLogKeyPresence(logsPath, protectedKeys);
      if (protectedPresence !== "absent") retainedDedicatedLogTargetIds.push(sessionId);
      if (protectedPresence !== "present") protectedButAlreadyDeletedLogTargetIds.push(sessionId);
    }
  }
  return {
    retainedDedicatedLogTargetIds,
    protectedButAlreadyDeletedLogTargetIds,
  };
}

async function protectedPurgeLogTargets(
  context: TrustedRootContext,
  payload: OperationRecoveryPayloadV1,
  currentScan: Awaited<ReturnType<typeof scanCodexRoot>>,
): Promise<Set<string>> {
  const targetIds = new Set(payload.sqlite?.dedicatedLogTargetIds ?? []);
  const protectedIds = new Set<string>();
  if (payload.kind !== "purge" || targetIds.size === 0) return protectedIds;
  for (const session of currentScan.sessions) {
    if (
      targetIds.has(session.id)
      && (session.fileTargets.length > 0 || session.hasThread || session.hasSessionIndex || session.hasHistory)
    ) {
      protectedIds.add(session.id);
    }
  }

  const trashRelativePath = ".codex-sessions-trash";
  const trashSnapshot = await captureManagedPath(context, trashRelativePath, {
    expectedKind: "directory",
    allowMissing: true,
  });
  if (!trashSnapshot.exists) return protectedIds;
  const currentEntry = payload.trash?.entryRelativePath ? path.basename(payload.trash.entryRelativePath) : null;
  const quarantineEntry = payload.trash?.quarantineRelativePath ? path.basename(payload.trash.quarantineRelativePath) : null;
  const entries = await readdir(trashSnapshot.absolutePath, { withFileTypes: true });
  await revalidateManagedPath(context, trashSnapshot);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === currentEntry || entry.name === quarantineEntry) continue;
    const manifestRelativePath = `${trashRelativePath}/${entry.name}/manifest.json`;
    try {
      const bytes = await readManagedFile(context, manifestRelativePath);
      const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as {
        manifest?: { trashId?: unknown; sessionIds?: unknown };
      };
      if (parsed.manifest?.trashId !== entry.name || !Array.isArray(parsed.manifest.sessionIds)) continue;
      for (const sessionId of parsed.manifest.sessionIds) {
        if (typeof sessionId === "string" && targetIds.has(sessionId)) protectedIds.add(sessionId);
      }
    } catch {
      // Invalid trash entries cannot authorize deletion. Retaining logs is the safe fallback.
      continue;
    }
  }
  return protectedIds;
}

async function reconcileRecoveryTrash(
  context: TrustedRootContext,
  payload: OperationRecoveryPayloadV1,
): Promise<void> {
  if (!payload.trash) return;
  if (payload.kind === "trash" && payload.strategy === "rollback") {
    if (payload.trash.entryRelativePath) {
      const entry = await captureManagedPath(context, payload.trash.entryRelativePath, {
        expectedKind: "directory",
        allowMissing: true,
      });
      if (entry.exists) {
        if (!payload.trash.manifestSha256) {
          throw new MutationSafetyError("RECOVERY_REQUIRED", "trash recovery is missing its manifest hash");
        }
        const manifestRelativePath = `${payload.trash.entryRelativePath}/manifest.json`;
        const manifest = await readManagedFile(context, manifestRelativePath);
        if (sha256(manifest) !== payload.trash.manifestSha256) {
          throw new MutationSafetyError("RECOVERY_REQUIRED", "trash manifest changed after the interrupted operation");
        }
        await removeManagedPath(context, payload.trash.entryRelativePath, {
          expectedKind: "directory",
          recursive: true,
          allowMissing: false,
        });
      }
    }
    if (payload.trash.temporaryRelativePath) {
      await removeManagedPath(context, payload.trash.temporaryRelativePath, {
        expectedKind: "directory",
        recursive: true,
        allowMissing: true,
      });
    }
    return;
  }
  if (payload.kind === "purge" && payload.strategy === "rollforward") {
    const entryRelativePath = payload.trash.entryRelativePath;
    const quarantineRelativePath = payload.trash.quarantineRelativePath;
    if (!entryRelativePath || !quarantineRelativePath || !payload.trash.manifestSha256) {
      throw new MutationSafetyError("RECOVERY_REQUIRED", "purge recovery payload is incomplete");
    }
    let entry = await captureManagedPath(context, entryRelativePath, {
      expectedKind: "directory",
      allowMissing: true,
    });
    let quarantine = await captureManagedPath(context, quarantineRelativePath, {
      expectedKind: "directory",
      allowMissing: true,
    });
    if (entry.exists && quarantine.exists) {
      throw new MutationSafetyError("RECOVERY_REQUIRED", "purge entry and quarantine both exist");
    }
    if (entry.exists) {
      const manifest = await readManagedFile(context, `${entryRelativePath}/manifest.json`);
      if (sha256(manifest) !== payload.trash.manifestSha256) {
        throw new MutationSafetyError("RECOVERY_REQUIRED", "purge manifest changed before recovery");
      }
      await renameManagedPath(context, entryRelativePath, quarantineRelativePath);
      entry = await captureManagedPath(context, entryRelativePath, { expectedKind: "directory", allowMissing: true });
      quarantine = await captureManagedPath(context, quarantineRelativePath, { expectedKind: "directory", allowMissing: false });
    }
    if (quarantine.exists) {
      const manifest = await readManagedFile(context, `${quarantineRelativePath}/manifest.json`);
      if (sha256(manifest) !== payload.trash.manifestSha256) {
        throw new MutationSafetyError("RECOVERY_REQUIRED", "purge quarantine manifest changed before recovery");
      }
      await removeManagedPath(context, quarantineRelativePath, {
        expectedKind: "directory",
        recursive: true,
        allowMissing: false,
      });
    }
    if (entry.exists) {
      throw new MutationSafetyError("RECOVERY_REQUIRED", "purge entry remained after recovery");
    }
    return;
  }
  throw new MutationSafetyError("RECOVERY_REQUIRED", `unsupported trash recovery strategy for ${payload.kind}`);
}

export async function getRecoveryStatus(rootArg?: string): Promise<RecoveryStatus> {
  const context = await createTrustedRootContext(path.resolve(expandCodexPath(rootArg ?? "~/.codex")));
  let interrupted: InterruptedMutation | null;
  try {
    interrupted = await readInterruptedMutation(context);
  } catch (error) {
    return {
      pending: true,
      operationId: null,
      kind: "invalid",
      stage: "recovery_required",
      targetIds: [],
      hasRecoveryPayload: false,
      checkpoints: [],
      invalidReason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!interrupted) {
    return {
      pending: false,
      operationId: null,
      kind: null,
      stage: null,
      targetIds: [],
      hasRecoveryPayload: false,
      checkpoints: [],
      invalidReason: null,
    };
  }
  return {
    pending: true,
    operationId: interrupted.operationId,
    kind: interrupted.kind,
    stage: interrupted.journal.stage,
    targetIds: interrupted.targetIds,
    hasRecoveryPayload: interrupted.recoveryPayload !== null,
    checkpoints: interrupted.journal.checkpoints,
    invalidReason: null,
  };
}

function recoveryVerificationScope(
  payload: OperationRecoveryPayloadV1,
  retainedDedicatedLogTargetIds: string[] = [],
): VerificationScope {
  const paths = payload.files.map((file) => file.relativePath.replaceAll("\\", "/"));
  return {
    sessionFiles: paths.some((relativePath) => (
      relativePath.startsWith("sessions/") || relativePath.startsWith("archived_sessions/")
    )),
    shellSnapshots: paths.some((relativePath) => relativePath.startsWith("shell_snapshots/")),
    sessionIndex: paths.includes("session_index.jsonl"),
    history: paths.includes("history.jsonl"),
    globalState: paths.includes(".codex-global-state.json"),
    sqlite: payload.sqlite !== undefined,
    trashEntry: payload.trash !== undefined,
    operationJournal: true,
    retainedSurfaces: [
      ...(payload.sqlite?.logsRelativePath && retainedDedicatedLogTargetIds.length === 0 ? [] : ["logs_N.sqlite"]),
      "memory",
      "remote-control",
    ],
  };
}

function staleLockFinalizationScope(): VerificationScope {
  return {
    sessionFiles: false,
    shellSnapshots: false,
    sessionIndex: false,
    history: false,
    globalState: false,
    sqlite: false,
    trashEntry: false,
    operationJournal: true,
    retainedSurfaces: [],
  };
}

function recordedVerificationStatus(details: Record<string, unknown>): VerificationStatus {
  const status = details.verificationStatus;
  return status === "passed" || status === "partial" || status === "failed"
    ? status
    : "not_run";
}

function staleLockWarnings(
  status: VerificationStatus,
  finalStage: "committed" | "rolled_back",
): string[] {
  const outcome = finalStage === "committed" ? "提交" : "回滚";
  if (status === "failed") {
    return [
      `操作此前已${outcome}，但 journal 记录的验证失败；本次恢复只清理 stale lock，没有重新验证数据面。`,
    ];
  }
  if (status === "partial") {
    return [
      `操作此前已${outcome}，但 journal 记录的验证不完整；本次恢复只清理 stale lock，没有重新验证数据面。`,
    ];
  }
  if (status === "not_run") {
    return [
      `操作此前已${outcome}，但 journal 没有可信的 verificationStatus；本次恢复只清理 stale lock，没有重新验证数据面。`,
    ];
  }
  return [`操作此前已${outcome}；本次恢复只清理 stale lock，并沿用 journal 中已有的验证结果，没有重新验证数据面。`];
}

const SAFE_SKIPPED_SQLITE_TABLES = new Set([
  "threads",
  "logs",
  "thread_spawn_edges",
  "agent_job_items",
  "thread_dynamic_tools",
  "stage1_outputs",
  "thread_goals",
]);

function safeRecordedCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000_000
    ? value as number
    : null;
}

function recordedStructuredWarnings(details: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const skippedRows = details.skippedSqliteRows;
  const skippedTotal = skippedRows && typeof skippedRows === "object" && !Array.isArray(skippedRows)
    ? safeRecordedCount((skippedRows as Record<string, unknown>).total)
    : null;
  const skippedTables = Array.isArray(details.skippedSqliteTables)
    ? [...new Set(details.skippedSqliteTables.filter(
        (table): table is string => typeof table === "string" && SAFE_SKIPPED_SQLITE_TABLES.has(table),
      ))].sort()
    : [];
  if (skippedTotal !== null && skippedTotal > 0) {
    const tableSummary = skippedTables.length > 0 ? `（未恢复表：${skippedTables.join(", ")}）` : "";
    warnings.push(`SQLite 有 ${skippedTotal} 条记录未恢复${tableSummary}。`);
  }
  const retainedLogRows = safeRecordedCount(details.retainedLogRows);
  if (retainedLogRows !== null && retainedLogRows > 0) {
    warnings.push(`manifest 中 ${retainedLogRows} 条 logs 按只读保留策略未恢复。`);
  }
  return warnings;
}

/**
 * Recovers file and SQLite transitions only when every current value matches
 * either the recorded pre-operation or intended post-operation state.
 */
export async function recoverInterruptedOperation(rootArg?: string): Promise<RecoveryExecutionResult> {
  assertDestructivePlatformSupported();
  const currentScan = await scanCodexRoot(rootArg);
  const currentRoots = getRegisteredTrustedRoots(currentScan.root);
  if (!currentRoots) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", "current trusted roots could not be established");
  }
  const context = currentRoots.root;
  const interrupted = await readInterruptedMutation(context);
  if (!interrupted) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", "no interrupted mutation is present");
  }
  const recordedSqliteIdentity = interrupted.journal.sqliteHomeIdentity;
  const currentSqliteHome = currentRoots.sqliteHome;
  if (
    interrupted.journal.sqliteHomeRealPath !== (currentSqliteHome?.realPath ?? null)
    || JSON.stringify(recordedSqliteIdentity) !== JSON.stringify(
      currentSqliteHome
        ? { dev: currentSqliteHome.identity.dev, ino: currentSqliteHome.identity.ino }
        : null,
    )
  ) {
    throw new MutationSafetyError(
      "RECOVERY_REQUIRED",
      "current SQLite home does not match the identity fixed in the operation lock and journal",
    );
  }
  if (interrupted.journal.stage === "committed" || interrupted.journal.stage === "rolled_back") {
    const finalStage = interrupted.journal.stage;
    const verificationStatus = recordedVerificationStatus(interrupted.journal.details);
    await finalizeInterruptedMutation(context, interrupted, finalStage, {
      ...interrupted.journal.details,
      recoveredStaleLock: true,
    });
    return {
      operationId: interrupted.operationId,
      kind: interrupted.kind,
      recoveredBy: finalStage === "committed" ? "finalize-committed" : "finalize-rolled-back",
      operationStatus: finalStage,
      verificationStatus,
      verificationScope: staleLockFinalizationScope(),
      warnings: [
        ...staleLockWarnings(verificationStatus, finalStage),
        ...recordedStructuredWarnings(interrupted.journal.details),
      ],
      errorCode: finalStage === "committed" && verificationStatus === "failed"
        ? "POST_COMMIT_VERIFY_FAILED"
        : null,
    };
  }
  if (interrupted.journal.stage === "prepared" && interrupted.recoveryPayload === null) {
    await finalizeInterruptedMutation(context, interrupted, "rolled_back", { recoveredBeforeMutation: true });
    return {
      operationId: interrupted.operationId,
      kind: interrupted.kind,
      recoveredBy: "rollback",
      operationStatus: "rolled_back",
      verificationStatus: "passed",
      verificationScope: staleLockFinalizationScope(),
      warnings: ["操作在任何 mutation 前中断；已清除 stale lock。"],
      errorCode: null,
    };
  }
  const payload = parseOperationRecoveryPayload(interrupted.recoveryPayload, interrupted);
  if (payload.rootRealPath !== context.realPath) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", "recovery payload belongs to a different trusted root");
  }
  const protectedLogTargetIds = await protectedPurgeLogTargets(context, payload, currentScan);
  await reconcileRecoveryFiles(context, payload);
  const sqliteRecovery = await reconcileRecoverySqlite(payload, protectedLogTargetIds);
  await reconcileRecoveryTrash(context, payload);
  const finalStage = payload.strategy === "rollback" ? "rolled_back" : "committed";
  await finalizeInterruptedMutation(context, interrupted, finalStage, { recovered: true });
  const logsAlreadyDeleted = sqliteRecovery.protectedButAlreadyDeletedLogTargetIds;
  return {
    operationId: interrupted.operationId,
    kind: interrupted.kind,
    recoveredBy: payload.strategy,
    operationStatus: finalStage,
    verificationStatus: logsAlreadyDeleted.length > 0 ? "partial" : "passed",
    verificationScope: recoveryVerificationScope(payload, sqliteRecovery.retainedDedicatedLogTargetIds),
    warnings: [
      ...(sqliteRecovery.retainedDedicatedLogTargetIds.length > 0
        ? [`恢复时检测到 live 或其他可恢复副本，已保留这些 session 的日志：${sqliteRecovery.retainedDedicatedLogTargetIds.join(", ")}`]
        : []),
      ...(logsAlreadyDeleted.length > 0
        ? [`恢复前日志已经删除，无法声称为后来出现的 live 或其他可恢复副本保留：${logsAlreadyDeleted.join(", ")}`]
        : []),
    ],
    errorCode: null,
  };
}

/** @deprecated Internal test alias retained for the initial file-only recovery tests. */
export const recoverInterruptedFiles = recoverInterruptedOperation;
