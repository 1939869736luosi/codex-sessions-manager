import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { acquireMutationLock } from "../src/core/mutation-safety.js";
import { createTrustedRootContext } from "../src/core/path-safety.js";
import {
  createRecoveryFileTransition,
  getRecoveryStatus,
  recoverInterruptedFiles,
  recoverInterruptedOperation,
  type OperationRecoveryPayloadV1,
} from "../src/core/recovery.js";
import { FIXTURE_IDS } from "./helpers/fixture.js";
import { createFixture } from "./helpers/fixture.js";
import { moveSessionsToTrash } from "../src/core/trash.js";
import { resolveSessions } from "../src/core/query.js";
import { scanCodexRoot } from "../src/core/scan.js";
import { exportSqliteRecordsForRestore } from "../src/core/sqlite.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function subprocessEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env, ...overrides };
  // Recovery tests intentionally start and kill child Node processes. They
  // must not inherit Vitest's worker-owned V8 coverage output directory.
  delete environment.NODE_V8_COVERAGE;
  return environment;
}

interface ChildExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: string | null;
}

interface ChildExitObserver {
  readonly promise: Promise<ChildExitResult>;
  readonly result: ChildExitResult | null;
}

function observeChildExit(child: ReturnType<typeof spawn>): ChildExitObserver {
  let result: ChildExitResult | null = null;
  const promise = new Promise<ChildExitResult>((resolve) => {
    child.once("error", (error) => {
      result = { code: null, signal: null, error: error.message };
      resolve(result);
    });
    child.once("exit", (code, signal) => {
      result = { code, signal, error: null };
      resolve(result);
    });
  });
  return {
    promise,
    get result() {
      return result;
    },
  };
}

async function buildCrashTestArtifacts(): Promise<void> {
  const build = spawn(process.execPath, ["scripts/build.mjs"], {
    cwd: repositoryRoot,
    stdio: "ignore",
    env: subprocessEnvironment(),
  });
  const [buildCode] = await once(build, "exit") as [number | null];
  if (buildCode !== 0) {
    throw new Error(`crash-test artifact build failed with exit code ${String(buildCode)}`);
  }
}

function assertChildStillRunning(observer: ChildExitObserver, boundary: string): void {
  if (!observer.result) return;
  const { code, signal, error } = observer.result;
  throw new Error(
    `crash-test child exited before ${boundary}: code=${String(code)} signal=${String(signal)} error=${error ?? "none"}`,
  );
}

async function waitForCheckpoint(
  rootPath: string,
  name: string,
  status: string,
  childExit?: ChildExitObserver,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  const lockPath = path.join(rootPath, ".codex-sessions-trash", ".operation.lock");
  while (Date.now() < deadline) {
    if (childExit) assertChildStillRunning(childExit, `${name}:${status}`);
    try {
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as { operationId: string };
      const journal = JSON.parse(
        await readFile(path.join(rootPath, ".codex-sessions-trash", ".operations", `${lock.operationId}.json`), "utf8"),
      ) as { checkpoints: Array<{ name: string; status: string }> };
      if (journal.checkpoints.some((entry) => entry.name === name && entry.status === status)) return;
    } catch {
      // The child has not persisted this boundary yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  if (childExit) assertChildStillRunning(childExit, `${name}:${status}`);
  throw new Error(`timed out waiting for ${name}:${status}`);
}

async function waitForLockWithoutJournal(rootPath: string, childExit?: ChildExitObserver): Promise<void> {
  const deadline = Date.now() + 15_000;
  const lockPath = path.join(rootPath, ".codex-sessions-trash", ".operation.lock");
  while (Date.now() < deadline) {
    if (childExit) assertChildStillRunning(childExit, "durable lock before journal");
    try {
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as { operationId: string };
      await access(path.join(rootPath, ".codex-sessions-trash", ".operations", `${lock.operationId}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        try {
          await access(lockPath);
          return;
        } catch {
          // The lock is not durable yet.
        }
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  if (childExit) assertChildStillRunning(childExit, "durable lock before journal");
  throw new Error("timed out waiting for a durable lock before its journal");
}

async function waitForBoundaryMarker(
  markerPath: string,
  boundary: string,
  childExit?: ChildExitObserver,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (childExit) assertChildStillRunning(childExit, boundary);
    try {
      await access(markerPath);
      return;
    } catch {
      // The child has not crossed the durable boundary yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  if (childExit) assertChildStillRunning(childExit, boundary);
  throw new Error(`timed out waiting for ${boundary}`);
}

describe("durable mutation recovery", () => {
  let sandbox: string;
  let rootDir: string;

  beforeAll(buildCrashTestArtifacts, 30_000);

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), "csm-recovery-"));
    rootDir = path.join(sandbox, "root");
    await mkdir(path.join(rootDir, "sessions"), { recursive: true });
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("rolls a file-only interrupted cleanup forward and clears the lock", async () => {
    const indexPath = path.join(rootDir, "session_index.jsonl");
    const before = `${JSON.stringify({ id: FIXTURE_IDS.ACTIVE_ID })}\n`;
    const after = "";
    await writeFile(indexPath, before, "utf8");
    const context = await createTrustedRootContext(rootDir);
    const lock = await acquireMutationLock(context, "cleanup-index", [FIXTURE_IDS.ACTIVE_ID]);
    const payload: OperationRecoveryPayloadV1 = {
      schemaVersion: "codex-sessions-recovery.v1",
      operationId: lock.operationId,
      kind: "cleanup-index",
      strategy: "rollforward",
      rootRealPath: context.realPath,
      targetIds: [FIXTURE_IDS.ACTIVE_ID],
      files: [createRecoveryFileTransition("session_index.jsonl", before, after)],
    };
    await lock.writeRecoveryPayload(payload);
    await lock.setStage("committing");

    const result = await recoverInterruptedFiles(rootDir);

    expect(result).toMatchObject({
      operationStatus: "committed",
      verificationStatus: "passed",
      recoveredBy: "rollforward",
      verificationScope: {
        sessionFiles: false,
        shellSnapshots: false,
        sessionIndex: true,
        history: false,
        globalState: false,
        sqlite: false,
        trashEntry: false,
        operationJournal: true,
      },
    });
    await expect(readFile(indexPath, "utf8")).resolves.toBe(after);
    expect(await getRecoveryStatus(rootDir)).toMatchObject({ pending: false });
    await expect(access(path.join(rootDir, lock.recoveryRelativePath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports only journal verification when recovering a prepared operation with no mutation payload", async () => {
    const context = await createTrustedRootContext(rootDir);
    await acquireMutationLock(context, "cleanup-index", [FIXTURE_IDS.ACTIVE_ID]);

    const result = await recoverInterruptedOperation(rootDir);

    expect(result).toMatchObject({
      operationStatus: "rolled_back",
      verificationStatus: "passed",
      verificationScope: {
        sessionFiles: false,
        shellSnapshots: false,
        sessionIndex: false,
        history: false,
        globalState: false,
        sqlite: false,
        trashEntry: false,
        operationJournal: true,
      },
    });
  });

  it("keeps the lock and refuses to overwrite an unrecognized third file state", async () => {
    const indexPath = path.join(rootDir, "session_index.jsonl");
    await writeFile(indexPath, "before\n", "utf8");
    const context = await createTrustedRootContext(rootDir);
    const lock = await acquireMutationLock(context, "cleanup-index", [FIXTURE_IDS.ACTIVE_ID]);
    await lock.writeRecoveryPayload({
      schemaVersion: "codex-sessions-recovery.v1",
      operationId: lock.operationId,
      kind: "cleanup-index",
      strategy: "rollforward",
      rootRealPath: context.realPath,
      targetIds: [FIXTURE_IDS.ACTIVE_ID],
      files: [createRecoveryFileTransition("session_index.jsonl", "before\n", "after\n")],
    } satisfies OperationRecoveryPayloadV1);
    await lock.setStage("committing");
    await writeFile(indexPath, "external third state\n", "utf8");

    await expect(recoverInterruptedFiles(rootDir)).rejects.toThrow(/RECOVERY_REQUIRED.*third state/iu);

    await expect(readFile(indexPath, "utf8")).resolves.toBe("external third state\n");
    expect(await getRecoveryStatus(rootDir)).toMatchObject({
      pending: true,
      operationId: lock.operationId,
    });

    const cli = spawn(
      process.execPath,
      ["dist/cli/index.js", "recover", lock.operationId, "--root", rootDir, "--yes", "--json"],
      { cwd: repositoryRoot, stdio: ["ignore", "pipe", "pipe"], env: subprocessEnvironment() },
    );
    let stderr = "";
    cli.stderr.setEncoding("utf8");
    cli.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const [exitCode] = await once(cli, "exit") as [number | null];
    expect(exitCode).toBe(3);
    expect(stderr).toMatch(/RECOVERY_REQUIRED.*third state/iu);
  }, 20_000);

  it("keeps the lock and refuses to overwrite a conflicting SQLite row", async () => {
    const fixture = await createFixture();
    try {
      const context = await createTrustedRootContext(fixture.rootDir);
      const lock = await acquireMutationLock(context, "delete", [FIXTURE_IDS.ACTIVE_ID]);
      const records = exportSqliteRecordsForRestore(
        fixture.paths.sqlite,
        FIXTURE_IDS.ACTIVE_ID,
        null,
        fixture.paths.goalsSqlite,
      ).state;
      await lock.writeRecoveryPayload({
        schemaVersion: "codex-sessions-recovery.v1",
        operationId: lock.operationId,
        kind: "delete",
        strategy: "rollback",
        rootRealPath: context.realPath,
        targetIds: [FIXTURE_IDS.ACTIVE_ID],
        files: [],
        sqlite: {
          sqliteHomeRealPath: context.realPath,
          sqliteHomeIdentity: { dev: context.identity.dev, ino: context.identity.ino },
          stateRelativePath: path.basename(fixture.paths.sqlite),
          goalsRelativePath: path.basename(fixture.paths.goalsSqlite as string),
          records: records as unknown as Record<string, unknown>,
        },
      });
      await lock.setStage("committing");
      const db = new Database(fixture.paths.sqlite);
      db.prepare("update threads set title = ? where id = ?").run("external changed title", FIXTURE_IDS.ACTIVE_ID);
      db.close();

      await expect(recoverInterruptedOperation(fixture.rootDir)).rejects.toThrow(/RECOVERY_REQUIRED.*conflict/iu);

      const verify = new Database(fixture.paths.sqlite, { readonly: true });
      expect((verify.prepare("select title from threads where id = ?").get(FIXTURE_IDS.ACTIVE_ID) as { title: string }).title)
        .toBe("external changed title");
      verify.close();
      expect(await getRecoveryStatus(fixture.rootDir)).toMatchObject({ pending: true, operationId: lock.operationId });
    } finally {
      await fixture.cleanup();
    }
  });

  it("round-trips SQLite BLOB values through the JSON recovery payload", async () => {
    const fixture = await createFixture();
    try {
      const blob = Buffer.from([0, 1, 2, 127, 128, 255]);
      const db = new Database(fixture.paths.sqlite);
      db.prepare("update threads set title = ? where id = ?").run(blob, FIXTURE_IDS.ACTIVE_ID);
      db.close();
      const context = await createTrustedRootContext(fixture.rootDir);
      const lock = await acquireMutationLock(context, "delete", [FIXTURE_IDS.ACTIVE_ID]);
      const records = exportSqliteRecordsForRestore(
        fixture.paths.sqlite,
        FIXTURE_IDS.ACTIVE_ID,
        null,
        fixture.paths.goalsSqlite,
      ).state;
      await lock.writeRecoveryPayload({
        schemaVersion: "codex-sessions-recovery.v1",
        operationId: lock.operationId,
        kind: "delete",
        strategy: "rollback",
        rootRealPath: context.realPath,
        targetIds: [FIXTURE_IDS.ACTIVE_ID],
        files: [],
        sqlite: {
          sqliteHomeRealPath: context.realPath,
          sqliteHomeIdentity: { dev: context.identity.dev, ino: context.identity.ino },
          stateRelativePath: path.basename(fixture.paths.sqlite),
          goalsRelativePath: path.basename(fixture.paths.goalsSqlite as string),
          records: records as unknown as Record<string, unknown>,
        },
      });
      await lock.setStage("committing");
      const remove = new Database(fixture.paths.sqlite);
      remove.pragma("foreign_keys = ON");
      remove.prepare("delete from threads where id = ?").run(FIXTURE_IDS.ACTIVE_ID);
      remove.close();

      await recoverInterruptedOperation(fixture.rootDir);

      const verify = new Database(fixture.paths.sqlite, { readonly: true });
      const restored = verify.prepare("select title from threads where id = ?").get(FIXTURE_IDS.ACTIVE_ID) as {
        title: Buffer;
      };
      verify.close();
      expect(Buffer.isBuffer(restored.title)).toBe(true);
      expect(restored.title.equals(blob)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("refuses recovery when the recorded SQLite trusted-root identity changed", async () => {
    const context = await createTrustedRootContext(rootDir);
    const lock = await acquireMutationLock(context, "delete", [FIXTURE_IDS.ACTIVE_ID]);
    await lock.writeRecoveryPayload({
      schemaVersion: "codex-sessions-recovery.v1",
      operationId: lock.operationId,
      kind: "delete",
      strategy: "rollback",
      rootRealPath: context.realPath,
      targetIds: [FIXTURE_IDS.ACTIVE_ID],
      files: [],
      sqlite: {
        sqliteHomeRealPath: context.realPath,
        sqliteHomeIdentity: { dev: context.identity.dev, ino: context.identity.ino + 1 },
        stateRelativePath: null,
        goalsRelativePath: null,
        records: {
          threads: [],
          logs: [],
          threadSpawnEdges: [],
          agentJobItems: [],
          threadDynamicTools: [],
          stage1Outputs: [],
          threadGoals: [],
        },
      },
    } satisfies OperationRecoveryPayloadV1);
    await lock.setStage("committing");

    await expect(recoverInterruptedOperation(rootDir)).rejects.toThrow(/RECOVERY_REQUIRED.*SQLite recovery root identity/);
    expect(await getRecoveryStatus(rootDir)).toMatchObject({ pending: true, operationId: lock.operationId });
  });

  it("refuses recovery when current config points at a different SQLite trusted root", async () => {
    const context = await createTrustedRootContext(rootDir);
    const lock = await acquireMutationLock(context, "cleanup-index", [FIXTURE_IDS.ACTIVE_ID]);
    await lock.release("recovery_required", { injected: true });
    const replacementSqliteHome = path.join(sandbox, "replacement-sqlite");
    await mkdir(replacementSqliteHome);
    await writeFile(
      path.join(rootDir, "config.toml"),
      `sqlite_home = ${JSON.stringify(replacementSqliteHome)}\n`,
      "utf8",
    );

    await expect(recoverInterruptedOperation(rootDir)).rejects.toThrow(
      /RECOVERY_REQUIRED.*current SQLite home.*operation lock and journal/iu,
    );
    expect(await getRecoveryStatus(rootDir)).toMatchObject({ pending: true, operationId: lock.operationId });
  });

  it("finalizes a committed journal when the process died before removing its lock", async () => {
    const context = await createTrustedRootContext(rootDir);
    const lock = await acquireMutationLock(context, "cleanup-index", [FIXTURE_IDS.ACTIVE_ID]);
    await lock.release("recovery_required", { injected: "after committed data" });
    const journalPath = path.join(rootDir, lock.journalRelativePath);
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
    journal.stage = "committed";
    await writeFile(journalPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");

    const result = await recoverInterruptedFiles(rootDir);

    expect(result.recoveredBy).toBe("finalize-committed");
    expect(await getRecoveryStatus(rootDir)).toMatchObject({ pending: false });
  });

  it.each([
    ["passed", "passed"],
    ["partial", "partial"],
    ["failed", "failed"],
    ["unknown", "not_run"],
    [undefined, "not_run"],
  ] as const)(
    "preserves trusted committed verification status %s and otherwise reports %s",
    async (recordedStatus, expectedStatus) => {
      const context = await createTrustedRootContext(rootDir);
      const lock = await acquireMutationLock(context, "cleanup-index", [FIXTURE_IDS.ACTIVE_ID]);
      await lock.setStage(
        "committed",
        recordedStatus === undefined ? {} : { verificationStatus: recordedStatus },
      );

      const result = await recoverInterruptedOperation(rootDir);

      expect(result.verificationStatus).toBe(expectedStatus);
      expect(result.errorCode).toBe(expectedStatus === "failed" ? "POST_COMMIT_VERIFY_FAILED" : null);
      expect(result.verificationScope).toMatchObject({
        sessionFiles: false,
        shellSnapshots: false,
        sessionIndex: false,
        history: false,
        globalState: false,
        sqlite: false,
        trashEntry: false,
        operationJournal: true,
      });
      expect(result.warnings.join("\n")).toMatch(/stale lock|验证/iu);
      const finalizedJournal = JSON.parse(
        await readFile(path.join(rootDir, lock.journalRelativePath), "utf8"),
      ) as { details?: Record<string, unknown> };
      expect(finalizedJournal.details).toMatchObject({ recoveredStaleLock: true });
      if (recordedStatus === "passed" || recordedStatus === "partial" || recordedStatus === "failed") {
        expect(finalizedJournal.details?.verificationStatus).toBe(recordedStatus);
      }
    },
  );

  it.each([
    ["passed", "passed"],
    ["partial", "partial"],
    ["failed", "failed"],
    [undefined, "not_run"],
  ] as const)(
    "preserves rolled-back verification status %s as %s without a post-commit error",
    async (recordedStatus, expectedStatus) => {
      const context = await createTrustedRootContext(rootDir);
      const lock = await acquireMutationLock(context, "cleanup-index", [FIXTURE_IDS.ACTIVE_ID]);
      await lock.setStage(
        "rolled_back",
        recordedStatus === undefined ? {} : { verificationStatus: recordedStatus },
      );

      const result = await recoverInterruptedOperation(rootDir);

      expect(result.operationStatus).toBe("rolled_back");
      expect(result.recoveredBy).toBe("finalize-rolled-back");
      expect(result.verificationStatus).toBe(expectedStatus);
      expect(result.errorCode).toBeNull();
      expect(result.warnings.join("\n")).toContain("已回滚");
      expect(result.warnings.join("\n")).not.toContain("此前已提交");
    },
  );

  it("regenerates safe warnings from structured journal fields without replaying free-form text", async () => {
    const context = await createTrustedRootContext(rootDir);
    const lock = await acquireMutationLock(context, "restore", [FIXTURE_IDS.ACTIVE_ID]);
    await lock.setStage("committed", {
      verificationStatus: "partial",
      skippedSqliteRows: { total: 1, threadGoals: 1 },
      skippedSqliteTables: ["thread_goals"],
      retainedLogRows: 2,
      warnings: ["/Users/private/session.jsonl\u001b[31m transcript secret"],
    });

    const result = await recoverInterruptedOperation(rootDir);

    expect(result.verificationStatus).toBe("partial");
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("验证不完整"),
      "SQLite 有 1 条记录未恢复（未恢复表：thread_goals）。",
      "manifest 中 2 条 logs 按只读保留策略未恢复。",
    ]));
    expect(result.warnings.join("\n")).not.toContain("/Users/private");
    expect(result.warnings.join("\n")).not.toContain("transcript secret");
    expect(result.warnings.join("\n")).not.toContain("\u001b");
  });

  it.runIf(process.platform !== "win32")(
    "recovers a real SIGKILL after the lock is durable but before the first journal write",
    async () => {
      const boundaryMarker = path.join(sandbox, "operation-lock-committed");
      const childSource = `
        import { writeFile } from 'node:fs/promises';
        import { createTrustedRootContext } from './dist/core/path-safety.js';
        import { acquireMutationLock, setMutationCheckpointHookForTests } from './dist/core/mutation-safety.js';
        setMutationCheckpointHookForTests(async (event) => {
          if (event.name === 'operation-lock' && event.status === 'committed') {
            await writeFile(process.env.CSM_CRASH_MARKER, 'committed\\n', 'utf8');
            await new Promise(() => { setInterval(() => {}, 1000); });
          }
        });
        const context = await createTrustedRootContext(process.env.CSM_CRASH_ROOT);
        await acquireMutationLock(context, 'cleanup-index', [process.env.CSM_CRASH_SESSION]);
      `;
      const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
        cwd: repositoryRoot,
        env: subprocessEnvironment({
          CSM_CRASH_ROOT: rootDir,
          CSM_CRASH_SESSION: FIXTURE_IDS.ACTIVE_ID,
          CSM_CRASH_MARKER: boundaryMarker,
        }),
        stdio: "ignore",
      });
      const childExit = observeChildExit(child);
      try {
        await waitForBoundaryMarker(boundaryMarker, "durable operation-lock checkpoint", childExit);
        await waitForLockWithoutJournal(rootDir, childExit);
        child.kill("SIGKILL");
        await childExit.promise;
      } finally {
        if (!childExit.result) {
          child.kill("SIGKILL");
          await childExit.promise;
        }
      }

      expect(await getRecoveryStatus(rootDir)).toMatchObject({
        pending: true,
        kind: "cleanup-index",
        stage: "prepared",
        hasRecoveryPayload: false,
      });
      const result = await recoverInterruptedOperation(rootDir);

      expect(result).toMatchObject({
        operationStatus: "rolled_back",
        verificationStatus: "passed",
        recoveredBy: "rollback",
      });
      expect(await getRecoveryStatus(rootDir)).toMatchObject({ pending: false });
    },
    20_000,
  );

  it.runIf(process.platform !== "win32")(
    "recovers a real SIGKILL between two index file commits",
    async () => {
      const fixture = await createFixture();
      try {
        const childSource = `
          import { scanCodexRoot } from './dist/core/scan.js';
          import { resolveSessions } from './dist/core/query.js';
          import { cleanupSessionIndexes } from './dist/core/delete.js';
          import { setMutationCheckpointHookForTests } from './dist/core/mutation-safety.js';
          setMutationCheckpointHookForTests(async (event) => {
            if (event.name === 'session-index' && event.status === 'committed') {
              await new Promise(() => { setInterval(() => {}, 1000); });
            }
          });
          const scan = await scanCodexRoot(process.env.CSM_CRASH_ROOT);
          const sessions = resolveSessions(scan, [process.env.CSM_CRASH_SESSION]);
          await cleanupSessionIndexes(scan, sessions, { allowActive: true });
        `;
        const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
          cwd: repositoryRoot,
          env: subprocessEnvironment({
            CSM_CRASH_ROOT: fixture.rootDir,
            CSM_CRASH_SESSION: FIXTURE_IDS.ACTIVE_ID,
          }),
          stdio: "ignore",
        });
        const childExit = observeChildExit(child);
        await waitForCheckpoint(fixture.rootDir, "session-index", "committed", childExit);
        child.kill("SIGKILL");
        await childExit.promise;

        const pending = await getRecoveryStatus(fixture.rootDir);
        expect(pending).toMatchObject({ pending: true, kind: "cleanup-index", stage: "committing" });
        const result = await recoverInterruptedFiles(fixture.rootDir);

        expect(result).toMatchObject({ operationStatus: "committed", recoveredBy: "rollforward" });
        const sessionIndex = await readFile(fixture.paths.sessionIndex, "utf8");
        const history = await readFile(fixture.paths.history, "utf8");
        expect(sessionIndex).not.toContain(FIXTURE_IDS.ACTIVE_ID);
        expect(history).not.toContain(FIXTURE_IDS.ACTIVE_ID);
        expect(sessionIndex).toContain(FIXTURE_IDS.ARCHIVED_ID);
        expect(history).toContain(FIXTURE_IDS.ARCHIVED_ID);
        expect(await getRecoveryStatus(fixture.rootDir)).toMatchObject({ pending: false });
      } finally {
        await fixture.cleanup();
      }
    },
    60_000,
  );

  it.runIf(process.platform !== "win32")(
    "rolls back a real SIGKILL between dedicated goals and state deletion",
    async () => {
      const fixture = await createFixture();
      try {
        const logsBefore = fixture.paths.logsSqlite ? await readFile(fixture.paths.logsSqlite) : null;
        const childSource = `
          import { scanCodexRoot } from './dist/core/scan.js';
          import { resolveSessions } from './dist/core/query.js';
          import { deleteSessions } from './dist/core/delete.js';
          import { setMutationCheckpointHookForTests } from './dist/core/mutation-safety.js';
          setMutationCheckpointHookForTests(async (event) => {
            if (event.name === 'sqlite-goals' && event.status === 'committed') {
              await new Promise(() => { setInterval(() => {}, 1000); });
            }
          });
          const scan = await scanCodexRoot(process.env.CSM_CRASH_ROOT);
          const sessions = resolveSessions(scan, [process.env.CSM_CRASH_SESSION]);
          await deleteSessions(scan, sessions, { allowActive: true });
        `;
        const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
          cwd: repositoryRoot,
          env: subprocessEnvironment({
            CSM_CRASH_ROOT: fixture.rootDir,
            CSM_CRASH_SESSION: FIXTURE_IDS.ACTIVE_ID,
          }),
          stdio: "ignore",
        });
        const childExit = observeChildExit(child);
        await waitForCheckpoint(fixture.rootDir, "sqlite-goals", "committed", childExit);
        child.kill("SIGKILL");
        await childExit.promise;

        const result = await recoverInterruptedOperation(fixture.rootDir);

        expect(result).toMatchObject({ operationStatus: "rolled_back", recoveredBy: "rollback" });
        await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
        await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toContain(FIXTURE_IDS.ACTIVE_ID);
        await expect(readFile(fixture.paths.history, "utf8")).resolves.toContain(FIXTURE_IDS.ACTIVE_ID);
        const stateDb = new Database(fixture.paths.sqlite, { readonly: true });
        expect((stateDb.prepare("select count(*) as count from threads where id = ?").get(FIXTURE_IDS.ACTIVE_ID) as { count: number }).count).toBe(1);
        stateDb.close();
        const goalsDb = new Database(fixture.paths.goalsSqlite as string, { readonly: true });
        expect((goalsDb.prepare("select count(*) as count from thread_goals where thread_id = ?").get(FIXTURE_IDS.ACTIVE_ID) as { count: number }).count).toBe(1);
        goalsDb.close();
        if (fixture.paths.logsSqlite && logsBefore) {
          await expect(readFile(fixture.paths.logsSqlite)).resolves.toEqual(logsBefore);
        }
        expect(await getRecoveryStatus(fixture.rootDir)).toMatchObject({ pending: false });
      } finally {
        await fixture.cleanup();
      }
    },
    60_000,
  );

  it.runIf(process.platform !== "win32")(
    "rolls a real SIGKILL during restore forward from its persisted manifest state",
    async () => {
      const fixture = await createFixture();
      try {
        const scan = await scanCodexRoot(fixture.rootDir);
        const trashed = await moveSessionsToTrash(
          scan,
          resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]),
          { allowActive: true },
        );
        const childSource = `
          import { restoreTrashEntry } from './dist/core/trash.js';
          import { setMutationCheckpointHookForTests } from './dist/core/mutation-safety.js';
          setMutationCheckpointHookForTests(async (event) => {
            if (event.name === 'sqlite' && event.status === 'started') {
              await new Promise(() => { setInterval(() => {}, 1000); });
            }
          });
          await restoreTrashEntry(process.env.CSM_CRASH_ROOT, process.env.CSM_TRASH_ID);
        `;
        const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
          cwd: repositoryRoot,
          env: subprocessEnvironment({
            CSM_CRASH_ROOT: fixture.rootDir,
            CSM_TRASH_ID: trashed.trashEntry.trashId,
          }),
          stdio: "ignore",
        });
        const childExit = observeChildExit(child);
        await waitForCheckpoint(fixture.rootDir, "sqlite", "started", childExit);
        child.kill("SIGKILL");
        await childExit.promise;

        const result = await recoverInterruptedOperation(fixture.rootDir);

        expect(result).toMatchObject({ operationStatus: "committed", recoveredBy: "rollforward" });
        await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
        await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toContain(FIXTURE_IDS.ACTIVE_ID);
        await expect(readFile(fixture.paths.history, "utf8")).resolves.toContain(FIXTURE_IDS.ACTIVE_ID);
        const stateDb = new Database(fixture.paths.sqlite, { readonly: true });
        expect((stateDb.prepare("select count(*) as count from threads where id = ?").get(FIXTURE_IDS.ACTIVE_ID) as { count: number }).count).toBe(1);
        stateDb.close();
        const goalsDb = new Database(fixture.paths.goalsSqlite as string, { readonly: true });
        expect((goalsDb.prepare("select count(*) as count from thread_goals where thread_id = ?").get(FIXTURE_IDS.ACTIVE_ID) as { count: number }).count).toBe(1);
        goalsDb.close();
        expect(await getRecoveryStatus(fixture.rootDir)).toMatchObject({ pending: false });
      } finally {
        await fixture.cleanup();
      }
    },
    60_000,
  );

  it.runIf(process.platform !== "win32")(
    "rolls back a real SIGKILL after committing the trash entry but before live deletion",
    async () => {
      const fixture = await createFixture();
      try {
        const childSource = `
          import { scanCodexRoot } from './dist/core/scan.js';
          import { resolveSessions } from './dist/core/query.js';
          import { moveSessionsToTrash } from './dist/core/trash.js';
          import { setMutationCheckpointHookForTests } from './dist/core/mutation-safety.js';
          setMutationCheckpointHookForTests(async (event) => {
            if (event.name === 'trash-entry' && event.status === 'committed') {
              await new Promise(() => { setInterval(() => {}, 1000); });
            }
          });
          const scan = await scanCodexRoot(process.env.CSM_CRASH_ROOT);
          const sessions = resolveSessions(scan, [process.env.CSM_CRASH_SESSION]);
          await moveSessionsToTrash(scan, sessions, { allowActive: true });
        `;
        const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
          cwd: repositoryRoot,
          env: subprocessEnvironment({
            CSM_CRASH_ROOT: fixture.rootDir,
            CSM_CRASH_SESSION: FIXTURE_IDS.ACTIVE_ID,
          }),
          stdio: "ignore",
        });
        const childExit = observeChildExit(child);
        await waitForCheckpoint(fixture.rootDir, "trash-entry", "committed", childExit);
        child.kill("SIGKILL");
        await childExit.promise;

        const result = await recoverInterruptedOperation(fixture.rootDir);

        expect(result).toMatchObject({ operationStatus: "rolled_back", recoveredBy: "rollback" });
        await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
        const trashEntries = await readdir(path.join(fixture.rootDir, ".codex-sessions-trash"));
        expect(trashEntries.filter((name) => !name.startsWith("."))).toEqual([]);
        expect(await getRecoveryStatus(fixture.rootDir)).toMatchObject({ pending: false });
      } finally {
        await fixture.cleanup();
      }
    },
    60_000,
  );

  it.runIf(process.platform !== "win32")(
    "finishes a real SIGKILL after purge atomically quarantines its trash entry",
    async () => {
      const fixture = await createFixture();
      try {
        const scan = await scanCodexRoot(fixture.rootDir);
        const trashed = await moveSessionsToTrash(
          scan,
          resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID]),
        );
        const childSource = `
          import { purgeTrashEntry } from './dist/core/trash.js';
          import { setMutationCheckpointHookForTests } from './dist/core/mutation-safety.js';
          setMutationCheckpointHookForTests(async (event) => {
            if (event.name === 'purge-quarantine' && event.status === 'committed') {
              await new Promise(() => { setInterval(() => {}, 1000); });
            }
          });
          await purgeTrashEntry(process.env.CSM_CRASH_ROOT, process.env.CSM_TRASH_ID);
        `;
        const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource], {
          cwd: repositoryRoot,
          env: subprocessEnvironment({
            CSM_CRASH_ROOT: fixture.rootDir,
            CSM_TRASH_ID: trashed.trashEntry.trashId,
          }),
          stdio: "ignore",
        });
        const childExit = observeChildExit(child);
        await waitForCheckpoint(fixture.rootDir, "purge-quarantine", "committed", childExit);
        child.kill("SIGKILL");
        await childExit.promise;

        const result = await recoverInterruptedOperation(fixture.rootDir);

        expect(result).toMatchObject({ operationStatus: "committed", recoveredBy: "rollforward" });
        const trashEntries = await readdir(path.join(fixture.rootDir, ".codex-sessions-trash"));
        expect(trashEntries.filter((name) => !name.startsWith("."))).toEqual([]);
        expect(await getRecoveryStatus(fixture.rootDir)).toMatchObject({ pending: false });
      } finally {
        await fixture.cleanup();
      }
    },
    60_000,
  );
});
