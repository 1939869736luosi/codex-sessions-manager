import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, getMcpVersionText, isMcpEntrypoint, type McpProfile } from "../src/mcp/server.js";
import { validateDeletion } from "../src/core/delete.js";
import { buildDeletePlanFile, writeDeletePlanFile } from "../src/core/plan-file.js";
import { buildPlanDelete } from "../src/core/plan-delete.js";
import { resolveSessions } from "../src/core/query.js";
import { scanCodexRoot } from "../src/core/scan.js";
import { acquireMutationLock, setMutationCheckpointHookForTests } from "../src/core/mutation-safety.js";
import { createTrustedRootContext } from "../src/core/path-safety.js";
import { createRecoveryFileTransition } from "../src/core/recovery.js";
import { createFixture, FIXTURE_IDS, writeExactGlobalStateFixture, type Fixture } from "./helpers/fixture.js";

async function createConnectedClient(profile: McpProfile = "admin") {
  const server = createServer(profile);
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
    setMutationCheckpointHookForTests(null);
    await fixture.cleanup();
  });

  it("reports a real interrupted trash write as RECOVERY_REQUIRED and keeps recovery visible", async () => {
    setMutationCheckpointHookForTests((event) => {
      if (event.kind === "trash" && event.name === "trash-entry" && event.status === "committed") {
        throw new Error("injected MCP trash interruption after durable trash entry");
      }
    });
    const { client, server } = await createConnectedClient("admin");
    try {
      const result = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ARCHIVED_ID],
          trash: true,
          confirm: true,
        },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("RECOVERY_REQUIRED"),
      });

      const status = await client.callTool({
        name: "get_recovery_status",
        arguments: { root: fixture.rootDir },
      });
      expect(status.structuredContent?.status).toMatchObject({
        pending: true,
        kind: "trash",
        stage: "recovery_required",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("exposes recovery status read-only and recovery execution only in admin", async () => {
    const context = await createTrustedRootContext(fixture.rootDir);
    const before = await readFile(fixture.paths.sessionIndex, "utf8");
    const after = `${before}mcp-recovered-marker\n`;
    const lock = await acquireMutationLock(context, "cleanup-index", [FIXTURE_IDS.ACTIVE_ID]);
    await lock.writeRecoveryPayload({
      schemaVersion: "codex-sessions-recovery.v1",
      operationId: lock.operationId,
      kind: "cleanup-index",
      strategy: "rollforward",
      rootRealPath: context.realPath,
      targetIds: [FIXTURE_IDS.ACTIVE_ID],
      files: [createRecoveryFileTransition("session_index.jsonl", before, after)],
    });
    await lock.setStage("committing");
    const readOnly = await createConnectedClient("read-only");
    const admin = await createConnectedClient("admin");
    try {
      const status = await readOnly.client.callTool({
        name: "get_recovery_status",
        arguments: { root: fixture.rootDir },
      });
      expect(status.structuredContent?.status).toMatchObject({ pending: true, operationId: lock.operationId });
      const blocked = await readOnly.client.callTool({
        name: "recover_operation",
        arguments: { root: fixture.rootDir, operationId: lock.operationId, confirm: true },
      });
      expect(blocked.isError).toBe(true);

      const preview = await admin.client.callTool({
        name: "recover_operation",
        arguments: { root: fixture.rootDir, operationId: lock.operationId },
      });
      expect(preview.structuredContent).toMatchObject({ requiresConfirmation: true });
      const recovered = await admin.client.callTool({
        name: "recover_operation",
        arguments: { root: fixture.rootDir, operationId: lock.operationId, confirm: true },
      });
      expect(recovered.structuredContent?.result).toMatchObject({
        operationStatus: "committed",
        recoveredBy: "rollforward",
      });
      await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toBe(after);
    } finally {
      await Promise.all([readOnly.client.close(), readOnly.server.close(), admin.client.close(), admin.server.close()]);
    }
  });

  it("creates the codex-sessions MCP server instance", () => {
    const server = createServer();
    expect(server).toBeDefined();
  });

  it("prints the package version for the MCP bin version flag", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as { version: string };

    expect(getMcpVersionText()).toBe(packageJson.version);
  });

  it.runIf(process.platform !== "win32")("recognizes symlinked MCP bin paths as the entrypoint", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-mcp-entrypoint-"));
    const targetPath = path.join(tempDir, "server.js");
    const symlinkPath = path.join(tempDir, "codex-sessions-mcp");

    try {
      await writeFile(targetPath, "", "utf8");
      await symlink(targetPath, symlinkPath);

      expect(isMcpEntrypoint(symlinkPath, pathToFileURL(targetPath).href)).toBe(true);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
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
        sourceInfo?: { sourceKind: string };
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
      expect(sessions[0].sourceInfo).toMatchObject({
        sourceKind: sessions[0].sourceKind,
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
      expect(report.sqlite.activeStatePath).toBe(await realpath(fixture.paths.sqlite));
      expect(report.sqlite.activeLogsPath).toBe(await realpath(fixture.paths.logsSqlite as string));
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

  it("builds explicit-ID read-only delete plans through MCP without execution affordances", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const tools = await client.listTools();
      const planTool = tools.tools.find((tool) => tool.name === "plan_delete_sessions");
      expect(planTool?.annotations?.readOnlyHint).toBe(true);
      expect(JSON.stringify(planTool?.inputSchema)).not.toContain("confirm");
      expect(JSON.stringify(planTool?.inputSchema)).not.toContain("trash");
      expect(JSON.stringify(planTool?.inputSchema)).not.toContain("force");

      const result = await client.callTool({
        name: "plan_delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ARCHIVED_ID],
        },
      });

      const plan = result.structuredContent?.plan as {
        readOnly: boolean;
        executionSupported: boolean;
        seedSessionIds: string[];
        selectedIds: string[];
        candidateIds?: string[];
        includedIds: Array<{ sessionId: string; reason: string }>;
        planHash?: string;
        previewToken?: string;
      };
      expect(plan).toMatchObject({
        readOnly: true,
        executionSupported: false,
        seedSessionIds: [FIXTURE_IDS.ARCHIVED_ID],
        selectedIds: [FIXTURE_IDS.ARCHIVED_ID],
        includedIds: [{ sessionId: FIXTURE_IDS.ARCHIVED_ID, reason: "seed" }],
      });
      expect(plan.candidateIds).toBeUndefined();
      expect(plan.planHash).toBeUndefined();
      expect(plan.previewToken).toBeUndefined();
      expect(result.structuredContent).toMatchObject({ readOnly: true, executionSupported: false });
      await expect(readFile(fixture.paths.archivedSessionFile, "utf8")).resolves.toContain("archived assistant output");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("applies MCP plan_delete_sessions include flags with the same read-only selection semantics", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "plan_delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ACTIVE_ID],
          includeChildren: true,
          includeSubagents: true,
          includeDescendants: true,
          includeFamily: true,
        },
      });

      const plan = result.structuredContent?.plan as {
        selectedIds: string[];
        includedIds: Array<{ sessionId: string; reason: string }>;
        rejectedIds: Array<{ sessionId: string; reason: string }>;
        warnings: string[];
      };
      expect(plan.selectedIds).toEqual([FIXTURE_IDS.ARCHIVED_ID]);
      expect(plan.includedIds).toEqual([
        { sessionId: FIXTURE_IDS.ARCHIVED_ID, reason: "include-children" },
      ]);
      expect(plan.rejectedIds).toEqual([
        { sessionId: FIXTURE_IDS.ACTIVE_ID, reason: "active-session-refused-by-default" },
      ]);
      expect(plan.warnings).toEqual(expect.arrayContaining([expect.stringContaining("--include-family")]));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("builds sourceKind candidate plans through MCP with candidateIds only", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "plan_delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sourceKind: "subagent",
          status: "archived",
          limit: 20,
        },
      });

      const plan = result.structuredContent?.plan as {
        readOnly: boolean;
        executionSupported: boolean;
        seedSessionIds: string[];
        selectedIds: string[];
        candidateIds: string[];
        candidateSource: { type: string; sourceKinds: string[]; statuses: string[]; limit: number };
        includedIds: unknown[];
      };
      expect(plan).toMatchObject({
        readOnly: true,
        executionSupported: false,
        seedSessionIds: [],
        selectedIds: [],
        candidateIds: [FIXTURE_IDS.ARCHIVED_ID],
        candidateSource: { type: "sourceKind", sourceKinds: ["subagent"], statuses: ["archived"], limit: 20 },
        includedIds: [],
      });
      expect(result.structuredContent).toMatchObject({ readOnly: true, executionSupported: false });

      const activeResult = await client.callTool({
        name: "plan_delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sourceKind: "cli",
          status: "active",
          limit: 20,
        },
      });
      const activePlan = activeResult.structuredContent?.plan as {
        selectedIds: string[];
        candidateIds: string[];
        rejectedIds: Array<{ sessionId: string; reason: string }>;
      };
      expect(activePlan.selectedIds).toEqual([]);
      expect(activePlan.candidateIds).toEqual([]);
      expect(activePlan.rejectedIds).toEqual([
        { sessionId: FIXTURE_IDS.ACTIVE_ID, reason: "active-session-refused-by-default" },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects unsafe MCP sourceKind candidate plan inputs", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const unknown = await client.callTool({
        name: "plan_delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sourceKind: "unknown",
          limit: 20,
        },
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("unknown sourceKind must be reviewed by explicit session ID"),
      });

      const missingLimit = await client.callTool({
        name: "plan_delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sourceKind: "subagent",
        },
      });
      expect(missingLimit.isError).toBe(true);
      expect(missingLimit.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("plan_delete_sessions sourceKind candidate mode requires explicit limit"),
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("previews delete plan files through MCP as read-only and suppresses stale delete previews", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const planPath = path.join(fixture.rootDir, "delete-plan.json");
      const scan = await scanCodexRoot(fixture.rootDir);
      const plan = buildPlanDelete(scan, [FIXTURE_IDS.ARCHIVED_ID]);
      const planFile = await writeDeletePlanFile(planPath, scan, plan);

      const currentResult = await client.callTool({
        name: "preview_delete_plan",
        arguments: {
          root: fixture.rootDir,
          planFile: planPath,
        },
      });
      const currentPreview = currentResult.structuredContent?.preview as {
        readOnly: boolean;
        executionSupported: boolean;
        stale: boolean;
        deletePreview: unknown;
      };
      expect(currentResult.structuredContent).toMatchObject({ readOnly: true, executionSupported: false });
      expect(currentPreview.readOnly).toBe(true);
      expect(currentPreview.executionSupported).toBe(false);
      expect(currentPreview.stale).toBe(false);
      expect(currentPreview.deletePreview).toBeTruthy();

      await writeFile(fixture.paths.history, `${await readFile(fixture.paths.history, "utf8")}\n`, "utf8");

      const staleResult = await client.callTool({
        name: "preview_delete_plan",
        arguments: {
          root: fixture.rootDir,
          plan: planFile,
        },
      });
      const stalePreview = staleResult.structuredContent?.preview as {
        readOnly: boolean;
        stale: boolean;
        staleReasons: string[];
        deletePreview: unknown;
      };
      expect(staleResult.structuredContent).toMatchObject({ readOnly: true, executionSupported: false });
      expect(stalePreview.readOnly).toBe(true);
      expect(stalePreview.stale).toBe(true);
      expect(stalePreview.staleReasons.length).toBeGreaterThan(0);
      expect(stalePreview.deletePreview).toBeNull();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("does not expose MCP delete-by-plan or plan preview write semantics", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).not.toContain("delete_sessions_by_plan");
      const previewTool = tools.tools.find((tool) => tool.name === "preview_delete_plan");
      expect(previewTool?.annotations?.readOnlyHint).toBe(true);
      const schemaText = JSON.stringify(previewTool?.inputSchema);
      expect(schemaText).not.toContain("confirm");
      expect(schemaText).not.toContain("trash");
      expect(schemaText).not.toContain("yes");
      expect(schemaText).not.toContain("force");

      const scan = await scanCodexRoot(fixture.rootDir);
      const inlinePlan = await buildDeletePlanFile(scan, buildPlanDelete(scan, [FIXTURE_IDS.ARCHIVED_ID]));
      const invalidPreview = await client.callTool({
        name: "preview_delete_plan",
        arguments: {
          root: fixture.rootDir,
          plan: inlinePlan,
          confirm: true,
        },
      });
      expect(invalidPreview.isError).toBe(true);
      expect(invalidPreview.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("Unrecognized key"),
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("uses the same exact-key global-state preview rules through MCP", async () => {
    await writeExactGlobalStateFixture(fixture.paths.globalState);
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "preview_delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.EXACT_GLOBAL_STATE_ID],
        },
      });

      const preview = result.structuredContent?.preview as {
        totals: { exactKeyGlobalStateRefs: number; possibleUnknownGlobalStateRefs: number };
        items: Array<{
          exactKeyGlobalStateRefsDetail: Array<{ ruleId: string; valueShape: string; value?: unknown }>;
        }>;
      };
      expect(preview.totals.exactKeyGlobalStateRefs).toBe(2);
      expect(preview.totals.possibleUnknownGlobalStateRefs).toBe(0);
      expect(preview.items[0].exactKeyGlobalStateRefsDetail).toEqual([
        expect.objectContaining({ ruleId: "electronPromptHistoryByThreadId", valueShape: "array(3)" }),
        expect.objectContaining({ ruleId: "heartbeatThreadPermissionsById", valueShape: "object(3)" }),
      ]);
      expect(preview.items[0].exactKeyGlobalStateRefsDetail[0]).not.toHaveProperty("value");
      expect(JSON.stringify(result.structuredContent)).not.toContain("secret prompt text");
      expect(JSON.stringify(result.structuredContent)).not.toContain("workspace-write");
      expect(JSON.stringify(result.structuredContent)).not.toContain(FIXTURE_IDS.PROMPT_HISTORY_VALUE_ID);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("removes exact-key global-state refs through confirmed MCP delete only", async () => {
    await writeExactGlobalStateFixture(fixture.paths.globalState);
    const { client, server } = await createConnectedClient();

    try {
      const preview = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.EXACT_GLOBAL_STATE_ID],
        },
      });
      expect(preview.structuredContent?.requiresConfirmation).toBe(true);
      expect(await readFile(fixture.paths.globalState, "utf8")).toContain(FIXTURE_IDS.EXACT_GLOBAL_STATE_ID);

      const deletion = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.EXACT_GLOBAL_STATE_ID],
          confirm: true,
        },
      });
      const result = deletion.structuredContent?.result as {
        validation: Array<{ exactKeyGlobalStateRefsRemaining: number }>;
      };
      const globalStateText = await readFile(fixture.paths.globalState, "utf8");

      expect(result.validation[0].exactKeyGlobalStateRefsRemaining).toBe(0);
      expect(globalStateText).not.toContain(`"019d9999-aaaa-7bbb-8ccc-ffffffffffff": [`);
      expect(globalStateText).toContain(FIXTURE_IDS.EXACT_GLOBAL_STATE_SIBLING_ID);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses non-exact unknown global-state cleanup through MCP", async () => {
    await writeExactGlobalStateFixture(fixture.paths.globalState);
    const { client, server } = await createConnectedClient();

    try {
      const result = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.BAD_HEARTBEAT_GLOBAL_STATE_ID],
          confirm: true,
        },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("拒绝删除 unknown global-state"),
      });
      expect(await readFile(fixture.paths.globalState, "utf8")).toContain(FIXTURE_IDS.BAD_HEARTBEAT_GLOBAL_STATE_ID);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("refuses installation-id and prompt-history value refs through MCP", async () => {
    await writeExactGlobalStateFixture(fixture.paths.globalState);
    const { client, server } = await createConnectedClient();

    try {
      for (const sessionId of [FIXTURE_IDS.INSTALLATION_GLOBAL_STATE_ID, FIXTURE_IDS.PROMPT_HISTORY_VALUE_ID]) {
        const result = await client.callTool({
          name: "delete_sessions",
          arguments: {
            root: fixture.rootDir,
            sessionIds: [sessionId],
            confirm: true,
          },
        });
        expect(result.isError).toBe(true);
        expect(result.content[0]).toMatchObject({
          type: "text",
          text: expect.stringContaining("拒绝删除 unknown global-state"),
        });
      }
      expect(await readFile(fixture.paths.globalState, "utf8")).toContain(FIXTURE_IDS.INSTALLATION_GLOBAL_STATE_ID);
      expect(await readFile(fixture.paths.globalState, "utf8")).toContain(FIXTURE_IDS.PROMPT_HISTORY_VALUE_ID);
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
          allowActive: true,
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
      expect(deletion.validation[0].sqlite.logRows).toBe(1);
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

  it("allows short session prefixes only for unconfirmed MCP previews", async () => {
    const { client, server } = await createConnectedClient();
    const shortId = FIXTURE_IDS.ACTIVE_ID.slice(0, 12);

    try {
      const preview = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [shortId],
        },
      });
      expect(preview.structuredContent).toMatchObject({
        requiresConfirmation: true,
        requiresFullSessionIds: true,
        requiresAllowActive: true,
        activeSessionIds: [FIXTURE_IDS.ACTIVE_ID],
        preview: { items: [{ sessionId: FIXTURE_IDS.ACTIVE_ID }] },
      });

      const confirmed = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [shortId],
          confirm: true,
        },
      });
      expect(confirmed.isError).toBe(true);
      expect(confirmed.content[0]).toMatchObject({
        type: "text",
        text: expect.stringMatching(/MALFORMED_ID|full UUID/),
      });
      const malformed = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: ["../victim"],
          confirm: true,
        },
      });
      expect(malformed.isError).toBe(true);
      expect(malformed.content[0]).toMatchObject({
        type: "text",
        text: expect.stringMatching(/MALFORMED_ID|full UUID/),
      });
      await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("requires allowActive=true for confirmed MCP deletion of active sessions", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const refused = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ACTIVE_ID],
          trash: true,
          confirm: true,
        },
      });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]).toMatchObject({
        type: "text",
        text: expect.stringMatching(/ACTIVE_SESSION|allowActive/),
      });
      await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");

      const allowed = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ACTIVE_ID],
          confirm: true,
          allowActive: true,
        },
      });
      expect(allowed.isError).not.toBe(true);
      await expect(readFile(fixture.paths.activeSessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("requires exact trashId for confirmed MCP restore even with one match", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const deletion = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ACTIVE_ID],
          trash: true,
          confirm: true,
          allowActive: true,
        },
      });
      const trashId = (deletion.structuredContent?.result as { trashEntry: { trashId: string } }).trashEntry.trashId;

      const preview = await client.callTool({
        name: "restore_sessions",
        arguments: {
          root: fixture.rootDir,
          id: FIXTURE_IDS.ACTIVE_ID.slice(0, 12),
        },
      });
      expect(preview.structuredContent).toMatchObject({
        requiresConfirmation: true,
        requiresExactTrashId: true,
      });

      const refused = await client.callTool({
        name: "restore_sessions",
        arguments: {
          root: fixture.rootDir,
          id: FIXTURE_IDS.ACTIVE_ID,
          confirm: true,
        },
      });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]).toMatchObject({
        type: "text",
        text: expect.stringMatching(/MALFORMED_ID|精确 trashId/),
      });

      const restored = await client.callTool({
        name: "restore_sessions",
        arguments: { root: fixture.rootDir, id: trashId, confirm: true },
      });
      expect(restored.isError).not.toBe(true);

      const purgeBySession = await client.callTool({
        name: "purge_trash",
        arguments: { root: fixture.rootDir, id: FIXTURE_IDS.ACTIVE_ID, confirm: true },
      });
      expect(purgeBySession.isError).toBe(true);
      expect(purgeBySession.content[0]).toMatchObject({
        type: "text",
        text: expect.stringMatching(/MALFORMED_ID|精确 trashId/),
      });
      const purged = await client.callTool({
        name: "purge_trash",
        arguments: { root: fixture.rootDir, id: trashId, confirm: true },
      });
      expect(purged.isError).not.toBe(true);
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
          allowActive: true,
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
      const deletion = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ACTIVE_ID],
          trash: true,
          confirm: true,
          allowActive: true,
        },
      });
      const trashId = (deletion.structuredContent?.result as { trashEntry: { trashId: string } }).trashEntry.trashId;

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
          id: trashId,
          confirm: true,
        },
      });
      expect((restore.structuredContent?.result as { restoredSessionIds: string[] }).restoredSessionIds).toContain(FIXTURE_IDS.ACTIVE_ID);
      await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");

      const purge = await client.callTool({
        name: "purge_trash",
        arguments: {
          root: fixture.rootDir,
          id: trashId,
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

  it("requires exact trash ids for duplicate trash writes through MCP tools", async () => {
    const { client, server } = await createConnectedClient();

    try {
      const firstDelete = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ACTIVE_ID],
          trash: true,
          confirm: true,
          allowActive: true,
        },
      });
      const firstTrashId = (firstDelete.structuredContent?.result as { trashEntry: { trashId: string } }).trashEntry.trashId;

      await client.callTool({
        name: "restore_sessions",
        arguments: {
          root: fixture.rootDir,
          id: firstTrashId,
          confirm: true,
        },
      });

      const secondDelete = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ACTIVE_ID],
          trash: true,
          confirm: true,
          allowActive: true,
        },
      });
      const secondTrashId = (secondDelete.structuredContent?.result as { trashEntry: { trashId: string } }).trashEntry.trashId;

      const trashList = await client.callTool({
        name: "list_trash",
        arguments: {
          root: fixture.rootDir,
        },
      });
      const entries = trashList.structuredContent?.entries as Array<{ trashId: string; sessionIds: string[] }>;
      const duplicateSessionIds = trashList.structuredContent?.duplicateSessionIds as Array<{ sessionId: string; trashIds: string[] }>;
      expect(entries.filter((entry) => entry.sessionIds.includes(FIXTURE_IDS.ACTIVE_ID))).toHaveLength(2);
      expect(duplicateSessionIds).toEqual([
        expect.objectContaining({
          sessionId: FIXTURE_IDS.ACTIVE_ID,
          trashIds: expect.arrayContaining([firstTrashId, secondTrashId]),
        }),
      ]);

      const restorePreview = await client.callTool({
        name: "restore_sessions",
        arguments: {
          root: fixture.rootDir,
          id: FIXTURE_IDS.ACTIVE_ID,
        },
      });
      expect(restorePreview.structuredContent?.requiresExactTrashId).toBe(true);

      const ambiguousRestore = await client.callTool({
        name: "restore_sessions",
        arguments: {
          root: fixture.rootDir,
          id: FIXTURE_IDS.ACTIVE_ID,
          confirm: true,
        },
      });
      expect(ambiguousRestore.isError).toBe(true);
      expect(ambiguousRestore.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("精确 trashId") });

      const ambiguousPurge = await client.callTool({
        name: "purge_trash",
        arguments: {
          root: fixture.rootDir,
          id: FIXTURE_IDS.ACTIVE_ID,
          confirm: true,
        },
      });
      expect(ambiguousPurge.isError).toBe(true);
      expect(ambiguousPurge.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("精确 trashId") });

      const restore = await client.callTool({
        name: "restore_sessions",
        arguments: {
          root: fixture.rootDir,
          id: secondTrashId,
          confirm: true,
        },
      });
      expect((restore.structuredContent?.result as { restoredSessionIds: string[] }).restoredSessionIds).toContain(FIXTURE_IDS.ACTIVE_ID);
      await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");

      const purge = await client.callTool({
        name: "purge_trash",
        arguments: {
          root: fixture.rootDir,
          id: firstTrashId,
          confirm: true,
        },
      });
      expect((purge.structuredContent?.result as { purged: boolean }).purged).toBe(true);
      await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");

      const afterPurge = await client.callTool({
        name: "list_trash",
        arguments: {
          root: fixture.rootDir,
        },
      });
      expect((afterPurge.structuredContent?.entries as Array<{ trashId: string }>).map((entry) => entry.trashId)).toEqual([
        secondTrashId,
      ]);
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

  it("requires full UUID and allowActive=true for confirmed MCP index cleanup", async () => {
    const { client, server } = await createConnectedClient();
    const shortId = FIXTURE_IDS.ACTIVE_ID.slice(0, 12);

    try {
      const preview = await client.callTool({
        name: "cleanup_session_indexes",
        arguments: { root: fixture.rootDir, sessionIds: [shortId] },
      });
      expect(preview.structuredContent).toMatchObject({
        requiresConfirmation: true,
        requiresFullSessionIds: true,
        requiresAllowActive: true,
        activeSessionIds: [FIXTURE_IDS.ACTIVE_ID],
        preview: { sessionIds: [FIXTURE_IDS.ACTIVE_ID] },
      });

      const shortConfirmed = await client.callTool({
        name: "cleanup_session_indexes",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [shortId],
          confirm: true,
          allowActive: true,
        },
      });
      expect(shortConfirmed.isError).toBe(true);
      expect(shortConfirmed.content[0]).toMatchObject({
        type: "text",
        text: expect.stringMatching(/MALFORMED_ID|full UUID/),
      });

      const activeConfirmed = await client.callTool({
        name: "cleanup_session_indexes",
        arguments: {
          root: fixture.rootDir,
          sessionIds: [FIXTURE_IDS.ACTIVE_ID],
          confirm: true,
        },
      });
      expect(activeConfirmed.isError).toBe(true);
      expect(activeConfirmed.content[0]).toMatchObject({
        type: "text",
        text: expect.stringMatching(/ACTIVE_SESSION|allowActive/),
      });
      expect(await readFile(fixture.paths.sessionIndex, "utf8")).toContain(FIXTURE_IDS.ACTIVE_ID);
      expect(await readFile(fixture.paths.history, "utf8")).toContain(FIXTURE_IDS.ACTIVE_ID);
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
          allowActive: true,
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

describe("mcp server --profile", () => {
  const ADMIN_TOOLS = ["delete_sessions", "restore_sessions", "purge_trash", "cleanup_session_indexes", "cleanup_stale_indexes", "recover_operation"];
  const READ_ONLY_TOOLS = [
    "inspect_root", "list_sessions", "summarize_sources", "list_projects",
    "get_session", "get_session_family", "audit_session", "audit_root",
    "preview_root_delete", "export_session_backup", "preview_delete_sessions",
    "plan_delete_sessions", "preview_delete_plan", "list_trash",
    "verify_sessions", "get_recovery_status",
  ];

  it("read-only profile registers only read-only tools", async () => {
    const { client, server } = await createConnectedClient("read-only");
    try {
      const { tools } = await client.listTools();
      const toolNames = tools.map((t) => t.name);
      for (const name of READ_ONLY_TOOLS) {
        expect(toolNames).toContain(name);
      }
      for (const name of ADMIN_TOOLS) {
        expect(toolNames).not.toContain(name);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("admin profile registers all tools", async () => {
    const { client, server } = await createConnectedClient("admin");
    try {
      const { tools } = await client.listTools();
      const toolNames = tools.map((t) => t.name);
      for (const name of [...READ_ONLY_TOOLS, ...ADMIN_TOOLS]) {
        expect(toolNames).toContain(name);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("read-only profile has 16 tools, admin has 22", async () => {
    const { client: roClient, server: roServer } = await createConnectedClient("read-only");
    const { client: adminClient, server: adminServer } = await createConnectedClient("admin");
    try {
      const roTools = await roClient.listTools();
      const adminTools = await adminClient.listTools();
      expect(roTools.tools.length).toBe(16);
      expect(adminTools.tools.length).toBe(22);
      expect(roTools.tools.map((tool) => tool.name)).toContain("get_recovery_status");
      expect(roTools.tools.map((tool) => tool.name)).not.toContain("recover_operation");
      expect(adminTools.tools.map((tool) => tool.name)).toContain("recover_operation");
    } finally {
      await roClient.close();
      await roServer.close();
      await adminClient.close();
      await adminServer.close();
    }
  });

  it("read-only profile rejects calling an admin tool", async () => {
    const { client, server } = await createConnectedClient("read-only");
    try {
      const result = await client.callTool({
        name: "delete_sessions",
        arguments: {
          sessionIds: ["019d1111-2222-7333-8444-aaaaaaaaaaaa"],
          confirm: true,
          trash: true,
          allowActive: true,
        },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("delete_sessions not found"),
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("parseProfile returns read-only by default", async () => {
    const { parseProfile } = await import("../src/mcp/server.js");
    expect(parseProfile(["node", "server.js"])).toBe("read-only");
  });

  it("parseProfile returns admin when --profile admin is passed", async () => {
    const { parseProfile } = await import("../src/mcp/server.js");
    expect(parseProfile(["node", "server.js", "--profile", "admin"])).toBe("admin");
  });

  it("parseProfile returns read-only when --profile read-only is passed", async () => {
    const { parseProfile } = await import("../src/mcp/server.js");
    expect(parseProfile(["node", "server.js", "--profile", "read-only"])).toBe("read-only");
  });

  it("parseProfile exits with code 1 when --profile is passed without a value", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { parseProfile } = await import("../src/mcp/server.js");
    try {
      expect(() => parseProfile(["node", "server.js", "--profile"])).toThrow("exit");
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("--profile requires a value"));
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
