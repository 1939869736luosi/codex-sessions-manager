import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  reconcileSqliteRecordsForRecovery,
  type SqliteRecordBundle,
} from "../src/core/sqlite.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function createStateSchema(sqlitePath: string): void {
  const db = new Database(sqlitePath);
  db.exec(`
    pragma foreign_keys = on;
    create table threads (
      id text primary key,
      title text not null,
      archived integer not null default 0
    );
    create table logs (
      id integer primary key,
      thread_id text not null,
      message text not null
    );
    create table thread_dynamic_tools (
      thread_id text not null,
      position integer not null,
      name text not null,
      primary key(thread_id, position),
      foreign key(thread_id) references threads(id)
    );
    create table stage1_outputs (
      thread_id text primary key,
      rollout_summary text not null,
      foreign key(thread_id) references threads(id)
    );
    create table agent_job_items (
      job_id text not null,
      item_id text not null,
      prompt text not null,
      assigned_thread_id text,
      primary key(job_id, item_id)
    );
    create table thread_spawn_edges (
      parent_thread_id text not null,
      child_thread_id text primary key,
      status text not null
    );
  `);
  db.close();
}

function createGoalsSchema(sqlitePath: string): void {
  const db = new Database(sqlitePath);
  db.exec(`
    create table thread_goals (
      thread_id text primary key,
      goal_id text not null,
      objective text not null
    );
  `);
  db.close();
}

function makeBundle(): SqliteRecordBundle {
  return {
    threads: [{ id: SESSION_ID, title: "restored", archived: 0 }],
    logs: [{ id: 7, thread_id: SESSION_ID, message: "legacy state log" }],
    threadSpawnEdges: [{ parent_thread_id: OTHER_ID, child_thread_id: SESSION_ID, status: "running" }],
    agentJobItems: [{ job_id: "job-1", item_id: "item-1", prompt: "do work", assigned_thread_id: SESSION_ID }],
    threadDynamicTools: [{ thread_id: SESSION_ID, position: 0, name: "search" }],
    stage1Outputs: [{ thread_id: SESSION_ID, rollout_summary: "summary" }],
    threadGoals: [{ thread_id: SESSION_ID, goal_id: "goal-1", objective: "recover safely" }],
  };
}

describe("SQLite recovery reconciliation", () => {
  let directory: string;
  let statePath: string;
  let goalsPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "csm-sqlite-recovery-"));
    statePath = path.join(directory, "state.sqlite");
    goalsPath = path.join(directory, "goals.sqlite");
    createStateSchema(statePath);
    createGoalsSchema(goalsPath);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("inserts every missing expected row and is idempotent", () => {
    const bundle = makeBundle();

    const first = reconcileSqliteRecordsForRecovery(statePath, goalsPath, bundle);
    const second = reconcileSqliteRecordsForRecovery(statePath, goalsPath, bundle);

    expect(first).toEqual({ inserted: 7, matched: 0, assignmentsRestored: 0 });
    expect(second).toEqual({ inserted: 0, matched: 7, assignmentsRestored: 0 });

    const state = new Database(statePath, { readonly: true });
    expect(state.prepare("select * from threads where id = ?").get(SESSION_ID)).toEqual({
      id: SESSION_ID,
      title: "restored",
      archived: 0,
    });
    expect(state.prepare("select count(*) as count from logs").get()).toEqual({ count: 1 });
    expect(state.prepare("select count(*) as count from thread_spawn_edges").get()).toEqual({ count: 1 });
    expect(state.prepare("select count(*) as count from agent_job_items").get()).toEqual({ count: 1 });
    expect(state.prepare("select count(*) as count from thread_dynamic_tools").get()).toEqual({ count: 1 });
    expect(state.prepare("select count(*) as count from stage1_outputs").get()).toEqual({ count: 1 });
    state.close();

    const goals = new Database(goalsPath, { readonly: true });
    expect(goals.prepare("select count(*) as count from thread_goals").get()).toEqual({ count: 1 });
    goals.close();
  });

  it("accepts identical existing rows and inserts only the missing rows", () => {
    const bundle = makeBundle();
    const db = new Database(statePath);
    db.prepare("insert into threads (id, title, archived) values (?, ?, ?)").run(SESSION_ID, "restored", 0);
    db.prepare("insert into logs (id, thread_id, message) values (?, ?, ?)").run(7, SESSION_ID, "legacy state log");
    db.close();

    const result = reconcileSqliteRecordsForRecovery(statePath, goalsPath, bundle);

    expect(result).toEqual({ inserted: 5, matched: 2, assignmentsRestored: 0 });
  });

  it("rejects a same-key value conflict and rolls back earlier inserts in the state transaction", () => {
    const db = new Database(statePath);
    db.prepare("insert into logs (id, thread_id, message) values (?, ?, ?)").run(7, SESSION_ID, "newer value");
    db.close();

    expect(() => reconcileSqliteRecordsForRecovery(statePath, goalsPath, makeBundle())).toThrow(
      /RECOVERY_REQUIRED: SQLite recovery conflict.*logs.*message/u,
    );

    const verification = new Database(statePath, { readonly: true });
    expect(verification.prepare("select count(*) as count from threads").get()).toEqual({ count: 0 });
    expect(verification.prepare("select message from logs where id = 7").get()).toEqual({ message: "newer value" });
    verification.close();
  });

  it("commits state and dedicated goals in separate transactions", () => {
    const goals = new Database(goalsPath);
    goals.prepare("insert into thread_goals (thread_id, goal_id, objective) values (?, 'goal-1', 'newer goal')").run(SESSION_ID);
    goals.close();

    expect(() => reconcileSqliteRecordsForRecovery(statePath, goalsPath, makeBundle())).toThrow(
      /RECOVERY_REQUIRED: SQLite recovery conflict.*thread_goals.*objective/u,
    );

    const state = new Database(statePath, { readonly: true });
    expect(state.prepare("select title from threads where id = ?").get(SESSION_ID)).toEqual({ title: "restored" });
    state.close();
    const goalsVerification = new Database(goalsPath, { readonly: true });
    expect(goalsVerification.prepare("select objective from thread_goals where thread_id = ?").get(SESSION_ID)).toEqual({
      objective: "newer goal",
    });
    goalsVerification.close();
  });

  it("restores a null agent assignment only when every other common column matches", () => {
    const bundle = makeBundle();
    const db = new Database(statePath);
    db.prepare("insert into threads (id, title, archived) values (?, ?, ?)").run(SESSION_ID, "restored", 0);
    db.prepare(
      "insert into agent_job_items (job_id, item_id, prompt, assigned_thread_id) values (?, ?, ?, null)",
    ).run("job-1", "item-1", "do work");
    db.close();

    const result = reconcileSqliteRecordsForRecovery(statePath, goalsPath, {
      ...bundle,
      threads: [],
      logs: [],
      threadSpawnEdges: [],
      threadDynamicTools: [],
      stage1Outputs: [],
      threadGoals: [],
    });

    expect(result).toEqual({ inserted: 0, matched: 0, assignmentsRestored: 1 });
    const verification = new Database(statePath, { readonly: true });
    expect(
      verification.prepare("select assigned_thread_id from agent_job_items where job_id = ? and item_id = ?").get("job-1", "item-1"),
    ).toEqual({ assigned_thread_id: SESSION_ID });
    verification.close();

    const conflicting = new Database(statePath);
    conflicting.prepare("update agent_job_items set assigned_thread_id = null, prompt = 'changed' where job_id = 'job-1'").run();
    conflicting.close();
    expect(() =>
      reconcileSqliteRecordsForRecovery(statePath, goalsPath, {
        ...bundle,
        threads: [],
        logs: [],
        threadSpawnEdges: [],
        threadDynamicTools: [],
        stage1Outputs: [],
        threadGoals: [],
      }),
    ).toThrow(/RECOVERY_REQUIRED: SQLite recovery conflict.*agent_job_items.*prompt/u);
  });

  it("works while both databases use WAL mode", () => {
    const state = new Database(statePath);
    expect(state.pragma("journal_mode = WAL", { simple: true })).toBe("wal");
    state.close();
    const goals = new Database(goalsPath);
    expect(goals.pragma("journal_mode = WAL", { simple: true })).toBe("wal");
    goals.close();

    expect(reconcileSqliteRecordsForRecovery(statePath, goalsPath, makeBundle()).inserted).toBe(7);
    const verification = new Database(statePath, { readonly: true });
    expect(verification.prepare("select count(*) as count from threads").get()).toEqual({ count: 1 });
    verification.close();
  });

  it("does not modify unrelated rows", () => {
    const db = new Database(statePath);
    db.prepare("insert into threads (id, title, archived) values (?, 'keep me', 1)").run(OTHER_ID);
    db.close();

    reconcileSqliteRecordsForRecovery(statePath, goalsPath, makeBundle());

    const verification = new Database(statePath, { readonly: true });
    expect(verification.prepare("select * from threads where id = ?").get(OTHER_ID)).toEqual({
      id: OTHER_ID,
      title: "keep me",
      archived: 1,
    });
    verification.close();
  });

  it("never reads or writes a dedicated logs_N database", async () => {
    const logsPath = path.join(directory, "logs_9.sqlite");
    const logs = new Database(logsPath);
    logs.exec("create table logs (id integer primary key, thread_id text, message text)");
    logs.prepare("insert into logs (id, thread_id, message) values (1, ?, 'sentinel')").run(SESSION_ID);
    logs.close();
    const before = await stat(logsPath);

    reconcileSqliteRecordsForRecovery(statePath, goalsPath, makeBundle());

    const after = await stat(logsPath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    const verification = new Database(logsPath, { readonly: true });
    expect(verification.prepare("select * from logs").all()).toEqual([
      { id: 1, thread_id: SESSION_ID, message: "sentinel" },
    ]);
    verification.close();
  });
});
