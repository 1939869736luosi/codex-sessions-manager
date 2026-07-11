import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli/run.js";
import { createServer } from "../src/mcp/server.js";
import { acquireMutationLock, setMutationCheckpointHookForTests } from "../src/core/mutation-safety.js";
import { createTrustedRootContext } from "../src/core/path-safety.js";
import { createRecoveryFileTransition } from "../src/core/recovery.js";
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
  const client = new Client({ name: "mutation-parity-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function mutationContract(value: unknown): Record<string, unknown> {
  const result = value as Record<string, any>;
  const previewItems = Array.isArray(result.preview?.items)
    ? result.preview.items.map((item: Record<string, unknown>) => item.sessionId)
    : undefined;
  return {
    operationStatus: result.operationStatus ?? null,
    verificationStatus: result.verificationStatus ?? null,
    verificationScope: result.verificationScope ?? null,
    errorCode: result.errorCode ?? null,
    warningCount: Array.isArray(result.warnings) ? result.warnings.length : 0,
    confirmed: result.confirmed ?? null,
    purged: result.purged ?? null,
    recoveredBy: result.recoveredBy ?? null,
    kind: result.kind ?? null,
    sessionIds: result.sessionIds
      ?? result.restoredSessionIds
      ?? result.staleSessionIds
      ?? result.trashEntry?.sessionIds
      ?? previewItems
      ?? [],
    removedSessionIndexRows: result.removedSessionIndexRows ?? null,
    removedHistoryRows: result.removedHistoryRows ?? null,
    restoredSessionFiles: result.restoredSessionFiles ?? null,
    restoredShellSnapshots: result.restoredShellSnapshots ?? null,
    restoredSessionIndexRecords: result.restoredSessionIndexRecords ?? null,
    restoredHistoryRecords: result.restoredHistoryRecords ?? null,
    restoredGlobalStateRefs: result.restoredGlobalStateRefs ?? null,
    restoredSqliteRows: result.restoredSqliteRows ?? null,
    skippedSqliteRows: result.skippedSqliteRows ?? null,
    deletion: result.deletion ? mutationContract(result.deletion) : null,
  };
}

async function runCliJson(fixture: Fixture, args: string[]): Promise<Record<string, unknown>> {
  const capture = createIo();
  await expect(runCli([...args, "--root", fixture.rootDir, "--json"], capture.io)).resolves.toBe(0);
  return JSON.parse(capture.stdout.join("\n")) as Record<string, unknown>;
}

async function runMcpResult(
  fixture: Fixture,
  name: string,
  argumentsValue: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { client, server } = await createAdminClient();
  try {
    const response = await client.callTool({
      name,
      arguments: { root: fixture.rootDir, ...argumentsValue },
    });
    expect(response.isError).not.toBe(true);
    return response.structuredContent?.result as Record<string, unknown>;
  } finally {
    await client.close();
    await server.close();
  }
}

describe("confirmed mutation adapter parity", () => {
  const fixtures: Fixture[] = [];
  const temporaryDirectories: string[] = [];

  async function pair(): Promise<[Fixture, Fixture]> {
    const created: [Fixture, Fixture] = [await createFixture(), await createFixture()];
    fixtures.push(...created);
    return created;
  }

  afterEach(async () => {
    setMutationCheckpointHookForTests(null);
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it("keeps confirmed permanent delete equivalent", async () => {
    const [cliFixture, mcpFixture] = await pair();
    const cli = await runCliJson(cliFixture, ["delete", FIXTURE_IDS.ARCHIVED_ID, "--yes"]);
    const mcp = await runMcpResult(mcpFixture, "delete_sessions", {
      sessionIds: [FIXTURE_IDS.ARCHIVED_ID],
      confirm: true,
    });

    expect(mutationContract(cli)).toEqual(mutationContract(mcp));
  });

  it("keeps confirmed trash, restore, and purge equivalent", async () => {
    const [cliFixture, mcpFixture] = await pair();
    const cliTrash = await runCliJson(cliFixture, ["delete", FIXTURE_IDS.ARCHIVED_ID, "--trash", "--yes"]);
    const mcpTrash = await runMcpResult(mcpFixture, "delete_sessions", {
      sessionIds: [FIXTURE_IDS.ARCHIVED_ID],
      trash: true,
      confirm: true,
    });
    expect(mutationContract(cliTrash)).toEqual(mutationContract(mcpTrash));

    const cliTrashId = (cliTrash.trashEntry as Record<string, unknown>).trashId as string;
    const mcpTrashId = (mcpTrash.trashEntry as Record<string, unknown>).trashId as string;
    const cliRestore = await runCliJson(cliFixture, ["restore", cliTrashId, "--yes"]);
    const mcpRestore = await runMcpResult(mcpFixture, "restore_sessions", { id: mcpTrashId, confirm: true });
    expect(mutationContract(cliRestore)).toEqual(mutationContract(mcpRestore));

    const cliTrashAgain = await runCliJson(cliFixture, ["delete", FIXTURE_IDS.ARCHIVED_ID, "--trash", "--yes"]);
    const mcpTrashAgain = await runMcpResult(mcpFixture, "delete_sessions", {
      sessionIds: [FIXTURE_IDS.ARCHIVED_ID],
      trash: true,
      confirm: true,
    });
    const cliPurgeId = (cliTrashAgain.trashEntry as Record<string, unknown>).trashId as string;
    const mcpPurgeId = (mcpTrashAgain.trashEntry as Record<string, unknown>).trashId as string;
    const cliPurge = await runCliJson(cliFixture, ["purge", cliPurgeId, "--yes"]);
    const mcpPurge = await runMcpResult(mcpFixture, "purge_trash", { id: mcpPurgeId, confirm: true });
    expect(mutationContract(cliPurge)).toEqual(mutationContract(mcpPurge));
  });

  it("keeps confirmed index cleanup and stale cleanup equivalent", async () => {
    const [cliFixture, mcpFixture] = await pair();
    const cliIndex = await runCliJson(cliFixture, ["cleanup-index", FIXTURE_IDS.ARCHIVED_ID, "--yes"]);
    const mcpIndex = await runMcpResult(mcpFixture, "cleanup_session_indexes", {
      sessionIds: [FIXTURE_IDS.ARCHIVED_ID],
      confirm: true,
    });
    expect(mutationContract(cliIndex)).toEqual(mutationContract(mcpIndex));

    const cliStale = await runCliJson(cliFixture, ["cleanup-stale", "--yes"]);
    const mcpStale = await runMcpResult(mcpFixture, "cleanup_stale_indexes", { confirm: true });
    expect(mutationContract(cliStale)).toEqual(mutationContract(mcpStale));
  });

  it("keeps confirmed recovery equivalent", async () => {
    const [cliFixture, mcpFixture] = await pair();
    const prepare = async (fixture: Fixture) => {
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
      return lock.operationId;
    };
    const cliOperationId = await prepare(cliFixture);
    const mcpOperationId = await prepare(mcpFixture);
    const cli = await runCliJson(cliFixture, ["recover", cliOperationId, "--yes"]);
    const mcp = await runMcpResult(mcpFixture, "recover_operation", {
      operationId: mcpOperationId,
      confirm: true,
    });

    expect(mutationContract(cli)).toEqual(mutationContract(mcp));
  });

  it.each([
    {
      label: "active session refusal",
      expectedCode: "ACTIVE_SESSION",
      prepare: async (_fixture: Fixture) => undefined,
      cliArgs: ["delete", FIXTURE_IDS.ACTIVE_ID, "--yes"],
      tool: "delete_sessions",
      toolArguments: { sessionIds: [FIXTURE_IDS.ACTIVE_ID], confirm: true },
    },
    {
      label: "unsafe managed directory refusal",
      expectedCode: "UNSAFE_PATH",
      prepare: async (fixture: Fixture) => {
        const external = await mkdtemp(path.join(os.tmpdir(), "csm-parity-external-"));
        temporaryDirectories.push(external);
        const archivedDirectory = path.join(fixture.rootDir, "archived_sessions");
        await rm(archivedDirectory, { recursive: true, force: true });
        await symlink(external, archivedDirectory);
      },
      cliArgs: ["delete", FIXTURE_IDS.ARCHIVED_ID, "--yes"],
      tool: "delete_sessions",
      toolArguments: { sessionIds: [FIXTURE_IDS.ARCHIVED_ID], confirm: true },
    },
  ])("keeps $label error codes equivalent", async ({ expectedCode, prepare, cliArgs, tool, toolArguments }) => {
    const [cliFixture, mcpFixture] = await pair();
    await prepare(cliFixture);
    await prepare(mcpFixture);

    let cliError: unknown;
    try {
      await runCli([...cliArgs, "--root", cliFixture.rootDir, "--json"], createIo().io);
    } catch (error) {
      cliError = error;
    }
    expect(cliError).toMatchObject({ code: expectedCode });

    const { client, server } = await createAdminClient();
    try {
      const mcp = await client.callTool({
        name: tool,
        arguments: { root: mcpFixture.rootDir, ...toolArguments },
      });
      expect(mcp.isError).toBe(true);
      expect(JSON.stringify(mcp.content)).toContain(expectedCode);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps committed post-verify failure status equivalent", async () => {
    const [cliFixture, mcpFixture] = await pair();
    const cliTrash = await runCliJson(cliFixture, ["delete", FIXTURE_IDS.ARCHIVED_ID, "--trash", "--yes"]);
    const mcpTrash = await runMcpResult(mcpFixture, "delete_sessions", {
      sessionIds: [FIXTURE_IDS.ARCHIVED_ID],
      trash: true,
      confirm: true,
    });
    const cliTrashId = (cliTrash.trashEntry as Record<string, unknown>).trashId as string;
    const mcpTrashId = (mcpTrash.trashEntry as Record<string, unknown>).trashId as string;

    const runFailedPurgeCli = async () => {
      const recreatedEntry = path.join(cliFixture.rootDir, ".codex-sessions-trash", cliTrashId);
      setMutationCheckpointHookForTests(async (event) => {
        if (event.name === "purge-remove" && event.status === "committed") {
          await mkdir(recreatedEntry, { recursive: true });
        }
      });
      const capture = createIo();
      await expect(runCli(["purge", cliTrashId, "--yes", "--root", cliFixture.rootDir, "--json"], capture.io)).resolves.toBe(2);
      setMutationCheckpointHookForTests(null);
      return JSON.parse(capture.stdout.join("\n")) as Record<string, unknown>;
    };
    const cli = await runFailedPurgeCli();

    const recreatedEntry = path.join(mcpFixture.rootDir, ".codex-sessions-trash", mcpTrashId);
    setMutationCheckpointHookForTests(async (event) => {
      if (event.name === "purge-remove" && event.status === "committed") {
        await mkdir(recreatedEntry, { recursive: true });
      }
    });
    const mcp = await runMcpResult(mcpFixture, "purge_trash", { id: mcpTrashId, confirm: true });
    setMutationCheckpointHookForTests(null);

    expect(mutationContract(cli)).toEqual(mutationContract(mcp));
    expect(mutationContract(cli)).toMatchObject({
      operationStatus: "committed",
      verificationStatus: "failed",
      errorCode: "POST_COMMIT_VERIFY_FAILED",
    });
  });

  it("keeps recovery-required refusal equivalent", async () => {
    const [cliFixture, mcpFixture] = await pair();
    const preparePending = async (fixture: Fixture) => {
      const context = await createTrustedRootContext(fixture.rootDir);
      const before = await readFile(fixture.paths.sessionIndex, "utf8");
      const lock = await acquireMutationLock(context, "cleanup-index", [FIXTURE_IDS.ACTIVE_ID]);
      await lock.writeRecoveryPayload({
        schemaVersion: "codex-sessions-recovery.v1",
        operationId: lock.operationId,
        kind: "cleanup-index",
        strategy: "rollforward",
        rootRealPath: context.realPath,
        targetIds: [FIXTURE_IDS.ACTIVE_ID],
        files: [createRecoveryFileTransition("session_index.jsonl", before, `${before}pending\n`)],
      });
      await lock.setStage("committing");
    };
    await preparePending(cliFixture);
    await preparePending(mcpFixture);

    let cliError: unknown;
    try {
      await runCli(["delete", FIXTURE_IDS.ARCHIVED_ID, "--yes", "--root", cliFixture.rootDir, "--json"], createIo().io);
    } catch (error) {
      cliError = error;
    }
    expect(cliError).toMatchObject({ code: "RECOVERY_REQUIRED" });

    const { client, server } = await createAdminClient();
    try {
      const mcp = await client.callTool({
        name: "delete_sessions",
        arguments: {
          root: mcpFixture.rootDir,
          sessionIds: [FIXTURE_IDS.ARCHIVED_ID],
          confirm: true,
        },
      });
      expect(mcp.isError).toBe(true);
      expect(JSON.stringify(mcp.content)).toContain("RECOVERY_REQUIRED");
    } finally {
      await client.close();
      await server.close();
    }
  });
});
