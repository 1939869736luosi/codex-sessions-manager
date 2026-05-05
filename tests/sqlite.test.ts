import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectSqliteDeletionCounts, deleteSessionsFromSqlite, validateSqliteDeletion } from "../src/core/sqlite.js";
import { createFixture, FIXTURE_IDS, type Fixture } from "./helpers/fixture.js";

describe("sqlite core", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("collects deletion counts and deletes linked rows", () => {
    const counts = collectSqliteDeletionCounts(fixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID], fixture.paths.logsSqlite);
    expect(counts.get(FIXTURE_IDS.ACTIVE_ID)).toEqual({
      threadRows: 1,
      logRows: 1,
      spawnEdgeRows: 1,
      assignedAgentJobs: 1,
      dynamicToolRows: 1,
      stage1Rows: 1,
      threadGoalRows: 1,
    });

    const deleted = deleteSessionsFromSqlite(fixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID], fixture.paths.logsSqlite);
    expect(deleted.get(FIXTURE_IDS.ACTIVE_ID)?.threadRows).toBe(1);

    const validation = validateSqliteDeletion(fixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID, FIXTURE_IDS.ARCHIVED_ID], fixture.paths.logsSqlite);
    expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.threadRows).toBe(0);
    expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.logRows).toBe(0);
    expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.stage1Rows).toBe(0);
    expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.dynamicToolRows).toBe(0);
    expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.threadGoalRows).toBe(0);
    expect(validation.get(FIXTURE_IDS.ARCHIVED_ID)?.threadRows).toBe(1);
    expect(validation.get(FIXTURE_IDS.ARCHIVED_ID)?.logRows).toBe(1);
    expect(validation.get(FIXTURE_IDS.ARCHIVED_ID)?.stage1Rows).toBe(1);
    expect(validation.get(FIXTURE_IDS.ARCHIVED_ID)?.dynamicToolRows).toBe(1);
    expect(validation.get(FIXTURE_IDS.ARCHIVED_ID)?.threadGoalRows).toBe(1);
  });

  it("stores null assigned_thread_id instead of deleting unrelated job items", async () => {
    deleteSessionsFromSqlite(fixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID], fixture.paths.logsSqlite);
    const db = new Database(fixture.paths.sqlite, { readonly: true });
    const row = db
      .prepare("select assigned_thread_id from agent_job_items where item_id = ?")
      .get(`item-${FIXTURE_IDS.ACTIVE_ID}`) as { assigned_thread_id: string | null };
    db.close();

    expect(row.assigned_thread_id).toBeNull();
  });

  it("deletes session logs from the dedicated logs database", () => {
    expect(fixture.paths.logsSqlite).not.toBeNull();
    deleteSessionsFromSqlite(fixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID], fixture.paths.logsSqlite);

    const db = new Database(fixture.paths.logsSqlite as string, { readonly: true });
    const activeLogs = db
      .prepare("select count(*) as count from logs where thread_id = ?")
      .get(FIXTURE_IDS.ACTIVE_ID) as { count: number };
    const archivedLogs = db
      .prepare("select count(*) as count from logs where thread_id = ?")
      .get(FIXTURE_IDS.ARCHIVED_ID) as { count: number };
    db.close();

    expect(activeLogs.count).toBe(0);
    expect(archivedLogs.count).toBe(1);
  });

  it("supports legacy state databases that still have a logs table", async () => {
    const legacyFixture = await createFixture({ logsDatabase: false, stateLogsTable: true });

    try {
      const counts = collectSqliteDeletionCounts(legacyFixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID]);
      expect(counts.get(FIXTURE_IDS.ACTIVE_ID)?.logRows).toBe(1);

      deleteSessionsFromSqlite(legacyFixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID]);
      const validation = validateSqliteDeletion(legacyFixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID]);
      expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.logRows).toBe(0);
    } finally {
      await legacyFixture.cleanup();
    }
  });

  it("does not fail when neither state nor logs database has a logs table", async () => {
    const noLogsFixture = await createFixture({ logsDatabase: false });

    try {
      const counts = collectSqliteDeletionCounts(noLogsFixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID]);
      expect(counts.get(FIXTURE_IDS.ACTIVE_ID)?.logRows).toBe(0);

      deleteSessionsFromSqlite(noLogsFixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID]);
      const validation = validateSqliteDeletion(noLogsFixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID]);
      expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.threadRows).toBe(0);
      expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.logRows).toBe(0);
    } finally {
      await noLogsFixture.cleanup();
    }
  });

  it("does not fail when the dedicated logs database has no logs table", async () => {
    const noLogsTableFixture = await createFixture({ logsSchema: "missing-table" });

    try {
      const counts = collectSqliteDeletionCounts(noLogsTableFixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID], noLogsTableFixture.paths.logsSqlite);
      expect(counts.get(FIXTURE_IDS.ACTIVE_ID)?.logRows).toBe(0);

      deleteSessionsFromSqlite(noLogsTableFixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID], noLogsTableFixture.paths.logsSqlite);
      const validation = validateSqliteDeletion(noLogsTableFixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID], noLogsTableFixture.paths.logsSqlite);
      expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.threadRows).toBe(0);
      expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.logRows).toBe(0);
    } finally {
      await noLogsTableFixture.cleanup();
    }
  });

  it("does not fail when the dedicated logs table has no thread_id column", async () => {
    const noThreadIdFixture = await createFixture({ logsSchema: "missing-thread-id" });

    try {
      const counts = collectSqliteDeletionCounts(noThreadIdFixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID], noThreadIdFixture.paths.logsSqlite);
      expect(counts.get(FIXTURE_IDS.ACTIVE_ID)?.logRows).toBe(0);

      deleteSessionsFromSqlite(noThreadIdFixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID], noThreadIdFixture.paths.logsSqlite);
      const validation = validateSqliteDeletion(noThreadIdFixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID], noThreadIdFixture.paths.logsSqlite);
      expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.threadRows).toBe(0);
      expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.logRows).toBe(0);
    } finally {
      await noThreadIdFixture.cleanup();
    }
  });

  it("restores dedicated logs when state deletion fails", () => {
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

    expect(() =>
      deleteSessionsFromSqlite(fixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID], fixture.paths.logsSqlite),
    ).toThrow("blocked delete");

    const logsDb = new Database(fixture.paths.logsSqlite as string, { readonly: true });
    const activeLogs = logsDb
      .prepare("select count(*) as count from logs where thread_id = ?")
      .get(FIXTURE_IDS.ACTIVE_ID) as { count: number };
    logsDb.close();

    const validation = validateSqliteDeletion(fixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID], fixture.paths.logsSqlite);
    expect(activeLogs.count).toBe(1);
    expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.threadRows).toBe(1);
    expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.logRows).toBe(1);
  });
});
