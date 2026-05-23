import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
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
      }>;
      const projects = result.structuredContent?.projectSummaries as Array<{ projectName: string; sessionCount: number }>;
      expect(sessions.map((session) => session.id)).toEqual([FIXTURE_IDS.ACTIVE_ID]);
      expect(sessions[0]).toMatchObject({
        displayTitle: "Active thread",
        sqliteTitle: `Title ${FIXTURE_IDS.ACTIVE_ID}`,
        titleSource: "session_index",
        titleMismatch: true,
      });
      expect(projects[0]).toMatchObject({ projectName: "demo", sessionCount: 1 });
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
        fileExists: true,
      });
      expect(family.familyMembers.map((node) => node.sessionId).sort()).toEqual(
        [FIXTURE_IDS.ACTIVE_ID, FIXTURE_IDS.ARCHIVED_ID].sort(),
      );
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
