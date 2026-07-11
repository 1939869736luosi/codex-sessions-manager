import { readFile } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli/run.js";
import {
  cleanupSessionIndexes,
  cleanupStaleIndexes,
  deleteSessions,
} from "../src/core/delete.js";
import { acquireMutationLock } from "../src/core/mutation-safety.js";
import { createTrustedRootContext } from "../src/core/path-safety.js";
import { recoverInterruptedOperation } from "../src/core/recovery.js";
import { resolveSessions } from "../src/core/query.js";
import { scanCodexRoot } from "../src/core/scan.js";
import {
  moveSessionsToTrash,
  purgeTrashEntry,
  restoreTrashEntry,
} from "../src/core/trash.js";
import { createServer } from "../src/mcp/server.js";
import { createFixture, FIXTURE_IDS, type Fixture } from "./helpers/fixture.js";

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;

function emulateWindows(): void {
  Object.defineProperty(process, "platform", { ...originalPlatformDescriptor, value: "win32" });
}

function restorePlatform(): void {
  Object.defineProperty(process, "platform", originalPlatformDescriptor);
}

function createIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message),
    },
  };
}

describe("Windows 0.6.1 destructive policy", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    restorePlatform();
    fixture = await createFixture();
  });

  afterEach(async () => {
    restorePlatform();
    await fixture.cleanup();
  });

  it("fails closed in every core mutation entrypoint while preserving files", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const archived = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID]);
    const trashed = await moveSessionsToTrash(scan, archived);
    const trashId = trashed.trashEntry.trashId;
    const sessionIndexBeforeBlockedCalls = await readFile(fixture.paths.sessionIndex, "utf8");
    const context = await createTrustedRootContext(fixture.rootDir);
    const recoveryLock = await acquireMutationLock(context, "cleanup-index", [FIXTURE_IDS.STALE_ID]);
    await recoveryLock.setStage("prepared");

    emulateWindows();

    const calls = [
      () => deleteSessions(scan, archived),
      () => moveSessionsToTrash(scan, archived),
      () => cleanupSessionIndexes(scan, archived),
      () => cleanupStaleIndexes(scan),
      () => restoreTrashEntry(fixture.rootDir, trashId),
      () => purgeTrashEntry(fixture.rootDir, trashId),
      () => recoverInterruptedOperation(fixture.rootDir),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toThrow(/UNSAFE_PATH.*Windows.*read-only/iu);
    }

    await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toBe(sessionIndexBeforeBlockedCalls);
  });

  it("keeps CLI read-only commands available and refuses confirmed mutation", async () => {
    emulateWindows();
    const listCapture = createIo();

    await expect(runCli(["list", "--root", fixture.rootDir, "--json"], listCapture.io)).resolves.toBe(0);
    await expect(
      runCli([
        "delete",
        FIXTURE_IDS.ARCHIVED_ID,
        "--root",
        fixture.rootDir,
        "--yes",
        "--json",
      ], createIo().io),
    ).rejects.toThrow(/UNSAFE_PATH.*Windows.*read-only/iu);
  });

  it("registers only read-only MCP tools even when the requested profile is admin", async () => {
    emulateWindows();
    const server = createServer("admin");
    const client = new Client({ name: "windows-policy-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      expect(names).toContain("list_sessions");
      expect(names).toContain("get_recovery_status");
      expect(names).not.toContain("delete_sessions");
      expect(names).not.toContain("restore_sessions");
      expect(names).not.toContain("purge_trash");
      expect(names).not.toContain("cleanup_session_indexes");
      expect(names).not.toContain("cleanup_stale_indexes");
      expect(names).not.toContain("recover_operation");

      const listed = await client.callTool({
        name: "list_sessions",
        arguments: { root: fixture.rootDir },
      });
      expect(listed.isError).not.toBe(true);
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
