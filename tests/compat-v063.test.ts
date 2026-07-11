import { readFile, rm, writeFile } from "node:fs/promises";

import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli/run.js";
import { scanCodexRoot } from "../src/core/scan.js";
import { readSessionTimelineResult } from "../src/core/timeline.js";
import { moveSessionsToTrash, restoreTrashEntry } from "../src/core/trash.js";
import { createServer } from "../src/mcp/server.js";
import { createFixture, FIXTURE_IDS, type Fixture } from "./helpers/fixture.js";

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

async function createConnectedClient() {
  const server = createServer("read-only");
  const client = new Client({ name: "compat-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function sessionMeta(historyMode: "legacy" | "paginated") {
  return {
    type: "session_meta",
    timestamp: "2026-07-10T00:00:00.000Z",
    payload: {
      session_id: FIXTURE_IDS.ACTIVE_ID,
      id: FIXTURE_IDS.ACTIVE_ID,
      timestamp: "2026-07-10T00:00:00.000Z",
      cwd: "/workspace/demo",
      originator: "codex-cli",
      cli_version: "0.144.1",
      history_mode: historyMode,
    },
  };
}

function completedItem(item: Record<string, unknown>, index: number) {
  return {
    type: "event_msg",
    timestamp: `2026-07-10T00:00:${String(index).padStart(2, "0")}.000Z`,
    payload: {
      type: "item_completed",
      thread_id: FIXTURE_IDS.ACTIVE_ID,
      turn_id: "turn-1",
      completed_at_ms: 1_783_641_600_000 + index,
      item,
    },
  };
}

async function writeRollout(fixture: Fixture, rows: Array<Record<string, unknown> | string>) {
  await writeFile(
    fixture.paths.activeSessionFile,
    `${rows.map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n")}\n`,
    "utf8",
  );
}

describe("Codex 0.144.1 compatibility", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("uses paginated ItemCompleted events as the canonical timeline and reports diagnostics", async () => {
    await writeRollout(fixture, [
      sessionMeta("paginated"),
      {
        type: "response_item",
        timestamp: "2026-07-10T00:00:01.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "duplicate raw user item" }],
        },
      },
      completedItem({
        type: "UserMessage",
        id: "item-user",
        content: [{ type: "text", text: "paginated user" }],
      }, 2),
      {
        type: "response_item",
        timestamp: "2026-07-10T00:00:03.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "duplicate raw assistant item" }],
        },
      },
      completedItem({
        type: "AgentMessage",
        id: "item-assistant",
        content: [{ type: "Text", text: "paginated assistant" }],
      }, 4),
      completedItem({
        type: "CommandExecution",
        id: "item-command",
        command: ["git", "status"],
        status: "completed",
        aggregated_output: "working tree clean",
      }, 5),
      completedItem({
        type: "McpToolCall",
        id: "item-mcp-error",
        server: "filesystem",
        tool: "read",
        arguments: { path: "/synthetic" },
        status: "failed",
        error: { message: "denied" },
      }, 6),
      completedItem({ type: "FutureItem", id: "future-item" }, 7),
      "not-json",
    ]);

    const scan = await scanCodexRoot(fixture.rootDir);
    const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID)!;
    const result = await readSessionTimelineResult(session, fixture.rootDir);

    expect(result.historyMode).toBe("paginated");
    expect(result.items.map((item) => item.body)).toEqual([
      "paginated user",
      "paginated assistant",
      "git status\nworking tree clean",
      "filesystem/read\n{\"path\":\"/synthetic\"}\n{\"message\":\"denied\"}",
      "不支持的 timeline item: FutureItem",
      "第 9 行无法解析为 JSON",
    ]);
    expect(result.items.some((item) => item.body.includes("duplicate raw"))).toBe(false);
    expect(result.items[4]).toMatchObject({ unsupported: true, parseError: false, sourceType: "FutureItem" });
    expect(result.items[5]).toMatchObject({ unsupported: false, parseError: true, lineNumber: 9 });
    expect(result).toMatchObject({
      completeness: "parse_error",
      itemsReturned: 6,
      itemsKnown: 6,
      unsupportedItemCount: 1,
      parseErrorCount: 1,
      exactExportAvailable: true,
      omittedReason: "1 parse error; 1 unsupported item",
    });
  });

  it("sorts by recency_at_ms, then recency_at, then updated_at and exposes historyMode", async () => {
    const db = new Database(fixture.paths.sqlite);
    try {
      db.exec(`
        alter table threads add column recency_at_ms integer;
        alter table threads add column recency_at integer;
        alter table threads add column history_mode text;
      `);
      db.prepare("update threads set recency_at_ms = ?, recency_at = ?, history_mode = ? where id = ?")
        .run(1_783_641_600_123, 1_783_641_600, "paginated", FIXTURE_IDS.ACTIVE_ID);
      db.prepare("update threads set recency_at_ms = ?, recency_at = ?, history_mode = ? where id = ?")
        .run(1_783_641_600_122, 1_783_641_600, "legacy", FIXTURE_IDS.ARCHIVED_ID);
    } finally {
      db.close();
    }

    const millisScan = await scanCodexRoot(fixture.rootDir);
    expect(millisScan.sessions[0]).toMatchObject({
      id: FIXTURE_IDS.ACTIVE_ID,
      historyMode: "paginated",
      recencyAtMs: 1_783_641_600_123,
      recencyAt: "2026-07-10T00:00:00.123Z",
    });

    const fallbackDb = new Database(fixture.paths.sqlite);
    try {
      fallbackDb.prepare("update threads set recency_at_ms = null, recency_at = ? where id = ?")
        .run(1_783_641_600, FIXTURE_IDS.ACTIVE_ID);
      fallbackDb.prepare("update threads set recency_at_ms = null, recency_at = ? where id = ?")
        .run(1_783_641_601, FIXTURE_IDS.ARCHIVED_ID);
    } finally {
      fallbackDb.close();
    }

    const secondsScan = await scanCodexRoot(fixture.rootDir);
    expect(secondsScan.sessions[0].id).toBe(FIXTURE_IDS.ARCHIVED_ID);

    const updatedFallbackDb = new Database(fixture.paths.sqlite);
    try {
      updatedFallbackDb.prepare("update threads set recency_at_ms = null, recency_at = null").run();
    } finally {
      updatedFallbackDb.close();
    }

    const updatedScan = await scanCodexRoot(fixture.rootDir);
    expect(updatedScan.sessions[0].id).toBe(FIXTURE_IDS.ACTIVE_ID);
  });

  it("marks compressed-only sessions unread without pretending history preview is the transcript", async () => {
    const compressedPath = `${fixture.paths.activeSessionFile}.zst`;
    await writeFile(compressedPath, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x02]));
    await rm(fixture.paths.activeSessionFile);

    const scan = await scanCodexRoot(fixture.rootDir);
    const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID)!;
    const result = await readSessionTimelineResult(session, fixture.rootDir);

    expect(result).toMatchObject({
      completeness: "compressed_unread",
      itemsKnown: null,
      exactExportAvailable: true,
      omittedReason: "compressed rollout cannot be read as semantic timeline",
    });
    expect(result.items).toEqual([
      expect.objectContaining({ body: "active prompt", source: "history", roleLabel: "历史输入 1" }),
    ]);

    const archivedCompressedPath = `${fixture.paths.archivedSessionFile}.zst`;
    const archivedCompressedBytes = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x10, 0x20, 0x30, 0x40]);
    await writeFile(archivedCompressedPath, archivedCompressedBytes);
    await rm(fixture.paths.archivedSessionFile);

    const archivedScan = await scanCodexRoot(fixture.rootDir);
    const archivedSession = archivedScan.sessions.find((entry) => entry.id === FIXTURE_IDS.ARCHIVED_ID)!;
    const archivedResult = await readSessionTimelineResult(archivedSession, fixture.rootDir);
    expect(archivedSession.fileTargets).toEqual([
      expect.objectContaining({ bucket: "archived_sessions", format: "jsonl.zst", compressed: true }),
    ]);
    expect(archivedResult).toMatchObject({ completeness: "compressed_unread", exactExportAvailable: true });

    const trashed = await moveSessionsToTrash(archivedScan, [archivedSession]);
    await expect(readFile(archivedCompressedPath)).rejects.toMatchObject({ code: "ENOENT" });
    await restoreTrashEntry(fixture.rootDir, trashed.trashEntry.trashId);
    await expect(readFile(archivedCompressedPath)).resolves.toEqual(archivedCompressedBytes);
  });

  it("reports unknown history modes and per-item tool truncation without hiding semantic output", async () => {
    await writeRollout(fixture, [
      {
        ...sessionMeta("legacy"),
        payload: {
          ...sessionMeta("legacy").payload,
          history_mode: "future-mode",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-07-10T00:00:01.000Z",
        payload: {
          type: "function_call_output",
          output: "x".repeat(1_200),
        },
      },
    ]);

    const scan = await scanCodexRoot(fixture.rootDir);
    const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID)!;
    const result = await readSessionTimelineResult(session, fixture.rootDir);

    expect(result).toMatchObject({
      historyMode: "unknown",
      completeness: "unsupported_items",
      unsupportedItemCount: 1,
      parseErrorCount: 0,
      toolOutputTruncatedCount: 1,
      exactExportAvailable: true,
    });
    expect(result.items).toEqual([
      expect.objectContaining({ sourceType: "history_mode", unsupported: true }),
      expect.objectContaining({ roleLabel: "工具输出", truncated: true, unsupported: false }),
    ]);
  });

  it("keeps CLI JSON complete and enforces MCP compact/full item and byte limits", async () => {
    const smallItems = Array.from({ length: 35 }, (_, index) => completedItem({
      type: "UserMessage",
      id: `item-${index}`,
      content: [{ type: "text", text: `message-${index}` }],
    }, index));
    await writeRollout(fixture, [sessionMeta("paginated"), ...smallItems]);

    const cliIo = createIo();
    expect(await runCli([
      "show",
      FIXTURE_IDS.ACTIVE_ID,
      "--root",
      fixture.rootDir,
      "--json",
    ], cliIo.io)).toBe(0);
    const cliResult = JSON.parse(cliIo.stdout.join("\n"));
    expect(cliResult.timeline).toHaveLength(35);
    expect(cliResult).toMatchObject({
      completeness: "complete",
      itemsReturned: 35,
      itemsKnown: 35,
      exactExportAvailable: true,
    });

    const humanIo = createIo();
    expect(await runCli([
      "show",
      FIXTURE_IDS.ACTIVE_ID,
      "--root",
      fixture.rootDir,
    ], humanIo.io)).toBe(0);
    expect(humanIo.stdout.join("\n")).toContain("时间线返回: 20/35");
    expect(humanIo.stdout.join("\n")).toContain("使用 show --json 查看全部可解析项；原始字节使用 export");

    const connected = await createConnectedClient();
    try {
      const compact = await connected.client.callTool({
        name: "get_session",
        arguments: { root: fixture.rootDir, sessionId: FIXTURE_IDS.ACTIVE_ID, detail: "compact" },
      });
      expect(compact.structuredContent).toMatchObject({
        detail: "compact",
        completeness: "truncated_limit",
        itemsReturned: 20,
        itemsKnown: 35,
        omittedReason: "MCP compact item limit (20)",
      });
      expect(Buffer.byteLength(JSON.stringify(compact.structuredContent), "utf8")).toBeLessThanOrEqual(64 * 1024);

      const full = await connected.client.callTool({
        name: "get_session",
        arguments: { root: fixture.rootDir, sessionId: FIXTURE_IDS.ACTIVE_ID, detail: "full" },
      });
      expect(full.structuredContent).toMatchObject({
        detail: "full",
        completeness: "complete",
        itemsReturned: 35,
        itemsKnown: 35,
      });
      expect(Buffer.byteLength(JSON.stringify(full.structuredContent), "utf8")).toBeLessThanOrEqual(256 * 1024);

      const largeItems = Array.from({ length: 10 }, (_, index) => completedItem({
        type: "UserMessage",
        id: `large-${index}`,
        content: [{ type: "text", text: `${index}:${"x".repeat(20_000)}` }],
      }, index));
      await writeRollout(fixture, [sessionMeta("paginated"), ...largeItems]);
      const byteBounded = await connected.client.callTool({
        name: "get_session",
        arguments: { root: fixture.rootDir, sessionId: FIXTURE_IDS.ACTIVE_ID, detail: "compact" },
      });
      expect(byteBounded.structuredContent).toMatchObject({
        detail: "compact",
        completeness: "truncated_limit",
        itemsKnown: 10,
        omittedReason: "MCP compact byte limit (65536)",
      });
      expect(Number(byteBounded.structuredContent?.itemsReturned)).toBeLessThan(10);
      expect(Buffer.byteLength(JSON.stringify(byteBounded.structuredContent), "utf8")).toBeLessThanOrEqual(64 * 1024);

      const overFullLimitItems = Array.from({ length: 205 }, (_, index) => completedItem({
        type: "UserMessage",
        id: `full-limit-${index}`,
        content: [{ type: "text", text: `full-limit-message-${index}` }],
      }, index));
      await writeRollout(fixture, [sessionMeta("paginated"), ...overFullLimitItems]);
      const fullLimited = await connected.client.callTool({
        name: "get_session",
        arguments: { root: fixture.rootDir, sessionId: FIXTURE_IDS.ACTIVE_ID, detail: "full" },
      });
      expect(fullLimited.structuredContent).toMatchObject({
        detail: "full",
        completeness: "truncated_limit",
        itemsReturned: 200,
        itemsKnown: 205,
        omittedReason: "MCP full item limit (200)",
      });
      expect(Buffer.byteLength(JSON.stringify(fullLimited.structuredContent), "utf8")).toBeLessThanOrEqual(256 * 1024);

      const diagnosticLimitedItems = Array.from({ length: 21 }, (_, index) => completedItem({
        type: "UserMessage",
        id: `diagnostic-limit-${index}`,
        content: [{ type: "text", text: `diagnostic-limit-message-${index}` }],
      }, index));
      await writeRollout(fixture, [sessionMeta("paginated"), ...diagnosticLimitedItems, "not-json"]);
      const diagnosticLimited = await connected.client.callTool({
        name: "get_session",
        arguments: { root: fixture.rootDir, sessionId: FIXTURE_IDS.ACTIVE_ID, detail: "compact" },
      });
      expect(diagnosticLimited.structuredContent).toMatchObject({
        completeness: "truncated_limit",
        sourceCompleteness: "parse_error",
        parseErrorCount: 1,
        itemsReturned: 20,
        itemsKnown: 22,
        omittedReason: "MCP compact item limit (20); 1 parse error",
      });
    } finally {
      await Promise.all([connected.client.close(), connected.server.close()]);
    }
  });
});
