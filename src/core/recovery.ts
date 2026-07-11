import crypto from "node:crypto";
import path from "node:path";

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
import type { MutationResultMetadata, VerificationScope } from "./types.js";
import { reconcileSqliteRecordsForRecovery, type SqliteRecordBundle } from "./sqlite.js";
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
    records: Record<string, unknown>;
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

async function reconcileRecoverySqlite(payload: OperationRecoveryPayloadV1): Promise<void> {
  if (!payload.sqlite) return;
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
  for (const relativePath of [payload.sqlite.stateRelativePath, payload.sqlite.goalsRelativePath]) {
    if (!relativePath) continue;
    await captureManagedPath(sqliteContext, relativePath, { expectedKind: "file", allowMissing: false });
  }
  reconcileSqliteRecordsForRecovery(statePath, goalsPath, parseSqliteRecordBundle(payload.sqlite.records));
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

function recoveryVerificationScope(): VerificationScope {
  return {
    sessionFiles: true,
    shellSnapshots: true,
    sessionIndex: true,
    history: true,
    globalState: true,
    sqlite: true,
    trashEntry: true,
    operationJournal: true,
    retainedSurfaces: ["logs_N.sqlite", "memory", "remote-control"],
  };
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
    await finalizeInterruptedMutation(context, interrupted, finalStage, { recoveredStaleLock: true });
    return {
      operationId: interrupted.operationId,
      kind: interrupted.kind,
      recoveredBy: finalStage === "committed" ? "finalize-committed" : "finalize-rolled-back",
      operationStatus: finalStage,
      verificationStatus: "passed",
      verificationScope: recoveryVerificationScope(),
      warnings: [],
      errorCode: null,
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
      verificationScope: recoveryVerificationScope(),
      warnings: ["操作在任何 mutation 前中断；已清除 stale lock。"],
      errorCode: null,
    };
  }
  const payload = parseOperationRecoveryPayload(interrupted.recoveryPayload, interrupted);
  if (payload.rootRealPath !== context.realPath) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", "recovery payload belongs to a different trusted root");
  }
  await reconcileRecoveryFiles(context, payload);
  await reconcileRecoverySqlite(payload);
  await reconcileRecoveryTrash(context, payload);
  const finalStage = payload.strategy === "rollback" ? "rolled_back" : "committed";
  await finalizeInterruptedMutation(context, interrupted, finalStage, { recovered: true });
  return {
    operationId: interrupted.operationId,
    kind: interrupted.kind,
    recoveredBy: payload.strategy,
    operationStatus: finalStage,
    verificationStatus: "passed",
    verificationScope: recoveryVerificationScope(),
    warnings: [],
    errorCode: null,
  };
}

/** @deprecated Internal test alias retained for the initial file-only recovery tests. */
export const recoverInterruptedFiles = recoverInterruptedOperation;
