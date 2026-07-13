import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  collectDedicatedLogRecords,
  collectDedicatedLogKeys,
  assertDedicatedLogRecoveryPayloadBounds,
  assertDedicatedLogKeyPayloadBounds,
  collectSqliteDeletionCounts,
  deleteDedicatedLogRows,
  MAX_DEDICATED_LOG_RECOVERY_ROWS,
  deleteSessionsFromSqlite,
  validateSqliteDeletion,
} from "../src/core/sqlite.js";
import { createFixture, FIXTURE_IDS, type Fixture } from "./helpers/fixture.js";

describe("sqlite core", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("collects deletion counts and deletes linked rows while retaining logs", () => {
    const counts = collectSqliteDeletionCounts(
      fixture.paths.sqlite,
      [FIXTURE_IDS.ACTIVE_ID],
      fixture.paths.logsSqlite,
      fixture.paths.goalsSqlite,
    );
    expect(counts.get(FIXTURE_IDS.ACTIVE_ID)).toEqual({
      threadRows: 1,
      logRows: 1,
      spawnEdgeRows: 1,
      assignedAgentJobs: 1,
      dynamicToolRows: 1,
      stage1Rows: 1,
      threadGoalRows: 1,
    });

    const deleted = deleteSessionsFromSqlite(
      fixture.paths.sqlite,
      [FIXTURE_IDS.ACTIVE_ID],
      fixture.paths.logsSqlite,
      fixture.paths.goalsSqlite,
    );
    expect(deleted.get(FIXTURE_IDS.ACTIVE_ID)?.threadRows).toBe(1);

    const validation = validateSqliteDeletion(
      fixture.paths.sqlite,
      [FIXTURE_IDS.ACTIVE_ID, FIXTURE_IDS.ARCHIVED_ID],
      fixture.paths.logsSqlite,
      fixture.paths.goalsSqlite,
    );
    expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.threadRows).toBe(0);
    expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.logRows).toBe(1);
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
    deleteSessionsFromSqlite(fixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID], fixture.paths.logsSqlite, fixture.paths.goalsSqlite);
    const db = new Database(fixture.paths.sqlite, { readonly: true });
    const row = db
      .prepare("select assigned_thread_id from agent_job_items where item_id = ?")
      .get(`item-${FIXTURE_IDS.ACTIVE_ID}`) as { assigned_thread_id: string | null };
    db.close();

    expect(row.assigned_thread_id).toBeNull();
  });

  it("retains session logs in the dedicated logs database", () => {
    expect(fixture.paths.logsSqlite).not.toBeNull();
    deleteSessionsFromSqlite(fixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID], fixture.paths.logsSqlite, fixture.paths.goalsSqlite);

    const db = new Database(fixture.paths.logsSqlite as string, { readonly: true });
    const activeLogs = db
      .prepare("select count(*) as count from logs where thread_id = ?")
      .get(FIXTURE_IDS.ACTIVE_ID) as { count: number };
    const archivedLogs = db
      .prepare("select count(*) as count from logs where thread_id = ?")
      .get(FIXTURE_IDS.ARCHIVED_ID) as { count: number };
    db.close();

    expect(activeLogs.count).toBe(1);
    expect(archivedLogs.count).toBe(1);
  });

  it("supports legacy state databases that still have a logs table", async () => {
    const legacyFixture = await createFixture({ logsDatabase: false, goalsDatabase: false, stateLogsTable: true });

    try {
      const counts = collectSqliteDeletionCounts(legacyFixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID]);
      expect(counts.get(FIXTURE_IDS.ACTIVE_ID)?.logRows).toBe(1);

      deleteSessionsFromSqlite(legacyFixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID]);
      const validation = validateSqliteDeletion(legacyFixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID]);
      expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.logRows).toBe(1);
    } finally {
      await legacyFixture.cleanup();
    }
  });

  it("does not fail when neither state nor logs database has a logs table", async () => {
    const noLogsFixture = await createFixture({ logsDatabase: false, goalsDatabase: false });

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

  it("retains dedicated logs when state deletion fails", () => {
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
      deleteSessionsFromSqlite(fixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID], fixture.paths.logsSqlite, fixture.paths.goalsSqlite),
    ).toThrow("blocked delete");

    const logsDb = new Database(fixture.paths.logsSqlite as string, { readonly: true });
    const activeLogs = logsDb
      .prepare("select count(*) as count from logs where thread_id = ?")
      .get(FIXTURE_IDS.ACTIVE_ID) as { count: number };
    logsDb.close();

    const validation = validateSqliteDeletion(fixture.paths.sqlite, [FIXTURE_IDS.ACTIVE_ID], fixture.paths.logsSqlite, fixture.paths.goalsSqlite);
    expect(activeLogs.count).toBe(1);
    expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.threadRows).toBe(1);
    expect(validation.get(FIXTURE_IDS.ACTIVE_ID)?.logRows).toBe(1);
  });

  it("deletes only exact session ids from a recognized dedicated logs schema", () => {
    expect(fixture.paths.logsSqlite).not.toBeNull();
    deleteDedicatedLogRows(fixture.paths.logsSqlite, [FIXTURE_IDS.ACTIVE_ID]);

    const db = new Database(fixture.paths.logsSqlite as string, { readonly: true });
    try {
      expect((db.prepare("select count(*) as count from logs where thread_id = ?").get(FIXTURE_IDS.ACTIVE_ID) as { count: number }).count).toBe(0);
      expect((db.prepare("select count(*) as count from logs where thread_id = ?").get(FIXTURE_IDS.ARCHIVED_ID) as { count: number }).count).toBe(1);
    } finally {
      db.close();
    }
  });

  it("fails closed before changing a dedicated logs database with an unknown schema", async () => {
    const unknown = await createFixture({ logsSchema: "missing-thread-id" });
    try {
      expect(() => deleteDedicatedLogRows(unknown.paths.logsSqlite, [FIXTURE_IDS.ACTIVE_ID])).toThrow(/schema|thread_id/iu);
    } finally {
      await unknown.cleanup();
    }
  });

  it("fails closed before loading an unbounded dedicated log recovery set", () => {
    const db = new Database(fixture.paths.logsSqlite as string);
    const insert = db.prepare(`
      insert into logs (ts, ts_nanos, level, target, feedback_log_body, thread_id, process_uuid, estimated_bytes)
      values (?, 0, 'INFO', 'bulk', 'x', ?, 'bulk-process', 1)
    `);
    const fill = db.transaction(() => {
      for (let index = 0; index < MAX_DEDICATED_LOG_RECOVERY_ROWS; index += 1) {
        insert.run(10_000 + index, FIXTURE_IDS.ACTIVE_ID);
      }
    });
    fill();
    db.close();

    expect(() => collectDedicatedLogRecords(fixture.paths.logsSqlite, [FIXTURE_IDS.ACTIVE_ID]))
      .toThrow(/safe recovery limit/iu);
  });

  it("rejects an encoded recovery payload that exceeds the row bound before journaling", () => {
    expect(() => assertDedicatedLogRecoveryPayloadBounds(
      Array.from({ length: MAX_DEDICATED_LOG_RECOVERY_ROWS + 1 }, (_, id) => ({ id })),
    )).toThrow(/encoded dedicated logs recovery payload/iu);
  });

  it("rejects an oversized purge key before loading it into the operation journal", () => {
    const db = new Database(fixture.paths.logsSqlite as string);
    db.exec("drop table logs; create table logs (id text primary key, thread_id text not null);");
    db.prepare("insert into logs (id, thread_id) values (?, ?)")
      .run("x".repeat(70 * 1024), FIXTURE_IDS.ACTIVE_ID);
    db.close();

    expect(() => collectDedicatedLogKeys(fixture.paths.logsSqlite, [FIXTURE_IDS.ACTIVE_ID]))
      .toThrow(/key payload|key component|safe bound/iu);
  });

  it("rejects an encoded purge-key payload that exceeds the byte bound", () => {
    expect(() => assertDedicatedLogKeyPayloadBounds([
      { id: "x".repeat(17 * 1024 * 1024), threadId: FIXTURE_IDS.ACTIVE_ID },
    ])).toThrow(/key payload|key component|safe bound/iu);
  });
});
