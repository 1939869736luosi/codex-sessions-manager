import Database from "better-sqlite3";

import type { SqliteDeletionCounts, SqliteTableInspection, ThreadRow, ThreadSpawnEdgeRow } from "./types.js";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SQLITE_KEY_TABLES = [
  "threads",
  "logs",
  "thread_spawn_edges",
  "agent_job_items",
  "thread_dynamic_tools",
  "stage1_outputs",
  "thread_goals",
] as const;

const ASSOCIATION_COLUMNS_BY_TABLE: Record<(typeof SQLITE_KEY_TABLES)[number], string[]> = {
  threads: ["id"],
  logs: ["thread_id", "id"],
  thread_spawn_edges: ["parent_thread_id", "child_thread_id"],
  agent_job_items: ["assigned_thread_id", "job_id", "item_id"],
  thread_dynamic_tools: ["thread_id"],
  stage1_outputs: ["thread_id"],
  thread_goals: ["thread_id"],
};

const REQUIRED_RESTORE_COLUMNS_BY_TABLE: Record<string, string[]> = {
  threads: ["id"],
  logs: ["thread_id"],
  thread_spawn_edges: ["parent_thread_id", "child_thread_id"],
  agent_job_items: ["assigned_thread_id"],
  thread_dynamic_tools: ["thread_id"],
  stage1_outputs: ["thread_id"],
  thread_goals: ["thread_id"],
};

export type SqliteRecordBundle = {
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

function getTableColumns(db: Database.Database, tableName: string): string[] {
  if (!tableExists(db, tableName)) {
    return [];
  }

  const rows = db.prepare(`pragma table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name?: string }>;
  return rows.map((row) => row.name).filter((name): name is string => Boolean(name));
}

export function inspectSqliteTables(sqlitePath: string | null): SqliteTableInspection[] {
  if (!sqlitePath) {
    return SQLITE_KEY_TABLES.map((table) => ({
      table,
      exists: false,
      columns: [],
      associationColumns: [],
    }));
  }

  return withDatabase(sqlitePath, true, (db) =>
    SQLITE_KEY_TABLES.map((table) => {
      const columns = getTableColumns(db, table);
      return {
        table,
        exists: columns.length > 0 || tableExists(db, table),
        columns,
        associationColumns: columns.filter((column) => ASSOCIATION_COLUMNS_BY_TABLE[table].includes(column)),
      };
    }),
  );
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

function selectOptionalColumn(columns: Set<string>, columnName: string): string {
  return columns.has(columnName) ? quoteIdentifier(columnName) : `null as ${quoteIdentifier(columnName)}`;
}

function stringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const text = String(value).trim();
  return text ? text : null;
}

function addSessionId(value: unknown, ids: Set<string>): void {
  const text = stringOrNull(value);
  if (text && SESSION_ID_PATTERN.test(text)) {
    ids.add(text);
  }
}

function collectColumnSessionIds(
  db: Database.Database,
  ids: Set<string>,
  tableName: string,
  columnName: string,
): void {
  if (!columnExists(db, tableName, columnName)) {
    return;
  }

  const rows = selectRows(db, `select ${quoteIdentifier(columnName)} as value from ${quoteIdentifier(tableName)}`);
  for (const row of rows) {
    addSessionId(row.value, ids);
  }
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
    source: stringOrNull(row.source),
    threadSource: stringOrNull(row.thread_source),
    agentRole: stringOrNull(row.agent_role),
    agentNickname: stringOrNull(row.agent_nickname),
    agentPath: stringOrNull(row.agent_path),
  };
}

export function scanThreads(sqlitePath: string | null): Map<string, ThreadRow> {
  if (!sqlitePath) {
    return new Map();
  }

  return withDatabase(sqlitePath, true, (db) => {
    if (!tableExists(db, "threads")) {
      return new Map();
    }

    const columns = new Set(getTableColumns(db, "threads"));
    const orderBy = columns.has("updated_at") ? "updated_at desc" : "id";
    const rows = db
      .prepare(
        `select id, title, first_user_message, created_at, updated_at, archived, rollout_path, model, cwd,
           ${selectOptionalColumn(columns, "source")},
           ${selectOptionalColumn(columns, "thread_source")},
           ${selectOptionalColumn(columns, "agent_role")},
           ${selectOptionalColumn(columns, "agent_nickname")},
           ${selectOptionalColumn(columns, "agent_path")}
         from threads
         order by ${orderBy}`,
      )
      .all() as Record<string, unknown>[];

    return new Map(rows.map((row) => [String(row.id), mapThreadRow(row)]));
  });
}

export function scanThreadSpawnEdges(sqlitePath: string | null): ThreadSpawnEdgeRow[] {
  if (!sqlitePath) {
    return [];
  }

  return withDatabase(sqlitePath, true, (db) => {
    if (
      !tableExists(db, "thread_spawn_edges") ||
      !columnExists(db, "thread_spawn_edges", "parent_thread_id") ||
      !columnExists(db, "thread_spawn_edges", "child_thread_id")
    ) {
      return [];
    }

    const columns = getTableColumns(db, "thread_spawn_edges");
    const rows = selectRows(
      db,
      "select * from thread_spawn_edges order by parent_thread_id, child_thread_id",
    );

    return rows.flatMap((row): ThreadSpawnEdgeRow[] => {
      const parentThreadId = stringOrNull(row.parent_thread_id);
      const childThreadId = stringOrNull(row.child_thread_id);

      if (!parentThreadId || !childThreadId) {
        return [];
      }

      const metadata: Record<string, unknown> = {};
      for (const column of columns) {
        if (column === "parent_thread_id" || column === "child_thread_id" || column === "status") {
          continue;
        }
        metadata[column] = row[column] ?? null;
      }

      return [
        {
          parentThreadId,
          childThreadId,
          status: stringOrNull(row.status),
          metadata,
        },
      ];
    });
  });
}

export function collectSqliteSessionIds(sqlitePath: string | null, logsSqlitePath: string | null = null): string[] {
  const ids = new Set<string>();

  if (sqlitePath) {
    withDatabase(sqlitePath, true, (db) => {
      collectColumnSessionIds(db, ids, "threads", "id");
      collectColumnSessionIds(db, ids, "logs", "thread_id");
      collectColumnSessionIds(db, ids, "thread_spawn_edges", "parent_thread_id");
      collectColumnSessionIds(db, ids, "thread_spawn_edges", "child_thread_id");
      collectColumnSessionIds(db, ids, "agent_job_items", "assigned_thread_id");
      collectColumnSessionIds(db, ids, "thread_dynamic_tools", "thread_id");
      collectColumnSessionIds(db, ids, "stage1_outputs", "thread_id");
      collectColumnSessionIds(db, ids, "thread_goals", "thread_id");
    });
  }

  if (logsSqlitePath && logsSqlitePath !== sqlitePath) {
    withDatabase(logsSqlitePath, true, (db) => {
      collectColumnSessionIds(db, ids, "logs", "thread_id");
    });
  }

  return [...ids].sort();
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

export function sumSqliteDeletionCounts(counts: SqliteDeletionCounts): number {
  return (
    counts.threadRows +
    counts.logRows +
    counts.spawnEdgeRows +
    counts.assignedAgentJobs +
    counts.dynamicToolRows +
    counts.stage1Rows +
    counts.threadGoalRows
  );
}

function deleteStateRows(sqlitePath: string | null, sessionIds: string[]): void {
  if (!sqlitePath || sessionIds.length === 0) {
    return;
  }

  withDatabase(sqlitePath, false, (db) => {
    const deleteLogs = hasSessionLogsTable(db) ? db.prepare("delete from logs where thread_id = ?") : null;
    const deleteGoals = tableExists(db, "thread_goals") ? db.prepare("delete from thread_goals where thread_id = ?") : null;
    const deleteDynamicTools = tableExists(db, "thread_dynamic_tools")
      ? db.prepare("delete from thread_dynamic_tools where thread_id = ?")
      : null;
    const deleteStage1Outputs = tableExists(db, "stage1_outputs")
      ? db.prepare("delete from stage1_outputs where thread_id = ?")
      : null;
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
        deleteDynamicTools?.run(sessionId);
        deleteStage1Outputs?.run(sessionId);
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

function getRestoreKey(
  tableName: string,
  row: Record<string, unknown>,
): {
  columns: string[];
  values: unknown[];
  label: string;
} | null {
  if (tableName === "threads" && row.id !== undefined) {
    return { columns: ["id"], values: [row.id], label: `id=${String(row.id)}` };
  }

  if (tableName === "logs" && row.id !== undefined) {
    return { columns: ["id"], values: [row.id], label: `id=${String(row.id)}` };
  }

  if (tableName === "thread_spawn_edges" && row.child_thread_id !== undefined) {
    return {
      columns: ["child_thread_id"],
      values: [row.child_thread_id],
      label: `child_thread_id=${String(row.child_thread_id)}`,
    };
  }

  if (tableName === "agent_job_items" && row.job_id !== undefined && row.item_id !== undefined) {
    return {
      columns: ["job_id", "item_id"],
      values: [row.job_id, row.item_id],
      label: `job_id=${String(row.job_id)}, item_id=${String(row.item_id)}`,
    };
  }

  if (tableName === "thread_dynamic_tools" && row.thread_id !== undefined && row.position !== undefined) {
    return {
      columns: ["thread_id", "position"],
      values: [row.thread_id, row.position],
      label: `thread_id=${String(row.thread_id)}, position=${String(row.position)}`,
    };
  }

  if ((tableName === "stage1_outputs" || tableName === "thread_goals") && row.thread_id !== undefined) {
    return { columns: ["thread_id"], values: [row.thread_id], label: `thread_id=${String(row.thread_id)}` };
  }

  return null;
}

function assertNoRestoreKeyConflictsInDatabase(
  sqlitePath: string | null,
  tableRows: Array<{ tableName: string; rows: Record<string, unknown>[] }>,
): void {
  if (!sqlitePath) {
    return;
  }

  withDatabase(sqlitePath, true, (db) => {
    for (const { tableName, rows } of tableRows) {
      if (!tableExists(db, tableName)) {
        continue;
      }

      const tableColumns = new Set(getTableColumns(db, tableName));
      for (const row of rows) {
        const key = getRestoreKey(tableName, row);
        if (!key || key.columns.some((column) => !tableColumns.has(column))) {
          continue;
        }

        const whereSql = key.columns.map((column) => `${quoteIdentifier(column)} = ?`).join(" and ");
        const conflictSql =
          tableName === "agent_job_items" && tableColumns.has("assigned_thread_id")
            ? `select count(*) as count from ${quoteIdentifier(tableName)} where ${whereSql} and assigned_thread_id is not null`
            : `select count(*) as count from ${quoteIdentifier(tableName)} where ${whereSql}`;
        if (countRows(db, conflictSql, key.values) > 0) {
          throw new Error(`恢复冲突：SQLite key conflict ${tableName}(${key.label})`);
        }
      }
    }
  });
}

type RestoreRowsResult = {
  restored: number;
  skipped: number;
  skippedTable: string | null;
};

function restoreRowsInDatabase(
  db: Database.Database,
  tableName: string,
  rows: Record<string, unknown>[],
): RestoreRowsResult {
  if (rows.length === 0) {
    return { restored: 0, skipped: 0, skippedTable: null };
  }

  if (!tableExists(db, tableName)) {
    return { restored: 0, skipped: rows.length, skippedTable: tableName };
  }

  const tableColumns = new Set(getTableColumns(db, tableName));
  const missingRequiredColumns = (REQUIRED_RESTORE_COLUMNS_BY_TABLE[tableName] ?? []).filter(
    (column) => !tableColumns.has(column),
  );
  if (missingRequiredColumns.length > 0) {
    return { restored: 0, skipped: rows.length, skippedTable: tableName };
  }

  const columns = Object.keys(rows[0]).filter((column) => tableColumns.has(column));
  if (columns.length === 0) {
    return { restored: 0, skipped: rows.length, skippedTable: tableName };
  }

  const columnSql = columns.map(quoteIdentifier).join(", ");
  const valueSql = columns.map(() => "?").join(", ");
  const insert = db.prepare(`insert into ${quoteIdentifier(tableName)} (${columnSql}) values (${valueSql})`);
  let restored = 0;

  for (const record of rows) {
    restored += insert.run(...columns.map((column) => record[column] ?? null)).changes;
  }

  return { restored, skipped: 0, skippedTable: null };
}

function restoreRows(sqlitePath: string | null, tableName: string, rows: Record<string, unknown>[]): RestoreRowsResult {
  if (rows.length === 0) {
    return { restored: 0, skipped: 0, skippedTable: null };
  }

  if (!sqlitePath) {
    return { restored: 0, skipped: rows.length, skippedTable: tableName };
  }

  return withDatabase(sqlitePath, false, (db) => {
    const transaction = db.transaction(() => restoreRowsInDatabase(db, tableName, rows));
    return transaction();
  });
}

function restoreAgentJobItemsInDatabase(db: Database.Database, rows: Record<string, unknown>[]): RestoreRowsResult {
  if (rows.length === 0) {
    return { restored: 0, skipped: 0, skippedTable: null };
  }

  const tableName = "agent_job_items";
  if (!tableExists(db, tableName)) {
    return { restored: 0, skipped: rows.length, skippedTable: tableName };
  }

  const tableColumns = new Set(getTableColumns(db, tableName));
  const missingRequiredColumns = REQUIRED_RESTORE_COLUMNS_BY_TABLE[tableName].filter(
    (column) => !tableColumns.has(column),
  );
  if (
    missingRequiredColumns.length > 0 ||
    !tableColumns.has("job_id") ||
    !tableColumns.has("item_id") ||
    !tableColumns.has("assigned_thread_id")
  ) {
    return { restored: 0, skipped: rows.length, skippedTable: tableName };
  }

  const columns = Object.keys(rows[0]).filter((column) => tableColumns.has(column));
  if (columns.length === 0) {
    return { restored: 0, skipped: rows.length, skippedTable: tableName };
  }

  const columnSql = columns.map(quoteIdentifier).join(", ");
  const valueSql = columns.map(() => "?").join(", ");
  const insert = db.prepare(`insert into ${quoteIdentifier(tableName)} (${columnSql}) values (${valueSql})`);
  const restoreAssignment = db.prepare(
    `update ${quoteIdentifier(tableName)}
     set assigned_thread_id = ?
     where job_id = ? and item_id = ? and assigned_thread_id is null`,
  );
  let restored = 0;

  for (const record of rows) {
    const hasKey = record.job_id !== undefined && record.item_id !== undefined;
    const restoredExisting = hasKey
      ? restoreAssignment.run(record.assigned_thread_id ?? null, record.job_id, record.item_id).changes
      : 0;

    restored += restoredExisting || insert.run(...columns.map((column) => record[column] ?? null)).changes;
  }

  return { restored, skipped: 0, skippedTable: null };
}

function restoreAgentJobItems(sqlitePath: string | null, rows: Record<string, unknown>[]): RestoreRowsResult {
  if (rows.length === 0) {
    return { restored: 0, skipped: 0, skippedTable: null };
  }

  if (!sqlitePath) {
    return { restored: 0, skipped: rows.length, skippedTable: "agent_job_items" };
  }

  return withDatabase(sqlitePath, false, (db) => {
    const transaction = db.transaction(() => restoreAgentJobItemsInDatabase(db, rows));
    return transaction();
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

export function exportSqliteRecordsForRestore(
  sqlitePath: string | null,
  sessionId: string,
  logsSqlitePath: string | null = null,
): {
  state: SqliteRecordBundle;
  dedicatedLogs: Record<string, unknown>[];
} {
  return {
    state: collectStateRecords(sqlitePath, sessionId),
    dedicatedLogs: logsSqlitePath && logsSqlitePath !== sqlitePath ? collectLogRecords(logsSqlitePath, sessionId) : [],
  };
}

export function assertNoSqliteRestoreKeyConflicts(
  sqlitePath: string | null,
  logsSqlitePath: string | null,
  bundle: {
    state: SqliteRecordBundle;
    dedicatedLogs: Record<string, unknown>[];
  },
): void {
  assertNoRestoreKeyConflictsInDatabase(sqlitePath, [
    { tableName: "threads", rows: bundle.state.threads },
    { tableName: "logs", rows: bundle.state.logs },
    { tableName: "thread_dynamic_tools", rows: bundle.state.threadDynamicTools },
    { tableName: "stage1_outputs", rows: bundle.state.stage1Outputs },
    { tableName: "agent_job_items", rows: bundle.state.agentJobItems },
    { tableName: "thread_spawn_edges", rows: bundle.state.threadSpawnEdges },
    { tableName: "thread_goals", rows: bundle.state.threadGoals },
  ]);

  if (logsSqlitePath && logsSqlitePath !== sqlitePath) {
    assertNoRestoreKeyConflictsInDatabase(logsSqlitePath, [{ tableName: "logs", rows: bundle.dedicatedLogs }]);
  }
}

export function restoreSqliteRecords(
  sqlitePath: string | null,
  logsSqlitePath: string | null,
  bundle: {
    state: SqliteRecordBundle;
    dedicatedLogs: Record<string, unknown>[];
  },
): {
  restored: {
    total: number;
    threads: number;
    logs: number;
    threadSpawnEdges: number;
    agentJobItems: number;
    threadDynamicTools: number;
    stage1Outputs: number;
    threadGoals: number;
    dedicatedLogs: number;
  };
  skipped: {
    total: number;
    threads: number;
    logs: number;
    threadSpawnEdges: number;
    agentJobItems: number;
    threadDynamicTools: number;
    stage1Outputs: number;
    threadGoals: number;
    dedicatedLogs: number;
  };
  skippedTables: string[];
} {
  const skippedTables = new Set<string>();
  const restored = {
    total: 0,
    threads: 0,
    logs: 0,
    threadSpawnEdges: 0,
    agentJobItems: 0,
    threadDynamicTools: 0,
    stage1Outputs: 0,
    threadGoals: 0,
    dedicatedLogs: 0,
  };
  const skipped = { ...restored };

  function apply(
    key: keyof typeof restored,
    tableName: string,
    result: RestoreRowsResult,
  ): void {
    restored[key] = result.restored;
    skipped[key] = result.skipped;
    restored.total += result.restored;
    skipped.total += result.skipped;
    if (result.skippedTable) {
      skippedTables.add(tableName);
    }
  }

  if (sqlitePath) {
    withDatabase(sqlitePath, false, (db) => {
      const transaction = db.transaction(() => {
        apply("threads", "threads", restoreRowsInDatabase(db, "threads", bundle.state.threads));
        apply("logs", "logs", restoreRowsInDatabase(db, "logs", bundle.state.logs));
        apply("threadDynamicTools", "thread_dynamic_tools", restoreRowsInDatabase(db, "thread_dynamic_tools", bundle.state.threadDynamicTools));
        apply("stage1Outputs", "stage1_outputs", restoreRowsInDatabase(db, "stage1_outputs", bundle.state.stage1Outputs));
        apply("agentJobItems", "agent_job_items", restoreAgentJobItemsInDatabase(db, bundle.state.agentJobItems));
        apply("threadSpawnEdges", "thread_spawn_edges", restoreRowsInDatabase(db, "thread_spawn_edges", bundle.state.threadSpawnEdges));
        apply("threadGoals", "thread_goals", restoreRowsInDatabase(db, "thread_goals", bundle.state.threadGoals));
      });
      transaction();
    });
  } else {
    apply("threads", "threads", restoreRows(null, "threads", bundle.state.threads));
    apply("logs", "logs", restoreRows(null, "logs", bundle.state.logs));
    apply("threadDynamicTools", "thread_dynamic_tools", restoreRows(null, "thread_dynamic_tools", bundle.state.threadDynamicTools));
    apply("stage1Outputs", "stage1_outputs", restoreRows(null, "stage1_outputs", bundle.state.stage1Outputs));
    apply("agentJobItems", "agent_job_items", restoreAgentJobItems(null, bundle.state.agentJobItems));
    apply("threadSpawnEdges", "thread_spawn_edges", restoreRows(null, "thread_spawn_edges", bundle.state.threadSpawnEdges));
    apply("threadGoals", "thread_goals", restoreRows(null, "thread_goals", bundle.state.threadGoals));
  }

  if (logsSqlitePath && logsSqlitePath !== sqlitePath) {
    withDatabase(logsSqlitePath, false, (db) => {
      const transaction = db.transaction(() => {
        apply("dedicatedLogs", "logs", restoreRowsInDatabase(db, "logs", bundle.dedicatedLogs));
      });
      transaction();
    });
  }

  return {
    restored,
    skipped,
    skippedTables: [...skippedTables].sort(),
  };
}
