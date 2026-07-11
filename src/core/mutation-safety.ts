import path from "node:path";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";

import {
  captureManagedPath,
  readManagedFile,
  readManagedText,
  reconstructManagedPath,
  revalidateManagedPath,
  type TrustedRootContext,
} from "./path-safety.js";
import { OperationError, type MutationErrorCode } from "./types.js";

export type MutationSafetyErrorCode = MutationErrorCode;
export type MutationOperationKind =
  | "delete"
  | "trash"
  | "restore"
  | "purge"
  | "cleanup-index"
  | "cleanup-stale";
export type MutationOperationStage =
  | "prepared"
  | "committing"
  | "committed"
  | "verifying"
  | "rolled_back"
  | "recovery_required";
export type MutationFinalStage = "committed" | "rolled_back" | "recovery_required";
export type MutationCheckpointStatus = "planned" | "started" | "committed";
export type MutationCheckpointName =
  | "operation-lock"
  | "recovery-payload"
  | "trash-entry"
  | "session-index"
  | "history"
  | "global-state"
  | "session-file"
  | "shell-snapshot"
  | "sqlite-goals"
  | "sqlite-state"
  | "sqlite"
  | "purge-quarantine"
  | "purge-remove";

export interface MutationCheckpointRegistration {
  name: MutationCheckpointName;
  statuses: readonly MutationCheckpointStatus[];
}

const COMMITTED_ONLY = ["committed"] as const;
const STARTED_AND_COMMITTED = ["started", "committed"] as const;

/**
 * Release-reviewed inventory of every durable mutation boundary. New writes
 * must add their boundary here before the journal accepts the checkpoint.
 */
export const MUTATION_CHECKPOINT_INVENTORY = {
  delete: [
    { name: "operation-lock", statuses: COMMITTED_ONLY },
    { name: "recovery-payload", statuses: COMMITTED_ONLY },
    { name: "session-index", statuses: STARTED_AND_COMMITTED },
    { name: "history", statuses: STARTED_AND_COMMITTED },
    { name: "global-state", statuses: STARTED_AND_COMMITTED },
    { name: "session-file", statuses: STARTED_AND_COMMITTED },
    { name: "shell-snapshot", statuses: STARTED_AND_COMMITTED },
    { name: "sqlite-goals", statuses: STARTED_AND_COMMITTED },
    { name: "sqlite-state", statuses: STARTED_AND_COMMITTED },
  ],
  trash: [
    { name: "operation-lock", statuses: COMMITTED_ONLY },
    { name: "recovery-payload", statuses: COMMITTED_ONLY },
    { name: "trash-entry", statuses: COMMITTED_ONLY },
    { name: "session-index", statuses: STARTED_AND_COMMITTED },
    { name: "history", statuses: STARTED_AND_COMMITTED },
    { name: "global-state", statuses: STARTED_AND_COMMITTED },
    { name: "session-file", statuses: STARTED_AND_COMMITTED },
    { name: "shell-snapshot", statuses: STARTED_AND_COMMITTED },
    { name: "sqlite-goals", statuses: STARTED_AND_COMMITTED },
    { name: "sqlite-state", statuses: STARTED_AND_COMMITTED },
  ],
  restore: [
    { name: "operation-lock", statuses: COMMITTED_ONLY },
    { name: "recovery-payload", statuses: COMMITTED_ONLY },
    { name: "session-file", statuses: STARTED_AND_COMMITTED },
    { name: "shell-snapshot", statuses: STARTED_AND_COMMITTED },
    { name: "session-index", statuses: STARTED_AND_COMMITTED },
    { name: "history", statuses: STARTED_AND_COMMITTED },
    { name: "global-state", statuses: STARTED_AND_COMMITTED },
    { name: "sqlite", statuses: STARTED_AND_COMMITTED },
  ],
  purge: [
    { name: "operation-lock", statuses: COMMITTED_ONLY },
    { name: "recovery-payload", statuses: COMMITTED_ONLY },
    { name: "purge-quarantine", statuses: STARTED_AND_COMMITTED },
    { name: "purge-remove", statuses: STARTED_AND_COMMITTED },
  ],
  "cleanup-index": [
    { name: "operation-lock", statuses: COMMITTED_ONLY },
    { name: "recovery-payload", statuses: COMMITTED_ONLY },
    { name: "session-index", statuses: STARTED_AND_COMMITTED },
    { name: "history", statuses: STARTED_AND_COMMITTED },
  ],
  "cleanup-stale": [
    { name: "operation-lock", statuses: COMMITTED_ONLY },
    { name: "recovery-payload", statuses: COMMITTED_ONLY },
    { name: "session-index", statuses: STARTED_AND_COMMITTED },
    { name: "history", statuses: STARTED_AND_COMMITTED },
  ],
} as const satisfies Record<MutationOperationKind, readonly MutationCheckpointRegistration[]>;

function assertRegisteredCheckpoint(
  kind: MutationOperationKind,
  name: string,
  status: MutationCheckpointStatus,
): void {
  const registration = MUTATION_CHECKPOINT_INVENTORY[kind]
    .find((entry) => entry.name === name) as MutationCheckpointRegistration | undefined;
  if (!registration) {
    throw new MutationSafetyError(
      "RECOVERY_REQUIRED",
      `checkpoint ${name} is not registered for ${kind}`,
    );
  }
  if (!registration.statuses.includes(status)) {
    throw new MutationSafetyError(
      "RECOVERY_REQUIRED",
      `checkpoint ${name} status ${status} is not registered for ${kind}`,
    );
  }
}

const MUTATION_OPERATION_KINDS = new Set<MutationOperationKind>([
  "delete",
  "trash",
  "restore",
  "purge",
  "cleanup-index",
  "cleanup-stale",
]);
const MUTATION_OPERATION_STAGES = new Set<MutationOperationStage>([
  "prepared",
  "committing",
  "committed",
  "verifying",
  "rolled_back",
  "recovery_required",
]);

export class MutationSafetyError extends OperationError {
  constructor(code: MutationSafetyErrorCode, message: string) {
    super(code, message, {
      operationStatus:
        code === "RECOVERY_REQUIRED"
          ? "recovery_required"
          : code === "POST_COMMIT_VERIFY_FAILED"
            ? "committed"
            : "not_started",
      verificationStatus: code === "POST_COMMIT_VERIFY_FAILED" ? "failed" : "not_run",
    });
    this.name = "MutationSafetyError";
  }
}

const CANONICAL_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function isCanonicalSessionId(value: string): boolean {
  return CANONICAL_SESSION_ID_PATTERN.test(value);
}

export function assertCanonicalSessionIds(sessionIds: readonly string[]): void {
  const malformed = sessionIds.filter((sessionId) => !isCanonicalSessionId(sessionId));
  if (malformed.length > 0) {
    throw new MutationSafetyError(
      "MALFORMED_ID",
      `destructive operations require full UUID session ids; rejected: ${malformed.join(", ")}`,
    );
  }
  const duplicates = sessionIds.filter((sessionId, index) => sessionIds.indexOf(sessionId) !== index);
  if (duplicates.length > 0) {
    throw new MutationSafetyError(
      "MALFORMED_ID",
      `destructive operations reject duplicate session ids: ${[...new Set(duplicates)].join(", ")}`,
    );
  }
}

export async function ensureManagedDirectory(
  context: TrustedRootContext,
  relativePath: string,
  mode = 0o700,
  enforceMode = false,
): Promise<void> {
  const normalized = reconstructManagedPath(context, relativePath).relativePath;
  const parts = normalized.split(path.sep);

  for (let index = 0; index < parts.length; index += 1) {
    const currentRelativePath = path.join(...parts.slice(0, index + 1));
    const snapshot = await captureManagedPath(context, currentRelativePath, {
      expectedKind: "directory",
      allowMissing: true,
    });
    if (snapshot.exists) {
      if (enforceMode && process.platform !== "win32") {
        await revalidateManagedPath(context, snapshot);
        await chmod(snapshot.absolutePath, mode);
        const verified = await captureManagedPath(context, currentRelativePath, {
          expectedKind: "directory",
          allowMissing: false,
        });
        if ((verified.identity!.mode & 0o777) !== mode) {
          throw new MutationSafetyError(
            "RECOVERY_REQUIRED",
            `managed directory permissions could not be restricted: ${currentRelativePath}`,
          );
        }
      }
      continue;
    }

    await revalidateManagedPath(context, snapshot);
    try {
      await mkdir(snapshot.absolutePath, { mode });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    await captureManagedPath(context, currentRelativePath, {
      expectedKind: "directory",
      allowMissing: false,
    });
    if (process.platform !== "win32") {
      const created = await captureManagedPath(context, currentRelativePath, {
        expectedKind: "directory",
        allowMissing: false,
      });
      if ((created.identity!.mode & 0o777) !== mode) {
        throw new MutationSafetyError(
          "RECOVERY_REQUIRED",
          `managed directory was created with unexpected permissions: ${currentRelativePath}`,
        );
      }
    }
  }
}

async function syncManagedDirectory(
  context: TrustedRootContext,
  relativePath: string | null,
): Promise<void> {
  const directoryPath = relativePath === null
    ? context.realPath
    : (await captureManagedPath(context, relativePath, {
      expectedKind: "directory",
      allowMissing: false,
    })).absolutePath;
  let handle;
  try {
    handle = await open(directoryPath, "r");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (process.platform === "win32" && ["EACCES", "EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")) {
      return;
    }
    throw error;
  }
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (process.platform !== "win32" || !["EINVAL", "ENOTSUP", "EPERM"].includes(code ?? "")) {
      throw error;
    }
  } finally {
    await handle.close();
  }
}

export async function removeManagedPath(
  context: TrustedRootContext,
  relativePath: string,
  options: { expectedKind?: "file" | "directory"; recursive?: boolean; allowMissing?: boolean } = {},
): Promise<boolean> {
  const snapshot = await captureManagedPath(context, relativePath, {
    expectedKind: options.expectedKind ?? "any",
    allowMissing: options.allowMissing ?? true,
  });
  if (!snapshot.exists) return false;
  await revalidateManagedPath(context, snapshot);
  await rm(snapshot.absolutePath, { recursive: options.recursive ?? false, force: true });
  return true;
}

export async function renameManagedPath(
  context: TrustedRootContext,
  fromRelativePath: string,
  toRelativePath: string,
): Promise<void> {
  const source = await captureManagedPath(context, fromRelativePath, { allowMissing: false });
  const destination = await captureManagedPath(context, toRelativePath, { allowMissing: true });
  if (destination.exists) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", `rename destination already exists: ${toRelativePath}`);
  }
  await revalidateManagedPath(context, source);
  await revalidateManagedPath(context, destination);
  await rename(source.absolutePath, destination.absolutePath);
  await captureManagedPath(context, destination.relativePath, { allowMissing: false });
}

export async function atomicWriteManagedText(
  context: TrustedRootContext,
  relativePath: string,
  contents: string,
  mode = 0o600,
): Promise<void> {
  await atomicWriteManagedFile(context, relativePath, contents, mode);
}

export async function atomicWriteManagedFile(
  context: TrustedRootContext,
  relativePath: string,
  contents: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  await atomicWriteManagedFileInternal(context, relativePath, contents, mode);
}

export async function atomicWriteManagedFileIfUnchanged(
  context: TrustedRootContext,
  relativePath: string,
  expectedContents: string | Uint8Array | null,
  contents: string | Uint8Array,
  mode = 0o600,
): Promise<void> {
  await atomicWriteManagedFileInternal(context, relativePath, contents, mode, expectedContents);
}

export async function atomicWriteManagedTextIfUnchanged(
  context: TrustedRootContext,
  relativePath: string,
  expectedContents: string | null,
  contents: string,
  mode = 0o600,
): Promise<void> {
  await atomicWriteManagedFileInternal(context, relativePath, contents, mode, expectedContents);
}

async function atomicWriteManagedFileInternal(
  context: TrustedRootContext,
  relativePath: string,
  contents: string | Uint8Array,
  mode: number,
  expectedContents?: string | Uint8Array | null,
): Promise<void> {
  const normalizedRelativePath = reconstructManagedPath(context, relativePath).relativePath;
  const parentRelativePath = path.dirname(normalizedRelativePath);
  if (parentRelativePath !== ".") {
    await ensureManagedDirectory(context, parentRelativePath);
  }
  const target = await captureManagedPath(context, normalizedRelativePath, {
    expectedKind: "file",
    allowMissing: true,
  });
  const parentSnapshot = parentRelativePath === "."
    ? null
    : await captureManagedPath(context, parentRelativePath, {
      expectedKind: "directory",
      allowMissing: false,
    });
  const tempRelativePath = path.join(
    parentRelativePath === "." ? "" : parentRelativePath,
    `.csm-tmp-${randomUUID()}`,
  );
  const temp = reconstructManagedPath(context, tempRelativePath);
  let handle;
  try {
    handle = await open(temp.absolutePath, "wx", mode);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = undefined;

    if (expectedContents !== undefined) {
      const current = await captureManagedPath(context, target.relativePath, {
        expectedKind: "file",
        allowMissing: true,
      });
      const expectedBytes = expectedContents === null
        ? null
        : Buffer.from(expectedContents);
      const currentBytes = current.exists
        ? await readManagedFile(context, current.relativePath)
        : null;
      const matches = expectedBytes === null
        ? currentBytes === null
        : currentBytes !== null && currentBytes.equals(expectedBytes);
      if (!matches) {
        throw new MutationSafetyError(
          "STALE_PLAN",
          `managed file contents changed before atomic replacement: ${target.relativePath}`,
        );
      }
    }
    await revalidateManagedPath(context, target);
    if (parentSnapshot) await revalidateManagedPath(context, parentSnapshot);
    await rename(temp.absolutePath, target.absolutePath);
    await captureManagedPath(context, target.relativePath, {
      expectedKind: "file",
      allowMissing: false,
    });
    await syncManagedDirectory(context, parentRelativePath === "." ? null : parentRelativePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temp.absolutePath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface MutationLock {
  operationId: string;
  journalRelativePath: string;
  recoveryRelativePath: string;
  setStage(stage: MutationOperationStage, details?: Record<string, unknown>): Promise<void>;
  checkpoint(name: MutationCheckpointName, status: MutationCheckpointStatus, details?: Record<string, unknown>): Promise<void>;
  writeRecoveryPayload(payload: unknown): Promise<void>;
  release(stage: MutationFinalStage, details?: Record<string, unknown>): Promise<void>;
}

export interface MutationJournalCheckpoint {
  name: MutationCheckpointName;
  status: MutationCheckpointStatus;
  at: string;
  details: Record<string, unknown>;
}

export interface MutationJournal {
  schemaVersion: "codex-sessions-operation.v2";
  operationId: string;
  kind: MutationOperationKind;
  targetIds: string[];
  rootRealPath: string;
  rootIdentity: { dev: number; ino: number };
  sqliteHomeRealPath: string | null;
  sqliteHomeIdentity: { dev: number; ino: number } | null;
  createdAt: string;
  updatedAt: string;
  stage: MutationOperationStage;
  details: Record<string, unknown>;
  recoveryRelativePath: string;
  checkpoints: MutationJournalCheckpoint[];
}

export interface InterruptedMutation {
  operationId: string;
  kind: MutationOperationKind;
  targetIds: string[];
  lockRelativePath: string;
  journalRelativePath: string;
  recoveryRelativePath: string;
  journal: MutationJournal;
  recoveryPayload: unknown | null;
}

type MutationCheckpointHook = (event: {
  operationId: string;
  kind: MutationOperationKind;
  name: MutationCheckpointName;
  status: MutationJournalCheckpoint["status"];
}) => void | Promise<void>;

let mutationCheckpointHook: MutationCheckpointHook | null = null;

/** Test-only process crash hook; production CLI/MCP never registers it. */
export function setMutationCheckpointHookForTests(hook: MutationCheckpointHook | null): void {
  mutationCheckpointHook = hook;
}

function parseObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${label} must be an object`);
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new MutationSafetyError(
      "RECOVERY_REQUIRED",
      `${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function hasTrustedRootIdentity(
  value: unknown,
  context: TrustedRootContext,
): value is { dev: number; ino: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as { dev?: unknown; ino?: unknown };
  return identity.dev === context.identity.dev && identity.ino === context.identity.ino;
}

function parseRecordedRootIdentity(value: unknown): { dev: number; ino: number } | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const identity = value as { dev?: unknown; ino?: unknown };
  return typeof identity.dev === "number" && typeof identity.ino === "number"
    ? { dev: identity.dev, ino: identity.ino }
    : null;
}

function isMutationOperationKind(value: unknown): value is MutationOperationKind {
  return typeof value === "string" && MUTATION_OPERATION_KINDS.has(value as MutationOperationKind);
}

function isMutationOperationStage(value: unknown): value is MutationOperationStage {
  return typeof value === "string" && MUTATION_OPERATION_STAGES.has(value as MutationOperationStage);
}

function parseJournal(
  value: Record<string, unknown>,
  expected: {
    operationId: string;
    kind: MutationOperationKind;
    context: TrustedRootContext;
    recoveryRelativePath: string;
    sqliteHomeRealPath: string | null;
    sqliteHomeIdentity: { dev: number; ino: number } | null;
  },
): MutationJournal {
  if (
    value.schemaVersion !== "codex-sessions-operation.v2"
    || value.operationId !== expected.operationId
    || value.kind !== expected.kind
    || value.rootRealPath !== expected.context.realPath
    || !hasTrustedRootIdentity(value.rootIdentity, expected.context)
    || value.sqliteHomeRealPath !== expected.sqliteHomeRealPath
    || JSON.stringify(value.sqliteHomeIdentity) !== JSON.stringify(expected.sqliteHomeIdentity)
    || value.recoveryRelativePath !== expected.recoveryRelativePath
    || !Array.isArray(value.targetIds)
    || !value.targetIds.every((targetId) => typeof targetId === "string")
    || typeof value.createdAt !== "string"
    || typeof value.updatedAt !== "string"
    || !isMutationOperationStage(value.stage)
    || !value.details
    || typeof value.details !== "object"
    || Array.isArray(value.details)
    || !Array.isArray(value.checkpoints)
  ) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", "operation journal does not match the mutation lock");
  }
  assertCanonicalSessionIds(value.targetIds);
  for (const checkpoint of value.checkpoints) {
    if (
      !checkpoint
      || typeof checkpoint !== "object"
      || Array.isArray(checkpoint)
      || typeof (checkpoint as MutationJournalCheckpoint).name !== "string"
      || !["planned", "started", "committed"].includes((checkpoint as MutationJournalCheckpoint).status)
      || typeof (checkpoint as MutationJournalCheckpoint).at !== "string"
      || !(checkpoint as MutationJournalCheckpoint).details
      || typeof (checkpoint as MutationJournalCheckpoint).details !== "object"
      || Array.isArray((checkpoint as MutationJournalCheckpoint).details)
    ) {
      throw new MutationSafetyError("RECOVERY_REQUIRED", "operation journal checkpoint schema is invalid");
    }
    assertRegisteredCheckpoint(
      expected.kind,
      (checkpoint as MutationJournalCheckpoint).name,
      (checkpoint as MutationJournalCheckpoint).status,
    );
  }
  return value as unknown as MutationJournal;
}

export async function readInterruptedMutation(
  context: TrustedRootContext,
): Promise<InterruptedMutation | null> {
  const lockRelativePath = ".codex-sessions-trash/.operation.lock";
  const lockSnapshot = await captureManagedPath(context, lockRelativePath, {
    expectedKind: "file",
    allowMissing: true,
  });
  if (!lockSnapshot.exists) return null;
  const lock = parseObject(await readManagedText(context, lockRelativePath), "mutation lock");
  const operationId = typeof lock.operationId === "string" ? lock.operationId : "";
  const kind = lock.kind;
  const targetIds = Array.isArray(lock.targetIds) && lock.targetIds.every((value) => typeof value === "string")
    ? lock.targetIds
    : [];
  const sqliteHomeRealPath = lock.sqliteHomeRealPath === null || typeof lock.sqliteHomeRealPath === "string"
    ? lock.sqliteHomeRealPath
    : undefined;
  const sqliteHomeIdentity = parseRecordedRootIdentity(lock.sqliteHomeIdentity);
  if (
    !isCanonicalSessionId(operationId)
    || !isMutationOperationKind(kind)
    || lock.rootRealPath !== context.realPath
    || !hasTrustedRootIdentity(lock.rootIdentity, context)
    || sqliteHomeRealPath === undefined
    || ((sqliteHomeRealPath === null) !== (lock.sqliteHomeIdentity === null))
    || (sqliteHomeRealPath !== null && sqliteHomeIdentity === null)
  ) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", "mutation lock schema is invalid");
  }
  assertCanonicalSessionIds(targetIds);
  const journalRelativePath = `.codex-sessions-trash/.operations/${operationId}.json`;
  const recoveryRelativePath = `.codex-sessions-trash/.operations/${operationId}.recovery.json`;
  const journalSnapshot = await captureManagedPath(context, journalRelativePath, {
    expectedKind: "file",
    allowMissing: true,
  });
  const recoverySnapshot = await captureManagedPath(context, recoveryRelativePath, {
    expectedKind: "file",
    allowMissing: true,
  });
  const recoveryPayload = recoverySnapshot.exists
    ? parseObject(await readManagedText(context, recoveryRelativePath), "operation recovery payload")
    : null;
  if (!journalSnapshot.exists) {
    if (recoveryPayload !== null) {
      throw new MutationSafetyError("RECOVERY_REQUIRED", "recovery payload exists without an operation journal");
    }
    const createdAt = typeof lock.createdAt === "string" ? lock.createdAt : new Date(0).toISOString();
    const syntheticJournal: MutationJournal = {
      schemaVersion: "codex-sessions-operation.v2",
      operationId,
      kind,
      targetIds,
      rootRealPath: context.realPath,
      rootIdentity: { dev: context.identity.dev, ino: context.identity.ino },
      sqliteHomeRealPath,
      sqliteHomeIdentity,
      createdAt,
      updatedAt: createdAt,
      stage: "prepared",
      details: { journalMissingAfterLockAcquisition: true },
      recoveryRelativePath,
      checkpoints: [],
    };
    await revalidateManagedPath(context, lockSnapshot);
    return {
      operationId,
      kind,
      targetIds,
      lockRelativePath,
      journalRelativePath,
      recoveryRelativePath,
      journal: syntheticJournal,
      recoveryPayload: null,
    };
  }
  const journal = parseJournal(
    parseObject(await readManagedText(context, journalRelativePath), "operation journal"),
    { operationId, kind, context, recoveryRelativePath, sqliteHomeRealPath, sqliteHomeIdentity },
  );
  if (JSON.stringify(journal.targetIds) !== JSON.stringify(targetIds)) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", "operation journal targets do not match the mutation lock");
  }
  await revalidateManagedPath(context, lockSnapshot);
  return {
    operationId,
    kind,
    targetIds,
    lockRelativePath,
    journalRelativePath,
    recoveryRelativePath,
    journal,
    recoveryPayload,
  };
}

export async function finalizeInterruptedMutation(
  context: TrustedRootContext,
  interrupted: InterruptedMutation,
  stage: "committed" | "rolled_back",
  details: Record<string, unknown> = {},
): Promise<void> {
  const current = await readInterruptedMutation(context);
  if (!current || current.operationId !== interrupted.operationId) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", "interrupted operation ownership changed");
  }
  const nextJournal: MutationJournal = {
    ...current.journal,
    stage,
    updatedAt: new Date().toISOString(),
    details,
  };
  await atomicWriteManagedText(
    context,
    current.journalRelativePath,
    `${JSON.stringify(nextJournal, null, 2)}\n`,
  );
  await removeManagedPath(context, current.recoveryRelativePath, {
    expectedKind: "file",
    allowMissing: true,
  });
  await removeManagedPath(context, current.lockRelativePath, {
    expectedKind: "file",
    allowMissing: false,
  });
  await syncManagedDirectory(context, ".codex-sessions-trash");
}

export async function acquireMutationLock(
  context: TrustedRootContext,
  kind: MutationOperationKind,
  targetIds: readonly string[],
  sqliteHome: TrustedRootContext | null = context,
): Promise<MutationLock> {
  assertCanonicalSessionIds(targetIds);
  await ensureManagedDirectory(context, ".codex-sessions-trash", 0o700, true);
  await ensureManagedDirectory(context, ".codex-sessions-trash/.operations", 0o700, true);

  const lockRelativePath = ".codex-sessions-trash/.operation.lock";
  const lockPath = reconstructManagedPath(context, lockRelativePath);
  const operationId = randomUUID();
  const journalRelativePath = `.codex-sessions-trash/.operations/${operationId}.json`;
  const recoveryRelativePath = `.codex-sessions-trash/.operations/${operationId}.recovery.json`;
  let lockHandle;
  try {
    lockHandle = await open(lockPath.absolutePath, "wx", 0o600);
    if (process.platform !== "win32") await lockHandle.chmod(0o600);
    await lockHandle.writeFile(`${JSON.stringify({
      operationId,
      kind,
      targetIds,
      createdAt: new Date().toISOString(),
      rootRealPath: context.realPath,
      rootIdentity: { dev: context.identity.dev, ino: context.identity.ino },
      sqliteHomeRealPath: sqliteHome?.realPath ?? null,
      sqliteHomeIdentity: sqliteHome
        ? { dev: sqliteHome.identity.dev, ino: sqliteHome.identity.ino }
        : null,
    })}\n`, "utf8");
    await lockHandle.sync();
    await lockHandle.close();
    lockHandle = undefined;
    await mutationCheckpointHook?.({
      operationId,
      kind,
      name: "operation-lock",
      status: "committed",
    });
  } catch (error) {
    await lockHandle?.close().catch(() => undefined);
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new MutationSafetyError(
        "RECOVERY_REQUIRED",
        `another mutation or an interrupted operation owns ${lockRelativePath}`,
      );
    }
    throw error;
  }

  const journal: MutationJournal = {
    schemaVersion: "codex-sessions-operation.v2",
    operationId,
    kind,
    targetIds: [...targetIds],
    rootRealPath: context.realPath,
    rootIdentity: { dev: context.identity.dev, ino: context.identity.ino },
    sqliteHomeRealPath: sqliteHome?.realPath ?? null,
    sqliteHomeIdentity: sqliteHome
      ? { dev: sqliteHome.identity.dev, ino: sqliteHome.identity.ino }
      : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    stage: "prepared",
    details: {},
    recoveryRelativePath,
    checkpoints: [],
  };

  const setStage = async (stage: MutationOperationStage, details: Record<string, unknown> = {}): Promise<void> => {
    journal.stage = stage;
    journal.updatedAt = new Date().toISOString();
    journal.details = details;
    await atomicWriteManagedText(
      context,
      journalRelativePath,
      `${JSON.stringify(journal, null, 2)}\n`,
    );
  };
  await setStage("prepared");
  const checkpoint: MutationLock["checkpoint"] = async (name, status, details = {}) => {
    assertRegisteredCheckpoint(kind, name, status);
    journal.checkpoints.push({ name, status, at: new Date().toISOString(), details });
    await setStage(journal.stage, journal.details);
    await mutationCheckpointHook?.({ operationId, kind, name, status });
  };

  return {
    operationId,
    journalRelativePath,
    recoveryRelativePath,
    setStage,
    checkpoint,
    async writeRecoveryPayload(payload) {
      await atomicWriteManagedText(
        context,
        recoveryRelativePath,
        `${JSON.stringify(payload, null, 2)}\n`,
      );
      await checkpoint("recovery-payload", "committed", { recoveryRelativePath });
    },
    async release(stage, details = {}) {
      await setStage(stage, details);
      if (stage === "recovery_required") return;
      const lockSnapshot = await captureManagedPath(context, lockRelativePath, {
        expectedKind: "file",
        allowMissing: false,
      });
      const lockContents = await readManagedText(context, lockRelativePath);
      let lockOwner: unknown;
      try {
        lockOwner = (JSON.parse(lockContents) as { operationId?: unknown }).operationId;
      } catch {
        throw new MutationSafetyError("RECOVERY_REQUIRED", "mutation lock is not valid JSON");
      }
      if (lockOwner !== operationId) {
        throw new MutationSafetyError("RECOVERY_REQUIRED", "mutation lock ownership changed");
      }
      await revalidateManagedPath(context, lockSnapshot);
      await removeManagedPath(context, recoveryRelativePath, {
        expectedKind: "file",
        allowMissing: true,
      });
      await rm(lockSnapshot.absolutePath, { force: true });
      await syncManagedDirectory(context, ".codex-sessions-trash");
    },
  };
}
