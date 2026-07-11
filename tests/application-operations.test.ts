import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  getSessionOperation,
  inspectRootOperation,
  listSessionsOperation,
} from "../src/application/session-operations.js";
import { getSessionEventsPageOperation } from "../src/application/event-operations.js";
import {
  auditSessionOperation,
  getSessionFamilyOperation,
  listProjectsOperation,
  planDeleteOperation,
  summarizeSourcesOperation,
  verifySessionsOperation,
} from "../src/application/read-operations.js";
import {
  deleteSessionsOperation,
  cleanupSessionIndexesOperation,
} from "../src/application/mutation-operations.js";
import { runCli } from "../src/cli/run.js";
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
});
