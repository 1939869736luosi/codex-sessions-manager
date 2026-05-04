import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
      expect(validation[0].sessionIndexRowsRemaining).toBe(1);
      expect(validation[0].sqlite.threadRows).toBe(1);
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
          sqlite: { threadRows: number; logRows: number };
        }>;
      };
      const scan = await scanCodexRoot(fixture.rootDir);

      expect(deletion).toBeDefined();
      expect(deletion.validation[0].sessionIndexRowsRemaining).toBe(0);
      expect(deletion.validation[0].historyRowsRemaining).toBe(0);
      expect(deletion.validation[0].sqlite.threadRows).toBe(0);
      expect(deletion.validation[0].sqlite.logRows).toBe(0);
      expect(scan.sessions.some((session) => session.id === FIXTURE_IDS.ACTIVE_ID)).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
