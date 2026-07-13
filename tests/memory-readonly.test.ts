import { afterEach, beforeEach, describe, expect, it } from "vitest";
import path from "node:path";

import Database from "better-sqlite3";

import { getSessionOperation, inspectRootOperation, interpretMemoryMode } from "../src/application/session-operations.js";
import { runCli } from "../src/cli/run.js";
import { deleteSessions } from "../src/core/delete.js";
import { resolveSessions } from "../src/core/query.js";
import { scanCodexRoot } from "../src/core/scan.js";
import { createFixture, FIXTURE_IDS, type Fixture } from "./helpers/fixture.js";

function createIo() {
  return {
    stdout: () => undefined,
    stderr: () => undefined,
  };
}

function createOfficialMemoriesDatabase(root: string): string {
  const databasePath = path.join(root, "memories_1.sqlite");
  const db = new Database(databasePath);
  db.exec(`
    create table stage1_outputs (
      thread_id text primary key,
      source_updated_at integer not null,
      raw_memory text not null,
      rollout_summary text not null,
      rollout_slug text,
      generated_at integer not null,
      usage_count integer,
      last_usage integer,
      selected_for_phase2 integer not null default 0,
      selected_for_phase2_source_updated_at integer
    );
    create table jobs (
      kind text not null,
      job_key text not null,
      status text not null,
      worker_id text,
      ownership_token text,
      started_at integer,
      finished_at integer,
      lease_until integer,
      retry_at integer,
      retry_remaining integer not null,
      last_error text,
      input_watermark integer,
      last_success_watermark integer,
      primary key (kind, job_key)
    );
  `);
  db.prepare(`
    insert into stage1_outputs (
      thread_id, source_updated_at, raw_memory, rollout_summary, generated_at,
      selected_for_phase2, selected_for_phase2_source_updated_at
    ) values (?, 100, ?, ?, 101, 1, 100)
  `).run(FIXTURE_IDS.ACTIVE_ID, "RAW_MEMORY_MUST_NOT_LEAK", "ROLLOUT_SUMMARY_MUST_NOT_LEAK");
  db.prepare(`
    insert into stage1_outputs (
      thread_id, source_updated_at, raw_memory, rollout_summary, generated_at,
      selected_for_phase2, selected_for_phase2_source_updated_at
    ) values (?, 200, ?, '', 201, 0, null)
  `).run(FIXTURE_IDS.ARCHIVED_ID, "ARCHIVED_RAW_MUST_NOT_LEAK");
  db.prepare("insert into jobs (kind, job_key, status, retry_remaining, last_success_watermark) values ('memory_consolidate_global', 'global', 'done', 3, 200)").run();
  db.prepare("insert into jobs (kind, job_key, status, retry_remaining) values ('memory_extract_stage1', ?, 'pending', 3)").run(FIXTURE_IDS.ARCHIVED_ID);
  db.close();
  return databasePath;
}

describe("read-only memory association", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
    const state = new Database(fixture.paths.sqlite);
    state.exec("alter table threads add column memory_mode text not null default 'enabled'");
    state.close();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("reports session memory linkage without returning memory text", async () => {
    createOfficialMemoriesDatabase(fixture.rootDir);

    const active = await getSessionOperation({ root: fixture.rootDir, sessionId: FIXTURE_IDS.ACTIVE_ID });
    const archived = await getSessionOperation({ root: fixture.rootDir, sessionId: FIXTURE_IDS.ARCHIVED_ID });

    expect(active.data.memoryLink).toEqual({
      enabled: true,
      stage1Present: true,
      rolloutSummaryPresent: true,
      phase2Influence: "unknown",
      sourceUpdatedAt: 100,
      selectedForPhase2: true,
      selectedForPhase2SourceUpdatedAt: 100,
      selectionMatchesCurrentSource: true,
      retainedAfterSessionDelete: true,
      schemaStatus: "recognized",
      warnings: [expect.stringContaining("Phase 2")],
    });
    expect(archived.data.memoryLink).toMatchObject({
      enabled: true,
      stage1Present: true,
      rolloutSummaryPresent: false,
      phase2Influence: "unknown",
      sourceUpdatedAt: 200,
      selectedForPhase2: false,
      selectedForPhase2SourceUpdatedAt: null,
      selectionMatchesCurrentSource: false,
      retainedAfterSessionDelete: true,
      warnings: [expect.stringContaining("provenance")],
    });
    const serialized = JSON.stringify([active.data.memoryLink, archived.data.memoryLink]);
    expect(serialized).not.toContain("RAW_MEMORY_MUST_NOT_LEAK");
    expect(serialized).not.toContain("ROLLOUT_SUMMARY_MUST_NOT_LEAK");
  });

  it("verifies after deletion that the read-only memory association was retained", async () => {
    createOfficialMemoriesDatabase(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);

    const result = await deleteSessions(scan, sessions, { allowActive: true });

    expect(result.validation[0].memoryLink).toMatchObject({
      stage1Present: true,
      sourceUpdatedAt: 100,
      retainedAfterSessionDelete: true,
    });
    expect(JSON.stringify(result.validation[0].memoryLink)).not.toContain("RAW_MEMORY_MUST_NOT_LEAK");
  });

  it("reports unknown for an unrecognized memory schema", async () => {
    const db = new Database(path.join(fixture.rootDir, "memories_1.sqlite"));
    db.exec("create table stage1_outputs (thread_id text primary key, raw_memory text)");
    db.prepare("insert into stage1_outputs values (?, 'PRIVATE_OLD_MEMORY')").run(FIXTURE_IDS.ACTIVE_ID);
    db.close();

    const result = await getSessionOperation({ root: fixture.rootDir, sessionId: FIXTURE_IDS.ACTIVE_ID });

    expect(result.data.memoryLink).toMatchObject({
      enabled: true,
      stage1Present: false,
      rolloutSummaryPresent: false,
      phase2Influence: "unknown",
      sourceUpdatedAt: null,
      selectedForPhase2: "unknown",
      selectedForPhase2SourceUpdatedAt: null,
      selectionMatchesCurrentSource: "unknown",
      retainedAfterSessionDelete: true,
      schemaStatus: "unrecognized",
    });
    expect(JSON.stringify(result.data.memoryLink)).not.toContain("PRIVATE_OLD_MEMORY");
  });

  it("does not claim no Phase 2 influence when the database or stage1 row is absent", async () => {
    const absent = await getSessionOperation({ root: fixture.rootDir, sessionId: FIXTURE_IDS.ACTIVE_ID });
    expect(absent.data.memoryLink).toMatchObject({
      schemaStatus: "absent",
      stage1Present: false,
      phase2Influence: "unknown",
      warnings: [expect.stringContaining("historical Phase 2 provenance")],
    });

    const databasePath = createOfficialMemoriesDatabase(fixture.rootDir);
    const db = new Database(databasePath);
    db.prepare("delete from stage1_outputs where thread_id = ?").run(FIXTURE_IDS.ACTIVE_ID);
    db.close();
    const missingRow = await getSessionOperation({ root: fixture.rootDir, sessionId: FIXTURE_IDS.ACTIVE_ID });
    expect(missingRow.data.memoryLink).toMatchObject({
      schemaStatus: "recognized",
      stage1Present: false,
      phase2Influence: "unknown",
      warnings: [expect.stringContaining("historical Phase 2 provenance")],
    });
  });

  it("reports unknown session memory enablement for unrecognized memory_mode values", async () => {
    expect(interpretMemoryMode("enabled")).toBe(true);
    expect(interpretMemoryMode("disabled")).toBe(false);
    expect(interpretMemoryMode(null)).toBe("unknown");
    expect(interpretMemoryMode(undefined)).toBe("unknown");
    expect(interpretMemoryMode("future-mode")).toBe("unknown");
    const db = new Database(fixture.paths.sqlite);
    db.prepare("update threads set memory_mode = 'mystery' where id = ?").run(FIXTURE_IDS.ACTIVE_ID);
    db.prepare("update threads set memory_mode = 'disabled' where id = ?").run(FIXTURE_IDS.ARCHIVED_ID);
    db.close();

    const unknown = await getSessionOperation({ root: fixture.rootDir, sessionId: FIXTURE_IDS.ACTIVE_ID });
    const disabled = await getSessionOperation({ root: fixture.rootDir, sessionId: FIXTURE_IDS.ARCHIVED_ID });
    expect(unknown.data.memoryLink.enabled).toBe("unknown");
    expect(disabled.data.memoryLink.enabled).toBe(false);
  });

  it("adds bounded memory statistics to doctor without raw rows", async () => {
    createOfficialMemoriesDatabase(fixture.rootDir);

    const result = await inspectRootOperation({ root: fixture.rootDir });

    expect(result.report.memory).toEqual({
      enabled: "unknown",
      databaseExists: true,
      schemaStatus: "recognized",
      stage1: { total: 2, withRolloutSummary: 1, selectedForPhase2: 1 },
      jobs: { total: 2, byStatus: { done: 1, pending: 1 } },
      warnings: [expect.stringContaining("database presence")],
    });
    expect(JSON.stringify(result.report.memory)).not.toContain("RAW_MEMORY_MUST_NOT_LEAK");
  });

  it("ordinary session deletion leaves the memories database unchanged", async () => {
    const databasePath = createOfficialMemoriesDatabase(fixture.rootDir);
    const before = new Database(databasePath, { readonly: true });
    const beforeRows = before.prepare("select * from stage1_outputs order by thread_id").all();
    before.close();

    await expect(
      runCli(["delete", FIXTURE_IDS.ARCHIVED_ID, "--root", fixture.rootDir, "--yes", "--json"], createIo()),
    ).resolves.toBe(0);

    const after = new Database(databasePath, { readonly: true });
    const afterRows = after.prepare("select * from stage1_outputs order by thread_id").all();
    after.close();
    expect(afterRows).toEqual(beforeRows);
  });

  it("delete preview and plan explicitly state that memory is retained", async () => {
    createOfficialMemoriesDatabase(fixture.rootDir);
    const previewOutput: string[] = [];
    const planOutput: string[] = [];

    await runCli(["delete", FIXTURE_IDS.ARCHIVED_ID, "--root", fixture.rootDir, "--json"], {
      stdout: (message) => previewOutput.push(message),
      stderr: () => undefined,
    });
    await runCli(["plan-delete", FIXTURE_IDS.ARCHIVED_ID, "--root", fixture.rootDir, "--json"], {
      stdout: (message) => planOutput.push(message),
      stderr: () => undefined,
    });

    expect(JSON.parse(previewOutput.join("\n")).preview).toMatchObject({
      memoryRetained: true,
      retainedSurfaces: expect.arrayContaining(["memories SQLite", "MEMORY.md", "memory_summary.md"]),
    });
    expect(JSON.parse(planOutput.join("\n")).warnings.join(" ")).toContain("memory");
  });
});
