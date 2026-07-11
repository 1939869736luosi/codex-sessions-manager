import path from "node:path";
import crypto from "node:crypto";
import { access, appendFile, chmod, lstat, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveSessions } from "../src/core/query.js";
import { scanCodexRoot } from "../src/core/scan.js";
import {
  listTrashEntries,
  moveSessionsToTrash,
  purgeTrashEntry,
  restoreTrashEntry,
} from "../src/core/trash.js";
import { createFixture, FIXTURE_IDS, type Fixture } from "./helpers/fixture.js";
import { createDirectoryLink, createFileSymlink } from "./helpers/fs-links.js";
import { setMutationCheckpointHookForTests } from "../src/core/mutation-safety.js";

async function waitForOperationStage(
  rootPath: string,
  kind: string,
  stage?: string,
): Promise<void> {
  const lockPath = path.join(rootPath, ".codex-sessions-trash", ".operation.lock");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const lock = JSON.parse(await readFile(lockPath, "utf8")) as { operationId: string; kind: string };
      if (lock.kind !== kind) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
        continue;
      }
      if (!stage) return;
      const journalPath = path.join(
        rootPath,
        ".codex-sessions-trash",
        ".operations",
        `${lock.operationId}.json`,
      );
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as { stage?: string };
      if (journal.stage === stage) return;
    } catch {
      // The operation has not created its lock/journal yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${kind}:${stage ?? "lock"}`);
}

describe("trash security and recovery", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    setMutationCheckpointHookForTests(null);
    vi.restoreAllMocks();
    if (fixture.paths.logsSqlite) {
      await chmod(fixture.paths.logsSqlite, 0o600).catch(() => undefined);
    }
    await fixture.cleanup();
  });

  it("reports committed/failed when purge completes but post-commit verification fails", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID]);
    const trashed = await moveSessionsToTrash(scan, session, { allowActive: true });
    const recreatedEntry = path.join(
      fixture.rootDir,
      ".codex-sessions-trash",
      trashed.trashEntry.trashId,
    );
    setMutationCheckpointHookForTests(async (event) => {
      if (event.name === "purge-remove" && event.status === "committed") {
        await mkdir(recreatedEntry, { recursive: true });
      }
    });

    const result = await purgeTrashEntry(fixture.rootDir, trashed.trashEntry.trashId);

    expect(result).toMatchObject({
      purged: true,
      operationStatus: "committed",
      verificationStatus: "failed",
      errorCode: "POST_COMMIT_VERIFY_FAILED",
    });
    expect(result.warnings.join("\n")).toContain("已经完成");
    await expect(access(path.join(fixture.rootDir, ".codex-sessions-trash", ".operation.lock")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("round-trips SQLite BLOB values through a trash manifest without changing bytes", async () => {
    const blob = Buffer.from([0, 1, 2, 127, 128, 255]);
    const db = new Database(fixture.paths.sqlite);
    db.prepare("update threads set title = ? where id = ?").run(blob, FIXTURE_IDS.ARCHIVED_ID);
    db.close();
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID]);
    const trashed = await moveSessionsToTrash(scan, session, { allowActive: true });
    const manifestPath = path.join(
      fixture.rootDir,
      ".codex-sessions-trash",
      trashed.trashEntry.trashId,
      "manifest.json",
    );

    const manifestText = await readFile(manifestPath, "utf8");
    expect(manifestText).toContain("$codexSessionsManagerBytesV1");
    await restoreTrashEntry(fixture.rootDir, trashed.trashEntry.trashId);

    const verify = new Database(fixture.paths.sqlite, { readonly: true });
    const restored = verify.prepare("select title from threads where id = ?").get(FIXTURE_IDS.ARCHIVED_ID) as {
      title: Buffer;
    };
    verify.close();
    expect(Buffer.isBuffer(restored.title)).toBe(true);
    expect(restored.title.equals(blob)).toBe(true);
  });

  it("returns committed/failed when restore data is complete but post-commit verification fails", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID]);
    const trashed = await moveSessionsToTrash(scan, session, { allowActive: true });
    const sentinel = `${JSON.stringify({
      id: FIXTURE_IDS.UNRELATED_ID,
      thread_name: "post-commit sentinel",
      updated_at: "2026-07-11T00:00:00.000Z",
    })}\n`;
    setMutationCheckpointHookForTests(async (event) => {
      if (event.kind === "restore" && event.name === "sqlite" && event.status === "committed") {
        await appendFile(fixture.paths.sessionIndex, sentinel, "utf8");
        const db = new Database(fixture.paths.sqlite);
        db.prepare("update threads set title = ? where id = ?")
          .run("post-commit concurrent title", FIXTURE_IDS.ARCHIVED_ID);
        db.close();
      }
    });

    const result = await restoreTrashEntry(fixture.rootDir, trashed.trashEntry.trashId);

    expect(result).toMatchObject({
      operationStatus: "committed",
      verificationStatus: "failed",
      errorCode: "POST_COMMIT_VERIFY_FAILED",
    });
    expect(result.warnings.join("\n")).toContain("已完成");
    await expect(readFile(fixture.paths.archivedSessionFile, "utf8")).resolves.toContain("archived assistant output");
    await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toContain("post-commit sentinel");
    const verify = new Database(fixture.paths.sqlite, { readonly: true });
    expect((verify.prepare("select title from threads where id = ?").get(FIXTURE_IDS.ARCHIVED_ID) as { title: string }).title)
      .toBe("post-commit concurrent title");
    verify.close();
    await expect(access(path.join(fixture.rootDir, ".codex-sessions-trash", ".operation.lock")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a concurrent same-ID SQLite row when restore later fails", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID]);
    const trashed = await moveSessionsToTrash(scan, session, { allowActive: true });
    setMutationCheckpointHookForTests((event) => {
      if (event.kind === "restore" && event.name === "global-state" && event.status === "committed") {
        const db = new Database(fixture.paths.sqlite);
        db.prepare(
          `insert into threads (id, title, first_user_message, created_at, updated_at, archived, rollout_path, model, cwd)
           values (?, 'Concurrent same-id row', 'must survive', 1, 2, 0, null, 'gpt-test', '/concurrent')`,
        ).run(FIXTURE_IDS.ARCHIVED_ID);
        db.close();
      }
    });

    await expect(restoreTrashEntry(fixture.rootDir, trashed.trashEntry.trashId))
      .rejects.toThrow(/恢复失败，已回滚|UNIQUE/iu);

    const verify = new Database(fixture.paths.sqlite, { readonly: true });
    const row = verify.prepare("select title, first_user_message from threads where id = ?")
      .get(FIXTURE_IDS.ARCHIVED_ID) as { title: string; first_user_message: string };
    verify.close();
    expect(row).toEqual({ title: "Concurrent same-id row", first_user_message: "must survive" });
    await expect(access(fixture.paths.archivedSessionFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("marks a manifest invalid when a global-state reference has a forged schema", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID]);
    const trashed = await moveSessionsToTrash(scan, session, { allowActive: true });
    const manifestPath = path.join(
      fixture.rootDir,
      ".codex-sessions-trash",
      trashed.trashEntry.trashId,
      "manifest.json",
    );
    const bundle = JSON.parse(await readFile(manifestPath, "utf8")) as {
      globalStateRefs: Array<Record<string, unknown>>;
    };
    expect(bundle.globalStateRefs.length).toBeGreaterThan(0);
    bundle.globalStateRefs[0].path = "$.queued-follow-ups.forged";
    bundle.globalStateRefs[0].kind = "object-string-value";
    await writeFile(manifestPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

    const entries = await listTrashEntries(fixture.rootDir);

    expect(entries).toContainEqual(expect.objectContaining({
      trashId: trashed.trashEntry.trashId,
      status: "invalid",
      invalidReason: expect.stringContaining("globalStateRef"),
    }));
    await expect(restoreTrashEntry(fixture.rootDir, trashed.trashEntry.trashId)).rejects.toThrow(/无效|globalStateRef/u);
  });

  it("lists a damaged manifest as invalid and refuses restore and purge", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID]);
    const trashed = await moveSessionsToTrash(scan, session, { allowActive: true });
    const manifestPath = path.join(
      fixture.rootDir,
      ".codex-sessions-trash",
      trashed.trashEntry.trashId,
      "manifest.json",
    );
    await writeFile(manifestPath, "{ damaged manifest\n", "utf8");

    const entries = await listTrashEntries(fixture.rootDir);

    expect(entries).toContainEqual(expect.objectContaining({
      trashId: trashed.trashEntry.trashId,
      status: "invalid",
      invalidReason: expect.stringContaining("manifest"),
    }));
    await expect(restoreTrashEntry(fixture.rootDir, trashed.trashEntry.trashId))
      .rejects.toThrow(/无效|invalid|manifest/u);
    await expect(purgeTrashEntry(fixture.rootDir, trashed.trashEntry.trashId))
      .rejects.toThrow(/无效|invalid|manifest/u);
    await expect(readFile(manifestPath, "utf8")).resolves.toBe("{ damaged manifest\n");
  });

  it("marks a manifest invalid when restore payloads target an unrelated session", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID]);
    const trashed = await moveSessionsToTrash(scan, session, { allowActive: true });
    const manifestPath = path.join(
      fixture.rootDir,
      ".codex-sessions-trash",
      trashed.trashEntry.trashId,
      "manifest.json",
    );
    const bundle = JSON.parse(await readFile(manifestPath, "utf8")) as {
      sessionFiles: Array<Record<string, unknown>>;
      historyRecords: Array<Record<string, unknown>>;
    };
    bundle.sessionFiles.push({
      sessionId: FIXTURE_IDS.UNRELATED_ID,
      path: "sessions/2026/07/11/unrelated.jsonl",
      text: "unrelated payload\n",
      encoding: "utf8",
    });
    bundle.historyRecords.push({ session_id: FIXTURE_IDS.UNRELATED_ID, text: "unrelated history" });
    await writeFile(manifestPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

    const entries = await listTrashEntries(fixture.rootDir);

    expect(entries[0]).toMatchObject({ status: "invalid" });
    await expect(restoreTrashEntry(fixture.rootDir, trashed.trashEntry.trashId))
      .rejects.toThrow(/无效|manifest/u);
    await expect(readFile(path.join(fixture.rootDir, "sessions/2026/07/11/unrelated.jsonl"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not read or rewrite the dedicated logs database while restoring", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    const trashed = await moveSessionsToTrash(scan, session, { allowActive: true });
    const logsPath = fixture.paths.logsSqlite as string;
    const before = await readFile(logsPath);
    const oldTimestamp = new Date("2001-01-01T00:00:00.000Z");
    await utimes(logsPath, oldTimestamp, oldTimestamp);
    const beforeMtime = (await stat(logsPath)).mtimeMs;
    const goalsDb = new Database(fixture.paths.goalsSqlite as string);
    goalsDb.exec(`
      create trigger fail_goals_restore_without_logs_snapshot
      before insert on thread_goals
      when new.thread_id = '${FIXTURE_IDS.ACTIVE_ID}'
      begin
        select raise(abort, 'blocked goals restore');
      end;
    `);
    goalsDb.close();

    await expect(restoreTrashEntry(fixture.rootDir, trashed.trashEntry.trashId))
      .rejects.toThrow(/恢复失败/u);

    await expect(readFile(logsPath)).resolves.toEqual(before);
    expect((await stat(logsPath)).mtimeMs).toBe(beforeMtime);
    const source = await readFile(new URL("../src/core/trash.ts", import.meta.url), "utf8");
    expect(source).not.toContain("paths.add(scan.root.logsSqlitePath)");
    expect(source).not.toMatch(/captureFileSnapshot\(scan\.root\.(?:sqlitePath|logsSqlitePath|goalsSqlitePath)/u);
  });

  it("rolls back only this restore's session rows when state SQLite uses WAL", async () => {
    const stateDb = new Database(fixture.paths.sqlite);
    expect(stateDb.pragma("journal_mode = WAL", { simple: true })).toBe("wal");
    stateDb.prepare(
      `insert into threads (id, title, first_user_message, created_at, updated_at, archived, rollout_path, model, cwd)
       values (?, 'Unrelated sentinel', 'keep', 1, 2, 0, null, 'gpt-5.4', '/workspace/unrelated')`,
    ).run(FIXTURE_IDS.UNRELATED_ID);
    stateDb.close();
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    const trashed = await moveSessionsToTrash(scan, session, { allowActive: true });
    const goalsDb = new Database(fixture.paths.goalsSqlite as string);
    goalsDb.exec(`
      create trigger fail_wal_restore
      before insert on thread_goals
      when new.thread_id = '${FIXTURE_IDS.ACTIVE_ID}'
      begin
        select raise(abort, 'blocked WAL restore');
      end;
    `);
    goalsDb.close();

    await expect(restoreTrashEntry(fixture.rootDir, trashed.trashEntry.trashId))
      .rejects.toThrow(/恢复失败，已回滚/u);

    const verifyDb = new Database(fixture.paths.sqlite, { readonly: true });
    const restoredThreads = verifyDb.prepare("select count(*) as count from threads where id = ?")
      .get(FIXTURE_IDS.ACTIVE_ID) as { count: number };
    const unrelatedThreads = verifyDb.prepare("select count(*) as count from threads where id = ?")
      .get(FIXTURE_IDS.UNRELATED_ID) as { count: number };
    expect(verifyDb.pragma("journal_mode", { simple: true })).toBe("wal");
    verifyDb.close();
    expect(restoredThreads.count).toBe(0);
    expect(unrelatedThreads.count).toBe(1);
  });

  it("restores managed files atomically with private permissions", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    const trashed = await moveSessionsToTrash(scan, session, { allowActive: true });

    await restoreTrashEntry(fixture.rootDir, trashed.trashEntry.trashId);

    const rolloutMode = (await stat(fixture.paths.activeSessionFile)).mode & 0o777;
    const snapshotMode = (await stat(fixture.paths.activeShellSnapshot)).mode & 0o777;
    const trashMode = (await stat(path.join(fixture.rootDir, ".codex-sessions-trash"))).mode & 0o777;
    const operationsMode = (await stat(path.join(fixture.rootDir, ".codex-sessions-trash", ".operations"))).mode & 0o777;
    const manifestMode = (
      await stat(path.join(fixture.rootDir, ".codex-sessions-trash", trashed.trashEntry.trashId, "manifest.json"))
    ).mode & 0o777;
    const operationsDir = path.join(fixture.rootDir, ".codex-sessions-trash", ".operations");
    const journalNames = await readdir(operationsDir);

    expect(rolloutMode).toBe(0o600);
    expect(snapshotMode).toBe(0o600);
    expect(trashMode).toBe(0o700);
    expect(operationsMode).toBe(0o700);
    expect(manifestMode).toBe(0o600);
    expect(journalNames.length).toBeGreaterThanOrEqual(2);
    for (const journalName of journalNames) {
      const journalPath = path.join(operationsDir, journalName);
      expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
      expect(JSON.parse(await readFile(journalPath, "utf8"))).toMatchObject({ stage: "committed" });
    }
  });

  it.runIf(process.platform !== "win32")("does not follow a rollout symlink introduced after scan while building trash", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID]);
    const outside = path.join(path.dirname(fixture.rootDir), `trash-outside-${crypto.randomUUID()}.jsonl`);
    await writeFile(outside, "outside secret\n", "utf8");
    await rm(fixture.paths.archivedSessionFile);
    await createFileSymlink(outside, fixture.paths.archivedSessionFile);

    try {
      await expect(moveSessionsToTrash(scan, session, { allowActive: true })).rejects.toThrow(/UNSAFE_PATH|STALE_PLAN/u);
      expect((await lstat(fixture.paths.archivedSessionFile)).isSymbolicLink()).toBe(true);
      await expect(readFile(outside, "utf8")).resolves.toBe("outside secret\n");
    } finally {
      await rm(outside, { force: true });
    }
  });

  it("refuses a regular rollout file changed after scan", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID]);
    await writeFile(fixture.paths.archivedSessionFile, "replacement after preview\n", "utf8");

    await expect(moveSessionsToTrash(scan, session, { allowActive: true })).rejects.toThrow(/STALE_PLAN/u);

    await expect(readFile(fixture.paths.archivedSessionFile, "utf8"))
      .resolves.toBe("replacement after preview\n");
    expect(await listTrashEntries(fixture.rootDir)).toEqual([]);
  });

  it("accepts the same canonical root when trash was created through a root symlink", async () => {
    const rootAlias = path.join(path.dirname(fixture.rootDir), `codex-root-alias-${crypto.randomUUID()}`);
    await createDirectoryLink(fixture.rootDir, rootAlias);
    try {
      const scan = await scanCodexRoot(rootAlias);
      const session = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID]);
      const trashed = await moveSessionsToTrash(scan, session, { allowActive: true });

      const restored = await restoreTrashEntry(fixture.rootDir, trashed.trashEntry.trashId);

      expect(restored.restoredSessionIds).toEqual([FIXTURE_IDS.ARCHIVED_ID]);
      await expect(readFile(fixture.paths.archivedSessionFile, "utf8"))
        .resolves.toContain("archived assistant output");
    } finally {
      await rm(rootAlias, { force: true });
    }
  });

  it("preserves an index appended on the same inode after restore snapshots it", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID]);
    const trashed = await moveSessionsToTrash(scan, session);
    const manifestPath = path.join(
      fixture.rootDir,
      ".codex-sessions-trash",
      trashed.trashEntry.trashId,
      "manifest.json",
    );
    const bundle = JSON.parse(await readFile(manifestPath, "utf8")) as {
      sessionFiles: Array<{ text: string }>;
    };
    bundle.sessionFiles[0].text = "x".repeat(32 * 1024 * 1024);
    await writeFile(manifestPath, `${JSON.stringify(bundle)}\n`, "utf8");
    const sentinel = `${JSON.stringify({
      id: FIXTURE_IDS.UNRELATED_ID,
      thread_name: "same-inode concurrent append",
      updated_at: "2026-07-11T00:00:00.000Z",
    })}\n`;
    const outcome = restoreTrashEntry(fixture.rootDir, trashed.trashEntry.trashId).then(
      (value) => ({ value, error: null as Error | null }),
      (error: Error) => ({ value: null, error }),
    );
    await waitForOperationStage(fixture.rootDir, "restore", "committing");
    await appendFile(fixture.paths.sessionIndex, sentinel, "utf8");

    const result = await outcome;

    expect(result.value).toBeNull();
    expect(result.error?.message).toMatch(/STALE_PLAN/u);
    await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toContain("same-inode concurrent append");
    await expect(access(fixture.paths.archivedSessionFile)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  it("refuses purge when manifest content changes on the same inode after planning", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID]);
    const trashed = await moveSessionsToTrash(scan, session);
    const manifestPath = path.join(
      fixture.rootDir,
      ".codex-sessions-trash",
      trashed.trashEntry.trashId,
      "manifest.json",
    );
    const original = await readFile(manifestPath, "utf8");
    const tampered = original.replace("Archived thread", "Archived thrEad");
    expect(tampered).not.toBe(original);
    const outcome = purgeTrashEntry(fixture.rootDir, trashed.trashEntry.trashId).then(
      (value) => ({ value, error: null as Error | null }),
      (error: Error) => ({ value: null, error }),
    );
    await waitForOperationStage(fixture.rootDir, "purge");
    await writeFile(manifestPath, tampered, "utf8");

    const result = await outcome;

    expect(result.value).toBeNull();
    expect(result.error?.message).toMatch(/STALE_PLAN/u);
    await expect(readFile(manifestPath, "utf8")).resolves.toBe(tampered);
  });

  it("refuses restore when manifest content changes on the same inode after planning", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID]);
    const trashed = await moveSessionsToTrash(scan, session);
    const manifestPath = path.join(
      fixture.rootDir,
      ".codex-sessions-trash",
      trashed.trashEntry.trashId,
      "manifest.json",
    );
    const original = await readFile(manifestPath, "utf8");
    const tampered = original.replace("Archived thread", "Archived thrEad");
    const outcome = restoreTrashEntry(fixture.rootDir, trashed.trashEntry.trashId).then(
      (value) => ({ value, error: null as Error | null }),
      (error: Error) => ({ value: null, error }),
    );
    await waitForOperationStage(fixture.rootDir, "restore");
    await writeFile(manifestPath, tampered, "utf8");

    const result = await outcome;

    expect(result.value).toBeNull();
    expect(result.error?.message).toMatch(/STALE_PLAN/u);
    await expect(readFile(manifestPath, "utf8")).resolves.toBe(tampered);
    await expect(access(fixture.paths.archivedSessionFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    "archived_sessions/nested/../../config.toml",
    "archived_sessions\\..\\config.toml",
  ])("lists non-canonical manifest path as invalid: %s", async (unsafePath) => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID]);
    const trashed = await moveSessionsToTrash(scan, session);
    const manifestPath = path.join(
      fixture.rootDir,
      ".codex-sessions-trash",
      trashed.trashEntry.trashId,
      "manifest.json",
    );
    const bundle = JSON.parse(await readFile(manifestPath, "utf8")) as {
      sessionFiles: Array<{ path: string }>;
      manifest: { sessions: Array<{ originalRelativePaths: string[] }> };
    };
    bundle.sessionFiles[0].path = unsafePath;
    bundle.manifest.sessions[0].originalRelativePaths[0] = unsafePath;
    await writeFile(manifestPath, `${JSON.stringify(bundle)}\n`, "utf8");

    const entries = await listTrashEntries(fixture.rootDir);

    expect(entries[0]).toMatchObject({ status: "invalid" });
    await expect(restoreTrashEntry(fixture.rootDir, trashed.trashEntry.trashId))
      .rejects.toThrow(/无效|路径|manifest/u);
  });
});
