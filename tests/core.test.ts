import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";

import { buildRootDeletePreview, buildRootResidueAudit, buildSessionResidueAudit } from "../src/core/audit.js";
import { exportSessionBackup } from "../src/core/backup.js";
import {
  buildDeletePreview,
  cleanupSessionIndexes,
  cleanupStaleIndexes,
  deleteSessions,
  previewCleanupSessionIndexes,
  previewCleanupStaleIndexes,
  validateDeletion,
} from "../src/core/delete.js";
import { buildSessionFamily, buildSessionFamilyQuery } from "../src/core/family.js";
import { inspectCodexRoot } from "../src/core/doctor.js";
import { listProjectSummaries } from "../src/core/project.js";
import { filterSessions, resolveSessions } from "../src/core/query.js";
import { scanCodexRoot } from "../src/core/scan.js";
import { summarizeSources } from "../src/core/sources.js";
import { readSessionTimeline } from "../src/core/timeline.js";
import { listTrashEntries, moveSessionsToTrash, purgeTrashEntry, restoreTrashEntry } from "../src/core/trash.js";
import { createFixture, FIXTURE_IDS, type Fixture } from "./helpers/fixture.js";

describe("core integration", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fixture.cleanup();
  });

  it("scans active, archived, and stale sessions", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const active = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID])[0];

    expect(new Set(scan.sessions.map((session) => session.id))).toEqual(
      new Set([FIXTURE_IDS.ACTIVE_ID, FIXTURE_IDS.ARCHIVED_ID, FIXTURE_IDS.STALE_ID]),
    );
    expect(active.kind).toBe("active");
    expect(active.displayTitle).toBe("Active thread");
    expect(active.title).toBe(active.displayTitle);
    expect(active.indexTitle).toBe("Active thread");
    expect(active.sqliteTitle).toBe(`Title ${FIXTURE_IDS.ACTIVE_ID}`);
    expect(active.firstUserMessage).toBe("active input");
    expect(active.titleSource).toBe("session_index");
    expect(active.titleMismatch).toBe(true);
    expect(active.titleCandidates).toEqual([
      { source: "session_index", title: "Active thread" },
      { source: "sqlite", title: `Title ${FIXTURE_IDS.ACTIVE_ID}` },
      { source: "first_user_message", title: "active input" },
      { source: "id", title: FIXTURE_IDS.ACTIVE_ID },
    ]);
    expect(active.sourceKind).toBe("cli");
    expect(active.source).toBe("cli");
    expect(active.threadSource).toBe("cli");
    expect(active.modelProvider).toBe("openai");
    expect(resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID])[0].kind).toBe("archived");
    expect(resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID])[0].sourceKind).toBe("subagent");
    expect(resolveSessions(scan, [FIXTURE_IDS.STALE_ID])[0].kind).toBe("stale");
  });

  it("searches all title candidates while showing the session_index title by default", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const byDisplayTitle = filterSessions(scan, { query: "Active thread" });
    const bySqliteTitle = filterSessions(scan, { query: `Title ${FIXTURE_IDS.ACTIVE_ID}` });
    const byFirstMessage = filterSessions(scan, { query: "active input" });

    expect(byDisplayTitle.map((session) => session.id)).toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(bySqliteTitle.map((session) => session.id)).toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(byFirstMessage.map((session) => session.id)).toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(bySqliteTitle[0].displayTitle).toBe("Active thread");
  });

  it("does not mark first user message differences as title mismatch", async () => {
    const db = new Database(fixture.paths.sqlite);
    db.prepare("update threads set title = ? where id = ?").run("Active thread", FIXTURE_IDS.ACTIVE_ID);
    db.close();

    const scan = await scanCodexRoot(fixture.rootDir);
    const active = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID])[0];

    expect(active.indexTitle).toBe("Active thread");
    expect(active.sqliteTitle).toBe("Active thread");
    expect(active.firstUserMessage).toBe("active input");
    expect(active.titleMismatch).toBe(false);
  });

  it("filters sessions by project, status, and updated time", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = filterSessions(scan, {
      project: "demo",
      status: "active",
      updatedAfter: "2026-04-03",
      updatedBefore: "2026-04-03",
    });
    const projects = listProjectSummaries(scan.sessions);

    expect(sessions.map((session) => session.id)).toEqual([FIXTURE_IDS.ACTIVE_ID]);
    expect(sessions[0].projectPath).toBe(FIXTURE_IDS.ACTIVE_CWD);
    expect(projects.some((project) => project.projectName === "demo" && project.activeCount === 1)).toBe(true);
    expect(projects.some((project) => project.projectName === "archive-demo" && project.archivedCount === 1)).toBe(true);
  });

  it("filters sessions by source and model metadata", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const subagentSessions = filterSessions(scan, {
      sourceKind: "subagent",
      source: "side",
      threadSource: "side",
      agentRole: "subagent",
      agentNickname: "helper",
      modelProvider: "sub2api",
      model: "gpt-5.4",
    });
    const cliSessions = filterSessions(scan, {
      sourceKind: ["cli"],
      source: ["cli"],
      modelProvider: ["openai"],
    });

    expect(subagentSessions.map((session) => session.id)).toEqual([FIXTURE_IDS.ARCHIVED_ID]);
    expect(cliSessions.map((session) => session.id)).toEqual([FIXTURE_IDS.ACTIVE_ID]);
    expect(() => filterSessions(scan, { sourceKind: "desktop" })).toThrow("sourceKind 可选");
  });

  it("summarizes source fields while keeping raw source values", async () => {
    const jsonSource = JSON.stringify({
      subagent: {
        thread_spawn: {
          parent_thread_id: FIXTURE_IDS.ACTIVE_ID,
          agent_role: "explorer",
        },
      },
    });
    const db = new Database(fixture.paths.sqlite);
    db.prepare("update threads set source = ?, thread_source = ?, agent_role = null, agent_nickname = null, agent_path = null where id = ?").run(
      jsonSource,
      "subagent",
      FIXTURE_IDS.ARCHIVED_ID,
    );
    db.close();

    const scan = await scanCodexRoot(fixture.rootDir);
    const archived = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID])[0];
    const summary = summarizeSources(scan.sessions);

    expect(archived.sourceKind).toBe("subagent");
    expect(archived.source).toBe(jsonSource);
    expect(summary.bySourceKind).toMatchObject({ cli: 1, subagent: 1, unknown: 1 });
    expect(summary.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceKind: "subagent",
          source: jsonSource,
          threadSource: "subagent",
          modelProvider: "sub2api",
          model: "gpt-5.4",
          agentRole: null,
          count: 1,
        }),
      ]),
    );
  });

  it("reports invalid date filters clearly", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    expect(() => filterSessions(scan, { updatedAfter: "not-a-date" })).toThrow("updatedAfter 不是有效日期");
    expect(() => filterSessions(scan, { updatedAfter: "2026-02-31" })).toThrow("updatedAfter 不是有效日期");
    expect(() => filterSessions(scan, { updatedBefore: "2026-04-31" })).toThrow("updatedBefore 不是有效日期");
    expect(() => filterSessions(scan, { updatedAfter: "2026-02-31T00:00:00.000Z" })).toThrow("updatedAfter 不是有效日期");
    expect(() => filterSessions(scan, { updatedBefore: "2026-04-31T12:00:00Z" })).toThrow("updatedBefore 不是有效日期");
    expect(() => filterSessions(scan, { updatedAfter: "2026-04-03T00:00:00" })).toThrow("updatedAfter 必须带明确时区");
    expect(filterSessions(scan, { updatedAfter: "2026-04-03T00:00:00.000Z" }).map((session) => session.id)).toContain(
      FIXTURE_IDS.ACTIVE_ID,
    );
  });

  it("uses plain sqlite insert during restore instead of insert or replace", async () => {
    const sqliteSource = await readFile(path.join(process.cwd(), "src/core/sqlite.ts"), "utf8");

    expect(sqliteSource).not.toContain("insert or replace");
  });

  it("interprets date-only filters as local calendar days", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID])[0];
    session.updatedAt = new Date(2026, 3, 3, 0, 30, 0, 0).toISOString();

    const sessions = filterSessions(scan, {
      updatedAfter: "2026-04-03",
      updatedBefore: "2026-04-03",
    });

    expect(sessions.map((item) => item.id)).toContain(FIXTURE_IDS.ACTIVE_ID);
  });

  it("builds a timeline and backup bundle", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID])[0];
    const timeline = await readSessionTimeline(session);
    const backup = await exportSessionBackup(scan, session);

    expect(timeline[0]?.body).toContain("active user input");
    expect(backup.manifest.sessionId).toBe(FIXTURE_IDS.ACTIVE_ID);
    expect(backup.sessionFiles).toHaveLength(1);
    expect(backup.shellSnapshots).toHaveLength(1);
    expect(backup.shellSnapshots[0].text).toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(backup.globalStateRefs).toHaveLength(3);
    expect(backup.sqlite.threads).toHaveLength(1);
    expect(backup.sqlite.logs).toHaveLength(1);
    expect(backup.sqlite.threadGoals).toHaveLength(1);
  });

  it("builds a session family for a parent with children", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const active = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID])[0];
    const family = buildSessionFamily(scan, active);

    expect(family.current.sessionId).toBe(FIXTURE_IDS.ACTIVE_ID);
    expect(family.root.sessionId).toBe(FIXTURE_IDS.ACTIVE_ID);
    expect(family.parent).toBeNull();
    expect(family.directChildren.map((node) => node.sessionId)).toEqual([FIXTURE_IDS.ARCHIVED_ID]);
    expect(family.directChildren[0]).toMatchObject({
      relationship: "child",
      relationshipStatus: "running",
      archived: true,
      fileExists: true,
      source: "side",
      sourceLabel: "subagent",
      threadSource: "side",
      agentRole: "subagent",
      agentNickname: "helper",
      agentPath: "/tmp/helper",
    });
    expect(family.directChildren[0]).toMatchObject({
      edgeStatus: "open",
      sourceKind: "subagent",
      childCategory: "subagent",
      childType: "subagent",
      childTypeLabels: ["subagent", "side/fork"],
      relationshipLabels: ["child", "child:subagent", "child:side/fork"],
      hasSessionIndex: true,
      hasThread: true,
    });
    expect(family.childrenByCategory.subagent.map((node) => node.sessionId)).toEqual([FIXTURE_IDS.ARCHIVED_ID]);
    expect(family.childrenByCategory["side/fork"].map((node) => node.sessionId)).toEqual([FIXTURE_IDS.ARCHIVED_ID]);
  });

  it("queries family modes and classifies direct children from child metadata", async () => {
    const childRows = [
      {
        id: "019d6666-7777-7888-8999-ffffffffffff",
        title: "Fork child",
        source: "fork",
        threadSource: "fork",
        status: "complete",
        expectedCategory: "side/fork",
        expectedSourceKind: "unknown",
      },
      {
        id: "019d7777-8888-7999-8aaa-111111111111",
        title: "MCP child",
        source: "mcp",
        threadSource: "mcp",
        status: "running",
        expectedCategory: "mcp",
        expectedSourceKind: "mcp",
      },
      {
        id: "019d8888-9999-7aaa-8bbb-222222222222",
        title: "Exec child",
        source: "exec",
        threadSource: "exec",
        status: "running",
        expectedCategory: "exec",
        expectedSourceKind: "exec",
      },
      {
        id: "019d9999-aaaa-7bbb-8ccc-333333333333",
        title: "VS Code child",
        source: "vscode",
        threadSource: "vscode",
        status: "running",
        expectedCategory: "vscode",
        expectedSourceKind: "vscode",
      },
      {
        id: "019daaaa-bbbb-7ccc-8ddd-444444444444",
        title: "CLI child",
        source: "cli",
        threadSource: "cli",
        status: "running",
        expectedCategory: "cli",
        expectedSourceKind: "cli",
      },
      {
        id: "019dbbbb-cccc-7ddd-8eee-555555555555",
        title: "Unknown child",
        source: "desktop",
        threadSource: "desktop",
        status: "mystery",
        expectedCategory: "unknown",
        expectedSourceKind: "unknown",
      },
    ] as const;
    const db = new Database(fixture.paths.sqlite);
    const insertThread = db.prepare(
      `insert into threads (
         id, title, first_user_message, created_at, updated_at, archived, rollout_path, model, cwd,
         source, thread_source, agent_role, agent_nickname, agent_path
       )
       values (?, ?, 'child input', 1775119000, 1775119060, 0, null, 'gpt-5.4', '/workspace/child', ?, ?, null, null, null)`,
    );
    const insertEdge = db.prepare(
      "insert into thread_spawn_edges (parent_thread_id, child_thread_id, status) values (?, ?, ?)",
    );
    for (const row of childRows) {
      insertThread.run(row.id, row.title, row.source, row.threadSource);
      insertEdge.run(FIXTURE_IDS.ACTIVE_ID, row.id, row.status);
    }
    db.close();

    const scan = await scanCodexRoot(fixture.rootDir);
    const childrenQuery = buildSessionFamilyQuery(scan, FIXTURE_IDS.ACTIVE_ID, { mode: "children" });
    const byId = new Map(childrenQuery.nodes.map((node) => [node.sessionId, node]));

    expect(childrenQuery.nodes.every((node) => node.relationship === "child")).toBe(true);
    expect(childrenQuery.nodes).toHaveLength(7);
    expect(childrenQuery.childrenByCategory.subagent.map((node) => node.sessionId)).toEqual([FIXTURE_IDS.ARCHIVED_ID]);
    expect(childrenQuery.childrenByCategory["side/fork"].map((node) => node.sessionId).sort()).toEqual(
      [FIXTURE_IDS.ARCHIVED_ID, childRows[0].id].sort(),
    );
    for (const row of childRows) {
      expect(byId.get(row.id)).toMatchObject({
        childCategory: row.expectedCategory,
        childType: row.expectedCategory,
        sourceKind: row.expectedSourceKind,
        hasThread: true,
        hasSessionIndex: false,
        fileExists: false,
      });
    }
    expect(byId.get(childRows[0].id)?.childTypeLabels).toEqual(["side/fork"]);
    expect(byId.get(childRows[0].id)?.relationshipLabels).toEqual(["child", "child:side/fork"]);
    expect(byId.get(childRows[0].id)?.edgeStatus).toBe("closed");
    expect(byId.get(childRows[5].id)?.edgeStatus).toBe("other");

    const parentsQuery = buildSessionFamilyQuery(scan, FIXTURE_IDS.ARCHIVED_ID, { mode: "parents" });
    expect(parentsQuery.nodes.map((node) => node.sessionId)).toEqual([FIXTURE_IDS.ACTIVE_ID]);

    const subagentsQuery = buildSessionFamilyQuery(scan, FIXTURE_IDS.ACTIVE_ID, { mode: "subagents" });
    expect(subagentsQuery.nodes.map((node) => node.sessionId)).toEqual([FIXTURE_IDS.ARCHIVED_ID]);

    const filteredQuery = buildSessionFamilyQuery(scan, FIXTURE_IDS.ACTIVE_ID, { mode: "children", sourceKind: "mcp" });
    expect(filteredQuery.nodes.map((node) => node.sessionId)).toEqual([childRows[1].id]);

    const impactQuery = buildSessionFamilyQuery(scan, FIXTURE_IDS.ACTIVE_ID, { mode: "impact" });
    expect(impactQuery.impact?.missingFileSessionIds).toEqual(childRows.map((row) => row.id).sort());
    expect(impactQuery.impact?.missingSessionIndexIds).toEqual(childRows.map((row) => row.id).sort());
    expect(impactQuery.impact?.missingSurfaceWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: childRows[0].id,
          role: "child",
          missingSurfaces: ["file", "session_index"],
        }),
      ]),
    );
  });

  it("builds a session family for a child with a parent", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const archived = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID])[0];
    const family = buildSessionFamily(scan, archived);

    expect(family.current.sessionId).toBe(FIXTURE_IDS.ARCHIVED_ID);
    expect(family.root.sessionId).toBe(FIXTURE_IDS.ACTIVE_ID);
    expect(family.parents.map((node) => node.sessionId)).toEqual([FIXTURE_IDS.ACTIVE_ID]);
    expect(family.parent?.relationshipStatus).toBe("running");
    expect(family.current.parentIds).toEqual([FIXTURE_IDS.ACTIVE_ID]);
    expect(family.current.childIds).toEqual([]);
  });

  it("builds a session family when a session has both parent and children", async () => {
    const db = new Database(fixture.paths.sqlite);
    db.prepare(
      `insert into threads (
         id, title, first_user_message, created_at, updated_at, archived, rollout_path, model, cwd,
         source, thread_source, agent_role, agent_nickname, agent_path
       )
       values (?, 'Child thread', 'child input', 1775119000, 1775119060, 0, null, 'gpt-5.4', '/workspace/child', 'fork', 'fork', null, null, null)`,
    ).run(FIXTURE_IDS.CHILD_ID);
    db.prepare(
      "insert into thread_spawn_edges (parent_thread_id, child_thread_id, status) values (?, ?, 'complete')",
    ).run(FIXTURE_IDS.ARCHIVED_ID, FIXTURE_IDS.CHILD_ID);
    db.close();

    const scan = await scanCodexRoot(fixture.rootDir);
    const archived = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID])[0];
    const family = buildSessionFamily(scan, archived);

    expect(family.root.sessionId).toBe(FIXTURE_IDS.ACTIVE_ID);
    expect(family.parents.map((node) => node.sessionId)).toEqual([FIXTURE_IDS.ACTIVE_ID]);
    expect(family.directChildren.map((node) => node.sessionId)).toEqual([FIXTURE_IDS.CHILD_ID]);
    expect(family.directChildren[0]).toMatchObject({
      relationship: "child",
      relationshipStatus: "complete",
      kind: "db-only",
      fileExists: false,
      source: "fork",
      sourceLabel: "side-thread",
      threadSource: "fork",
    });
    expect(family.familyMembers.map((node) => node.sessionId).sort()).toEqual(
      [FIXTURE_IDS.ACTIVE_ID, FIXTURE_IDS.ARCHIVED_ID, FIXTURE_IDS.CHILD_ID].sort(),
    );
  });

  it("returns a normal single-node family for unrelated sessions", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const stale = resolveSessions(scan, [FIXTURE_IDS.STALE_ID])[0];
    const family = buildSessionFamily(scan, stale);

    expect(family.current.sessionId).toBe(FIXTURE_IDS.STALE_ID);
    expect(family.root.sessionId).toBe(FIXTURE_IDS.STALE_ID);
    expect(family.parent).toBeNull();
    expect(family.directChildren).toEqual([]);
    expect(family.familyMembers.map((node) => node.sessionId)).toEqual([FIXTURE_IDS.STALE_ID]);
  });

  it("warns during delete preview when related parent or child sessions are not selected", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const [active] = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    const [archived] = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID]);
    const parentPreview = buildDeletePreview(scan, [active]);
    const childPreview = buildDeletePreview(scan, [archived]);
    const combinedPreview = buildDeletePreview(scan, [active, archived]);

    expect(parentPreview.familyWarnings).toEqual([
      expect.objectContaining({
        sessionId: FIXTURE_IDS.ACTIVE_ID,
        unselectedParentIds: [],
        unselectedChildIds: [FIXTURE_IDS.ARCHIVED_ID],
        unselectedFamilyMemberIds: [],
        unselectedRelatedSessionIds: [FIXTURE_IDS.ARCHIVED_ID],
        missingParentIds: [],
        missingChildIds: [],
        warnings: [],
      }),
    ]);
    expect(childPreview.familyWarnings).toEqual([
      expect.objectContaining({
        sessionId: FIXTURE_IDS.ARCHIVED_ID,
        unselectedParentIds: [FIXTURE_IDS.ACTIVE_ID],
        unselectedChildIds: [],
        unselectedFamilyMemberIds: [],
        unselectedRelatedSessionIds: [FIXTURE_IDS.ACTIVE_ID],
        missingParentIds: [],
        missingChildIds: [],
        warnings: [],
      }),
    ]);
    expect(combinedPreview.familyWarnings).toEqual([]);
  });

  it("reports broken family edges when parent or child sessions are missing", async () => {
    const missingParentId = "019d6666-7777-7888-8999-ffffffffffff";
    const missingChildId = "019d7777-8888-7999-8aaa-111111111111";
    const db = new Database(fixture.paths.sqlite);
    db.prepare(
      "insert into thread_spawn_edges (parent_thread_id, child_thread_id, status) values (?, ?, 'missing-parent')",
    ).run(missingParentId, FIXTURE_IDS.ACTIVE_ID);
    db.prepare(
      "insert into thread_spawn_edges (parent_thread_id, child_thread_id, status) values (?, ?, 'missing-child')",
    ).run(FIXTURE_IDS.ACTIVE_ID, missingChildId);
    db.close();

    const scan = await scanCodexRoot(fixture.rootDir);
    const active = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID])[0];
    const family = buildSessionFamily(scan, active);
    const impactQuery = buildSessionFamilyQuery(scan, FIXTURE_IDS.ACTIVE_ID, { mode: "impact" });
    const preview = buildDeletePreview(scan, [active]);

    expect(family.warnings).toContain(`missing parent session: ${missingParentId}`);
    expect(family.warnings).toContain(`missing child session: ${missingChildId}`);
    expect(family.brokenRelations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parentThreadId: missingParentId,
          childThreadId: FIXTURE_IDS.ACTIVE_ID,
          missingParentSession: true,
          parentMissingSurfaces: ["session"],
        }),
        expect.objectContaining({
          parentThreadId: FIXTURE_IDS.ACTIVE_ID,
          childThreadId: missingChildId,
          missingChildSession: true,
          childMissingSurfaces: ["session"],
        }),
      ]),
    );
    expect(preview.familyWarnings[0]).toMatchObject({
      sessionId: FIXTURE_IDS.ACTIVE_ID,
      missingParentIds: [missingParentId],
      missingChildIds: [missingChildId],
    });
    expect(preview.familyWarnings[0].warnings).toEqual(
      expect.arrayContaining([
        `missing parent session: ${missingParentId}`,
        `missing child session: ${missingChildId}`,
      ]),
    );
    expect(impactQuery.impact).toMatchObject({
      readOnly: true,
      targetSessionId: FIXTURE_IDS.ACTIVE_ID,
      unselectedChildIds: [FIXTURE_IDS.ARCHIVED_ID, missingChildId],
      missingParentIds: [missingParentId],
      missingChildIds: [missingChildId],
      missingFileSessionIds: [missingParentId, missingChildId],
      missingSessionIndexIds: [missingParentId, missingChildId],
      missingRelations: {
        missingParents: [
          expect.objectContaining({
            parentThreadId: missingParentId,
            childThreadId: FIXTURE_IDS.ACTIVE_ID,
          }),
        ],
        missingChildren: [
          expect.objectContaining({
            parentThreadId: FIXTURE_IDS.ACTIVE_ID,
            childThreadId: missingChildId,
          }),
        ],
      },
      missingSurfaces: {
        missingFileSessionIds: [missingParentId, missingChildId],
        missingSessionIndexIds: [missingParentId, missingChildId],
        missingThreadIds: [missingParentId, missingChildId],
      },
    });
    expect(impactQuery.impact?.missingSurfaceWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: missingParentId,
          role: "parent",
          missingSurfaces: expect.arrayContaining(["session"]),
        }),
        expect.objectContaining({
          sessionId: missingChildId,
          role: "child",
          missingSurfaces: expect.arrayContaining(["session"]),
        }),
      ]),
    );
  });

  it("audits a complete live session without modifying anything", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const audit = buildSessionResidueAudit(scan, FIXTURE_IDS.ACTIVE_ID);

    expect(audit.sessionId).toBe(FIXTURE_IDS.ACTIVE_ID);
    expect(audit.overallStatus).toEqual(["present", "risky-global-state"]);
    expect(audit.currentState.hasOriginalRollout).toBe(true);
    expect(audit.surfaces.rolloutFiles.count).toBe(1);
    expect(audit.surfaces.shellSnapshots.count).toBe(1);
    expect(audit.surfaces.sessionIndex.count).toBe(1);
    expect(audit.surfaces.history.count).toBe(1);
    expect(audit.surfaces.sqlite.rows).toBe(7);
    expect(audit.surfaces.globalStateKnown.count).toBe(3);
    expect(audit.surfaces.globalStateUnknown.count).toBe(1);
    expect(audit.surfaces.globalStateUnknown.paths).toEqual(["$.some-user-setting"]);
    expect(audit.familySummary.isFamilyMember).toBe(true);
    expect(audit.familySummary.childIds).toEqual([FIXTURE_IDS.ARCHIVED_ID]);
    expect(audit.recommendedNextCommand).toBe(`codex-sessions delete ${FIXTURE_IDS.ACTIVE_ID} --root ${fixture.rootDir}`);
    expect(audit.recommendedNextCommand).not.toContain("--yes");
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
  });

  it("audits a db-only session when only SQLite remains", async () => {
    const db = new Database(fixture.paths.sqlite);
    db.prepare(
      `insert into threads (
         id, title, first_user_message, created_at, updated_at, archived, rollout_path, model, cwd
       )
       values (?, 'DB only thread', 'db only input', 1775119000, 1775119060, 0, null, 'gpt-5.4', '/workspace/db-only')`,
    ).run(FIXTURE_IDS.CHILD_ID);
    db.close();

    const audit = buildSessionResidueAudit(await scanCodexRoot(fixture.rootDir), FIXTURE_IDS.CHILD_ID);

    expect(audit.overallStatus).toEqual(["partial", "db-only"]);
    expect(audit.surfaces.rolloutFiles.present).toBe(false);
    expect(audit.surfaces.sqlite.counts.threadRows).toBe(1);
    expect(audit.surfaces.sessionIndex.count).toBe(0);
    expect(audit.surfaces.history.count).toBe(0);
  });

  it("audits session_index and history residue without files or SQLite", async () => {
    const audit = buildSessionResidueAudit(await scanCodexRoot(fixture.rootDir), FIXTURE_IDS.STALE_ID);

    expect(audit.overallStatus).toEqual(["partial", "index-only"]);
    expect(audit.surfaces.rolloutFiles.present).toBe(false);
    expect(audit.surfaces.sessionIndex.count).toBe(1);
    expect(audit.surfaces.history.count).toBe(1);
    expect(audit.surfaces.sqlite.rows).toBe(0);
  });

  it("audits known and unknown global-state-only residue", async () => {
    const audit = buildSessionResidueAudit(await scanCodexRoot(fixture.rootDir), FIXTURE_IDS.UNRELATED_ID);

    expect(audit.overallStatus).toEqual(["partial"]);
    expect(audit.surfaces.rolloutFiles.count).toBe(0);
    expect(audit.surfaces.shellSnapshots.count).toBe(1);
    expect(audit.surfaces.globalStateKnown.count).toBe(3);
    expect(audit.surfaces.globalStateUnknown.count).toBe(0);
  });

  it("audits broken family relations for missing parent and child sessions", async () => {
    const missingParentId = "019d6666-7777-7888-8999-ffffffffffff";
    const missingChildId = "019d7777-8888-7999-8aaa-111111111111";
    const db = new Database(fixture.paths.sqlite);
    db.prepare(
      "insert into thread_spawn_edges (parent_thread_id, child_thread_id, status) values (?, ?, 'missing-parent')",
    ).run(missingParentId, FIXTURE_IDS.ACTIVE_ID);
    db.prepare(
      "insert into thread_spawn_edges (parent_thread_id, child_thread_id, status) values (?, ?, 'missing-child')",
    ).run(FIXTURE_IDS.ACTIVE_ID, missingChildId);
    db.close();

    const audit = buildSessionResidueAudit(await scanCodexRoot(fixture.rootDir), FIXTURE_IDS.ACTIVE_ID);

    expect(audit.overallStatus).toEqual(["present", "risky-global-state", "broken-family"]);
    expect(audit.familySummary.parentIds).toContain(missingParentId);
    expect(audit.familySummary.childIds).toContain(missingChildId);
    expect(audit.brokenRelations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ parentThreadId: missingParentId, missingParentSession: true }),
        expect.objectContaining({ childThreadId: missingChildId, missingChildSession: true }),
      ]),
    );
  });

  it("lists root-level residue candidates while filtering ordinary active sessions by default", async () => {
    const audit = buildRootResidueAudit(await scanCodexRoot(fixture.rootDir));
    const ids = audit.candidates.map((candidate) => candidate.sessionId);
    const limited = buildRootResidueAudit(await scanCodexRoot(fixture.rootDir), { limit: 1 });

    expect(ids).toContain(FIXTURE_IDS.STALE_ID);
    expect(ids).toContain(FIXTURE_IDS.UNRELATED_ID);
    expect(ids).not.toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(ids).not.toContain(FIXTURE_IDS.ARCHIVED_ID);
    expect(audit.totalCandidates).toBe(2);
    expect(audit.totalCandidatesBeforeFilter).toBe(2);
    expect(audit.totalCandidatesAfterFilter).toBe(2);
    expect(audit.returnedCandidates).toBe(2);
    expect(audit.byStatus).toMatchObject({
      partial: 2,
      "partial-residue": 2,
      "index-only": 1,
      "shell-snapshot-residue": 1,
    });
    expect(audit.bySource).toMatchObject({
      session_index: 1,
      history: 1,
      shell_snapshots: 1,
      global_state_known: 1,
    });
    expect(limited.limit).toBe(1);
    expect(limited.returnedCandidates).toBe(1);
    expect(limited.totalCandidates).toBe(2);
  });

  it("classifies root-level global-state, db-only, index-only, shell snapshot, and broken edge residue", async () => {
    const unknownGlobalId = "019d9999-aaaa-7bbb-8ccc-333333333333";
    const dbOnlyId = "019daaaa-bbbb-7ccc-8ddd-444444444444";
    const missingParentId = "019dbbbb-cccc-7ddd-8eee-555555555555";
    const missingChildId = "019dcccc-dddd-7eee-8fff-666666666666";
    const globalState = JSON.parse(await readFile(fixture.paths.globalState, "utf8")) as Record<string, unknown>;
    globalState["deleted-session-marker"] = unknownGlobalId;
    await writeFile(fixture.paths.globalState, `${JSON.stringify(globalState, null, 2)}\n`, "utf8");

    const db = new Database(fixture.paths.sqlite);
    db.prepare(
      `insert into threads (
         id, title, first_user_message, created_at, updated_at, archived, rollout_path, model, cwd
       )
       values (?, 'DB only residue', 'db only residue input', 1775119000, 1775119060, 0, null, 'gpt-5.4', '/workspace/db-only')`,
    ).run(dbOnlyId);
    db.prepare(
      "insert into thread_spawn_edges (parent_thread_id, child_thread_id, status) values (?, ?, 'missing-parent')",
    ).run(missingParentId, FIXTURE_IDS.ACTIVE_ID);
    db.prepare(
      "insert into thread_spawn_edges (parent_thread_id, child_thread_id, status) values (?, ?, 'missing-child')",
    ).run(FIXTURE_IDS.ACTIVE_ID, missingChildId);
    db.close();

    const audit = buildRootResidueAudit(await scanCodexRoot(fixture.rootDir), { limit: 50 });
    const byId = new Map(audit.candidates.map((candidate) => [candidate.sessionId, candidate]));

    expect(byId.get(unknownGlobalId)?.statuses).toEqual(
      expect.arrayContaining(["partial-residue", "risky-global-state", "global-state-unknown"]),
    );
    expect(byId.get(dbOnlyId)?.statuses).toEqual(expect.arrayContaining(["db-only", "sqlite-residue"]));
    expect(byId.get(FIXTURE_IDS.STALE_ID)?.statuses).toEqual(expect.arrayContaining(["index-only", "index-residue"]));
    expect(byId.get(FIXTURE_IDS.UNRELATED_ID)?.statuses).toEqual(
      expect.arrayContaining(["partial-residue", "shell-snapshot-residue"]),
    );
    expect(byId.get(missingParentId)?.statuses).toEqual(expect.arrayContaining(["missing-parent-edge", "broken-family"]));
    expect(byId.get(missingChildId)?.statuses).toEqual(expect.arrayContaining(["missing-child-edge", "broken-family"]));
    expect(byId.get(missingParentId)?.recommendedAuditCommand).toBe(
      `codex-sessions audit ${missingParentId} --root ${fixture.rootDir}`,
    );
  });

  it("filters root residue candidates by status and source with summary counts", async () => {
    const unknownGlobalId = "019d9999-aaaa-7bbb-8ccc-333333333333";
    const dbOnlyId = "019daaaa-bbbb-7ccc-8ddd-444444444444";
    const globalState = JSON.parse(await readFile(fixture.paths.globalState, "utf8")) as Record<string, unknown>;
    globalState["deleted-session-marker"] = unknownGlobalId;
    await writeFile(fixture.paths.globalState, `${JSON.stringify(globalState, null, 2)}\n`, "utf8");

    const db = new Database(fixture.paths.sqlite);
    db.prepare(
      `insert into threads (
         id, title, first_user_message, created_at, updated_at, archived, rollout_path, model, cwd
       )
       values (?, 'DB only residue', 'db only residue input', 1775119000, 1775119060, 0, null, 'gpt-5.4', '/workspace/db-only')`,
    ).run(dbOnlyId);
    db.close();

    const scan = await scanCodexRoot(fixture.rootDir);
    const risky = buildRootResidueAudit(scan, { statuses: ["risky-global-state"] });
    const dbOnly = buildRootResidueAudit(scan, { statuses: ["db-only"] });
    const globalUnknown = buildRootResidueAudit(scan, { sources: ["global-state-unknown"] });
    const sqlite = buildRootResidueAudit(scan, { sources: ["sqlite"] });
    const multiStatus = buildRootResidueAudit(scan, { statuses: ["db-only", "index-only"] });
    const multiSourceLimited = buildRootResidueAudit(scan, {
      sources: ["sqlite", "global-state-unknown"],
      limit: 1,
    });

    expect(risky.candidates.map((candidate) => candidate.sessionId)).toEqual([unknownGlobalId]);
    expect(risky.filters.statuses).toEqual(["risky-global-state"]);
    expect(risky.totalCandidatesBeforeFilter).toBe(4);
    expect(risky.totalCandidatesAfterFilter).toBe(1);
    expect(risky.byStatus).toMatchObject({
      partial: 1,
      "risky-global-state": 1,
      "global-state-unknown": 1,
      "partial-residue": 1,
    });
    expect(risky.bySource).toEqual({ global_state_unknown: 1 });

    expect(dbOnly.candidates.map((candidate) => candidate.sessionId)).toEqual([dbOnlyId]);
    expect(sqlite.candidates.map((candidate) => candidate.sessionId)).toEqual([dbOnlyId]);
    expect(globalUnknown.candidates.map((candidate) => candidate.sessionId)).toEqual([unknownGlobalId]);
    expect(multiStatus.candidates.map((candidate) => candidate.sessionId).sort()).toEqual(
      [dbOnlyId, FIXTURE_IDS.STALE_ID].sort(),
    );
    expect(multiSourceLimited.totalCandidatesAfterFilter).toBe(2);
    expect(multiSourceLimited.returnedCandidates).toBe(1);
    expect(multiSourceLimited.candidates).toHaveLength(1);
    expect(multiSourceLimited.filters.sources).toEqual(["global_state_unknown", "sqlite"]);
  });

  it("builds a read-only root delete preview from audit-root filters", async () => {
    const unknownGlobalId = "019d9999-aaaa-7bbb-8ccc-333333333333";
    const dbOnlyId = "019daaaa-bbbb-7ccc-8ddd-444444444444";
    const missingParentId = "019dbbbb-cccc-7ddd-8eee-555555555555";
    const missingChildId = "019dcccc-dddd-7eee-8fff-666666666666";
    const globalState = JSON.parse(await readFile(fixture.paths.globalState, "utf8")) as Record<string, unknown>;
    globalState["deleted-session-marker"] = unknownGlobalId;
    await writeFile(fixture.paths.globalState, `${JSON.stringify(globalState, null, 2)}\n`, "utf8");

    const db = new Database(fixture.paths.sqlite);
    db.prepare(
      `insert into threads (
         id, title, first_user_message, created_at, updated_at, archived, rollout_path, model, cwd
       )
       values (?, 'DB only residue', 'db only residue input', 1775119000, 1775119060, 0, null, 'gpt-5.4', '/workspace/db-only')`,
    ).run(dbOnlyId);
    db.close();

    const beforeSessionIndex = await readFile(fixture.paths.sessionIndex, "utf8");
    const beforeHistory = await readFile(fixture.paths.history, "utf8");
    const beforeGlobalState = await readFile(fixture.paths.globalState, "utf8");
    const scan = await scanCodexRoot(fixture.rootDir);
    const globalUnknown = buildRootDeletePreview(scan, { sources: ["global-state-unknown"] });
    const dbOnly = buildRootDeletePreview(scan, { statuses: ["db-only"] });
    const limited = buildRootDeletePreview(scan, { sources: ["sqlite", "global-state-unknown"], limit: 1 });

    const familyDb = new Database(fixture.paths.sqlite);
    familyDb.prepare(
      "insert into thread_spawn_edges (parent_thread_id, child_thread_id, status) values (?, ?, 'missing-parent')",
    ).run(missingParentId, FIXTURE_IDS.ACTIVE_ID);
    familyDb.prepare(
      "insert into thread_spawn_edges (parent_thread_id, child_thread_id, status) values (?, ?, 'missing-child')",
    ).run(FIXTURE_IDS.ACTIVE_ID, missingChildId);
    familyDb.close();
    const brokenFamily = buildRootDeletePreview(await scanCodexRoot(fixture.rootDir), { statuses: ["broken-family"], limit: 20 });

    expect(globalUnknown.filters.sources).toEqual(["global_state_unknown"]);
    expect(globalUnknown.candidates.map((candidate) => candidate.sessionId)).toEqual([unknownGlobalId]);
    expect(globalUnknown.previewedCandidates).toBe(1);
    expect(globalUnknown.omittedCandidates).toBe(0);
    expect(globalUnknown.aggregatePreview).toMatchObject({
      rolloutFiles: 0,
      shellSnapshots: 0,
      sessionIndexRows: 0,
      historyRows: 0,
      knownGlobalStateRefs: 0,
      possibleUnknownGlobalStateRefs: 1,
      threadSpawnEdges: 0,
    });

    expect(dbOnly.filters.statuses).toEqual(["db-only"]);
    expect(dbOnly.candidates.map((candidate) => candidate.sessionId)).toEqual([dbOnlyId]);
    expect(dbOnly.aggregatePreview.sqliteRows).toBe(1);

    expect(limited.totalCandidatesAfterFilter).toBe(2);
    expect(limited.previewedCandidates).toBe(1);
    expect(limited.omittedCandidates).toBe(1);
    expect(limited.limit).toBe(1);

    expect(brokenFamily.candidates.map((candidate) => candidate.sessionId)).toEqual(
      expect.arrayContaining([missingParentId, missingChildId]),
    );
    expect(brokenFamily.familyWarningSummary.missingParentIds).toEqual([missingParentId]);
    expect(brokenFamily.familyWarningSummary.missingChildIds).toEqual([missingChildId]);
    expect(brokenFamily.familyWarningSummary.brokenRelationCount).toBe(2);
    expect(brokenFamily.familyWarningSummary.warningCount).toBe(2);
    expect(brokenFamily.aggregatePreview.threadSpawnEdges).toBe(3);
    expect(brokenFamily.candidates.every((candidate) => candidate.familyWarnings.length > 0)).toBe(true);
    expect([
      ...globalUnknown.candidates,
      ...dbOnly.candidates,
      ...limited.candidates,
      ...brokenFamily.candidates,
    ].every((candidate) => !candidate.recommendedAuditCommand.includes("--yes") && !candidate.recommendedPreviewCommand.includes("--yes"))).toBe(
      true,
    );

    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
    await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toBe(beforeSessionIndex);
    await expect(readFile(fixture.paths.history, "utf8")).resolves.toBe(beforeHistory);
    await expect(readFile(fixture.paths.globalState, "utf8")).resolves.toBe(beforeGlobalState);
  });

  it("reports absent for a valid session id with no local record or residue", async () => {
    const absentId = "019d8888-9999-7aaa-8bbb-222222222222";
    const audit = buildSessionResidueAudit(await scanCodexRoot(fixture.rootDir), absentId);

    expect(audit.sessionId).toBe(absentId);
    expect(audit.knownLocally).toBe(false);
    expect(audit.overallStatus).toEqual(["absent"]);
    expect(audit.counts.rawSessionFiles).toBe(0);
    expect(audit.counts.sqliteRows).toBe(0);
    expect(audit.recommendedNextCommand).toBeNull();
    expect(audit.recommendedNextCommandNote).toBe("不需要处理，当前没有发现这个 ID 的本地记录或残留。");
    expect(audit.currentState.kind).toBe("absent");
    expect(audit.currentState.message).toBe("未发现这个 ID 的本地记录或残留。");
  });

  it("keeps clean for a locally known session id with no current residue", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const knownCleanId = "019d9999-aaaa-7bbb-8ccc-333333333333";
    const template = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID])[0];
    const knownCleanSession = {
      ...template,
      id: knownCleanId,
      displayTitle: knownCleanId,
      indexTitle: null,
      sqliteTitle: null,
      firstUserMessage: null,
      titleSource: "id" as const,
      titleMismatch: false,
      titleCandidates: [{ source: "id" as const, title: knownCleanId }],
      title: knownCleanId,
      kind: "stale" as const,
      archived: false,
      createdAt: null,
      updatedAt: null,
      rolloutPath: null,
      previewSummary: "known clean fixture",
      historyPreview: [],
      totalFileSize: 0,
      fileTargets: [],
      hasThread: false,
      hasSessionIndex: false,
      hasHistory: false,
      sessionIndexCount: 0,
      historyCount: 0,
      thread: null,
    };
    const audit = buildSessionResidueAudit({ ...scan, sessions: [...scan.sessions, knownCleanSession] }, knownCleanId);

    expect(audit.knownLocally).toBe(true);
    expect(audit.overallStatus).toEqual(["clean"]);
    expect(audit.recommendedNextCommand).toBeNull();
    expect(audit.recommendedNextCommandNote).toBe("不需要处理，当前没有发现本地残留。");
    expect(audit.currentState.kind).toBe("clean");
    expect(audit.currentState.message).toBe("这个 ID 在本机记录中出现过，但当前没有发现本地残留。");
  });

  it("reports a clear error for invalid unknown session input", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    expect(() => buildSessionResidueAudit(scan, "not-a-session")).toThrow("找不到会话或本地残留：not-a-session");
  });

  it("deletes an active session and validates all cleanup surfaces", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    const preview = buildDeletePreview(scan, sessions);
    const result = await deleteSessions(scan, sessions);
    const globalState = JSON.parse(await readFile(fixture.paths.globalState, "utf8")) as {
      "pinned-thread-ids": string[];
      "queued-follow-ups": Record<string, unknown>;
      diffViewThreadSettings: Record<string, unknown>;
      "some-user-setting": string;
      "prompt-history": string[];
    };
    const bakText = await readFile(fixture.paths.globalStateBak, "utf8");

    expect(preview.totals.sessionFiles).toBe(1);
    expect(preview.totals.shellSnapshotFiles).toBe(1);
    expect(preview.totals.globalStateRefs).toBe(3);
    expect(preview.totals.possibleUnknownGlobalStateRefs).toBe(1);
    expect(preview.totals.sqliteRows).toBe(7);
    expect(result.validation.every((item) => item.filePathsRemaining.length === 0)).toBe(true);
    expect(result.validation.every((item) => item.shellSnapshotFilesRemaining.length === 0)).toBe(true);
    expect(result.validation.every((item) => item.globalStateRefsRemaining === 0)).toBe(true);
    expect(result.validation.every((item) => item.possibleUnknownGlobalStateRefsRemaining === 1)).toBe(true);
    expect(result.validation[0].possibleUnknownGlobalStateRefPaths).toEqual(["$.some-user-setting"]);
    expect(result.validation.every((item) => item.sessionIndexRowsRemaining === 0)).toBe(true);
    expect(result.validation.every((item) => item.historyRowsRemaining === 0)).toBe(true);
    expect(result.validation.every((item) => item.sqlite.stage1Rows === 0)).toBe(true);
    expect(result.validation.every((item) => item.sqlite.dynamicToolRows === 0)).toBe(true);
    expect(result.validation.every((item) => item.sqlite.logRows === 0)).toBe(true);
    expect(result.validation.every((item) => item.sqlite.threadGoalRows === 0)).toBe(true);
    expect(result.validation.every((item) => item.sqlite.threadRows === 0)).toBe(true);
    await expect(readFile(fixture.paths.activeShellSnapshot, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixture.paths.archivedShellSnapshot, "utf8")).resolves.toContain(FIXTURE_IDS.ARCHIVED_ID);
    await expect(readFile(fixture.paths.unrelatedShellSnapshot, "utf8")).resolves.toContain(FIXTURE_IDS.UNRELATED_ID);
    expect(globalState["pinned-thread-ids"]).not.toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(globalState["pinned-thread-ids"]).toContain(FIXTURE_IDS.ARCHIVED_ID);
    expect(globalState["pinned-thread-ids"]).toContain(FIXTURE_IDS.UNRELATED_ID);
    expect(globalState["queued-follow-ups"]).not.toHaveProperty(FIXTURE_IDS.ACTIVE_ID);
    expect(globalState["queued-follow-ups"]).toHaveProperty(FIXTURE_IDS.UNRELATED_ID);
    expect(globalState.diffViewThreadSettings).not.toHaveProperty(FIXTURE_IDS.ACTIVE_ID);
    expect(globalState.diffViewThreadSettings).toHaveProperty(FIXTURE_IDS.UNRELATED_ID);
    expect(globalState["some-user-setting"]).toBe(FIXTURE_IDS.ACTIVE_ID);
    expect(globalState["prompt-history"][0]).toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(bakText).toBe("backup must not change\n");
  });

  it("deletes residual-only shell snapshots and global state references when explicitly targeted", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.UNRELATED_ID]);
    const preview = buildDeletePreview(scan, sessions);
    const result = await deleteSessions(scan, sessions);
    const globalState = JSON.parse(await readFile(fixture.paths.globalState, "utf8")) as {
      "pinned-thread-ids": string[];
      "queued-follow-ups": Record<string, unknown>;
      diffViewThreadSettings: Record<string, unknown>;
    };

    expect(sessions[0].kind).toBe("stale");
    expect(sessions[0].fileTargets).toEqual([]);
    expect(preview.totals.sessionFiles).toBe(0);
    expect(preview.totals.shellSnapshotFiles).toBe(1);
    expect(preview.totals.globalStateRefs).toBe(3);
    expect(preview.totals.sqliteRows).toBe(0);
    expect(result.validation[0].shellSnapshotFilesRemaining).toEqual([]);
    expect(result.validation[0].globalStateRefsRemaining).toBe(0);
    expect(result.validation[0].possibleUnknownGlobalStateRefsRemaining).toBe(0);
    await expect(readFile(fixture.paths.unrelatedShellSnapshot, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixture.paths.activeShellSnapshot, "utf8")).resolves.toContain(FIXTURE_IDS.ACTIVE_ID);
    await expect(readFile(fixture.paths.archivedShellSnapshot, "utf8")).resolves.toContain(FIXTURE_IDS.ARCHIVED_ID);
    expect(globalState["pinned-thread-ids"]).not.toContain(FIXTURE_IDS.UNRELATED_ID);
    expect(globalState["pinned-thread-ids"]).toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(globalState["queued-follow-ups"]).not.toHaveProperty(FIXTURE_IDS.UNRELATED_ID);
    expect(globalState.diffViewThreadSettings).not.toHaveProperty(FIXTURE_IDS.UNRELATED_ID);
  });

  it("fails safely and rolls back when global state is invalid json", async () => {
    await writeFile(fixture.paths.globalState, "{ invalid json\n", "utf8");

    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID])[0];
    await expect(deleteSessions(scan, [session])).rejects.toThrow("删除失败");

    const rescanned = await scanCodexRoot(fixture.rootDir);
    const validation = await validateDeletion(rescanned, [session]);

    expect(scan.warnings.some((warning) => warning.includes(".codex-global-state.json"))).toBe(true);
    expect(await readFile(fixture.paths.globalState, "utf8")).toBe("{ invalid json\n");
    expect(validation[0].filePathsRemaining).toHaveLength(1);
    expect(validation[0].shellSnapshotFilesRemaining).toHaveLength(1);
    expect(validation[0].globalStateRefsRemaining).toBe(-1);
    expect(validation[0].possibleUnknownGlobalStateRefsRemaining).toBe(-1);
    expect(validation[0].globalStateWarning).toContain("global state 无法解析");
    expect(validation[0].sessionIndexRowsRemaining).toBe(1);
    expect(validation[0].historyRowsRemaining).toBe(1);
    expect(validation[0].sqlite.threadRows).toBe(1);
    expect(validation[0].sqlite.logRows).toBe(1);
    await expect(readFile(fixture.paths.activeShellSnapshot, "utf8")).resolves.toContain(FIXTURE_IDS.ACTIVE_ID);
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

  it("inspects the root structure and reports sqlite tables plus unknown global state refs", async () => {
    const state12 = path.join(fixture.rootDir, "state_12.sqlite");
    const logs10 = path.join(fixture.rootDir, "logs_10.sqlite");
    await writeFile(state12, await readFile(fixture.paths.sqlite));
    await writeFile(logs10, await readFile(fixture.paths.logsSqlite as string));

    const report = await inspectCodexRoot(fixture.rootDir);
    const expectedTables = [
      "threads",
      "logs",
      "thread_spawn_edges",
      "agent_job_items",
      "thread_dynamic_tools",
      "stage1_outputs",
      "thread_goals",
    ];

    expect(report.paths.sessionsDir.readable).toBe(true);
    expect(report.paths.archivedSessionsDir.readable).toBe(true);
    expect(report.paths.sessionIndex.readable).toBe(true);
    expect(report.paths.history.readable).toBe(true);
    expect(report.paths.globalState.parseable).toBe(true);
    expect(report.paths.shellSnapshotsDir.readable).toBe(true);
    expect(report.sqlite.stateCandidates).toContain(fixture.paths.sqlite);
    expect(report.sqlite.logsCandidates).toContain(fixture.paths.logsSqlite);
    expect(report.sqlite.activeStatePath).toBe(state12);
    expect(report.sqlite.activeLogsPath).toBe(logs10);
    expect(report.sqlite.stateTables.map((table) => table.table)).toEqual(expectedTables);
    expect(report.sqlite.logsTables.map((table) => table.table)).toEqual(expectedTables);
    expect(report.sqlite.stateTables.find((table) => table.table === "threads")).toMatchObject({
      exists: true,
      associationColumns: ["id"],
    });
    expect(report.sqlite.logsTables.find((table) => table.table === "logs")?.associationColumns).toContain("thread_id");
    expect(report.globalState.knownRefs.filter((ref) => ref.sessionId === FIXTURE_IDS.ACTIVE_ID)).toHaveLength(3);
    expect(report.globalState.possibleUnknownRefs).toContainEqual({
      sessionId: FIXTURE_IDS.ACTIVE_ID,
      path: "$.some-user-setting",
      kind: "object-string-value",
    });
    expect(report.globalState.possibleUnknownRefs.some((ref) => ref.path.startsWith("$.prompt-history"))).toBe(false);
  });

  it("reports missing sqlite tables and association columns during root inspection", async () => {
    const stateDb = new Database(fixture.paths.sqlite);
    stateDb.exec("drop table thread_goals");
    stateDb.close();

    const logsDb = new Database(fixture.paths.logsSqlite as string);
    logsDb.exec("drop table logs; create table logs (id integer primary key autoincrement, ts integer not null);");
    logsDb.close();

    const report = await inspectCodexRoot(fixture.rootDir);

    expect(report.sqlite.stateTables.find((table) => table.table === "thread_goals")).toMatchObject({
      exists: false,
      associationColumns: [],
    });
    expect(report.sqlite.logsTables.find((table) => table.table === "logs")).toMatchObject({
      exists: true,
      associationColumns: ["id"],
    });
  });

  it("reports damaged global state during root inspection", async () => {
    await writeFile(fixture.paths.globalState, "{ invalid json\n", "utf8");

    const report = await inspectCodexRoot(fixture.rootDir);

    expect(report.paths.globalState.parseable).toBe(false);
    expect(report.globalState.warnings[0]).toContain("global state 无法解析");
    expect(report.warnings.some((warning) => warning.includes("global state 无法解析"))).toBe(true);
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
    expect(validation[0].shellSnapshotFilesRemaining).toHaveLength(1);
    expect(validation[0].globalStateRefsRemaining).toBe(3);
    expect(validation[0].sessionIndexRowsRemaining).toBe(1);
    expect(validation[0].historyRowsRemaining).toBe(1);
    expect(validation[0].sqlite.threadRows).toBe(1);
    expect(validation[0].sqlite.logRows).toBe(1);
    expect(await readFile(fixture.paths.activeShellSnapshot, "utf8")).toContain(FIXTURE_IDS.ACTIVE_ID);
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

  it("previews cleanup-index without changing jsonl indexes in core", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID])[0];
    const beforeSessionIndex = await readFile(fixture.paths.sessionIndex, "utf8");
    const beforeHistory = await readFile(fixture.paths.history, "utf8");

    const preview = previewCleanupSessionIndexes(scan, [session]);

    expect(preview.sessionIds).toEqual([FIXTURE_IDS.ACTIVE_ID]);
    expect(preview.removedSessionIndexRows).toBe(1);
    expect(preview.removedHistoryRows).toBe(1);
    await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toBe(beforeSessionIndex);
    await expect(readFile(fixture.paths.history, "utf8")).resolves.toBe(beforeHistory);
  });

  it("cleans stale indexes only", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const cleanup = await cleanupStaleIndexes(scan);
    const rescanned = await scanCodexRoot(fixture.rootDir);

    expect(cleanup.staleSessionIds).toEqual([FIXTURE_IDS.STALE_ID]);
    expect(rescanned.sessions.some((session) => session.id === FIXTURE_IDS.STALE_ID)).toBe(false);
  });

  it("previews cleanup-stale without changing jsonl indexes in core", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const beforeSessionIndex = await readFile(fixture.paths.sessionIndex, "utf8");
    const beforeHistory = await readFile(fixture.paths.history, "utf8");

    const preview = previewCleanupStaleIndexes(scan);

    expect(preview.staleSessionIds).toEqual([FIXTURE_IDS.STALE_ID]);
    expect(preview.removedSessionIndexRows).toBe(1);
    expect(preview.removedHistoryRows).toBe(1);
    await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toBe(beforeSessionIndex);
    await expect(readFile(fixture.paths.history, "utf8")).resolves.toBe(beforeHistory);
  });

  it("moves a session to trash and restores every cleanup surface", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    const trashResult = await moveSessionsToTrash(scan, sessions);
    const trashEntries = await listTrashEntries(fixture.rootDir);
    const liveValidation = await validateDeletion(await scanCodexRoot(fixture.rootDir), sessions);

    expect(trashEntries).toHaveLength(1);
    expect(trashEntries[0].trashId).toBe(trashResult.trashEntry.trashId);
    expect(liveValidation[0].filePathsRemaining).toEqual([]);
    expect(liveValidation[0].shellSnapshotFilesRemaining).toEqual([]);
    expect(liveValidation[0].globalStateRefsRemaining).toBe(0);
    expect(liveValidation[0].possibleUnknownGlobalStateRefsRemaining).toBe(1);
    expect(liveValidation[0].sessionIndexRowsRemaining).toBe(0);
    expect(liveValidation[0].historyRowsRemaining).toBe(0);
    expect(liveValidation[0].sqlite.threadRows).toBe(0);
    expect(liveValidation[0].sqlite.logRows).toBe(0);

    const restore = await restoreTrashEntry(fixture.rootDir, trashResult.trashEntry.trashId);
    const restoredScan = await scanCodexRoot(fixture.rootDir);
    const restoredSession = resolveSessions(restoredScan, [FIXTURE_IDS.ACTIVE_ID])[0];
    const restoredValidation = await validateDeletion(restoredScan, [restoredSession]);
    const globalState = JSON.parse(await readFile(fixture.paths.globalState, "utf8")) as {
      "pinned-thread-ids": string[];
      "queued-follow-ups": Record<string, unknown>;
      diffViewThreadSettings: Record<string, unknown>;
    };
    const logsDb = new Database(fixture.paths.logsSqlite as string, { readonly: true });
    const activeLogs = logsDb
      .prepare("select count(*) as count from logs where thread_id = ?")
      .get(FIXTURE_IDS.ACTIVE_ID) as { count: number };
    logsDb.close();

    expect(restore.restoredSessionFiles).toBe(1);
    expect(restore.restoredShellSnapshots).toBe(1);
    expect(restore.restoredSessionIndexRecords).toBe(1);
    expect(restore.restoredHistoryRecords).toBe(1);
    expect(restore.restoredGlobalStateRefs).toBe(3);
    expect(restore.restoredSqliteRows.total).toBe(7);
    expect(restore.skippedSqliteRows.total).toBe(0);
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
    await expect(readFile(fixture.paths.activeShellSnapshot, "utf8")).resolves.toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(restoredValidation[0].filePathsRemaining).toHaveLength(1);
    expect(restoredValidation[0].shellSnapshotFilesRemaining).toHaveLength(1);
    expect(restoredValidation[0].globalStateRefsRemaining).toBe(3);
    expect(restoredValidation[0].possibleUnknownGlobalStateRefsRemaining).toBe(1);
    expect(restoredValidation[0].sessionIndexRowsRemaining).toBe(1);
    expect(restoredValidation[0].historyRowsRemaining).toBe(1);
    expect(restoredValidation[0].sqlite.threadRows).toBe(1);
    expect(restoredValidation[0].sqlite.logRows).toBe(1);
    expect(globalState["pinned-thread-ids"].filter((id) => id === FIXTURE_IDS.ACTIVE_ID)).toHaveLength(1);
    expect(globalState["queued-follow-ups"]).toHaveProperty(FIXTURE_IDS.ACTIVE_ID);
    expect(globalState.diffViewThreadSettings).toHaveProperty(FIXTURE_IDS.ACTIVE_ID);
    expect(activeLogs.count).toBe(1);

    await expect(restoreTrashEntry(fixture.rootDir, trashResult.trashEntry.trashId)).rejects.toThrow("恢复冲突");
    const conflictValidation = await validateDeletion(await scanCodexRoot(fixture.rootDir), [restoredSession]);
    expect(conflictValidation[0].sessionIndexRowsRemaining).toBe(1);
    expect(conflictValidation[0].historyRowsRemaining).toBe(1);
    expect(conflictValidation[0].sqlite.threadRows).toBe(1);
    expect(conflictValidation[0].sqlite.logRows).toBe(1);
  });

  it("keeps the committed trash entry when live deletion fails", async () => {
    await writeFile(fixture.paths.globalState, "{ invalid json\n", "utf8");

    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    await expect(moveSessionsToTrash(scan, sessions)).rejects.toThrow("回收站记录已保留");

    const validation = await validateDeletion(await scanCodexRoot(fixture.rootDir), sessions);
    const trashEntries = await listTrashEntries(fixture.rootDir);
    expect(trashEntries).toHaveLength(1);
    expect(trashEntries[0].sessionIds).toContain(FIXTURE_IDS.ACTIVE_ID);
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
    await expect(readFile(fixture.paths.activeShellSnapshot, "utf8")).resolves.toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(validation[0].sessionIndexRowsRemaining).toBe(1);
    expect(validation[0].historyRowsRemaining).toBe(1);
    expect(validation[0].sqlite.threadRows).toBe(1);
    expect(validation[0].sqlite.logRows).toBe(1);
  });

  it("reports a missing trash root as a readable restore error", async () => {
    await expect(restoreTrashEntry(fixture.rootDir, "missing-trash-id")).rejects.toThrow(
      "找不到回收站记录：missing-trash-id",
    );
  });

  it("removes temporary trash data when writing the trash entry fails", async () => {
    const fixedNow = new Date("2026-05-04T00:00:00.000Z");
    const fixedUuid = "00000000-0000-4000-8000-000000000000";
    const trashId = `${fixedNow.toISOString().replace(/[:.]/g, "-")}-${fixedUuid}`;
    const tempTrashDir = path.join(fixture.rootDir, ".codex-sessions-trash", `.tmp-${trashId}`);
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(fixedUuid);
    await mkdir(tempTrashDir, { recursive: true });
    await writeFile(path.join(tempTrashDir, "sessions"), "not a directory\n", "utf8");

    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    await expect(moveSessionsToTrash(scan, sessions)).rejects.toThrow("移入回收站失败");

    expect(await listTrashEntries(fixture.rootDir)).toEqual([]);
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
    await expect(readFile(fixture.paths.activeShellSnapshot, "utf8")).resolves.toContain(FIXTURE_IDS.ACTIVE_ID);
  });

  it("refuses restore when any live surface already exists", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    const trashResult = await moveSessionsToTrash(scan, sessions);

    await writeFile(fixture.paths.activeSessionFile, "new live content\n", "utf8");

    await expect(restoreTrashEntry(fixture.rootDir, trashResult.trashEntry.trashId)).rejects.toThrow("恢复冲突");

    const validation = await validateDeletion(await scanCodexRoot(fixture.rootDir), sessions);
    expect(await readFile(fixture.paths.activeSessionFile, "utf8")).toBe("new live content\n");
    expect(validation[0].sessionIndexRowsRemaining).toBe(0);
    expect(validation[0].historyRowsRemaining).toBe(0);
    expect(validation[0].sqlite.threadRows).toBe(0);
  });

  it("refuses restore when sqlite exists even if files are missing", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    const trashResult = await moveSessionsToTrash(scan, sessions);

    const db = new Database(fixture.paths.sqlite);
    db.prepare(
      `insert into threads (id, title, first_user_message, created_at, updated_at, archived, rollout_path, model, cwd)
       values (?, 'Live sqlite row', 'live', 1, 2, 0, null, 'gpt-5.4', '/workspace/demo')`,
    ).run(FIXTURE_IDS.ACTIVE_ID);
    db.close();

    await expect(restoreTrashEntry(fixture.rootDir, trashResult.trashEntry.trashId)).rejects.toThrow("SQLite");

    const validation = await validateDeletion(await scanCodexRoot(fixture.rootDir), sessions);
    expect(validation[0].filePathsRemaining).toEqual([]);
    expect(validation[0].sqlite.threadRows).toBe(1);
    expect(validation[0].sessionIndexRowsRemaining).toBe(0);
    expect(validation[0].historyRowsRemaining).toBe(0);
  });

  it("refuses restore when live dedicated logs have the same primary key", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    const trashResult = await moveSessionsToTrash(scan, sessions);
    const logsDb = new Database(fixture.paths.logsSqlite as string);
    logsDb.prepare(
      `insert into logs (id, ts, ts_nanos, level, target, feedback_log_body, thread_id, process_uuid, estimated_bytes)
       values (1, 99, 0, 'INFO', 'fixture', 'live unrelated log', ?, 'fixture-process', 18)`,
    ).run(FIXTURE_IDS.UNRELATED_ID);
    logsDb.close();

    await expect(restoreTrashEntry(fixture.rootDir, trashResult.trashEntry.trashId)).rejects.toThrow("SQLite key conflict logs(id=1)");

    const verifyDb = new Database(fixture.paths.logsSqlite as string, { readonly: true });
    const row = verifyDb.prepare("select feedback_log_body, thread_id from logs where id = 1").get() as {
      feedback_log_body: string;
      thread_id: string;
    };
    verifyDb.close();
    expect(row).toEqual({ feedback_log_body: "live unrelated log", thread_id: FIXTURE_IDS.UNRELATED_ID });
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses restore when live spawn edges have the same unique key", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID, FIXTURE_IDS.ARCHIVED_ID]);
    const trashResult = await moveSessionsToTrash(scan, sessions);
    const db = new Database(fixture.paths.sqlite);
    db.prepare(
      "insert into thread_spawn_edges (parent_thread_id, child_thread_id, status) values (?, ?, 'complete')",
    ).run(FIXTURE_IDS.UNRELATED_ID, FIXTURE_IDS.ARCHIVED_ID);
    db.close();

    await expect(restoreTrashEntry(fixture.rootDir, trashResult.trashEntry.trashId)).rejects.toThrow(
      `SQLite key conflict thread_spawn_edges(child_thread_id=${FIXTURE_IDS.ARCHIVED_ID})`,
    );

    const verifyDb = new Database(fixture.paths.sqlite, { readonly: true });
    const row = verifyDb.prepare("select parent_thread_id, status from thread_spawn_edges where child_thread_id = ?").get(
      FIXTURE_IDS.ARCHIVED_ID,
    ) as { parent_thread_id: string; status: string };
    verifyDb.close();
    expect(row).toEqual({ parent_thread_id: FIXTURE_IDS.UNRELATED_ID, status: "complete" });
  });

  it("rolls back files, jsonl, global state, and sqlite when a later state table restore fails", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    const trashResult = await moveSessionsToTrash(scan, sessions);
    const db = new Database(fixture.paths.sqlite);
    db.exec(`
      create trigger fail_stage1_restore
      before insert on stage1_outputs
      when new.thread_id = '${FIXTURE_IDS.ACTIVE_ID}'
      begin
        select raise(abort, 'blocked restore');
      end;
    `);
    db.close();

    await expect(restoreTrashEntry(fixture.rootDir, trashResult.trashEntry.trashId)).rejects.toThrow("恢复失败，已回滚");

    const validation = await validateDeletion(await scanCodexRoot(fixture.rootDir), sessions);
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixture.paths.activeShellSnapshot, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(validation[0].sessionIndexRowsRemaining).toBe(0);
    expect(validation[0].historyRowsRemaining).toBe(0);
    expect(validation[0].globalStateRefsRemaining).toBe(0);
    expect(validation[0].sqlite.threadRows).toBe(0);
    expect(validation[0].sqlite.logRows).toBe(0);
    expect(validation[0].sqlite.dynamicToolRows).toBe(0);
    expect(validation[0].sqlite.stage1Rows).toBe(0);
    expect(validation[0].sqlite.assignedAgentJobs).toBe(0);
    expect(validation[0].sqlite.threadGoalRows).toBe(0);
  });

  it("rolls back state sqlite when dedicated logs restore fails after state rows were restored", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    const trashResult = await moveSessionsToTrash(scan, sessions);
    const logsDb = new Database(fixture.paths.logsSqlite as string);
    logsDb.exec(`
      create trigger fail_dedicated_log_restore
      before insert on logs
      when new.thread_id = '${FIXTURE_IDS.ACTIVE_ID}'
      begin
        select raise(abort, 'blocked dedicated logs restore');
      end;
    `);
    logsDb.close();

    await expect(restoreTrashEntry(fixture.rootDir, trashResult.trashEntry.trashId)).rejects.toThrow("恢复失败，已回滚");

    const validation = await validateDeletion(await scanCodexRoot(fixture.rootDir), sessions);
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(fixture.paths.activeShellSnapshot, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(validation[0].sessionIndexRowsRemaining).toBe(0);
    expect(validation[0].historyRowsRemaining).toBe(0);
    expect(validation[0].globalStateRefsRemaining).toBe(0);
    expect(validation[0].sqlite.threadRows).toBe(0);
    expect(validation[0].sqlite.logRows).toBe(0);
    expect(validation[0].sqlite.dynamicToolRows).toBe(0);
    expect(validation[0].sqlite.stage1Rows).toBe(0);
    expect(validation[0].sqlite.assignedAgentJobs).toBe(0);
    expect(validation[0].sqlite.threadGoalRows).toBe(0);
  });

  it("dedupes sqlite relationship rows for multi-session trash bundles", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID, FIXTURE_IDS.ARCHIVED_ID]);
    const trashResult = await moveSessionsToTrash(scan, sessions);
    const bundlePath = path.join(
      fixture.rootDir,
      ".codex-sessions-trash",
      trashResult.trashEntry.trashId,
      "manifest.json",
    );
    const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
      sqlite: {
        state: { threadSpawnEdges: Array<Record<string, unknown>> };
      };
    };

    expect(bundle.sqlite.state.threadSpawnEdges).toHaveLength(1);

    const restore = await restoreTrashEntry(fixture.rootDir, trashResult.trashEntry.trashId);
    const db = new Database(fixture.paths.sqlite, { readonly: true });
    const edgeCount = db.prepare("select count(*) as count from thread_spawn_edges").get() as { count: number };
    db.close();

    expect(edgeCount.count).toBe(1);
    expect(restore.restoredSqliteRows.total).toBe(13);
  });

  it("purges a trash entry without touching restored live sessions", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    const trashResult = await moveSessionsToTrash(scan, sessions);
    await restoreTrashEntry(fixture.rootDir, FIXTURE_IDS.ACTIVE_ID);

    const purge = await purgeTrashEntry(fixture.rootDir, FIXTURE_IDS.ACTIVE_ID);

    expect(purge.purged).toBe(true);
    expect(await listTrashEntries(fixture.rootDir)).toEqual([]);
    await expect(restoreTrashEntry(fixture.rootDir, trashResult.trashEntry.trashId)).rejects.toThrow("找不到回收站记录");
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
  });

  it("keeps restored trash entries and refuses ambiguous duplicate writes by session id", async () => {
    const firstScan = await scanCodexRoot(fixture.rootDir);
    const firstTrash = await moveSessionsToTrash(firstScan, resolveSessions(firstScan, [FIXTURE_IDS.ACTIVE_ID]));

    await restoreTrashEntry(fixture.rootDir, firstTrash.trashEntry.trashId);
    let entries = await listTrashEntries(fixture.rootDir);
    expect(entries.filter((entry) => entry.sessionIds.includes(FIXTURE_IDS.ACTIVE_ID))).toHaveLength(1);
    expect(entries.map((entry) => entry.trashId)).toContain(firstTrash.trashEntry.trashId);
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");

    const secondScan = await scanCodexRoot(fixture.rootDir);
    const secondTrash = await moveSessionsToTrash(secondScan, resolveSessions(secondScan, [FIXTURE_IDS.ACTIVE_ID]));

    entries = await listTrashEntries(fixture.rootDir);
    expect(entries.filter((entry) => entry.sessionIds.includes(FIXTURE_IDS.ACTIVE_ID))).toHaveLength(2);
    expect(entries.map((entry) => entry.trashId).sort()).toEqual(
      [firstTrash.trashEntry.trashId, secondTrash.trashEntry.trashId].sort(),
    );
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await expect(restoreTrashEntry(fixture.rootDir, FIXTURE_IDS.ACTIVE_ID)).rejects.toThrow("精确 trashId");
    await expect(purgeTrashEntry(fixture.rootDir, FIXTURE_IDS.ACTIVE_ID)).rejects.toThrow("精确 trashId");

    const restore = await restoreTrashEntry(fixture.rootDir, secondTrash.trashEntry.trashId);
    expect(restore.restoredSessionIds).toContain(FIXTURE_IDS.ACTIVE_ID);
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");

    const purge = await purgeTrashEntry(fixture.rootDir, firstTrash.trashEntry.trashId);
    expect(purge.purged).toBe(true);
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
    entries = await listTrashEntries(fixture.rootDir);
    expect(entries.map((entry) => entry.trashId)).toEqual([secondTrash.trashEntry.trashId]);
  });

  it("restores safely when optional sqlite surfaces are missing", async () => {
    const partialFixture = await createFixture();

    try {
      const scan = await scanCodexRoot(partialFixture.rootDir);
      const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
      const trashResult = await moveSessionsToTrash(scan, sessions);
      const db = new Database(partialFixture.paths.sqlite);
      db.exec("drop table thread_goals");
      db.close();
      const logsDb = new Database(partialFixture.paths.logsSqlite as string);
      logsDb.exec("drop table logs; create table logs (id integer primary key autoincrement, ts integer not null);");
      logsDb.close();
      const restore = await restoreTrashEntry(partialFixture.rootDir, trashResult.trashEntry.trashId);
      const validation = await validateDeletion(await scanCodexRoot(partialFixture.rootDir), sessions);

      expect(restore.restoredSessionFiles).toBe(1);
      expect(restore.restoredSqliteRows.total).toBe(5);
      expect(restore.skippedSqliteRows.threadGoals).toBe(1);
      expect(restore.skippedSqliteRows.dedicatedLogs).toBe(1);
      expect(restore.skippedSqliteTables).toEqual(["logs", "thread_goals"]);
      expect(restore.warnings[0]).toContain("SQLite 有 2 条记录未恢复");
      expect(validation[0].sqlite.threadRows).toBe(1);
      expect(validation[0].sqlite.logRows).toBe(0);
      expect(validation[0].sqlite.threadGoalRows).toBe(0);
    } finally {
      await partialFixture.cleanup();
    }
  });

  it("reports trash manifest corruption clearly before restore", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    const trashResult = await moveSessionsToTrash(scan, sessions);
    await writeFile(
      path.join(fixture.rootDir, ".codex-sessions-trash", trashResult.trashEntry.trashId, "manifest.json"),
      "{ invalid json\n",
      "utf8",
    );

    await expect(restoreTrashEntry(fixture.rootDir, trashResult.trashEntry.trashId)).rejects.toThrow("回收站 manifest");
  });

  it("refuses trash manifests with inconsistent structure", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    const trashResult = await moveSessionsToTrash(scan, sessions);
    const manifestPath = path.join(fixture.rootDir, ".codex-sessions-trash", trashResult.trashEntry.trashId, "manifest.json");
    const bundle = JSON.parse(await readFile(manifestPath, "utf8")) as {
      manifest: { sessions: Array<{ sessionId: string }> };
      sessionFiles: unknown[];
    };
    bundle.manifest.sessions[0].sessionId = FIXTURE_IDS.ARCHIVED_ID;
    bundle.sessionFiles = [];
    await writeFile(manifestPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

    await expect(restoreTrashEntry(fixture.rootDir, trashResult.trashEntry.trashId)).rejects.toThrow(
      "回收站 manifest",
    );
  });

  it("refuses to restore a trash entry created for another root", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    const trashResult = await moveSessionsToTrash(scan, sessions);
    const manifestPath = path.join(fixture.rootDir, ".codex-sessions-trash", trashResult.trashEntry.trashId, "manifest.json");
    const bundle = JSON.parse(await readFile(manifestPath, "utf8")) as { manifest: { rootPath: string } };
    bundle.manifest.rootPath = "/tmp/another-codex-root";
    await writeFile(manifestPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

    await expect(restoreTrashEntry(fixture.rootDir, trashResult.trashEntry.trashId)).rejects.toThrow(
      "回收站记录来自不同 root",
    );
  });

  it("refuses trash manifest paths that leave the root", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    const trashResult = await moveSessionsToTrash(scan, sessions);
    const manifestPath = path.join(fixture.rootDir, ".codex-sessions-trash", trashResult.trashEntry.trashId, "manifest.json");
    const bundle = JSON.parse(await readFile(manifestPath, "utf8")) as {
      sessionFiles: Array<{ path: string }>;
      manifest: { sessions: Array<{ originalRelativePaths: string[] }> };
    };
    bundle.sessionFiles[0].path = "../outside.jsonl";
    bundle.manifest.sessions[0].originalRelativePaths[0] = "../outside.jsonl";
    await writeFile(manifestPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

    await expect(restoreTrashEntry(fixture.rootDir, trashResult.trashEntry.trashId)).rejects.toThrow(
      "路径不能离开 root",
    );
  });

  it("dedupes jsonl and global state refs during restore", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const sessions = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID]);
    const trashResult = await moveSessionsToTrash(scan, sessions);
    const manifestPath = path.join(fixture.rootDir, ".codex-sessions-trash", trashResult.trashEntry.trashId, "manifest.json");
    const bundle = JSON.parse(await readFile(manifestPath, "utf8")) as {
      sessionIndexRecords: unknown[];
      historyRecords: unknown[];
      globalStateRefs: unknown[];
    };
    bundle.sessionIndexRecords.push(bundle.sessionIndexRecords[0]);
    bundle.historyRecords.push(bundle.historyRecords[0]);
    bundle.globalStateRefs.push(bundle.globalStateRefs[0]);
    await writeFile(manifestPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

    const restore = await restoreTrashEntry(fixture.rootDir, trashResult.trashEntry.trashId);
    const restoredScan = await scanCodexRoot(fixture.rootDir);
    const restoredSession = resolveSessions(restoredScan, [FIXTURE_IDS.ACTIVE_ID])[0];
    const globalState = JSON.parse(await readFile(fixture.paths.globalState, "utf8")) as {
      "pinned-thread-ids": string[];
    };

    expect(restore.restoredSessionIndexRecords).toBe(1);
    expect(restore.restoredHistoryRecords).toBe(1);
    expect(restore.restoredGlobalStateRefs).toBe(3);
    expect(restoredSession.sessionIndexCount).toBe(1);
    expect(restoredSession.historyCount).toBe(1);
    expect(globalState["pinned-thread-ids"].filter((id) => id === FIXTURE_IDS.ACTIVE_ID)).toHaveLength(1);
  });
});
