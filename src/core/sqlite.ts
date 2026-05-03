import Database from "better-sqlite3";

import type { SqliteDeletionCounts, ThreadRow } from "./types.js";

type SqliteRecordBundle = {
  threads: Record<string, unknown>[];
  logs: Record<string, unknown>[];
  threadSpawnEdges: Record<string, unknown>[];
  agentJobItems: Record<string, unknown>[];
  threadDynamicTools: Record<string, unknown>[];
  stage1Outputs: Record<string, unknown>[];
  threadGoals: Record<string, unknown>[];
};

function withDatabase<T>(sqlitePath: string | null, readonly: boolean, callback: (db: Database.Database) => T): T {
  if (!sqlitePath) {
    throw new Error("SQLite path is not available.");
  }

  const db = new Database(sqlitePath, { readonly });

  try {
    db.pragma("foreign_keys = ON");
    return callback(db);
  } finally {
    db.close();
  }
}

function emptySqliteDeletionCounts(): SqliteDeletionCounts {
  return {
    threadRows: 0,
    logRows: 0,
    spawnEdgeRows: 0,
    assignedAgentJobs: 0,
    dynamicToolRows: 0,
    stage1Rows: 0,
    threadGoalRows: 0,
  };
}

function emptySqliteRecordBundle(): SqliteRecordBundle {
  return {
    threads: [],
    logs: [],
    threadSpawnEdges: [],
    agentJobItems: [],
    threadDynamicTools: [],
    stage1Outputs: [],
    threadGoals: [],
  };
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`);
  }

  return `"${identifier}"`;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("select count(*) as count from sqlite_master where type = 'table' and name = ?")
    .get(tableName) as { count?: number } | undefined;

  return Number(row?.count ?? 0) > 0;
}

function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  if (!tableExists(db, tableName)) {
    return false;
  }

  const rows = db.prepare(`pragma table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name?: string }>;
  return rows.some((row) => row.name === columnName);
}

function countRows(db: Database.Database, sql: string, params: unknown[] = []): number {
  return Number((db.prepare(sql).get(...params) as { count?: number } | undefined)?.count ?? 0);
}

function countRowsIfTableExists(
  db: Database.Database,
  tableName: string,
  sql: string,
  params: unknown[] = [],
): number {
  if (!tableExists(db, tableName)) {
    return 0;
  }

  return countRows(db, sql, params);
}

function createInClause(values: string[]): {
  clause: string;
  params: string[];
} {
  const uniqueValues = [...new Set(values)];
  return {
    clause: uniqueValues.map(() => "?").join(", "),
    params: uniqueValues,
  };
}

function hasSessionLogsTable(db: Database.Database): boolean {
  return columnExists(db, "logs", "thread_id");
}

function countSessionLogs(db: Database.Database, sessionId: string): number {
  if (!hasSessionLogsTable(db)) {
    return 0;
  }

  return countRows(db, "select count(*) as count from logs where thread_id = ?", [sessionId]);
}

function selectSessionLogs(db: Database.Database, sessionId: string): Record<string, unknown>[] {
  if (!hasSessionLogsTable(db)) {
    return [];
  }

  return selectRows(db, "select * from logs where thread_id = ?", [sessionId]);
}

function addLogRows(
  counts: Map<string, SqliteDeletionCounts>,
  sessionId: string,
  logRows: number,
): void {
  const current = counts.get(sessionId) ?? emptySqliteDeletionCounts();
  counts.set(sessionId, {
    ...current,
    logRows: current.logRows + logRows,
  });
}

function mapThreadRow(row: Record<string, unknown>): ThreadRow {
  return {
    id: String(row.id ?? ""),
    title: String(row.title ?? ""),
    firstUserMessage: String(row.first_user_message ?? ""),
    createdAt: row.created_at === null || row.created_at === undefined ? null : Number(row.created_at),
    updatedAt: row.updated_at === null || row.updated_at === undefined ? null : Number(row.updated_at),
    archived: Number(row.archived ?? 0) === 1,
    rolloutPath: row.rollout_path ? String(row.rollout_path) : null,
    model: row.model ? String(row.model) : null,
    cwd: row.cwd ? String(row.cwd) : null,
  };
}

export function scanThreads(sqlitePath: string | null): Map<string, ThreadRow> {
  if (!sqlitePath) {
    return new Map();
  }

  return withDatabase(sqlitePath, true, (db) => {
    const rows = db
      .prepare(
        `select id, title, first_user_message, created_at, updated_at, archived, rollout_path, model, cwd
         from threads
         order by updated_at desc`,
      )
      .all() as Record<string, unknown>[];

    return new Map(rows.map((row) => [String(row.id), mapThreadRow(row)]));
  });
}

function collectCountsForSession(db: Database.Database, sessionId: string): SqliteDeletionCounts {
  return {
    threadRows: countRowsIfTableExists(db, "threads", "select count(*) as count from threads where id = ?", [sessionId]),
    logRows: countSessionLogs(db, sessionId),
    spawnEdgeRows: countRowsIfTableExists(
      db,
      "thread_spawn_edges",
      "select count(*) as count from thread_spawn_edges where parent_thread_id = ? or child_thread_id = ?",
      [sessionId, sessionId],
    ),
    assignedAgentJobs: columnExists(db, "agent_job_items", "assigned_thread_id")
      ? countRows(
          db,
          "select count(*) as count from agent_job_items where assigned_thread_id = ?",
          [sessionId],
        )
      : 0,
    dynamicToolRows: countRowsIfTableExists(
      db,
      "thread_dynamic_tools",
      "select count(*) as count from thread_dynamic_tools where thread_id = ?",
      [sessionId],
    ),
    stage1Rows: countRowsIfTableExists(db, "stage1_outputs", "select count(*) as count from stage1_outputs where thread_id = ?", [sessionId]),
    threadGoalRows: countRowsIfTableExists(db, "thread_goals", "select count(*) as count from thread_goals where thread_id = ?", [sessionId]),
  };
}

function collectCountsForSessions(db: Database.Database, sessionIds: string[]): SqliteDeletionCounts {
  const { clause, params } = createInClause(sessionIds);
  if (!clause) {
    return emptySqliteDeletionCounts();
  }

  return {
    threadRows: countRowsIfTableExists(db, "threads", `select count(*) as count from threads where id in (${clause})`, params),
    logRows: hasSessionLogsTable(db)
      ? countRows(db, `select count(*) as count from logs where thread_id in (${clause})`, params)
      : 0,
    spawnEdgeRows: countRowsIfTableExists(
      db,
      "thread_spawn_edges",
      `select count(*) as count from thread_spawn_edges where parent_thread_id in (${clause}) or child_thread_id in (${clause})`,
      [...params, ...params],
    ),
    assignedAgentJobs: columnExists(db, "agent_job_items", "assigned_thread_id")
      ? countRows(db, `select count(*) as count from agent_job_items where assigned_thread_id in (${clause})`, params)
      : 0,
    dynamicToolRows: countRowsIfTableExists(
      db,
      "thread_dynamic_tools",
      `select count(*) as count from thread_dynamic_tools where thread_id in (${clause})`,
      params,
    ),
    stage1Rows: countRowsIfTableExists(
      db,
      "stage1_outputs",
      `select count(*) as count from stage1_outputs where thread_id in (${clause})`,
      params,
    ),
    threadGoalRows: countRowsIfTableExists(
      db,
      "thread_goals",
      `select count(*) as count from thread_goals where thread_id in (${clause})`,
      params,
    ),
  };
}

function addCounts(left: SqliteDeletionCounts, right: SqliteDeletionCounts): SqliteDeletionCounts {
  return {
    threadRows: left.threadRows + right.threadRows,
    logRows: left.logRows + right.logRows,
    spawnEdgeRows: left.spawnEdgeRows + right.spawnEdgeRows,
    assignedAgentJobs: left.assignedAgentJobs + right.assignedAgentJobs,
    dynamicToolRows: left.dynamicToolRows + right.dynamicToolRows,
    stage1Rows: left.stage1Rows + right.stage1Rows,
    threadGoalRows: left.threadGoalRows + right.threadGoalRows,
  };
}

export function collectSqliteDeletionCounts(
  sqlitePath: string | null,
  sessionIds: string[],
  logsSqlitePath: string | null = null,
): Map<string, SqliteDeletionCounts> {
  const counts = new Map<string, SqliteDeletionCounts>();

  if (sessionIds.length === 0) {
    return counts;
  }

  for (const sessionId of sessionIds) {
    counts.set(sessionId, emptySqliteDeletionCounts());
  }

  if (sqlitePath) {
    withDatabase(sqlitePath, true, (db) => {
      for (const sessionId of sessionIds) {
        counts.set(sessionId, collectCountsForSession(db, sessionId));
      }
    });
  }

  if (logsSqlitePath && logsSqlitePath !== sqlitePath) {
    withDatabase(logsSqlitePath, true, (db) => {
      for (const sessionId of sessionIds) {
        addLogRows(counts, sessionId, countSessionLogs(db, sessionId));
      }
    });
  }

  return counts;
}

export function collectSqliteDeletionTotals(
  sqlitePath: string | null,
  sessionIds: string[],
  logsSqlitePath: string | null = null,
): SqliteDeletionCounts {
  let totals = emptySqliteDeletionCounts();

  if (sessionIds.length === 0) {
    return totals;
  }

  if (sqlitePath) {
    totals = withDatabase(sqlitePath, true, (db) => collectCountsForSessions(db, sessionIds));
  }

  if (logsSqlitePath && logsSqlitePath !== sqlitePath) {
    const logTotals = withDatabase(logsSqlitePath, true, (db) => ({
      ...emptySqliteDeletionCounts(),
      logRows: collectCountsForSessions(db, sessionIds).logRows,
    }));
    totals = addCounts(totals, logTotals);
  }

  return totals;
}

function deleteStateRows(sqlitePath: string | null, sessionIds: string[]): void {
  if (!sqlitePath || sessionIds.length === 0) {
    return;
  }

  withDatabase(sqlitePath, false, (db) => {
    const deleteLogs = hasSessionLogsTable(db) ? db.prepare("delete from logs where thread_id = ?") : null;
    const deleteGoals = tableExists(db, "thread_goals") ? db.prepare("delete from thread_goals where thread_id = ?") : null;
    const deleteEdges = tableExists(db, "thread_spawn_edges")
      ? db.prepare("delete from thread_spawn_edges where parent_thread_id = ? or child_thread_id = ?")
      : null;
    const nullAgentJobItems = columnExists(db, "agent_job_items", "assigned_thread_id")
      ? db.prepare("update agent_job_items set assigned_thread_id = null where assigned_thread_id = ?")
      : null;
    const deleteThread = tableExists(db, "threads") ? db.prepare("delete from threads where id = ?") : null;

    const transaction = db.transaction((ids: string[]) => {
      for (const sessionId of ids) {
        deleteLogs?.run(sessionId);
        deleteGoals?.run(sessionId);
        deleteEdges?.run(sessionId, sessionId);
        nullAgentJobItems?.run(sessionId);
        deleteThread?.run(sessionId);
      }
    });

    transaction(sessionIds);
  });
}

function deleteSessionLogs(sqlitePath: string | null, sessionIds: string[]): void {
  if (!sqlitePath || sessionIds.length === 0) {
    return;
  }

  withDatabase(sqlitePath, false, (db) => {
    if (!hasSessionLogsTable(db)) {
      return;
    }

    const deleteLogs = db.prepare("delete from logs where thread_id = ?");
    const transaction = db.transaction((ids: string[]) => {
      for (const sessionId of ids) {
        deleteLogs.run(sessionId);
      }
    });

    transaction(sessionIds);
  });
}

function collectStateRecords(sqlitePath: string | null, sessionId: string): SqliteRecordBundle {
  if (!sqlitePath) {
    return emptySqliteRecordBundle();
  }

  return withDatabase(sqlitePath, true, (db) => ({
    threads: selectRowsIfTableExists(db, "threads", "select * from threads where id = ?", [sessionId]),
    logs: selectSessionLogs(db, sessionId),
    threadSpawnEdges: selectRowsIfTableExists(
      db,
      "thread_spawn_edges",
      "select * from thread_spawn_edges where parent_thread_id = ? or child_thread_id = ?",
      [sessionId, sessionId],
    ),
    agentJobItems: columnExists(db, "agent_job_items", "assigned_thread_id")
      ? selectRows(db, "select * from agent_job_items where assigned_thread_id = ?", [sessionId])
      : [],
    threadDynamicTools: selectRowsIfTableExists(db, "thread_dynamic_tools", "select * from thread_dynamic_tools where thread_id = ?", [sessionId]),
    stage1Outputs: selectRowsIfTableExists(db, "stage1_outputs", "select * from stage1_outputs where thread_id = ?", [sessionId]),
    threadGoals: selectRowsIfTableExists(db, "thread_goals", "select * from thread_goals where thread_id = ?", [sessionId]),
  }));
}

function collectLogRecords(sqlitePath: string | null, sessionId: string): Record<string, unknown>[] {
  if (!sqlitePath) {
    return [];
  }

  return withDatabase(sqlitePath, true, (db) => selectSessionLogs(db, sessionId));
}

function collectLogRecordsForSessions(sqlitePath: string | null, sessionIds: string[]): Record<string, unknown>[] {
  if (!sqlitePath || sessionIds.length === 0) {
    return [];
  }

  return withDatabase(sqlitePath, true, (db) =>
    sessionIds.flatMap((sessionId) => selectSessionLogs(db, sessionId)),
  );
}

function selectRows(
  db: Database.Database,
  sql: string,
  params: unknown[] = [],
): Record<string, unknown>[] {
  return db.prepare(sql).all(...params) as Record<string, unknown>[];
}

function selectRowsIfTableExists(
  db: Database.Database,
  tableName: string,
  sql: string,
  params: unknown[] = [],
): Record<string, unknown>[] {
  if (!tableExists(db, tableName)) {
    return [];
  }

  return selectRows(db, sql, params);
}

function restoreRows(sqlitePath: string | null, tableName: string, rows: Record<string, unknown>[]): void {
  if (!sqlitePath || rows.length === 0) {
    return;
  }

  withDatabase(sqlitePath, false, (db) => {
    if (!tableExists(db, tableName)) {
      return;
    }

    const columns = Object.keys(rows[0]);
    if (columns.length === 0) {
      return;
    }

    const columnSql = columns.map(quoteIdentifier).join(", ");
    const valueSql = columns.map(() => "?").join(", ");
    const insert = db.prepare(`insert or replace into ${quoteIdentifier(tableName)} (${columnSql}) values (${valueSql})`);
    const transaction = db.transaction((records: Record<string, unknown>[]) => {
      for (const record of records) {
        insert.run(...columns.map((column) => record[column] ?? null));
      }
    });

    transaction(rows);
  });
}

export function deleteSessionsFromSqlite(
  sqlitePath: string | null,
  sessionIds: string[],
  logsSqlitePath: string | null = null,
): Map<string, SqliteDeletionCounts> {
  const counts = collectSqliteDeletionCounts(sqlitePath, sessionIds, logsSqlitePath);
  const usesDedicatedLogs = Boolean(logsSqlitePath && logsSqlitePath !== sqlitePath);
  const logSnapshots = usesDedicatedLogs ? collectLogRecordsForSessions(logsSqlitePath, sessionIds) : [];
  let dedicatedLogsDeleted = false;

  try {
    if (usesDedicatedLogs) {
      deleteSessionLogs(logsSqlitePath, sessionIds);
      dedicatedLogsDeleted = true;
    }

    deleteStateRows(sqlitePath, sessionIds);
  } catch (error) {
    if (dedicatedLogsDeleted) {
      try {
        restoreRows(logsSqlitePath, "logs", logSnapshots);
      } catch (restoreError) {
        throw new Error(
          `SQLite 删除失败，logs 恢复也失败：${restoreError instanceof Error ? restoreError.message : String(restoreError)}。原始错误：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    throw error;
  }

  return counts;
}

export function validateSqliteDeletion(
  sqlitePath: string | null,
  sessionIds: string[],
  logsSqlitePath: string | null = null,
): Map<string, SqliteDeletionCounts> {
  return collectSqliteDeletionCounts(sqlitePath, sessionIds, logsSqlitePath);
}

export function exportSqliteRecords(
  sqlitePath: string | null,
  sessionId: string,
  logsSqlitePath: string | null = null,
): SqliteRecordBundle {
  const bundle = collectStateRecords(sqlitePath, sessionId);

  if (logsSqlitePath && logsSqlitePath !== sqlitePath) {
    bundle.logs.push(...collectLogRecords(logsSqlitePath, sessionId));
  }

  return bundle;
}
