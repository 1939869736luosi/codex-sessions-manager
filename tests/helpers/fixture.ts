import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";

import Database from "better-sqlite3";

const ACTIVE_ID = "019d1111-2222-7333-8444-aaaaaaaaaaaa";
const ARCHIVED_ID = "019d2222-3333-7444-8555-bbbbbbbbbbbb";
const STALE_ID = "019d3333-4444-7555-8666-cccccccccccc";
const UNRELATED_ID = "019d4444-5555-7666-8777-dddddddddddd";
const CHILD_ID = "019d5555-6666-7777-8888-eeeeeeeeeeee";
const ACTIVE_CWD = "/workspace/demo";
const ARCHIVED_CWD = "/workspace/archive-demo";

export interface Fixture {
  rootDir: string;
  cleanup(): Promise<void>;
  readText(relativePath: string): Promise<string>;
  readBytes(relativePath: string): Promise<Uint8Array>;
  paths: {
    activeSessionFile: string;
    archivedSessionFile: string;
    sessionIndex: string;
    history: string;
    sqlite: string;
    logsSqlite: string | null;
    globalState: string;
    globalStateBak: string;
    activeShellSnapshot: string;
    archivedShellSnapshot: string;
    unrelatedShellSnapshot: string;
  };
}

export interface FixtureOptions {
  logsDatabase?: boolean;
  logsSchema?: "standard" | "missing-table" | "missing-thread-id";
  stateLogsTable?: boolean;
  threadGoals?: boolean;
}

async function writeJsonl(filePath: string, rows: unknown[]): Promise<void> {
  await writeFile(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
}

function insertLogRows(db: Database.Database, ids: readonly string[]): void {
  const insert = db.prepare(
    `insert into logs (ts, ts_nanos, level, target, feedback_log_body, thread_id, process_uuid, estimated_bytes)
     values (?, 0, 'INFO', 'fixture', ?, ?, 'fixture-process', ?)`,
  );

  ids.forEach((id, index) => {
    const body = `log for ${id}`;
    insert.run(index + 1, body, id, body.length);
  });
}

async function createLogsDatabase(
  logsSqlite: string,
  ids: readonly string[],
  schema: FixtureOptions["logsSchema"] = "standard",
): Promise<void> {
  const db = new Database(logsSqlite);

  if (schema === "missing-table") {
    db.exec("create table metadata (key text primary key, value text);");
    db.close();
    return;
  }

  if (schema === "missing-thread-id") {
    db.exec(`
      create table logs (
        id integer primary key autoincrement,
        ts integer not null
      );
    `);
    db.prepare("insert into logs (ts) values (1)").run();
    db.close();
    return;
  }

  db.exec(`
    create table logs (
      id integer primary key autoincrement,
      ts integer not null,
      ts_nanos integer not null,
      level text not null,
      target text not null,
      feedback_log_body text,
      module_path text,
      file text,
      line integer,
      thread_id text,
      process_uuid text,
      estimated_bytes integer not null default 0
    );
    create index idx_logs_thread_id on logs(thread_id);
  `);
  insertLogRows(db, ids);
  db.close();
}

export async function createFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const logsDatabase = options.logsDatabase ?? true;
  const stateLogsTable = options.stateLogsTable ?? false;
  const threadGoals = options.threadGoals ?? true;
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "codex-sessions-"));
  const sessionsDir = path.join(rootDir, "sessions", "2026", "04", "03");
  const archivedDir = path.join(rootDir, "archived_sessions");
  const shellSnapshotsDir = path.join(rootDir, "shell_snapshots");
  await mkdir(sessionsDir, { recursive: true });
  await mkdir(archivedDir, { recursive: true });
  await mkdir(shellSnapshotsDir, { recursive: true });

  const activeSessionFile = path.join(
    sessionsDir,
    `rollout-2026-04-03T12-00-00-${ACTIVE_ID}.jsonl`,
  );
  const archivedSessionFile = path.join(
    archivedDir,
    `rollout-2026-04-02T11-00-00-${ARCHIVED_ID}.jsonl`,
  );
  const sessionIndex = path.join(rootDir, "session_index.jsonl");
  const history = path.join(rootDir, "history.jsonl");
  const sqlite = path.join(rootDir, "state_5.sqlite");
  const logsSqlite = logsDatabase ? path.join(rootDir, "logs_2.sqlite") : null;
  const globalState = path.join(rootDir, ".codex-global-state.json");
  const globalStateBak = path.join(rootDir, ".codex-global-state.json.bak");
  const activeShellSnapshot = path.join(shellSnapshotsDir, `${ACTIVE_ID}.1777716371736843000.sh`);
  const archivedShellSnapshot = path.join(shellSnapshotsDir, `${ARCHIVED_ID}.1777716371736843001.sh`);
  const unrelatedShellSnapshot = path.join(shellSnapshotsDir, `${UNRELATED_ID}.1777716371736843002.sh`);

  await writeJsonl(activeSessionFile, [
    {
      type: "event_msg",
      timestamp: "2026-04-03T04:00:00.000Z",
      payload: { type: "user_message", message: "active user input" },
    },
  ]);

  await writeJsonl(archivedSessionFile, [
    {
      type: "response_item",
      timestamp: "2026-04-02T03:00:00.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "archived assistant output" }],
      },
    },
  ]);

  await writeJsonl(sessionIndex, [
    {
      id: ACTIVE_ID,
      thread_name: "Active thread",
      updated_at: "2026-04-03T04:01:00.000Z",
    },
    {
      id: ARCHIVED_ID,
      thread_name: "Archived thread",
      updated_at: "2026-04-02T03:01:00.000Z",
    },
    {
      id: STALE_ID,
      thread_name: "Stale only",
      updated_at: "2026-04-01T01:00:00.000Z",
    },
  ]);

  await writeJsonl(history, [
    { session_id: ACTIVE_ID, ts: 1, text: "active prompt" },
    { session_id: ARCHIVED_ID, ts: 2, text: "archived prompt" },
    { session_id: STALE_ID, ts: 3, text: "stale prompt" },
  ]);

  await writeFile(activeShellSnapshot, `echo active ${ACTIVE_ID}\n`, "utf8");
  await writeFile(archivedShellSnapshot, `echo archived ${ARCHIVED_ID}\n`, "utf8");
  await writeFile(unrelatedShellSnapshot, `echo unrelated ${UNRELATED_ID}\n`, "utf8");
  await writeFile(
    globalState,
    `${JSON.stringify(
      {
        "pinned-thread-ids": [ACTIVE_ID, ARCHIVED_ID, UNRELATED_ID],
        "queued-follow-ups": {
          [ACTIVE_ID]: [],
          [UNRELATED_ID]: [],
        },
        diffViewThreadSettings: {
          [ACTIVE_ID]: { mode: "split" },
          [UNRELATED_ID]: { mode: "unified" },
        },
        "some-user-setting": ACTIVE_ID,
        "prompt-history": [`this prompt mentions ${ACTIVE_ID} but is not a structured reference`],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(globalStateBak, "backup must not change\n", "utf8");

  const db = new Database(sqlite);
  db.pragma("foreign_keys = ON");
  db.exec(`
    create table threads (
      id text primary key,
      title text,
      first_user_message text,
      created_at integer,
      updated_at integer,
      archived integer,
      rollout_path text,
      model text,
      cwd text,
      source text,
      thread_source text,
      agent_role text,
      agent_nickname text,
      agent_path text
    );
    create table thread_dynamic_tools (
      thread_id text not null,
      position integer not null,
      name text not null,
      description text not null,
      input_schema text not null,
      primary key(thread_id, position),
      foreign key(thread_id) references threads(id) on delete cascade
    );
    create table stage1_outputs (
      thread_id text primary key,
      source_updated_at integer not null,
      raw_memory text not null,
      rollout_summary text not null,
      generated_at integer not null,
      foreign key(thread_id) references threads(id) on delete cascade
    );
    create table agent_job_items (
      job_id text not null,
      item_id text not null,
      assigned_thread_id text,
      primary key(job_id, item_id)
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text not null primary key,
      status text not null
    );
  `);

  if (threadGoals) {
    db.exec(`
      create table thread_goals (
        thread_id text primary key not null references threads(id) on delete cascade,
        goal_id text not null,
        objective text not null,
        status text not null check(status in ('active', 'paused', 'budget_limited', 'complete')),
        token_budget integer,
        tokens_used integer not null default 0,
        time_used_seconds integer not null default 0,
        created_at_ms integer not null,
        updated_at_ms integer not null
      );
    `);
  }

  if (stateLogsTable) {
    db.exec(`
      create table logs (
        id integer primary key autoincrement,
        thread_id text
      );
    `);
  }

  for (const [id, rolloutPath, archived, firstUserMessage, createdAt, updatedAt, cwd, source, threadSource, agentRole, agentNickname, agentPath] of [
    [ACTIVE_ID, activeSessionFile, 0, "active input", 1775198400, 1775198460, ACTIVE_CWD, "main", "main", null, null, null],
    [ARCHIVED_ID, archivedSessionFile, 1, "archived input", 1775118000, 1775118060, ARCHIVED_CWD, "side", "side", "subagent", "helper", "/tmp/helper"],
  ] as const) {
    db.prepare(
      `insert into threads (
         id, title, first_user_message, created_at, updated_at, archived, rollout_path, model, cwd,
         source, thread_source, agent_role, agent_nickname, agent_path
       )
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      `Title ${id}`,
      firstUserMessage,
      createdAt,
      updatedAt,
      archived,
      rolloutPath,
      "gpt-5.4",
      cwd,
      source,
      threadSource,
      agentRole,
      agentNickname,
      agentPath,
    );
    if (stateLogsTable) {
      db.prepare("insert into logs (thread_id) values (?)").run(id);
    }
    db.prepare(
      "insert into thread_dynamic_tools (thread_id, position, name, description, input_schema) values (?, 0, 'tool', 'desc', '{}')",
    ).run(id);
    db.prepare(
      "insert into stage1_outputs (thread_id, source_updated_at, raw_memory, rollout_summary, generated_at) values (?, 1, 'raw', 'summary', 2)",
    ).run(id);
    if (threadGoals) {
      db.prepare(
        "insert into thread_goals (thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms) values (?, ?, 'objective', 'active', 1000, 0, 0, 1, 2)",
      ).run(id, `goal-${id}`);
    }
    db.prepare(
      "insert into agent_job_items (job_id, item_id, assigned_thread_id) values ('job', ?, ?)",
    ).run(`item-${id}`, id);
  }

  db.prepare(
    "insert into thread_spawn_edges (parent_thread_id, child_thread_id, status) values (?, ?, 'running')",
  ).run(ACTIVE_ID, ARCHIVED_ID);
  db.close();

  if (logsSqlite) {
    await createLogsDatabase(logsSqlite, [ACTIVE_ID, ARCHIVED_ID], options.logsSchema);
  }

  return {
    rootDir,
    cleanup: () => rm(rootDir, { recursive: true, force: true }),
    readText: async (relativePath) => readFile(path.join(rootDir, relativePath), "utf8"),
    readBytes: async (relativePath) => new Uint8Array(await readFile(path.join(rootDir, relativePath))),
    paths: {
      activeSessionFile,
      archivedSessionFile,
      sessionIndex,
      history,
      sqlite,
      logsSqlite,
      globalState,
      globalStateBak,
      activeShellSnapshot,
      archivedShellSnapshot,
      unrelatedShellSnapshot,
    },
  };
}

export const FIXTURE_IDS = {
  ACTIVE_ID,
  ARCHIVED_ID,
  STALE_ID,
  UNRELATED_ID,
  CHILD_ID,
  ACTIVE_CWD,
  ARCHIVED_CWD,
};
