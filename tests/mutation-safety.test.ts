import os from "node:os";
import path from "node:path";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTrustedRootContext } from "../src/core/path-safety.js";
import {
  acquireMutationLock,
  assertCanonicalSessionIds,
  atomicWriteManagedText,
  ensureManagedDirectory,
  finalizeInterruptedMutation,
  MUTATION_CHECKPOINT_INVENTORY,
  readInterruptedMutation,
  removeManagedPath,
  renameManagedPath,
  setMutationCheckpointHookForTests,
} from "../src/core/mutation-safety.js";
import { FIXTURE_IDS } from "./helpers/fixture.js";
import { createFileSymlink } from "./helpers/fs-links.js";

describe("mutation safety", () => {
  let sandbox: string;
  let rootDir: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), "csm-mutation-safety-"));
    rootDir = path.join(sandbox, "root");
    await mkdir(path.join(rootDir, "sessions"), { recursive: true });
  });

  afterEach(async () => {
    setMutationCheckpointHookForTests(null);
    await rm(sandbox, { recursive: true, force: true });
  });

  it("accepts full UUIDs and rejects prefixes or path-like session ids", () => {
    expect(() => assertCanonicalSessionIds([FIXTURE_IDS.ACTIVE_ID])).not.toThrow();
    for (const invalidId of [
      FIXTURE_IDS.ACTIVE_ID.slice(0, 12),
      "../../outside",
      "..\\outside",
      "/tmp/outside",
      "C:\\Users\\outside",
      `bad\0${FIXTURE_IDS.ACTIVE_ID}`,
      FIXTURE_IDS.ACTIVE_ID.toUpperCase(),
      "０19d1111-2222-7333-8444-aaaaaaaaaaaa",
      "019d1111-2222-7333-8444-aaaaaaaaaaa/",
      "a".repeat(4_096),
    ]) {
      expect(() => assertCanonicalSessionIds([invalidId]), invalidId).toThrow(/MALFORMED_ID/);
    }
    expect(() => assertCanonicalSessionIds([FIXTURE_IDS.ACTIVE_ID, FIXTURE_IDS.ACTIVE_ID]))
      .toThrow(/MALFORMED_ID.*duplicate/);
  });

  it("atomically replaces a managed file with private permissions", async () => {
    const target = path.join(rootDir, "session_index.jsonl");
    await writeFile(target, "before\n", { mode: 0o600 });
    const context = await createTrustedRootContext(rootDir);

    await atomicWriteManagedText(context, "session_index.jsonl", "after\n");

    await expect(readFile(target, "utf8")).resolves.toBe("after\n");
    if (process.platform !== "win32") {
      expect((await lstat(target)).mode & 0o777).toBe(0o600);
    }
  });

  it("creates nested managed directories and new files with private modes", async () => {
    const context = await createTrustedRootContext(rootDir);

    await atomicWriteManagedText(context, "private/nested/new.json", "{}\n");
    await ensureManagedDirectory(context, "private/nested", 0o700, true);

    await expect(readFile(path.join(rootDir, "private/nested/new.json"), "utf8")).resolves.toBe("{}\n");
    if (process.platform !== "win32") {
      expect((await lstat(path.join(rootDir, "private"))).mode & 0o777).toBe(0o700);
      expect((await lstat(path.join(rootDir, "private/nested/new.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("removes and renames only managed paths", async () => {
    const source = path.join(rootDir, "source.txt");
    await writeFile(source, "source", "utf8");
    const context = await createTrustedRootContext(rootDir);

    expect(await removeManagedPath(context, "missing.txt")).toBe(false);
    await renameManagedPath(context, "source.txt", "renamed.txt");
    await expect(readFile(path.join(rootDir, "renamed.txt"), "utf8")).resolves.toBe("source");
    await writeFile(path.join(rootDir, "occupied.txt"), "occupied", "utf8");
    await expect(renameManagedPath(context, "renamed.txt", "occupied.txt"))
      .rejects.toThrow(/RECOVERY_REQUIRED/);
    expect(await removeManagedPath(context, "renamed.txt", { expectedKind: "file" })).toBe(true);
    await expect(readFile(path.join(rootDir, "renamed.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform !== "win32")("refuses to atomically replace a symlink target", async () => {
    const outside = path.join(sandbox, "outside.jsonl");
    await writeFile(outside, "outside\n", "utf8");
    await createFileSymlink(outside, path.join(rootDir, "session_index.jsonl"));
    const context = await createTrustedRootContext(rootDir);

    await expect(atomicWriteManagedText(context, "session_index.jsonl", "changed\n"))
      .rejects.toThrow(/UNSAFE_PATH/);
    await expect(readFile(outside, "utf8")).resolves.toBe("outside\n");
  });

  it("uses an exclusive lock and releases it explicitly", async () => {
    const context = await createTrustedRootContext(rootDir);
    const first = await acquireMutationLock(context, "delete", [FIXTURE_IDS.ACTIVE_ID]);

    await expect(acquireMutationLock(context, "cleanup-stale", [FIXTURE_IDS.STALE_ID]))
      .rejects.toThrow(/RECOVERY_REQUIRED/);

    await first.release("rolled_back");
    const second = await acquireMutationLock(context, "cleanup-stale", [FIXTURE_IDS.STALE_ID]);
    await second.release("committed");
  });

  it("keeps the exclusive lock when recovery is required", async () => {
    const context = await createTrustedRootContext(rootDir);
    const first = await acquireMutationLock(context, "delete", [FIXTURE_IDS.ACTIVE_ID]);

    await first.release("recovery_required", { reason: "injected crash" });

    await expect(acquireMutationLock(context, "cleanup-stale", [FIXTURE_IDS.STALE_ID]))
      .rejects.toThrow(/RECOVERY_REQUIRED/);
    const journal = JSON.parse(
      await readFile(path.join(rootDir, first.journalRelativePath), "utf8"),
    ) as { stage: string; details: { reason: string } };
    expect(journal).toMatchObject({
      stage: "recovery_required",
      details: { reason: "injected crash" },
    });
  });

  it("persists recovery material and ordered mutation checkpoints", async () => {
    const context = await createTrustedRootContext(rootDir);
    const lock = await acquireMutationLock(context, "delete", [FIXTURE_IDS.ACTIVE_ID]);
    await lock.writeRecoveryPayload({
      schemaVersion: "codex-sessions-recovery.v1",
      kind: "delete",
      targetIds: [FIXTURE_IDS.ACTIVE_ID],
    });
    await lock.checkpoint("session-index", "started", { beforeHash: "a", afterHash: "b" });
    await lock.checkpoint("session-index", "committed", { afterHash: "b" });

    const interrupted = await readInterruptedMutation(context);

    expect(interrupted).toMatchObject({
      operationId: lock.operationId,
      kind: "delete",
      targetIds: [FIXTURE_IDS.ACTIVE_ID],
      recoveryPayload: {
        schemaVersion: "codex-sessions-recovery.v1",
        kind: "delete",
      },
      journal: {
        schemaVersion: "codex-sessions-operation.v2",
        stage: "prepared",
        checkpoints: [
          { name: "recovery-payload", status: "committed" },
          { name: "session-index", status: "started" },
          { name: "session-index", status: "committed" },
        ],
      },
    });
    if (process.platform !== "win32") {
      expect((await lstat(path.join(rootDir, lock.recoveryRelativePath))).mode & 0o777).toBe(0o600);
    }
    await lock.release("rolled_back");
  });

  it("registers every delete, trash, restore, purge, and cleanup mutation boundary", () => {
    const names = (kind: keyof typeof MUTATION_CHECKPOINT_INVENTORY) =>
      MUTATION_CHECKPOINT_INVENTORY[kind].map((entry) => entry.name);

    expect(names("delete")).toEqual([
      "operation-lock",
      "recovery-payload",
      "session-index",
      "history",
      "global-state",
      "session-file",
      "shell-snapshot",
      "sqlite-goals",
      "sqlite-state",
    ]);
    expect(names("trash")).toEqual([
      "operation-lock",
      "recovery-payload",
      "trash-entry",
      "session-index",
      "history",
      "global-state",
      "session-file",
      "shell-snapshot",
      "sqlite-goals",
      "sqlite-state",
    ]);
    expect(names("restore")).toEqual([
      "operation-lock",
      "recovery-payload",
      "session-file",
      "shell-snapshot",
      "session-index",
      "history",
      "global-state",
      "sqlite",
    ]);
    expect(names("purge")).toEqual([
      "operation-lock",
      "recovery-payload",
      "purge-logs",
      "purge-quarantine",
      "purge-remove",
    ]);
    expect(names("cleanup-index")).toEqual([
      "operation-lock",
      "recovery-payload",
      "session-index",
      "history",
    ]);
    expect(names("cleanup-stale")).toEqual(names("cleanup-index"));
  });

  it("keeps every literal production checkpoint in the maintained inventory", async () => {
    const sourceFiles = [
      "src/core/mutation-safety.ts",
      "src/core/delete.ts",
      "src/core/trash.ts",
    ];
    const literals = new Set<string>(["operation-lock"]);
    for (const sourceFile of sourceFiles) {
      const source = await readFile(path.resolve(import.meta.dirname, "..", sourceFile), "utf8");
      for (const match of source.matchAll(/checkpoint\("([a-z-]+)"/gu)) {
        literals.add(match[1]);
      }
    }
    const registered = new Set(
      Object.values(MUTATION_CHECKPOINT_INVENTORY).flatMap((entries) => entries.map((entry) => entry.name)),
    );

    expect([...literals].sort()).toEqual([...registered].sort());
  });

  it("enforces operation-specific checkpoint names and statuses at journal write time", async () => {
    const context = await createTrustedRootContext(rootDir);
    const kinds = Object.keys(MUTATION_CHECKPOINT_INVENTORY) as Array<keyof typeof MUTATION_CHECKPOINT_INVENTORY>;

    for (const kind of kinds) {
      const lock = await acquireMutationLock(context, kind, [FIXTURE_IDS.STALE_ID]);
      for (const entry of MUTATION_CHECKPOINT_INVENTORY[kind]) {
        if (entry.name === "operation-lock" || entry.name === "recovery-payload") continue;
        for (const status of entry.statuses) {
          await expect(lock.checkpoint(entry.name, status)).resolves.toBeUndefined();
        }
      }
      const foreignEntry = Object.values(MUTATION_CHECKPOINT_INVENTORY)
        .flat()
        .find((entry) => !MUTATION_CHECKPOINT_INVENTORY[kind].some((candidate) => candidate.name === entry.name));
      if (foreignEntry) {
        await expect(lock.checkpoint(foreignEntry.name, foreignEntry.statuses[0]))
          .rejects.toThrow(/RECOVERY_REQUIRED.*checkpoint.*not registered/iu);
      }
      await lock.release("rolled_back");
    }
  });

  it("provides a deterministic failure-injection path for every registered durable boundary", async () => {
    const kinds = Object.keys(MUTATION_CHECKPOINT_INVENTORY) as Array<keyof typeof MUTATION_CHECKPOINT_INVENTORY>;

    for (const kind of kinds) {
      for (const entry of MUTATION_CHECKPOINT_INVENTORY[kind]) {
        for (const status of entry.statuses) {
          const expectedMessage = `injected ${kind}:${entry.name}:${status}`;
          setMutationCheckpointHookForTests((event) => {
            if (event.kind === kind && event.name === entry.name && event.status === status) {
              throw new Error(expectedMessage);
            }
          });

          if (entry.name === "operation-lock") {
            const context = await createTrustedRootContext(rootDir);
            await expect(acquireMutationLock(context, kind, [FIXTURE_IDS.STALE_ID]))
              .rejects.toThrow(expectedMessage);
            setMutationCheckpointHookForTests(null);
            const interrupted = await readInterruptedMutation(context);
            expect(interrupted).not.toBeNull();
            await finalizeInterruptedMutation(context, interrupted!, "rolled_back", { injectedBoundary: expectedMessage });
            continue;
          }

          setMutationCheckpointHookForTests(null);
          const context = await createTrustedRootContext(rootDir);
          const lock = await acquireMutationLock(context, kind, [FIXTURE_IDS.STALE_ID]);
          setMutationCheckpointHookForTests((event) => {
            if (event.kind === kind && event.name === entry.name && event.status === status) {
              throw new Error(expectedMessage);
            }
          });
          if (entry.name === "recovery-payload") {
            await expect(lock.writeRecoveryPayload({ injectedBoundary: expectedMessage }))
              .rejects.toThrow(expectedMessage);
          } else {
            await expect(lock.checkpoint(entry.name, status)).rejects.toThrow(expectedMessage);
          }
          setMutationCheckpointHookForTests(null);
          await lock.release("rolled_back", { injectedBoundary: expectedMessage });
        }
      }
    }
  });

  it("reports no interrupted operation when no lock exists", async () => {
    const context = await createTrustedRootContext(rootDir);
    await expect(readInterruptedMutation(context)).resolves.toBeNull();
  });

  it("treats an owned lock without a journal as a recoverable pre-mutation interruption", async () => {
    const context = await createTrustedRootContext(rootDir);
    const lock = await acquireMutationLock(context, "delete", [FIXTURE_IDS.ACTIVE_ID]);
    await rm(path.join(rootDir, lock.journalRelativePath));

    const interrupted = await readInterruptedMutation(context);

    expect(interrupted).toMatchObject({
      operationId: lock.operationId,
      kind: "delete",
      recoveryPayload: null,
      journal: {
        stage: "prepared",
        checkpoints: [],
        details: { journalMissingAfterLockAcquisition: true },
      },
    });
    await finalizeInterruptedMutation(context, interrupted!, "rolled_back", { recoveredBeforeJournal: true });
    await expect(readInterruptedMutation(context)).resolves.toBeNull();
  });

  it("binds an interrupted operation to the original trusted-root identity", async () => {
    const context = await createTrustedRootContext(rootDir);
    await acquireMutationLock(context, "delete", [FIXTURE_IDS.ACTIVE_ID]);
    const lockPath = path.join(rootDir, ".codex-sessions-trash", ".operation.lock");
    const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
      rootIdentity: { dev: number; ino: number };
    };
    lock.rootIdentity.ino += 1;
    await writeFile(lockPath, `${JSON.stringify(lock)}\n`, "utf8");

    await expect(readInterruptedMutation(context)).rejects.toThrow(/RECOVERY_REQUIRED.*lock schema/);
  });

  it("rejects malformed or inconsistent interrupted-operation metadata", async () => {
    const context = await createTrustedRootContext(rootDir);
    await ensureManagedDirectory(context, ".codex-sessions-trash/.operations", 0o700, true);
    const lockPath = path.join(rootDir, ".codex-sessions-trash/.operation.lock");

    await writeFile(lockPath, "not-json\n", { mode: 0o600 });
    await expect(readInterruptedMutation(context)).rejects.toThrow(/RECOVERY_REQUIRED.*invalid JSON/);

    await writeFile(lockPath, `${JSON.stringify({ operationId: "bad", kind: "delete", targetIds: [] })}\n`, { mode: 0o600 });
    await expect(readInterruptedMutation(context)).rejects.toThrow(/RECOVERY_REQUIRED.*schema/);

    const operationId = "019d1111-2222-7333-8444-cccccccccccc";
    await writeFile(
      lockPath,
      `${JSON.stringify({
        operationId,
        kind: "delete",
        targetIds: [FIXTURE_IDS.ACTIVE_ID],
        rootRealPath: context.realPath,
        rootIdentity: { dev: context.identity.dev, ino: context.identity.ino },
        sqliteHomeRealPath: context.realPath,
        sqliteHomeIdentity: { dev: context.identity.dev, ino: context.identity.ino },
      })}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      path.join(rootDir, `.codex-sessions-trash/.operations/${operationId}.json`),
      `${JSON.stringify({ schemaVersion: "wrong", operationId, kind: "delete" })}\n`,
      { mode: 0o600 },
    );
    await expect(readInterruptedMutation(context)).rejects.toThrow(/RECOVERY_REQUIRED.*does not match/);

    const validJournal = {
      schemaVersion: "codex-sessions-operation.v2",
      operationId,
      kind: "delete",
      targetIds: [FIXTURE_IDS.ACTIVE_ID],
      rootRealPath: context.realPath,
      rootIdentity: { dev: context.identity.dev, ino: context.identity.ino },
      sqliteHomeRealPath: context.realPath,
      sqliteHomeIdentity: { dev: context.identity.dev, ino: context.identity.ino },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      stage: "not-a-real-stage",
      details: {},
      recoveryRelativePath: `.codex-sessions-trash/.operations/${operationId}.recovery.json`,
      checkpoints: [],
    };
    await writeFile(
      path.join(rootDir, `.codex-sessions-trash/.operations/${operationId}.json`),
      `${JSON.stringify(validJournal)}\n`,
      { mode: 0o600 },
    );
    await expect(readInterruptedMutation(context)).rejects.toThrow(/RECOVERY_REQUIRED.*does not match/);

    validJournal.stage = "prepared";
    validJournal.checkpoints = [{ name: "index", status: "unknown" }] as never[];
    await writeFile(
      path.join(rootDir, `.codex-sessions-trash/.operations/${operationId}.json`),
      `${JSON.stringify(validJournal)}\n`,
      { mode: 0o600 },
    );
    await expect(readInterruptedMutation(context)).rejects.toThrow(/RECOVERY_REQUIRED.*checkpoint schema/);
  });

  it("finalizes an interrupted operation and removes its recovery lock", async () => {
    const context = await createTrustedRootContext(rootDir);
    const lock = await acquireMutationLock(context, "delete", [FIXTURE_IDS.ACTIVE_ID]);
    await lock.writeRecoveryPayload({ schemaVersion: "test" });
    const interrupted = await readInterruptedMutation(context);
    expect(interrupted).not.toBeNull();

    await finalizeInterruptedMutation(context, interrupted!, "rolled_back", { reason: "test" });

    await expect(readInterruptedMutation(context)).resolves.toBeNull();
    const journal = JSON.parse(await readFile(path.join(rootDir, lock.journalRelativePath), "utf8")) as {
      stage: string;
      details: Record<string, unknown>;
    };
    expect(journal).toMatchObject({ stage: "rolled_back", details: { reason: "test" } });
  });

  it.runIf(process.platform !== "win32")("restricts journal directories and files to private modes", async () => {
    const context = await createTrustedRootContext(rootDir);
    const lock = await acquireMutationLock(context, "delete", [FIXTURE_IDS.ACTIVE_ID]);

    expect((await lstat(path.join(rootDir, ".codex-sessions-trash"))).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(rootDir, ".codex-sessions-trash", ".operations"))).mode & 0o777).toBe(0o700);
    expect((await lstat(path.join(rootDir, ".codex-sessions-trash", ".operation.lock"))).mode & 0o777).toBe(0o600);
    expect((await lstat(path.join(rootDir, lock.journalRelativePath))).mode & 0o777).toBe(0o600);

    await lock.release("committed");
  });

  it("refuses to release a lock whose owner was changed", async () => {
    const context = await createTrustedRootContext(rootDir);
    const lock = await acquireMutationLock(context, "delete", [FIXTURE_IDS.ACTIVE_ID]);
    await writeFile(
      path.join(rootDir, ".codex-sessions-trash", ".operation.lock"),
      `${JSON.stringify({ operationId: "different-owner" })}\n`,
      "utf8",
    );

    await expect(lock.release("committed")).rejects.toThrow(/RECOVERY_REQUIRED/);
  });
});
