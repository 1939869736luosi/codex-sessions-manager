import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/mcp/server.js";
import { validateDeletion } from "../src/core/delete.js";
import { resolveSessions } from "../src/core/query.js";
import { scanCodexRoot } from "../src/core/scan.js";
import { createFixture, FIXTURE_IDS, type Fixture } from "./helpers/fixture.js";

async function createConnectedClient() {
  const server = createServer();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("mcp server", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("creates the codex-sessions MCP server instance", () => {
    const server = createServer();
    expect(server).toBeDefined();
  });

  it("lists sessions by project and updated range", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "list_sessions",
        arguments: {
          root: fixture.rootDir,
          project: "demo",
          updatedAfter: "2026-04-03",
          updatedBefore: "2026-04-03",
          groupBy: "project",
        },
      });

      const sessions = result.structuredContent?.sessions as Array<{
        id: string;
        displayTitle: string;
        sqliteTitle: string;
        titleSource: string;
        titleMismatch: boolean;
        sourceKind: string;
        modelProvider: string;
      }>;
      const projects = result.structuredContent?.projectSummaries as Array<{ projectName: string; sessionCount: number }>;
      expect(sessions.map((session) => session.id)).toEqual([FIXTURE_IDS.ACTIVE_ID]);
      expect(sessions[0]).toMatchObject({
        displayTitle: "Active thread",
        sqliteTitle: `Title ${FIXTURE_IDS.ACTIVE_ID}`,
        titleSource: "session_index",
        titleMismatch: true,
        sourceKind: "cli",
        modelProvider: "openai",
      });
      expect(projects[0]).toMatchObject({ projectName: "demo", sessionCount: 1 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lists sessions through MCP with source and model filters", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "list_sessions",
        arguments: {
          root: fixture.rootDir,
          sourceKind: "subagent",
          source: "side",
          threadSource: "side",
          agentRole: "subagent",
          agentNickname: "helper",
          modelProvider: "sub2api",
          model: "gpt-5.4",
        },
      });

      const sessions = result.structuredContent?.sessions as Array<{
        id: string;
        sourceKind: string;
        source: string;
        threadSource: string;
        modelProvider: string;
      }>;
      expect(sessions).toEqual([
        expect.objectContaining({
          id: FIXTURE_IDS.ARCHIVED_ID,
          sourceKind: "subagent",
          source: "side",
          threadSource: "side",
          modelProvider: "sub2api",
        }),
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("summarizes sources through MCP", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "summarize_sources",
        arguments: {
          root: fixture.rootDir,
        },
      });

      const summary = result.structuredContent?.summary as {
        totalSessions: number;
        bySourceKind: Record<string, number>;
        rows: Array<{
          sourceKind: string;
          source: string | null;
          threadSource: string | null;
          modelProvider: string | null;
          model: string | null;
          agentRole: string | null;
          count: number;
        }>;
      };
      expect(summary.totalSessions).toBe(3);
      expect(summary.bySourceKind).toMatchObject({ cli: 1, subagent: 1, unknown: 1 });
      expect(summary.rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceKind: "cli",
            source: "cli",
            threadSource: "cli",
            modelProvider: "openai",
            model: "gpt-5.4",
            agentRole: null,
            count: 1,
          }),
        ]),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("inspects the root through MCP", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "inspect_root",
        arguments: {
          root: fixture.rootDir,
        },
      });

      const report = result.structuredContent?.report as {
        sqlite: { activeStatePath: string; activeLogsPath: string; stateTables: Array<{ table: string; exists: boolean }> };
        globalState: { possibleUnknownRefs: Array<{ path: string }> };
      };
      expect(report.sqlite.activeStatePath).toBe(fixture.paths.sqlite);
      expect(report.sqlite.activeLogsPath).toBe(fixture.paths.logsSqlite);
      expect(report.sqlite.stateTables.some((table) => table.table === "threads" && table.exists)).toBe(true);
      expect(report.globalState.possibleUnknownRefs.some((ref) => ref.path === "$.some-user-setting")).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns structured session family through MCP", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "get_session_family",
        arguments: {
          root: fixture.rootDir,
          sessionId: FIXTURE_IDS.ACTIVE_ID,
        },
      });

      const family = result.structuredContent?.family as {
        current: { sessionId: string; childIds: string[] };
        root: { sessionId: string };
        parent: null | { sessionId: string };
        directChildren: Array<{
          sessionId: string;
          relationship: string;
          relationshipStatus: string;
          source: string;
          sourceLabel: string;
          threadSource: string;
          agentRole: string;
          agentNickname: string;
          childType: string;
          childTypeLabels: string[];
          relationshipLabels: string[];
          fileExists: boolean;
        }>;
        familyMembers: Array<{ sessionId: string }>;
      };

      expect(family.current.sessionId).toBe(FIXTURE_IDS.ACTIVE_ID);
      expect(family.current.childIds).toEqual([FIXTURE_IDS.ARCHIVED_ID]);
      expect(family.root.sessionId).toBe(FIXTURE_IDS.ACTIVE_ID);
      expect(family.parent).toBeNull();
      expect(family.directChildren).toHaveLength(1);
      expect(family.directChildren[0]).toMatchObject({
        sessionId: FIXTURE_IDS.ARCHIVED_ID,
        relationship: "child",
        relationshipStatus: "running",
        source: "side",
        sourceLabel: "subagent",
        threadSource: "side",
        agentRole: "subagent",
        agentNickname: "helper",
        childType: "subagent",
        childTypeLabels: ["subagent", "side/fork"],
        relationshipLabels: ["child", "child:subagent", "child:side/fork"],
        fileExists: true,
      });
      expect(family.familyMembers.map((node) => node.sessionId).sort()).toEqual(
        [FIXTURE_IDS.ACTIVE_ID, FIXTURE_IDS.ARCHIVED_ID].sort(),
      );
      expect(result.structuredContent).toMatchObject({
        mode: "full",
        sourceKinds: [],
        readOnly: true,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns family modes and sourceKind filters through MCP as read-only data", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const tools = await client.listTools();
      const familyTool = tools.tools.find((tool) => tool.name === "get_session_family");
      expect(familyTool?.annotations?.readOnlyHint).toBe(true);

      const children = await client.callTool({
        name: "get_session_family",
        arguments: {
          root: fixture.rootDir,
          sessionId: FIXTURE_IDS.ACTIVE_ID,
          mode: "children",
          sourceKind: "subagent",
        },
      });
      const childrenContent = children.structuredContent as {
        mode: string;
        sourceKinds: string[];
        nodes: Array<{
          sessionId: string;
          relationship: string;
          sourceKind: string;
          source: string;
          threadSource: string;
          agentRole: string;
          agentNickname: string;
          childTypeLabels: string[];
          relationshipLabels: string[];
          hasSessionIndex: boolean;
          hasThread: boolean;
          fileExists: boolean;
        }>;
      };

      expect(childrenContent.mode).toBe("children");
      expect(childrenContent.sourceKinds).toEqual(["subagent"]);
      expect(childrenContent.nodes).toEqual([
        expect.objectContaining({
          sessionId: FIXTURE_IDS.ARCHIVED_ID,
          relationship: "child",
          sourceKind: "subagent",
          source: "side",
          threadSource: "side",
          agentRole: "subagent",
          agentNickname: "helper",
          childTypeLabels: ["subagent", "side/fork"],
          relationshipLabels: ["child", "child:subagent", "child:side/fork"],
          hasSessionIndex: true,
          hasThread: true,
          fileExists: true,
        }),
      ]);

      const parents = await client.callTool({
        name: "get_session_family",
        arguments: {
          root: fixture.rootDir,
          sessionId: FIXTURE_IDS.ARCHIVED_ID,
          mode: "parents",
        },
      });
      expect((parents.structuredContent?.nodes as Array<{ sessionId: string }>).map((node) => node.sessionId)).toEqual([
        FIXTURE_IDS.ACTIVE_ID,
      ]);

      const impact = await client.callTool({
        name: "get_session_family",
        arguments: {
          root: fixture.rootDir,
          sessionId: FIXTURE_IDS.ACTIVE_ID,
          mode: "impact",
        },
      });
      const impactContent = impact.structuredContent as {
        mode: string;
        readOnly: boolean;
        impact: {
          readOnly: boolean;
          unselectedChildIds: string[];
          missingParentIds: string[];
          missingChildIds: string[];
          missingRelations: { missingParents: unknown[]; missingChildren: unknown[] };
          missingSurfaces: { missingFileSessionIds: string[]; missingSessionIndexIds: string[]; missingThreadIds: string[] };
        };
      };
      expect(impactContent.mode).toBe("impact");
      expect(impactContent.readOnly).toBe(true);
      expect(impactContent.impact).toMatchObject({
        readOnly: true,
        unselectedChildIds: [FIXTURE_IDS.ARCHIVED_ID],
        missingParentIds: [],
        missingChildIds: [],
        missingRelations: { missingParents: [], missingChildren: [] },
        missingSurfaces: { missingFileSessionIds: [], missingSessionIndexIds: [], missingThreadIds: [] },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("lists projects", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "list_projects",
        arguments: {
          root: fixture.rootDir,
        },
      });

      const projects = result.structuredContent?.projects as Array<{ projectName: string }>;
      expect(projects.some((project) => project.projectName === "demo")).toBe(true);
      expect(projects.some((project) => project.projectName === "archive-demo")).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("requires explicit confirmation before deleting sessions", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ACTIVE_ID],
        },
      });
      const scan = await scanCodexRoot(fixture.rootDir);
      const session = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID])[0];
      const validation = await validateDeletion(scan, [session]);

      expect(result.structuredContent?.requiresConfirmation).toBe(true);
      expect(validation[0].filePathsRemaining).toHaveLength(1);
      expect(validation[0].shellSnapshotFilesRemaining).toHaveLength(1);
      expect(validation[0].globalStateRefsRemaining).toBe(3);
      expect(validation[0].possibleUnknownGlobalStateRefsRemaining).toBe(1);
      expect(validation[0].sessionIndexRowsRemaining).toBe(1);
      expect(validation[0].sqlite.threadRows).toBe(1);
      await expect(readFile(fixture.paths.activeShellSnapshot, "utf8")).resolves.toContain(FIXTURE_IDS.ACTIVE_ID);
      expect(await readFile(fixture.paths.globalState, "utf8")).toContain(FIXTURE_IDS.ACTIVE_ID);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("previews deletion with warnings through the dedicated MCP tool", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "preview_delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ACTIVE_ID],
        },
      });

      const preview = result.structuredContent?.preview as {
        totals: { globalStateRefs: number; possibleUnknownGlobalStateRefs: number };
        familyWarnings: Array<{ sessionId: string; unselectedChildIds: string[] }>;
      };
      expect(preview.totals.globalStateRefs).toBe(3);
      expect(preview.totals.possibleUnknownGlobalStateRefs).toBe(1);
      expect(preview.familyWarnings[0]).toMatchObject({
        sessionId: FIXTURE_IDS.ACTIVE_ID,
        unselectedChildIds: [FIXTURE_IDS.ARCHIVED_ID],
      });
      expect(result.structuredContent).toHaveProperty("warnings");
      await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("verifies known and unknown global state refs through MCP", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "verify_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ACTIVE_ID],
        },
      });

      const results = result.structuredContent?.results as Array<{
        globalStateRefsRemaining: number;
        possibleUnknownGlobalStateRefsRemaining: number;
        possibleUnknownGlobalStateRefPaths: string[];
      }>;
      expect(results[0].globalStateRefsRemaining).toBe(3);
      expect(results[0].possibleUnknownGlobalStateRefsRemaining).toBe(1);
      expect(results[0].possibleUnknownGlobalStateRefPaths).toEqual(["$.some-user-setting"]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns structured residue audit through MCP without changing files", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const beforeSessionIndex = await readFile(fixture.paths.sessionIndex, "utf8");
      const beforeGlobalState = await readFile(fixture.paths.globalState, "utf8");
      const result = await client.callTool({
        name: "audit_session",
        arguments: {
          root: fixture.rootDir,
          sessionId: FIXTURE_IDS.ACTIVE_ID,
        },
      });

      const audit = result.structuredContent?.audit as {
        sessionId: string;
        overallStatus: string[];
        surfaces: {
          globalStateKnown: { count: number };
          globalStateUnknown: { count: number; paths: string[] };
          threadSpawnEdges: { count: number };
        };
        familySummary: { childIds: string[] };
        recommendedNextCommand: string;
      };

      expect(audit.sessionId).toBe(FIXTURE_IDS.ACTIVE_ID);
      expect(audit.overallStatus).toEqual(["present", "risky-global-state"]);
      expect(audit.surfaces.globalStateKnown.count).toBe(3);
      expect(audit.surfaces.globalStateUnknown.count).toBe(1);
      expect(audit.surfaces.globalStateUnknown.paths).toEqual(["$.some-user-setting"]);
      expect(audit.surfaces.threadSpawnEdges.count).toBe(1);
      expect(audit.familySummary.childIds).toEqual([FIXTURE_IDS.ARCHIVED_ID]);
      expect(audit.recommendedNextCommand).not.toContain("--yes");
      await expect(readFile(fixture.paths.activeShellSnapshot, "utf8")).resolves.toContain(FIXTURE_IDS.ACTIVE_ID);
      await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toBe(beforeSessionIndex);
      await expect(readFile(fixture.paths.globalState, "utf8")).resolves.toBe(beforeGlobalState);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns absent for an unknown valid uuid through MCP", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const unknownId = "019e0000-0000-7000-8000-000000000000";
      const result = await client.callTool({
        name: "audit_session",
        arguments: {
          root: fixture.rootDir,
          sessionId: unknownId,
        },
      });

      const audit = result.structuredContent?.audit as {
        sessionId: string;
        knownLocally: boolean;
        overallStatus: string[];
        currentState: { kind: string; message: string };
        recommendedNextCommand: string | null;
        recommendedNextCommandNote: string;
      };

      expect(audit.sessionId).toBe(unknownId);
      expect(audit.knownLocally).toBe(false);
      expect(audit.overallStatus).toEqual(["absent"]);
      expect(audit.currentState).toMatchObject({
        kind: "absent",
        message: "未发现这个 ID 的本地记录或残留。",
      });
      expect(audit.recommendedNextCommand).toBeNull();
      expect(audit.recommendedNextCommandNote).toBe("不需要处理，当前没有发现这个 ID 的本地记录或残留。");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns structured root residue audit through MCP", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "audit_root",
        arguments: {
          root: fixture.rootDir,
          limit: 1,
        },
      });

      const audit = result.structuredContent as {
        rootPath: string;
        filters: { statuses: string[]; sources: string[]; includeAll: boolean };
        totalCandidatesBeforeFilter: number;
        totalCandidatesAfterFilter: number;
        totalCandidates: number;
        returnedCandidates: number;
        limit: number;
        byStatus: Record<string, number>;
        bySource: Record<string, number>;
        candidates: Array<{
          sessionId: string;
          statuses: string[];
          surfaces: { shellSnapshots: number; sessionIndexRows: number };
          family: { brokenFamily: boolean };
          recommendedAuditCommand: string;
        }>;
        warnings: string[];
      };

      expect(audit.rootPath).toBe(fixture.rootDir);
      expect(audit.filters).toEqual({ statuses: [], sources: [], includeAll: false });
      expect(audit.totalCandidatesBeforeFilter).toBe(2);
      expect(audit.totalCandidatesAfterFilter).toBe(2);
      expect(audit.totalCandidates).toBe(2);
      expect(audit.returnedCandidates).toBe(1);
      expect(audit.limit).toBe(1);
      expect(audit.byStatus).toMatchObject({ partial: 2, "partial-residue": 2 });
      expect(audit.bySource).toMatchObject({ session_index: 1, shell_snapshots: 1 });
      expect(audit.candidates[0].statuses.length).toBeGreaterThan(0);
      expect(audit.candidates[0].recommendedAuditCommand).toContain("codex-sessions audit");
      expect(audit.warnings).toEqual([]);
      await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("filters root residue audit through MCP status and source parameters", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "audit_root",
        arguments: {
          root: fixture.rootDir,
          status: ["index-only", "shell-snapshot-residue"],
          source: ["session-index", "shell-snapshot"],
          limit: 10,
        },
      });

      const audit = result.structuredContent as {
        filters: { statuses: string[]; sources: string[] };
        totalCandidatesBeforeFilter: number;
        totalCandidatesAfterFilter: number;
        candidates: Array<{ sessionId: string }>;
      };

      expect(audit.filters.statuses).toEqual(["index-only", "shell-snapshot-residue"]);
      expect(audit.filters.sources).toEqual(["session_index", "shell_snapshots"]);
      expect(audit.totalCandidatesBeforeFilter).toBe(2);
      expect(audit.totalCandidatesAfterFilter).toBe(2);
      expect(audit.candidates.map((candidate) => candidate.sessionId).sort()).toEqual(
        [FIXTURE_IDS.STALE_ID, FIXTURE_IDS.UNRELATED_ID].sort(),
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns structured root delete preview through MCP without changing files", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const unknownGlobalId = "019d9999-aaaa-7bbb-8ccc-333333333333";
      const globalState = JSON.parse(await readFile(fixture.paths.globalState, "utf8")) as Record<string, unknown>;
      globalState["deleted-session-marker"] = unknownGlobalId;
      await writeFile(fixture.paths.globalState, `${JSON.stringify(globalState, null, 2)}\n`, "utf8");
      const beforeSessionIndex = await readFile(fixture.paths.sessionIndex, "utf8");
      const beforeHistory = await readFile(fixture.paths.history, "utf8");
      const beforeGlobalState = await readFile(fixture.paths.globalState, "utf8");

      const result = await client.callTool({
        name: "preview_root_delete",
        arguments: {
          root: fixture.rootDir,
          source: "global-state-unknown",
          limit: 10,
        },
      });

      const preview = result.structuredContent as {
        rootPath: string;
        filters: { statuses: string[]; sources: string[]; includeAll: boolean };
        totalCandidatesBeforeFilter: number;
        totalCandidatesAfterFilter: number;
        previewedCandidates: number;
        omittedCandidates: number;
        limit: number;
        aggregatePreview: {
          possibleUnknownGlobalStateRefs: number;
          knownGlobalStateRefs: number;
          threadSpawnEdges: number;
        };
        familyWarningSummary: { candidatesWithFamilyWarnings: number; warningCount: number };
        candidates: Array<{
          sessionId: string;
          statuses: string[];
          sources: string[];
          previewCounts: { possibleUnknownGlobalStateRefs: number };
          familyWarnings: unknown[];
          recommendedAuditCommand: string;
          previewOnlyCommand: string;
          recommendedPreviewCommand: string;
        }>;
        warnings: string[];
      };

      expect(preview.rootPath).toBe(fixture.rootDir);
      expect(preview.filters).toEqual({ statuses: [], sources: ["global_state_unknown"], includeAll: false });
      expect(preview.totalCandidatesBeforeFilter).toBe(3);
      expect(preview.totalCandidatesAfterFilter).toBe(1);
      expect(preview.previewedCandidates).toBe(1);
      expect(preview.omittedCandidates).toBe(0);
      expect(preview.limit).toBe(10);
      expect(preview.aggregatePreview).toMatchObject({
        possibleUnknownGlobalStateRefs: 1,
        knownGlobalStateRefs: 0,
        threadSpawnEdges: 0,
      });
      expect(preview.familyWarningSummary).toMatchObject({ candidatesWithFamilyWarnings: 0, warningCount: 0 });
      expect(preview.candidates).toHaveLength(1);
      expect(preview.candidates[0]).toMatchObject({
        sessionId: unknownGlobalId,
        sources: ["global_state_unknown"],
        previewCounts: { possibleUnknownGlobalStateRefs: 1 },
        familyWarnings: [],
      });
      expect(preview.candidates[0].recommendedAuditCommand).not.toContain("--yes");
      expect(preview.candidates[0].previewOnlyCommand).not.toContain("--yes");
      expect(preview.candidates[0].recommendedPreviewCommand).not.toContain("--yes");
      expect(preview.warnings).toEqual([]);
      await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
      await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toBe(beforeSessionIndex);
      await expect(readFile(fixture.paths.history, "utf8")).resolves.toBe(beforeHistory);
      await expect(readFile(fixture.paths.globalState, "utf8")).resolves.toBe(beforeGlobalState);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("filters root delete preview through MCP status and source parameters", async () => {
    const { client, server } = await createConnectedClient();

    try {
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

      const result = await client.callTool({
        name: "preview_root_delete",
        arguments: {
          root: fixture.rootDir,
          status: ["db-only", "risky-global-state"],
          source: ["sqlite", "global-state-unknown"],
          limit: 10,
        },
      });

      const preview = result.structuredContent as {
        filters: { statuses: string[]; sources: string[] };
        totalCandidatesBeforeFilter: number;
        totalCandidatesAfterFilter: number;
        previewedCandidates: number;
        omittedCandidates: number;
        candidates: Array<{ sessionId: string; previewOnlyCommand: string; recommendedPreviewCommand: string }>;
      };

      expect(preview.filters.statuses).toEqual(["db-only", "risky-global-state"]);
      expect(preview.filters.sources).toEqual(["global_state_unknown", "sqlite"]);
      expect(preview.totalCandidatesBeforeFilter).toBe(4);
      expect(preview.totalCandidatesAfterFilter).toBe(2);
      expect(preview.previewedCandidates).toBe(2);
      expect(preview.omittedCandidates).toBe(0);
      expect(preview.candidates.map((candidate) => candidate.sessionId).sort()).toEqual(
        [unknownGlobalId, dbOnlyId].sort(),
      );
      expect(preview.candidates.every((candidate) => !candidate.previewOnlyCommand.includes("--yes"))).toBe(true);
      expect(preview.candidates.every((candidate) => !candidate.recommendedPreviewCommand.includes("--yes"))).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("deletes sessions when confirmation is explicit", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ACTIVE_ID],
          confirm: true,
        },
      });

      const deletion = result.structuredContent?.result as {
        validation: Array<{
          sessionIndexRowsRemaining: number;
          historyRowsRemaining: number;
          shellSnapshotFilesRemaining: string[];
          globalStateRefsRemaining: number;
          possibleUnknownGlobalStateRefsRemaining: number;
          sqlite: { threadRows: number; logRows: number; stage1Rows: number; dynamicToolRows: number };
        }>;
      };
      const scan = await scanCodexRoot(fixture.rootDir);

      expect(deletion).toBeDefined();
      expect(deletion.validation[0].sessionIndexRowsRemaining).toBe(0);
      expect(deletion.validation[0].historyRowsRemaining).toBe(0);
      expect(deletion.validation[0].shellSnapshotFilesRemaining).toEqual([]);
      expect(deletion.validation[0].globalStateRefsRemaining).toBe(0);
      expect(deletion.validation[0].possibleUnknownGlobalStateRefsRemaining).toBe(1);
      expect(deletion.validation[0].sqlite.threadRows).toBe(0);
      expect(deletion.validation[0].sqlite.logRows).toBe(0);
      expect(deletion.validation[0].sqlite.stage1Rows).toBe(0);
      expect(deletion.validation[0].sqlite.dynamicToolRows).toBe(0);
      expect(scan.sessions.some((session) => session.id === FIXTURE_IDS.ACTIVE_ID)).toBe(false);
      await expect(readFile(fixture.paths.activeShellSnapshot, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(fixture.paths.globalState, "utf8")).toContain(FIXTURE_IDS.ARCHIVED_ID);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("moves sessions to trash only when confirmation is explicit", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const preview = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ACTIVE_ID],
          trash: true,
        },
      });

      expect(preview.structuredContent?.requiresConfirmation).toBe(true);
      await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");

      const deletion = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ACTIVE_ID],
          trash: true,
          confirm: true,
        },
      });
      const trashList = await client.callTool({
        name: "list_trash",
        arguments: {
          root: fixture.rootDir,
        },
      });

      expect(deletion.structuredContent?.result).toBeDefined();
      await expect(readFile(fixture.paths.activeSessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      expect((trashList.structuredContent?.entries as Array<{ sessionIds: string[] }>)[0].sessionIds).toContain(FIXTURE_IDS.ACTIVE_ID);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("restores and purges trash entries through MCP tools", async () => {
    const { client, server } = await createConnectedClient();

    try {
      await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ACTIVE_ID],
          trash: true,
          confirm: true,
        },
      });

      const restorePreview = await client.callTool({
        name: "restore_sessions",
        arguments: {
          root: fixture.rootDir,
          id: FIXTURE_IDS.ACTIVE_ID,
        },
      });
      expect(restorePreview.structuredContent?.requiresConfirmation).toBe(true);
      await expect(readFile(fixture.paths.activeSessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      const restore = await client.callTool({
        name: "restore_sessions",
        arguments: {
          root: fixture.rootDir,
          id: FIXTURE_IDS.ACTIVE_ID,
          confirm: true,
        },
      });
      expect((restore.structuredContent?.result as { restoredSessionIds: string[] }).restoredSessionIds).toContain(FIXTURE_IDS.ACTIVE_ID);
      await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");

      const purge = await client.callTool({
        name: "purge_trash",
        arguments: {
          root: fixture.rootDir,
          id: FIXTURE_IDS.ACTIVE_ID,
          confirm: true,
        },
      });
      expect((purge.structuredContent?.result as { purged: boolean }).purged).toBe(true);
      const trashList = await client.callTool({
        name: "list_trash",
        arguments: {
          root: fixture.rootDir,
        },
      });
      expect(trashList.structuredContent?.entries).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("previews cleanup_stale_indexes without rewriting jsonl indexes", async () => {
    const { client, server } = await createConnectedClient();
    const beforeSessionIndex = await readFile(fixture.paths.sessionIndex, "utf8");
    const beforeHistory = await readFile(fixture.paths.history, "utf8");

    try {
      const result = await client.callTool({
        name: "cleanup_stale_indexes",
        arguments: {
          root: fixture.rootDir,
        },
      });
      const preview = result.structuredContent?.preview as {
        staleSessionIds: string[];
        removedSessionIndexRows: number;
        removedHistoryRows: number;
      };

      expect(result.structuredContent?.requiresConfirmation).toBe(true);
      expect(preview.staleSessionIds).toEqual([FIXTURE_IDS.STALE_ID]);
      expect(preview.removedSessionIndexRows).toBe(1);
      expect(preview.removedHistoryRows).toBe(1);
      await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toBe(beforeSessionIndex);
      await expect(readFile(fixture.paths.history, "utf8")).resolves.toBe(beforeHistory);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("executes cleanup_stale_indexes only with confirm=true", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "cleanup_stale_indexes",
        arguments: {
          root: fixture.rootDir,
          confirm: true,
        },
      });
      const cleanup = result.structuredContent?.result as {
        staleSessionIds: string[];
        removedSessionIndexRows: number;
        removedHistoryRows: number;
      };

      expect(cleanup.staleSessionIds).toEqual([FIXTURE_IDS.STALE_ID]);
      expect(cleanup.removedSessionIndexRows).toBe(1);
      expect(cleanup.removedHistoryRows).toBe(1);
      expect(await readFile(fixture.paths.sessionIndex, "utf8")).not.toContain(FIXTURE_IDS.STALE_ID);
      expect(await readFile(fixture.paths.history, "utf8")).not.toContain(FIXTURE_IDS.STALE_ID);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("previews cleanup_session_indexes without rewriting jsonl indexes", async () => {
    const { client, server } = await createConnectedClient();
    const beforeSessionIndex = await readFile(fixture.paths.sessionIndex, "utf8");
    const beforeHistory = await readFile(fixture.paths.history, "utf8");

    try {
      const result = await client.callTool({
        name: "cleanup_session_indexes",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ACTIVE_ID],
        },
      });
      const preview = result.structuredContent?.preview as {
        sessionIds: string[];
        removedSessionIndexRows: number;
        removedHistoryRows: number;
      };

      expect(result.structuredContent?.requiresConfirmation).toBe(true);
      expect(preview.sessionIds).toEqual([FIXTURE_IDS.ACTIVE_ID]);
      expect(preview.removedSessionIndexRows).toBe(1);
      expect(preview.removedHistoryRows).toBe(1);
      await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toBe(beforeSessionIndex);
      await expect(readFile(fixture.paths.history, "utf8")).resolves.toBe(beforeHistory);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("executes cleanup_session_indexes only with confirm=true", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "cleanup_session_indexes",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ACTIVE_ID],
          confirm: true,
        },
      });
      const cleanup = result.structuredContent?.result as {
        sessionIds: string[];
        removedSessionIndexRows: number;
        removedHistoryRows: number;
      };

      expect(cleanup.sessionIds).toEqual([FIXTURE_IDS.ACTIVE_ID]);
      expect(cleanup.removedSessionIndexRows).toBe(1);
      expect(cleanup.removedHistoryRows).toBe(1);
      expect(await readFile(fixture.paths.sessionIndex, "utf8")).not.toContain(FIXTURE_IDS.ACTIVE_ID);
      expect(await readFile(fixture.paths.history, "utf8")).not.toContain(FIXTURE_IDS.ACTIVE_ID);
      await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
