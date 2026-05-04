import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, rm } from "node:fs/promises";
import Database from "better-sqlite3";

import { exportSessionBackup } from "../src/core/backup.js";
import { buildDeletePreview, cleanupSessionIndexes, cleanupStaleIndexes, deleteSessions, validateDeletion } from "../src/core/delete.js";
import { resolveSessions } from "../src/core/query.js";
import { scanCodexRoot } from "../src/core/scan.js";
import { readSessionTimeline } from "../src/core/timeline.js";
import { createFixture, FIXTURE_IDS, type Fixture } from "./helpers/fixture.js";

describe("core integration", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("scans active, archived, and stale sessions", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);

    expect(new Set(scan.sessions.map((session) => session.id))).toEqual(
      new Set([FIXTURE_IDS.ACTIVE_ID, FIXTURE_IDS.ARCHIVED_ID, FIXTURE_IDS.STALE_ID]),
    );
    expect(resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID])[0].kind).toBe("active");
    expect(resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID])[0].kind).toBe("archived");
    expect(resolveSessions(scan, [FIXTURE_IDS.STALE_ID])[0].kind).toBe("stale");
  });

  it("builds a timeline and backup bundle", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID])[0];
    const timeline = await readSessionTimeline(session);
    const backup = await exportSessionBackup(scan, session);

    expect(timeline[0]?.body).toContain("active user input");
    expect(backup.manifest.sessionId).toBe(FIXTURE_IDS.ACTIVE_ID);
    expect(backup.sessionFiles).toHaveLength(1);
    expect(backup.sqlite.threads).toHaveLength(1);
    expect(backup.sqlite.logs).toHaveLength(1);
    expect(backup.sqlite.threadGoals).toHaveLength(1);
  });

  it("deletes mixed active and archived sessions and validates cleanup", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID, FIXTURE_IDS.ARCHIVED_ID]);
    const preview = buildDeletePreview(scan, sessions);
    const result = await deleteSessions(scan, sessions);

    expect(preview.totals.sessionFiles).toBe(2);
    expect(preview.totals.sqliteRows).toBe(13);
    expect(result.validation.every((item) => item.filePathsRemaining.length === 0)).toBe(true);
    expect(result.validation.every((item) => item.sessionIndexRowsRemaining === 0)).toBe(true);
    expect(result.validation.every((item) => item.historyRowsRemaining === 0)).toBe(true);
    expect(result.validation.every((item) => item.sqlite.logRows === 0)).toBe(true);
    expect(result.validation.every((item) => item.sqlite.threadGoalRows === 0)).toBe(true);
  });

  it("does not treat session IDs inside unrelated JSONL text as remaining rows", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID])[0];
    await cleanupSessionIndexes(scan, [session]);
    await appendFile(
      fixture.paths.sessionIndex,
      `${JSON.stringify({ id: FIXTURE_IDS.STALE_ID, thread_name: `mentions ${FIXTURE_IDS.ACTIVE_ID}` })}\n`,
      "utf8",
    );
    await appendFile(
      fixture.paths.history,
      `${JSON.stringify({ session_id: FIXTURE_IDS.STALE_ID, text: `mentions ${FIXTURE_IDS.ACTIVE_ID}` })}\n`,
      "utf8",
    );

    const verification = await validateDeletion(await scanCodexRoot(fixture.rootDir), [session]);
    expect(verification[0].sessionIndexRowsRemaining).toBe(0);
    expect(verification[0].historyRowsRemaining).toBe(0);
  });

  it("continues deleting indexes and sqlite when a file is already missing", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID])[0];
    await rm(fixture.paths.activeSessionFile);

    const result = await deleteSessions(scan, [session]);
    expect(result.validation[0].filePathsRemaining).toEqual([]);
    expect(result.validation[0].sessionIndexRowsRemaining).toBe(0);
    expect(result.validation[0].historyRowsRemaining).toBe(0);
  });

  it("restores files, indexes, and dedicated logs when sqlite deletion fails", async () => {
    const stateDb = new Database(fixture.paths.sqlite);
    stateDb.exec(`
      create trigger fail_thread_delete
      before delete on threads
      when old.id = '${FIXTURE_IDS.ACTIVE_ID}'
      begin
        select raise(abort, 'blocked delete');
      end;
    `);
    stateDb.close();

    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID])[0];
    await expect(deleteSessions(scan, [session])).rejects.toThrow("删除失败");

    const validation = await validateDeletion(await scanCodexRoot(fixture.rootDir), [session]);
    expect(validation[0].filePathsRemaining).toHaveLength(1);
    expect(validation[0].sessionIndexRowsRemaining).toBe(1);
    expect(validation[0].historyRowsRemaining).toBe(1);
    expect(validation[0].sqlite.threadRows).toBe(1);
    expect(validation[0].sqlite.logRows).toBe(1);
  });

  it("cleans only index traces without touching raw files or sqlite", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID])[0];

    const cleanup = await cleanupSessionIndexes(scan, [session]);
    const verification = await validateDeletion(await scanCodexRoot(fixture.rootDir), [session]);

    expect(cleanup.removedSessionIndexRows).toBe(1);
    expect(cleanup.removedHistoryRows).toBe(1);
    expect(verification[0].filePathsRemaining).toHaveLength(1);
    expect(verification[0].sqlite.threadRows).toBe(1);
  });

  it("cleans stale indexes only", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const cleanup = await cleanupStaleIndexes(scan);
    const rescanned = await scanCodexRoot(fixture.rootDir);

    expect(cleanup.staleSessionIds).toEqual([FIXTURE_IDS.STALE_ID]);
    expect(rescanned.sessions.some((session) => session.id === FIXTURE_IDS.STALE_ID)).toBe(false);
  });
});
