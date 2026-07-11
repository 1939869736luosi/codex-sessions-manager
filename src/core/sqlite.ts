import Database from "better-sqlite3";
import { lstatSync } from "node:fs";

import { MutationSafetyError } from "./mutation-safety.js";
import { deriveSourceInfo } from "./sources.js";
import type {
  MemoryDoctorStats,
  MemorySchemaStatus,
  SessionMemoryLink,
  SqliteDeletionCounts,
  SqliteTableInspection,
  ThreadHistoryMode,
  ThreadRow,
  ThreadSpawnEdgeRow,
} from "./types.js";

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

const ASSOCIATION_COLUMNS_BY_TABLE: Record<string, string[]> = {
  threads: ["id"],
  logs: ["thread_id", "id"],
  thread_spawn_edges: ["parent_thread_id", "child_thread_id"],
  agent_job_items: ["assigned_thread_id", "job_id", "item_id"],
  thread_dynamic_tools: ["thread_id"],
  stage1_outputs: ["thread_id"],
  thread_goals: ["thread_id"],
  jobs: ["id", "job_id", "thread_id", "source_thread_id", "target_thread_id"],
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

const SQLITE_JSON_BYTES_TAG = "$codexSessionsManagerBytesV1";

function encodeSqliteJsonValue(value: unknown): unknown {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { [SQLITE_JSON_BYTES_TAG]: Buffer.from(value).toString("base64") };
  }
  if (Array.isArray(value)) return value.map(encodeSqliteJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, nested]) => [key, encodeSqliteJsonValue(nested)]),
  );
}

function decodeSqliteJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeSqliteJsonValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 1 && typeof record[SQLITE_JSON_BYTES_TAG] === "string") {
    const encoded = record[SQLITE_JSON_BYTES_TAG];
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
      throw new MutationSafetyError("RECOVERY_REQUIRED", "stored SQLite byte value has invalid base64");
    }
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded) {
      throw new MutationSafetyError("RECOVERY_REQUIRED", "stored SQLite byte value is not canonical base64");
    }
    return bytes;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, nested]) => [key, decodeSqliteJsonValue(nested)]),
  );
}

export function encodeSqliteRecordsForJson(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return encodeSqliteJsonValue(rows) as Record<string, unknown>[];
}

export function decodeSqliteRecordsFromJson(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return decodeSqliteJsonValue(rows) as Record<string, unknown>[];
}

export function encodeSqliteRecordBundleForJson(bundle: SqliteRecordBundle): SqliteRecordBundle {
  return encodeSqliteJsonValue(bundle) as SqliteRecordBundle;
}

export function decodeSqliteRecordBundleFromJson(bundle: SqliteRecordBundle): SqliteRecordBundle {
  return decodeSqliteJsonValue(bundle) as SqliteRecordBundle;
}

const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

function assertSafeSqliteFile(filePath: string, label: string): void {
  let fileStat;
  try {
    fileStat = lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT" && label !== "main database") return;
    throw new MutationSafetyError(
      "UNSAFE_PATH",
      `${label} cannot be inspected safely (${filePath}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new MutationSafetyError("UNSAFE_PATH", `${label} must be a regular file without symlinks (${filePath})`);
  }
  if (fileStat.nlink > 1) {
    throw new MutationSafetyError("UNSAFE_PATH", `${label} has multiple hard links (${filePath})`);
  }
}

function assertSafeSqliteFiles(sqlitePath: string): void {
  assertSafeSqliteFile(sqlitePath, "main database");
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    assertSafeSqliteFile(`${sqlitePath}${suffix}`, `SQLite ${suffix.slice(1)} sidecar`);
  }
}

function withDatabase<T>(sqlitePath: string | null, readonly: boolean, callback: (db: Database.Database) => T): T {
  if (!sqlitePath) {
    throw new Error("SQLite path is not available.");
  }

  assertSafeSqliteFiles(sqlitePath);
  const db = new Database(sqlitePath, { readonly, fileMustExist: true });

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
  return inspectNamedSqliteTables(sqlitePath, [...SQLITE_KEY_TABLES]);
}

export function inspectNamedSqliteTables(sqlitePath: string | null, tables: string[]): SqliteTableInspection[] {
  if (!sqlitePath) {
    return tables.map((table) => ({
      table,
      exists: false,
      columns: [],
      associationColumns: [],
    }));
  }

  return withDatabase(sqlitePath, true, (db) =>
    tables.map((table) => {
      const columns = getTableColumns(db, table);
      return {
        table,
        exists: columns.length > 0 || tableExists(db, table),
        columns,
        associationColumns: columns.filter((column) => (ASSOCIATION_COLUMNS_BY_TABLE[table] ?? []).includes(column)),
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

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function historyModeOrUnknown(value: unknown): ThreadHistoryMode {
  const mode = stringOrNull(value);
  if (mode === "legacy" || mode === "paginated") return mode;
  return mode ? "unknown" : "legacy";
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
  const source = stringOrNull(row.source);
  const threadSource = stringOrNull(row.thread_source);
  const agentRole = stringOrNull(row.agent_role);
  const agentNickname = stringOrNull(row.agent_nickname);
  const agentPath = stringOrNull(row.agent_path);
  const sourceInfo = deriveSourceInfo({ source, threadSource, agentRole, agentNickname, agentPath });

  return {
    id: String(row.id ?? ""),
    title: String(row.title ?? ""),
    firstUserMessage: String(row.first_user_message ?? ""),
    createdAt: numberOrNull(row.created_at),
    updatedAt: numberOrNull(row.updated_at),
    createdAtMs: numberOrNull(row.created_at_ms),
    updatedAtMs: numberOrNull(row.updated_at_ms),
    recencyAt: numberOrNull(row.recency_at),
    recencyAtMs: numberOrNull(row.recency_at_ms),
    historyMode: historyModeOrUnknown(row.history_mode),
    memoryMode: stringOrNull(row.memory_mode),
    archived: Number(row.archived ?? 0) === 1,
    rolloutPath: row.rollout_path ? String(row.rollout_path) : null,
    model: row.model ? String(row.model) : null,
    modelProvider: stringOrNull(row.model_provider),
    cwd: row.cwd ? String(row.cwd) : null,
    sourceKind: sourceInfo.sourceKind,
    sourceInfo,
    source,
    threadSource,
    agentRole,
    agentNickname,
    agentPath,
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
    const orderBy = columns.has("recency_at_ms")
      ? "recency_at_ms desc, id desc"
      : columns.has("recency_at")
        ? "recency_at desc, id desc"
        : columns.has("updated_at_ms")
          ? "updated_at_ms desc, id desc"
          : columns.has("updated_at")
            ? "updated_at desc, id desc"
            : "id";
    const rows = db
      .prepare(
        `select id, title, first_user_message, created_at, updated_at,
           ${selectOptionalColumn(columns, "created_at_ms")},
           ${selectOptionalColumn(columns, "updated_at_ms")},
           ${selectOptionalColumn(columns, "recency_at")},
           ${selectOptionalColumn(columns, "recency_at_ms")},
           ${selectOptionalColumn(columns, "history_mode")},
           ${selectOptionalColumn(columns, "memory_mode")},
           archived, rollout_path, model,
           ${selectOptionalColumn(columns, "model_provider")},
           cwd,
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

const MEMORY_STAGE1_COLUMNS = [
  "thread_id",
  "source_updated_at",
  "rollout_summary",
  "selected_for_phase2",
  "selected_for_phase2_source_updated_at",
] as const;

const MEMORY_JOB_COLUMNS = ["kind", "job_key", "status", "last_success_watermark"] as const;

function memorySchemaStatus(db: Database.Database): MemorySchemaStatus {
  if (!tableExists(db, "stage1_outputs") || !tableExists(db, "jobs")) {
    return "unrecognized";
  }
  const stage1Columns = new Set(getTableColumns(db, "stage1_outputs"));
  const jobColumns = new Set(getTableColumns(db, "jobs"));
  return MEMORY_STAGE1_COLUMNS.every((column) => stage1Columns.has(column))
    && MEMORY_JOB_COLUMNS.every((column) => jobColumns.has(column))
    ? "recognized"
    : "unrecognized";
}

function emptyMemoryLink(enabled: boolean, schemaStatus: MemorySchemaStatus, warnings: string[]): SessionMemoryLink {
  return {
    enabled,
    stage1Present: false,
    rolloutSummaryPresent: false,
    phase2Influence: "unknown",
    retainedAfterSessionDelete: true,
    schemaStatus,
    warnings: [
      ...warnings,
      "historical Phase 2 provenance cannot be confirmed without a current stage1 association",
    ],
  };
}

export function inspectSessionMemoryLink(
  memoriesPath: string | null,
  sessionId: string,
  enabled: boolean,
): SessionMemoryLink {
  if (!memoriesPath) {
    return emptyMemoryLink(enabled, "absent", []);
  }

  return withDatabase(memoriesPath, true, (db) => {
    const schemaStatus = memorySchemaStatus(db);
    if (schemaStatus !== "recognized") {
      return emptyMemoryLink(enabled, schemaStatus, ["memories SQLite schema is not recognized; association is unknown"]);
    }

    const row = db.prepare(`
      select source_updated_at,
             case when length(trim(rollout_summary)) > 0 then 1 else 0 end as rollout_summary_present,
             selected_for_phase2,
             selected_for_phase2_source_updated_at
      from stage1_outputs
      where thread_id = ?
    `).get(sessionId) as {
      source_updated_at?: unknown;
      rollout_summary_present?: unknown;
      selected_for_phase2?: unknown;
      selected_for_phase2_source_updated_at?: unknown;
    } | undefined;
    if (!row) {
      return emptyMemoryLink(enabled, schemaStatus, []);
    }

    const sourceUpdatedAt = numberOrNull(row.source_updated_at);
    const selectedSourceUpdatedAt = numberOrNull(row.selected_for_phase2_source_updated_at);
    const selected = Number(row.selected_for_phase2 ?? 0) === 1;
    const selectionMatchesCurrentSource = selected
      && sourceUpdatedAt !== null
      && selectedSourceUpdatedAt === sourceUpdatedAt;
    const phase2Warning = selectionMatchesCurrentSource
      ? "session is selected for Phase 2, but final Phase 2 provenance cannot be confirmed"
      : selected
        ? "session has ambiguous Phase 2 selection metadata; final provenance cannot be confirmed"
        : "session is not currently selected for Phase 2; historical Phase 2 provenance cannot be confirmed";
    return {
      enabled,
      stage1Present: true,
      rolloutSummaryPresent: Number(row.rollout_summary_present ?? 0) === 1,
      phase2Influence: "unknown",
      retainedAfterSessionDelete: true,
      schemaStatus,
      warnings: [phase2Warning],
    };
  });
}

function emptyMemoryDoctorStats(
  databaseExists: boolean,
  schemaStatus: MemorySchemaStatus,
  warnings: string[],
): MemoryDoctorStats {
  return {
    enabled: "unknown",
    databaseExists,
    schemaStatus,
    stage1: { total: 0, withRolloutSummary: 0, selectedForPhase2: 0 },
    jobs: { total: 0, byStatus: {} },
    warnings: [
      ...warnings,
      "memory enablement cannot be inferred from database presence alone",
    ],
  };
}

export function inspectMemoryDoctorStats(memoriesPath: string | null): MemoryDoctorStats {
  if (!memoriesPath) {
    return emptyMemoryDoctorStats(false, "absent", []);
  }

  return withDatabase(memoriesPath, true, (db) => {
    const schemaStatus = memorySchemaStatus(db);
    if (schemaStatus !== "recognized") {
      return emptyMemoryDoctorStats(true, schemaStatus, ["memories SQLite schema is not recognized; statistics are unavailable"]);
    }
    const stage1 = db.prepare(`
      select
        count(*) as total,
        sum(case when length(trim(rollout_summary)) > 0 then 1 else 0 end) as with_rollout_summary,
        sum(case when selected_for_phase2 = 1 then 1 else 0 end) as selected_for_phase2
      from stage1_outputs
    `).get() as { total?: unknown; with_rollout_summary?: unknown; selected_for_phase2?: unknown };
    const statuses = db.prepare("select status, count(*) as count from jobs group by status order by status").all() as Array<{
      status?: unknown;
      count?: unknown;
    }>;
    const byStatus = Object.fromEntries(statuses.flatMap((row) => {
      const status = stringOrNull(row.status);
      return status ? [[status, Number(row.count ?? 0)]] : [];
    }));
    return {
      enabled: "unknown",
      databaseExists: true,
      schemaStatus,
      stage1: {
        total: Number(stage1.total ?? 0),
        withRolloutSummary: Number(stage1.with_rollout_summary ?? 0),
        selectedForPhase2: Number(stage1.selected_for_phase2 ?? 0),
      },
      jobs: {
        total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
        byStatus,
      },
      warnings: ["memory enablement cannot be inferred from database presence alone"],
    };
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

export function collectSqliteSessionIds(
  sqlitePath: string | null,
  logsSqlitePath: string | null = null,
  goalsSqlitePath: string | null = null,
): string[] {
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

  if (goalsSqlitePath && goalsSqlitePath !== sqlitePath) {
    withDatabase(goalsSqlitePath, true, (db) => {
      collectColumnSessionIds(db, ids, "thread_goals", "thread_id");
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
  goalsSqlitePath: string | null = null,
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

  if (goalsSqlitePath && goalsSqlitePath !== sqlitePath) {
    withDatabase(goalsSqlitePath, true, (db) => {
      for (const sessionId of sessionIds) {
        const current = counts.get(sessionId) ?? emptySqliteDeletionCounts();
        counts.set(sessionId, {
          ...current,
          threadGoalRows:
            current.threadGoalRows +
            countRowsIfTableExists(db, "thread_goals", "select count(*) as count from thread_goals where thread_id = ?", [sessionId]),
        });
      }
    });
  }

  return counts;
}

export function collectSqliteDeletionTotals(
  sqlitePath: string | null,
  sessionIds: string[],
  logsSqlitePath: string | null = null,
  goalsSqlitePath: string | null = null,
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

  if (goalsSqlitePath && goalsSqlitePath !== sqlitePath) {
    const goalTotals = withDatabase(goalsSqlitePath, true, (db) => ({
      ...emptySqliteDeletionCounts(),
      threadGoalRows: collectCountsForSessions(db, sessionIds).threadGoalRows,
    }));
    totals = addCounts(totals, goalTotals);
  }

  return totals;
}

export function sumSqliteDeletionCounts(counts: SqliteDeletionCounts): number {
  return (
    counts.threadRows +
    counts.spawnEdgeRows +
    counts.assignedAgentJobs +
    counts.dynamicToolRows +
    counts.stage1Rows +
    counts.threadGoalRows
  );
}

export function deleteStateRows(sqlitePath: string | null, sessionIds: string[]): void {
  if (!sqlitePath || sessionIds.length === 0) {
    return;
  }

  withDatabase(sqlitePath, false, (db) => {
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

export function deleteGoalRows(sqlitePath: string | null, sessionIds: string[]): void {
  if (!sqlitePath || sessionIds.length === 0) {
    return;
  }

  withDatabase(sqlitePath, false, (db) => {
    if (!tableExists(db, "thread_goals")) {
      return;
    }

    const deleteGoals = db.prepare("delete from thread_goals where thread_id = ?");
    const transaction = db.transaction((ids: string[]) => {
      for (const sessionId of ids) {
        deleteGoals.run(sessionId);
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
    logs: [],
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

function collectGoalRecords(sqlitePath: string | null, sessionId: string): Record<string, unknown>[] {
  if (!sqlitePath) {
    return [];
  }

  return withDatabase(sqlitePath, true, (db) =>
    selectRowsIfTableExists(db, "thread_goals", "select * from thread_goals where thread_id = ?", [sessionId]),
  );
}

function collectGoalRecordsForSessions(sqlitePath: string | null, sessionIds: string[]): Record<string, unknown>[] {
  if (!sqlitePath || sessionIds.length === 0) {
    return [];
  }

  return withDatabase(sqlitePath, true, (db) =>
    sessionIds.flatMap((sessionId) =>
      selectRowsIfTableExists(db, "thread_goals", "select * from thread_goals where thread_id = ?", [sessionId]),
    ),
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

function removeRestoredRowsIfUnchanged(
  sqlitePath: string | null,
  tableName: string,
  rows: Record<string, unknown>[],
): void {
  if (!sqlitePath || rows.length === 0) return;
  withDatabase(sqlitePath, false, (db) => {
    const transaction = db.transaction(() => {
      if (!tableExists(db, tableName)) {
        throw new MutationSafetyError(
          "RECOVERY_REQUIRED",
          `SQLite rollback cannot verify ${tableName}: table is missing`,
        );
      }
      const tableColumns = new Set(getTableColumns(db, tableName));
      for (const row of rows) {
        const key = getRestoreKey(tableName, row);
        if (!key || key.columns.some((column) => !tableColumns.has(column))) {
          throw new MutationSafetyError(
            "RECOVERY_REQUIRED",
            `SQLite rollback cannot identify restored ${tableName} row`,
          );
        }
        const whereSql = key.columns.map((column) => `${quoteIdentifier(column)} is ?`).join(" and ");
        const current = db
          .prepare(`select * from ${quoteIdentifier(tableName)} where ${whereSql}`)
          .get(...key.values) as Record<string, unknown> | undefined;
        if (!current) continue;
        const comparisonColumns = Object.keys(row).filter((column) => tableColumns.has(column));
        const differs = comparisonColumns.some(
          (column) => !recoveryValueEquals(current[column], row[column]),
        );
        if (differs) {
          throw new MutationSafetyError(
            "RECOVERY_REQUIRED",
            `SQLite rollback found a concurrent change in ${tableName} (${key.label})`,
          );
        }
        db.prepare(`delete from ${quoteIdentifier(tableName)} where ${whereSql}`).run(...key.values);
      }
    });
    transaction();
  });
}

export function deleteSessionsFromSqlite(
  sqlitePath: string | null,
  sessionIds: string[],
  logsSqlitePath: string | null = null,
  goalsSqlitePath: string | null = null,
): Map<string, SqliteDeletionCounts> {
  const counts = collectSqliteDeletionCounts(sqlitePath, sessionIds, logsSqlitePath, goalsSqlitePath);
  const usesDedicatedGoals = Boolean(goalsSqlitePath && goalsSqlitePath !== sqlitePath);
  const goalSnapshots = usesDedicatedGoals ? collectGoalRecordsForSessions(goalsSqlitePath, sessionIds) : [];
  let dedicatedGoalsDeleted = false;

  try {
    if (usesDedicatedGoals) {
      deleteGoalRows(goalsSqlitePath, sessionIds);
      dedicatedGoalsDeleted = true;
    }

    deleteStateRows(sqlitePath, sessionIds);
  } catch (error) {
    if (dedicatedGoalsDeleted) {
      try {
        restoreRows(goalsSqlitePath, "thread_goals", goalSnapshots);
      } catch (restoreError) {
        throw new Error(
          `SQLite 删除失败，goals 恢复也失败：${restoreError instanceof Error ? restoreError.message : String(restoreError)}。原始错误：${error instanceof Error ? error.message : String(error)}`,
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
  goalsSqlitePath: string | null = null,
): Map<string, SqliteDeletionCounts> {
  return collectSqliteDeletionCounts(sqlitePath, sessionIds, logsSqlitePath, goalsSqlitePath);
}

export function exportSqliteRecords(
  sqlitePath: string | null,
  sessionId: string,
  _logsSqlitePath: string | null = null,
  goalsSqlitePath: string | null = null,
): SqliteRecordBundle {
  const bundle = collectStateRecords(sqlitePath, sessionId);

  if (goalsSqlitePath && goalsSqlitePath !== sqlitePath) {
    bundle.threadGoals.push(...collectGoalRecords(goalsSqlitePath, sessionId));
  }

  return bundle;
}

export function exportSqliteRecordsForRestore(
  sqlitePath: string | null,
  sessionId: string,
  _logsSqlitePath: string | null = null,
  goalsSqlitePath: string | null = null,
): {
  state: SqliteRecordBundle;
  dedicatedLogs: Record<string, unknown>[];
} {
  const state = collectStateRecords(sqlitePath, sessionId);
  if (goalsSqlitePath && goalsSqlitePath !== sqlitePath) {
    state.threadGoals.push(...collectGoalRecords(goalsSqlitePath, sessionId));
  }

  return {
    state,
    dedicatedLogs: [],
  };
}

export function assertNoSqliteRestoreKeyConflicts(
  sqlitePath: string | null,
  logsSqlitePath: string | null,
  goalsSqlitePath: string | null,
  bundle: {
    state: SqliteRecordBundle;
    dedicatedLogs: Record<string, unknown>[];
  },
): void {
  const usesDedicatedGoals = Boolean(goalsSqlitePath && goalsSqlitePath !== sqlitePath);
  assertNoRestoreKeyConflictsInDatabase(sqlitePath, [
    { tableName: "threads", rows: bundle.state.threads },
    { tableName: "logs", rows: bundle.state.logs },
    { tableName: "thread_dynamic_tools", rows: bundle.state.threadDynamicTools },
    { tableName: "stage1_outputs", rows: bundle.state.stage1Outputs },
    { tableName: "agent_job_items", rows: bundle.state.agentJobItems },
    { tableName: "thread_spawn_edges", rows: bundle.state.threadSpawnEdges },
    ...(usesDedicatedGoals ? [] : [{ tableName: "thread_goals", rows: bundle.state.threadGoals }]),
  ]);

  if (logsSqlitePath && logsSqlitePath !== sqlitePath) {
    assertNoRestoreKeyConflictsInDatabase(logsSqlitePath, [{ tableName: "logs", rows: bundle.dedicatedLogs }]);
  }

  if (goalsSqlitePath && goalsSqlitePath !== sqlitePath) {
    assertNoRestoreKeyConflictsInDatabase(goalsSqlitePath, [{ tableName: "thread_goals", rows: bundle.state.threadGoals }]);
  }
}

export function restoreSqliteRecords(
  sqlitePath: string | null,
  logsSqlitePath: string | null,
  goalsSqlitePath: string | null,
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
  const usesDedicatedGoals = Boolean(goalsSqlitePath && goalsSqlitePath !== sqlitePath);
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

  let dedicatedLogsApplied = false;
  let dedicatedGoalsApplied = false;
  try {
    // Separate databases commit before the state database. If a later write
    // fails, their exact rows can be conditionally removed without touching
    // unrelated or concurrently changed rows.
    if (logsSqlitePath && logsSqlitePath !== sqlitePath) {
      withDatabase(logsSqlitePath, false, (db) => {
        const transaction = db.transaction(() => {
          apply("dedicatedLogs", "logs", restoreRowsInDatabase(db, "logs", bundle.dedicatedLogs));
        });
        transaction();
      });
      dedicatedLogsApplied = restored.dedicatedLogs > 0;
    }

    if (usesDedicatedGoals) {
      withDatabase(goalsSqlitePath, false, (db) => {
        const transaction = db.transaction(() => {
          apply("threadGoals", "thread_goals", restoreRowsInDatabase(db, "thread_goals", bundle.state.threadGoals));
        });
        transaction();
      });
      dedicatedGoalsApplied = restored.threadGoals > 0;
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
          if (!usesDedicatedGoals) {
            apply("threadGoals", "thread_goals", restoreRowsInDatabase(db, "thread_goals", bundle.state.threadGoals));
          }
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
      if (!usesDedicatedGoals) {
        apply("threadGoals", "thread_goals", restoreRows(null, "thread_goals", bundle.state.threadGoals));
      }
    }
  } catch (error) {
    try {
      if (dedicatedGoalsApplied) {
        removeRestoredRowsIfUnchanged(goalsSqlitePath, "thread_goals", bundle.state.threadGoals);
      }
      if (dedicatedLogsApplied) {
        removeRestoredRowsIfUnchanged(logsSqlitePath, "logs", bundle.dedicatedLogs);
      }
    } catch (rollbackError) {
      throw new MutationSafetyError(
        "RECOVERY_REQUIRED",
        `SQLite restore failed and exact cross-database rollback was unsafe: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      );
    }
    throw error;
  }

  return {
    restored,
    skipped,
    skippedTables: [...skippedTables].sort(),
  };
}

function assertRowsPresentAndUnchanged(
  db: Database.Database,
  tableName: string,
  rows: Record<string, unknown>[],
  skippedTables: ReadonlySet<string>,
): void {
  if (rows.length === 0 || skippedTables.has(tableName)) return;
  if (!tableExists(db, tableName)) {
    throw new MutationSafetyError("RECOVERY_REQUIRED", `SQLite verification is missing table ${tableName}`);
  }
  const tableColumns = new Set(getTableColumns(db, tableName));
  for (const row of rows) {
    const key = getRestoreKey(tableName, row);
    if (!key || key.columns.some((column) => !tableColumns.has(column))) {
      throw new MutationSafetyError("RECOVERY_REQUIRED", `SQLite verification cannot identify ${tableName} row`);
    }
    const whereSql = key.columns.map((column) => `${quoteIdentifier(column)} is ?`).join(" and ");
    const current = db
      .prepare(`select * from ${quoteIdentifier(tableName)} where ${whereSql}`)
      .get(...key.values) as Record<string, unknown> | undefined;
    if (!current) {
      throw new MutationSafetyError(
        "RECOVERY_REQUIRED",
        `SQLite verification is missing ${tableName} (${key.label})`,
      );
    }
    const comparisonColumns = Object.keys(row).filter((column) => tableColumns.has(column));
    const differingColumns = comparisonColumns.filter(
      (column) => !recoveryValueEquals(current[column], row[column]),
    );
    if (differingColumns.length > 0) {
      throw new MutationSafetyError(
        "RECOVERY_REQUIRED",
        `SQLite verification found changed ${tableName} (${key.label}): ${differingColumns.join(", ")}`,
      );
    }
  }
}

export function validateRestoredSqliteRecords(
  sqlitePath: string | null,
  goalsSqlitePath: string | null,
  bundle: SqliteRecordBundle,
  skippedTableNames: readonly string[] = [],
): void {
  const skippedTables = new Set(skippedTableNames);
  const usesDedicatedGoals = Boolean(goalsSqlitePath && goalsSqlitePath !== sqlitePath);
  if (sqlitePath) {
    withDatabase(sqlitePath, true, (db) => {
      assertRowsPresentAndUnchanged(db, "threads", bundle.threads, skippedTables);
      assertRowsPresentAndUnchanged(db, "logs", bundle.logs, skippedTables);
      assertRowsPresentAndUnchanged(db, "thread_dynamic_tools", bundle.threadDynamicTools, skippedTables);
      assertRowsPresentAndUnchanged(db, "stage1_outputs", bundle.stage1Outputs, skippedTables);
      assertRowsPresentAndUnchanged(db, "agent_job_items", bundle.agentJobItems, skippedTables);
      assertRowsPresentAndUnchanged(db, "thread_spawn_edges", bundle.threadSpawnEdges, skippedTables);
      if (!usesDedicatedGoals) {
        assertRowsPresentAndUnchanged(db, "thread_goals", bundle.threadGoals, skippedTables);
      }
    });
  }
  if (usesDedicatedGoals) {
    withDatabase(goalsSqlitePath, true, (db) => {
      assertRowsPresentAndUnchanged(db, "thread_goals", bundle.threadGoals, skippedTables);
    });
  }
}

export interface SqliteRecoveryReconcileResult {
  inserted: number;
  matched: number;
  assignmentsRestored: number;
}

function emptyRecoveryReconcileResult(): SqliteRecoveryReconcileResult {
  return { inserted: 0, matched: 0, assignmentsRestored: 0 };
}

function addRecoveryReconcileResults(
  left: SqliteRecoveryReconcileResult,
  right: SqliteRecoveryReconcileResult,
): SqliteRecoveryReconcileResult {
  return {
    inserted: left.inserted + right.inserted,
    matched: left.matched + right.matched,
    assignmentsRestored: left.assignmentsRestored + right.assignmentsRestored,
  };
}

function recoveryValueEquals(actual: unknown, expected: unknown): boolean {
  const normalizedExpected = expected === undefined ? null : expected;
  if (Buffer.isBuffer(actual) && Buffer.isBuffer(normalizedExpected)) {
    return actual.equals(normalizedExpected);
  }
  if (actual instanceof Uint8Array && normalizedExpected instanceof Uint8Array) {
    return Buffer.from(actual).equals(Buffer.from(normalizedExpected));
  }
  return Object.is(actual, normalizedExpected);
}

function describeRecoveryKey(key: { label: string }): string {
  return key.label.replaceAll("\n", " ");
}

function throwRecoveryConflict(
  tableName: string,
  key: { label: string },
  columns: string[],
): never {
  throw new MutationSafetyError(
    "RECOVERY_REQUIRED",
    `SQLite recovery conflict in ${tableName} (${describeRecoveryKey(key)}); differing columns: ${columns.join(", ")}`,
  );
}

function reconcileRowsForRecovery(
  db: Database.Database,
  tableName: string,
  rows: Record<string, unknown>[],
): SqliteRecoveryReconcileResult {
  const result = emptyRecoveryReconcileResult();
  if (rows.length === 0) return result;
  if (!tableExists(db, tableName)) {
    throw new MutationSafetyError(
      "RECOVERY_REQUIRED",
      `SQLite recovery cannot reconcile ${tableName}: expected table is missing`,
    );
  }

  const tableColumns = new Set(getTableColumns(db, tableName));
  for (const row of rows) {
    const key = getRestoreKey(tableName, row);
    if (!key || key.columns.some((column) => !tableColumns.has(column))) {
      throw new MutationSafetyError(
        "RECOVERY_REQUIRED",
        `SQLite recovery cannot identify an expected ${tableName} row by a supported key`,
      );
    }

    const commonColumns = Object.keys(row).filter((column) => tableColumns.has(column));
    if (commonColumns.length === 0) {
      throw new MutationSafetyError(
        "RECOVERY_REQUIRED",
        `SQLite recovery cannot reconcile ${tableName} (${describeRecoveryKey(key)}): no common columns`,
      );
    }

    const whereSql = key.columns.map((column) => `${quoteIdentifier(column)} is ?`).join(" and ");
    const existing = db
      .prepare(`select * from ${quoteIdentifier(tableName)} where ${whereSql}`)
      .get(...key.values) as Record<string, unknown> | undefined;

    if (!existing) {
      const columnSql = commonColumns.map(quoteIdentifier).join(", ");
      const valueSql = commonColumns.map(() => "?").join(", ");
      db.prepare(`insert into ${quoteIdentifier(tableName)} (${columnSql}) values (${valueSql})`).run(
        ...commonColumns.map((column) => row[column] ?? null),
      );
      result.inserted += 1;
      continue;
    }

    const assignmentRecovery = tableName === "agent_job_items" && tableColumns.has("assigned_thread_id");
    const comparisonColumns = assignmentRecovery
      ? commonColumns.filter((column) => column !== "assigned_thread_id")
      : commonColumns;
    const differingColumns = comparisonColumns.filter(
      (column) => !recoveryValueEquals(existing[column], row[column]),
    );
    if (differingColumns.length > 0) {
      throwRecoveryConflict(tableName, key, differingColumns);
    }

    if (assignmentRecovery) {
      const actualAssignment = existing.assigned_thread_id ?? null;
      const expectedAssignment = row.assigned_thread_id ?? null;
      if (actualAssignment === null && expectedAssignment !== null) {
        const updateWhereSql = key.columns.map((column) => `${quoteIdentifier(column)} is ?`).join(" and ");
        const update = db
          .prepare(
            `update ${quoteIdentifier(tableName)}
             set assigned_thread_id = ?
             where ${updateWhereSql} and assigned_thread_id is null`,
          )
          .run(expectedAssignment, ...key.values);
        if (update.changes !== 1) {
          throw new MutationSafetyError(
            "RECOVERY_REQUIRED",
            `SQLite recovery could not restore agent assignment in ${tableName} (${describeRecoveryKey(key)})`,
          );
        }
        result.assignmentsRestored += 1;
        continue;
      }
      if (!recoveryValueEquals(actualAssignment, expectedAssignment)) {
        throwRecoveryConflict(tableName, key, ["assigned_thread_id"]);
      }
    }

    result.matched += 1;
  }

  return result;
}

function reconcileDatabaseForRecovery(
  sqlitePath: string | null,
  tableRows: Array<{ tableName: string; rows: Record<string, unknown>[] }>,
): SqliteRecoveryReconcileResult {
  const hasExpectedRows = tableRows.some(({ rows }) => rows.length > 0);
  if (!hasExpectedRows) return emptyRecoveryReconcileResult();
  if (!sqlitePath) {
    throw new MutationSafetyError(
      "RECOVERY_REQUIRED",
      "SQLite recovery cannot reconcile expected rows because the database path is unavailable",
    );
  }

  try {
    return withDatabase(sqlitePath, false, (db) => {
      const transaction = db.transaction(() => {
        let result = emptyRecoveryReconcileResult();
        for (const { tableName, rows } of tableRows) {
          result = addRecoveryReconcileResults(result, reconcileRowsForRecovery(db, tableName, rows));
        }
        return result;
      });
      return transaction();
    });
  } catch (error) {
    if (error instanceof MutationSafetyError) throw error;
    throw new MutationSafetyError(
      "RECOVERY_REQUIRED",
      `SQLite recovery failed for ${sqlitePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Idempotently reconciles rows recorded by a recovery journal.
 *
 * Dedicated logs databases are deliberately outside this API. State and goals
 * databases commit in separate SQLite transactions so a retry can reconcile
 * either committed side without overwriting newer, conflicting values.
 */
export function reconcileSqliteRecordsForRecovery(
  sqlitePath: string | null,
  goalsSqlitePath: string | null,
  bundle: SqliteRecordBundle,
): SqliteRecoveryReconcileResult {
  const usesDedicatedGoals = Boolean(goalsSqlitePath && goalsSqlitePath !== sqlitePath);
  const stateResult = reconcileDatabaseForRecovery(sqlitePath, [
    { tableName: "threads", rows: bundle.threads },
    { tableName: "logs", rows: bundle.logs },
    { tableName: "thread_dynamic_tools", rows: bundle.threadDynamicTools },
    { tableName: "stage1_outputs", rows: bundle.stage1Outputs },
    { tableName: "agent_job_items", rows: bundle.agentJobItems },
    { tableName: "thread_spawn_edges", rows: bundle.threadSpawnEdges },
    ...(usesDedicatedGoals ? [] : [{ tableName: "thread_goals", rows: bundle.threadGoals }]),
  ]);
  if (!usesDedicatedGoals) return stateResult;

  const goalsResult = reconcileDatabaseForRecovery(goalsSqlitePath, [
    { tableName: "thread_goals", rows: bundle.threadGoals },
  ]);
  return addRecoveryReconcileResults(stateResult, goalsResult);
}
