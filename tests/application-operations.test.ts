import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  getSessionOperation,
  inspectRootOperation,
  listSessionsOperation,
} from "../src/application/session-operations.js";
import { getSessionEventsPageOperation } from "../src/application/event-operations.js";
import {
  auditRootOperation,
  auditSessionOperation,
  getRecoveryStatusOperation,
  getSessionFamilyOperation,
  listTrashOperation,
  listProjectsOperation,
  planDeleteOperation,
  previewDeletePlanOperation,
  previewRootDeleteOperation,
  summarizeSourcesOperation,
  verifySessionsOperation,
  writeDeletePlanOperation,
} from "../src/application/read-operations.js";
import {
  cleanupStaleIndexesOperation,
  deleteSessionsOperation,
  cleanupSessionIndexesOperation,
  purgeTrashOperation,
  recoverOperation,
  restoreTrashOperation,
} from "../src/application/mutation-operations.js";
import { acquireMutationLock } from "../src/core/mutation-safety.js";
import { createTrustedRootContext } from "../src/core/path-safety.js";
import { createRecoveryFileTransition } from "../src/core/recovery.js";
import { runCli } from "../src/cli/run.js";
import { formatDoctor } from "../src/cli/format.js";
import { createServer } from "../src/mcp/server.js";
import { createFixture, FIXTURE_IDS, type Fixture } from "./helpers/fixture.js";

function createIo() {
  const stdout: string[] = [];
  return {
    stdout,
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: () => undefined,
    },
  };
}

async function createAdminClient() {
  const server = createServer("admin");
  const client = new Client({ name: "application-parity-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("shared application operations", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("returns the same canonical list result used by CLI JSON", async () => {
    const operation = await listSessionsOperation({
      root: fixture.rootDir,
      filters: { status: "active" },
      groupBy: "project",
    });
    const capture = createIo();

    await expect(
      runCli(["list", "--root", fixture.rootDir, "--status", "active", "--group-by", "project", "--json"], capture.io),
    ).resolves.toBe(0);

    expect(JSON.parse(capture.stdout.join("\n"))).toEqual(operation.data);
    expect(operation.data.sessions.map((session) => session.id)).toEqual([FIXTURE_IDS.ACTIVE_ID]);
  });

  it("returns the same canonical session result used by CLI JSON", async () => {
    const operation = await getSessionOperation({
      root: fixture.rootDir,
      sessionId: FIXTURE_IDS.ACTIVE_ID,
    });
    const capture = createIo();

    await expect(
      runCli(["show", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--json"], capture.io),
    ).resolves.toBe(0);

    expect(JSON.parse(capture.stdout.join("\n"))).toEqual(operation.data);
    expect(operation.data.session.id).toBe(FIXTURE_IDS.ACTIVE_ID);
    expect(operation.data.timeline.length).toBeGreaterThan(0);
  });

  it("keeps root inspection in the shared application layer", async () => {
    const result = await inspectRootOperation({ root: fixture.rootDir });

    expect(result.report.rootPath).toBe(fixture.rootDir);
    expect(result.warnings).toEqual(result.report.warnings);
    expect(result.report.detailsIncluded).toBe(false);
    expect(result.report.sampleLimit).toBe(5);
    expect(result.report.globalState.knownRefs.length).toBeLessThanOrEqual(5);
    expect(result.report.globalState.exactKeyRefs.length).toBeLessThanOrEqual(5);
    expect(result.report.globalState.possibleUnknownRefs.length).toBeLessThanOrEqual(5);
    expect(result.report.warnings.length).toBeLessThanOrEqual(20);
  });

  it("returns complete doctor references only when details are explicit", async () => {
    const summary = await inspectRootOperation({ root: fixture.rootDir });
    const details = await inspectRootOperation({ root: fixture.rootDir, includeDetails: true });

    expect(details.report.detailsIncluded).toBe(true);
    expect(details.report.sampleLimit).toBeNull();
    expect(details.report.counts.globalStateKnownRefs).toBe(details.report.globalState.knownRefs.length);
    expect(details.report.counts.globalStateExactKeyRefs).toBe(details.report.globalState.exactKeyRefs.length);
    expect(details.report.counts.globalStatePossibleUnknownRefs).toBe(details.report.globalState.possibleUnknownRefs.length);
    expect(summary.report.counts).toEqual(details.report.counts);
    expect(formatDoctor(summary.report).split("\n").length).toBeLessThanOrEqual(200);
  });

  it("exposes doctor details through an explicit CLI flag", async () => {
    const compact = createIo();
    const detailed = createIo();

    await expect(runCli(["doctor", "--root", fixture.rootDir, "--json"], compact.io)).resolves.toBe(0);
    await expect(runCli(["doctor", "--root", fixture.rootDir, "--json", "--details"], detailed.io)).resolves.toBe(0);

    expect(JSON.parse(compact.stdout.join("\n"))).toMatchObject({ detailsIncluded: false, sampleLimit: 5 });
    expect(JSON.parse(detailed.stdout.join("\n"))).toMatchObject({ detailsIncluded: true, sampleLimit: null });
  });

  it("keeps CLI event JSONL and the bounded page on one canonical operation", async () => {
    const page = await getSessionEventsPageOperation({
      root: fixture.rootDir,
      sessionId: FIXTURE_IDS.ACTIVE_ID,
      limit: 10,
    });
    const capture = createIo();

    await expect(runCli(["events", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir], capture.io)).resolves.toBe(0);

    expect(capture.stdout.map((line) => JSON.parse(line))).toEqual(page.events);
    expect(page.completeness).toBe("complete");

    const { client, server } = await createAdminClient();
    try {
      const mcp = await client.callTool({
        name: "get_session_events_page",
        arguments: { root: fixture.rootDir, sessionId: FIXTURE_IDS.ACTIVE_ID, limit: 10 },
      });
      expect(mcp.structuredContent).toEqual(JSON.parse(JSON.stringify(page)));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it.each([
    ["sources", () => summarizeSourcesOperation({ root: fixture.rootDir })],
    ["projects", () => listProjectsOperation({ root: fixture.rootDir })],
    ["family", () => getSessionFamilyOperation({ root: fixture.rootDir, sessionId: FIXTURE_IDS.ACTIVE_ID })],
    ["audit", () => auditSessionOperation({ root: fixture.rootDir, sessionId: FIXTURE_IDS.ACTIVE_ID })],
    ["verify", () => verifySessionsOperation({ root: fixture.rootDir, sessionIds: [FIXTURE_IDS.ARCHIVED_ID] })],
  ])("uses one canonical read operation for CLI %s JSON", async (command, operationFactory) => {
    const operation = await operationFactory();
    const capture = createIo();
    const args = command === "sources" || command === "projects"
      ? [command, "--root", fixture.rootDir, "--json"]
      : [command, command === "verify" ? FIXTURE_IDS.ARCHIVED_ID : FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--json"];

    await expect(runCli(args, capture.io)).resolves.toBe(0);
    expect(JSON.parse(capture.stdout.join("\n"))).toEqual(operation.data);
  });

  it("uses one canonical explicit-ID plan operation", async () => {
    const operation = await planDeleteOperation({
      root: fixture.rootDir,
      sessionIds: [FIXTURE_IDS.ARCHIVED_ID],
      options: {},
    });
    const capture = createIo();

    await expect(runCli(["plan-delete", FIXTURE_IDS.ARCHIVED_ID, "--root", fixture.rootDir, "--json"], capture.io)).resolves.toBe(0);
    expect(JSON.parse(capture.stdout.join("\n"))).toEqual(operation.data);
  });

  it("keeps every shared read operation equivalent across CLI JSON and MCP", async () => {
    const { client, server } = await createAdminClient();
    const assertParity = async (
      cliArgs: string[],
      tool: string,
      toolArguments: Record<string, unknown>,
      canonical: unknown,
      normalizeMcp: (content: Record<string, unknown>) => unknown = (content) => content,
      normalize: (value: unknown) => unknown = (value) => value,
    ) => {
      const capture = createIo();
      await expect(runCli(cliArgs, capture.io)).resolves.toBe(0);
      const mcp = await client.callTool({ name: tool, arguments: toolArguments });
      expect(normalize(JSON.parse(capture.stdout.join("\n")))).toEqual(normalize(canonical));
      expect(normalize(normalizeMcp(mcp.structuredContent as Record<string, unknown>))).toEqual(normalize(canonical));
    };

    try {
      const root = fixture.rootDir;
      const doctor = await inspectRootOperation({ root });
      await assertParity(
        ["doctor", "--root", root, "--json"],
        "inspect_root",
        { root },
        doctor.report,
        (content) => content.report,
      );

      const listed = await listSessionsOperation({ root, filters: {} });
      const normalizeList = (value: unknown) => {
        const record = value as Record<string, unknown>;
        const sessions = record.sessions as Array<Record<string, unknown>>;
        const rootValue = record.root as Record<string, unknown>;
        return {
          rootPath: rootValue.rootPath,
          sessionIds: sessions.map((session) => session.id),
          kinds: sessions.map((session) => session.kind),
          totalMatches: record.totalMatches ?? sessions.length,
        };
      };
      await assertParity(
        ["list", "--root", root, "--json"],
        "list_sessions",
        { root },
        listed.data,
        (content) => content,
        normalizeList,
      );

      const shown = await getSessionOperation({ root, sessionId: FIXTURE_IDS.ACTIVE_ID });
      const normalizeSession = (value: unknown) => {
        const record = value as Record<string, unknown>;
        const session = record.session as Record<string, unknown>;
        const items = (record.timeline ?? record.items) as Array<Record<string, unknown>>;
        return {
          sessionId: session.id,
          memoryLink: record.memoryLink,
          items: items.map((item) => ({ role: item.role, roleLabel: item.roleLabel, body: item.body })),
          completeness: record.completeness,
          itemsReturned: record.itemsReturned ?? items.length,
        };
      };
      await assertParity(
        ["show", FIXTURE_IDS.ACTIVE_ID, "--root", root, "--json"],
        "get_session",
        { root, sessionId: FIXTURE_IDS.ACTIVE_ID, detail: "compact" },
        shown.data,
        (content) => content,
        normalizeSession,
      );

      const sources = await summarizeSourcesOperation({ root });
      await assertParity(["sources", "--root", root, "--json"], "summarize_sources", { root }, sources.data);

      const projects = await listProjectsOperation({ root });
      await assertParity(["projects", "--root", root, "--json"], "list_projects", { root }, projects.data);

      const family = await getSessionFamilyOperation({ root, sessionId: FIXTURE_IDS.ACTIVE_ID });
      await assertParity(
        ["family", FIXTURE_IDS.ACTIVE_ID, "--root", root, "--json"],
        "get_session_family",
        { root, sessionId: FIXTURE_IDS.ACTIVE_ID },
        family.data,
      );

      const audit = await auditSessionOperation({ root, sessionId: FIXTURE_IDS.ACTIVE_ID });
      await assertParity(
        ["audit", FIXTURE_IDS.ACTIVE_ID, "--root", root, "--json"],
        "audit_session",
        { root, sessionId: FIXTURE_IDS.ACTIVE_ID },
        audit.data,
        (content) => content.audit,
      );

      const rootAudit = await auditRootOperation({ root });
      await assertParity(["audit-root", "--root", root, "--json"], "audit_root", { root }, rootAudit.data);

      const rootPreview = await previewRootDeleteOperation({ root });
      await assertParity(["preview-root", "--root", root, "--json"], "preview_root_delete", { root }, rootPreview.data);

      const trash = await listTrashOperation({ root });
      await assertParity(
        ["trash-list", "--root", root, "--json"],
        "list_trash",
        { root },
        trash.data,
        (content) => ({
          root: content.root,
          entries: content.entries,
          duplicateSessionIds: content.duplicateSessionIds,
        }),
      );

      const recovery = await getRecoveryStatusOperation({ root });
      await assertParity(
        ["recovery-status", "--root", root, "--json"],
        "get_recovery_status",
        { root },
        recovery.data,
        (content) => content.status,
      );

      const verification = await verifySessionsOperation({ root, sessionIds: [FIXTURE_IDS.ARCHIVED_ID] });
      await assertParity(
        ["verify", FIXTURE_IDS.ARCHIVED_ID, "--root", root, "--json"],
        "verify_sessions",
        { root, sessionIds: [FIXTURE_IDS.ARCHIVED_ID] },
        verification.data,
        (content) => content.results,
      );

      const plan = await planDeleteOperation({ root, sessionIds: [FIXTURE_IDS.ARCHIVED_ID], options: {} });
      await assertParity(
        ["plan-delete", FIXTURE_IDS.ARCHIVED_ID, "--root", root, "--json"],
        "plan_delete_sessions",
        { root, sessionIds: [FIXTURE_IDS.ARCHIVED_ID] },
        plan.data,
        (content) => content.plan,
        (value) => ({ ...(value as Record<string, unknown>), scanTimestamp: "<normalized>" }),
      );

      const planPath = path.join(root, "parity-delete-plan.json");
      await writeDeletePlanOperation({
        root,
        outputPath: planPath,
        sessionIds: [FIXTURE_IDS.ARCHIVED_ID],
        options: {},
      });
      const planPreview = await previewDeletePlanOperation({ root, planFile: planPath });
      await assertParity(
        ["preview-plan", planPath, "--root", root, "--json"],
        "preview_delete_plan",
        { root, planFile: planPath },
        planPreview.data,
        (content) => content.preview,
        (value) => ({ ...(value as Record<string, unknown>), scanTimestamp: "<normalized>" }),
      );

      const indexText = await readFile(fixture.paths.sessionIndex, "utf8");
      await writeFile(fixture.paths.sessionIndex, `${indexText}{"id":"${FIXTURE_IDS.ARCHIVED_ID}","thread_name":"stale-plan-change"}\n`, "utf8");
      const stalePlanPreview = await previewDeletePlanOperation({ root, planFile: planPath });
      await assertParity(
        ["preview-plan", planPath, "--root", root, "--json"],
        "preview_delete_plan",
        { root, planFile: planPath },
        stalePlanPreview.data,
        (content) => content.preview,
        (value) => ({ ...(value as Record<string, unknown>), scanTimestamp: "<normalized>" }),
      );
      expect(stalePlanPreview.data.stale).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("uses one canonical delete preview for CLI JSON", async () => {
    const operation = await deleteSessionsOperation({
      root: fixture.rootDir,
      sessionIds: [FIXTURE_IDS.ARCHIVED_ID],
      confirm: false,
      trash: false,
    });
    const capture = createIo();

    await expect(runCli(["delete", FIXTURE_IDS.ARCHIVED_ID, "--root", fixture.rootDir, "--json"], capture.io)).resolves.toBe(0);
    expect(JSON.parse(capture.stdout.join("\n"))).toEqual(operation.data);
    expect(operation.executed).toBe(false);
  });

  it("uses one canonical cleanup preview for CLI JSON", async () => {
    const operation = await cleanupSessionIndexesOperation({
      root: fixture.rootDir,
      sessionIds: [FIXTURE_IDS.ARCHIVED_ID],
      confirm: false,
    });
    const capture = createIo();

    await expect(runCli(["cleanup-index", FIXTURE_IDS.ARCHIVED_ID, "--root", fixture.rootDir, "--json"], capture.io)).resolves.toBe(0);
    expect(JSON.parse(capture.stdout.join("\n"))).toEqual(operation.data);
    expect(operation.executed).toBe(false);
  });

  it.each([
    {
      tool: "delete_sessions",
      command: "delete",
      operation: () => deleteSessionsOperation({
        root: fixture.rootDir,
        sessionIds: [FIXTURE_IDS.ARCHIVED_ID],
        confirm: false,
      }),
    },
    {
      tool: "cleanup_session_indexes",
      command: "cleanup-index",
      operation: () => cleanupSessionIndexesOperation({
        root: fixture.rootDir,
        sessionIds: [FIXTURE_IDS.ARCHIVED_ID],
        confirm: false,
      }),
    },
  ])("keeps CLI and MCP $tool previews equal to the application contract", async ({ tool, command, operation }) => {
    const canonical = await operation();
    const capture = createIo();
    const { client, server } = await createAdminClient();
    try {
      await expect(runCli([command, FIXTURE_IDS.ARCHIVED_ID, "--root", fixture.rootDir, "--json"], capture.io)).resolves.toBe(0);
      const mcp = await client.callTool({
        name: tool,
        arguments: { root: fixture.rootDir, sessionIds: [FIXTURE_IDS.ARCHIVED_ID] },
      });

      expect(JSON.parse(capture.stdout.join("\n"))).toEqual(canonical.data);
      expect(mcp.structuredContent).toEqual(canonical.data);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps mutation input validation inside the application layer", async () => {
    await expect(deleteSessionsOperation({
      root: fixture.rootDir,
      sessionIds: [],
      confirm: false,
    })).rejects.toMatchObject({ code: "MALFORMED_ID" });
    await expect(cleanupSessionIndexesOperation({
      root: fixture.rootDir,
      sessionIds: [""],
      confirm: false,
    })).rejects.toMatchObject({ code: "MALFORMED_ID" });
  });

  it("keeps trash and stale-cleanup previews equal across application, CLI, and MCP", async () => {
    const trashed = await deleteSessionsOperation({
      root: fixture.rootDir,
      sessionIds: [FIXTURE_IDS.ARCHIVED_ID],
      confirm: true,
      trash: true,
    });
    if (!trashed.executed || trashed.action !== "trash") throw new Error("trash setup did not execute");
    const trashId = trashed.result.trashEntry.trashId;
    const { client, server } = await createAdminClient();
    try {
      for (const entry of [
        {
          command: "restore",
          tool: "restore_sessions",
          id: trashId,
          canonical: () => restoreTrashOperation({ root: fixture.rootDir, id: trashId, confirm: false }),
        },
        {
          command: "purge",
          tool: "purge_trash",
          id: trashId,
          canonical: () => purgeTrashOperation({ root: fixture.rootDir, id: trashId, confirm: false }),
        },
      ]) {
        const canonical = await entry.canonical();
        const capture = createIo();
        await expect(runCli([entry.command, entry.id, "--root", fixture.rootDir, "--json"], capture.io)).resolves.toBe(0);
        const mcp = await client.callTool({ name: entry.tool, arguments: { root: fixture.rootDir, id: entry.id } });

        expect(JSON.parse(capture.stdout.join("\n"))).toEqual(canonical.data);
        expect(mcp.structuredContent).toEqual(canonical.data);
      }

      const stale = await cleanupStaleIndexesOperation({ root: fixture.rootDir, confirm: false });
      const capture = createIo();
      await expect(runCli(["cleanup-stale", "--root", fixture.rootDir, "--json"], capture.io)).resolves.toBe(0);
      const mcp = await client.callTool({ name: "cleanup_stale_indexes", arguments: { root: fixture.rootDir } });

      expect(JSON.parse(capture.stdout.join("\n"))).toEqual(stale.data);
      expect(mcp.structuredContent).toEqual(stale.data);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps recovery preview equal across application, CLI, and MCP", async () => {
    const context = await createTrustedRootContext(fixture.rootDir);
    const before = await readFile(fixture.paths.sessionIndex, "utf8");
    const after = `${before}recovery-parity-marker\n`;
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

    const canonical = await recoverOperation({
      root: fixture.rootDir,
      operationId: lock.operationId,
      confirm: false,
    });
    const capture = createIo();
    const { client, server } = await createAdminClient();
    try {
      await expect(runCli(["recover", lock.operationId, "--root", fixture.rootDir, "--json"], capture.io)).resolves.toBe(0);
      const mcp = await client.callTool({
        name: "recover_operation",
        arguments: { root: fixture.rootDir, operationId: lock.operationId },
      });

      expect(JSON.parse(capture.stdout.join("\n"))).toEqual(canonical.data);
      expect(mcp.structuredContent).toEqual(canonical.data);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
