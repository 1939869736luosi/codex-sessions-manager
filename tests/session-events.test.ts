import { createHash } from "node:crypto";
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CANONICAL_SESSION_EVENT_VERSION,
  MAX_CANONICAL_EVENT_PAGE_BYTES,
  readCanonicalSessionEventPage,
  resolveExactSessionEventSource,
  streamCanonicalSessionEvents,
  type CanonicalSessionEvent,
  type ResolvedSessionEventSource,
} from "../src/core/session-events.js";
import { runCli } from "../src/cli/run.js";
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

async function collectEvents(options: ResolvedSessionEventSource): Promise<CanonicalSessionEvent[]> {
  const events: CanonicalSessionEvent[] = [];
  for await (const event of streamCanonicalSessionEvents(options)) {
    events.push(event);
  }
  return events;
}

async function activeSource(fixture: Fixture): Promise<ResolvedSessionEventSource> {
  return resolveExactSessionEventSource(fixture.rootDir, FIXTURE_IDS.ACTIVE_ID);
}

describe("canonical Codex session events", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("preserves full large tool calls and outputs with call ids and source evidence", async () => {
    const argumentsText = JSON.stringify({ prompt: "a".repeat(128_000) });
    const outputText = "tool-output-".repeat(20_000);
    const rows = [
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-11T01:02:03.000Z",
        payload: {
          type: "function_call",
          call_id: "call-123",
          name: "exec_command",
          arguments: argumentsText,
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-11T01:02:04.000Z",
        payload: {
          type: "function_call_output",
          call_id: "call-123",
          output: outputText,
        },
      }),
    ];
    await writeFile(fixture.paths.activeSessionFile, `${rows.join("\n")}\n`, "utf8");

    const source = await activeSource(fixture);
    const events = await collectEvents(source);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      schemaVersion: CANONICAL_SESSION_EVENT_VERSION,
      eventType: "tool_call",
      sessionId: FIXTURE_IDS.ACTIVE_ID,
      timestamp: "2026-07-11T01:02:03.000Z",
      recordType: "response_item",
      payloadType: "function_call",
      callId: "call-123",
      name: "exec_command",
      arguments: argumentsText,
      source: {
        path: source.sourcePath,
        lineNumber: 1,
        recordOrdinal: 1,
        rawLineSha256: createHash("sha256").update(rows[0]).digest("hex"),
      },
    });
    expect(events[1]).toMatchObject({
      eventType: "tool_output",
      callId: "call-123",
      output: outputText,
      source: {
        lineNumber: 2,
        recordOrdinal: 2,
        rawLineSha256: createHash("sha256").update(rows[1]).digest("hex"),
      },
    });
    expect((events[0] as { arguments: string }).arguments).toHaveLength(argumentsText.length);
    expect((events[1] as { output: string }).output).toHaveLength(outputText.length);
  });

  it("exports user and assistant content but excludes internal reasoning by default", async () => {
    const rows = [
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-11T01:00:00.000Z",
        payload: { type: "user_message", message: "visible user content" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-07-11T01:00:01.000Z",
        payload: { type: "agent_reasoning", message: "private chain of thought" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-11T01:00:02.000Z",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "private summary" }],
          encrypted_content: "secret-ciphertext",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-11T01:00:03.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "visible assistant content" }],
        },
      }),
    ];
    await writeFile(fixture.paths.activeSessionFile, `${rows.join("\n")}\n`, "utf8");

    const events = await collectEvents(await activeSource(fixture));
    const serialized = JSON.stringify(events);

    expect(events.map((event) => event.eventType)).toEqual(["message", "message"]);
    expect(events[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "visible user content" }],
      source: { lineNumber: 1, recordOrdinal: 1 },
    });
    expect(events[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "output_text", text: "visible assistant content" }],
      source: { lineNumber: 4, recordOrdinal: 4 },
    });
    expect(serialized).not.toContain("private chain of thought");
    expect(serialized).not.toContain("private summary");
    expect(serialized).not.toContain("secret-ciphertext");
  });

  it("normalizes canonical ItemCompleted user and assistant messages", async () => {
    const rows = [
      JSON.stringify({
        type: "event_msg",
        payload: { type: "item_completed", completed_at_ms: 1782864001000, item: { type: "UserMessage", content: [{ type: "text", text: "paginated user" }] } },
      }),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "item_completed", completed_at_ms: 1782864002000, item: { type: "AgentMessage", content: [{ type: "Text", text: "paginated assistant" }] } },
      }),
    ];
    await writeFile(fixture.paths.activeSessionFile, `${rows.join("\n")}\n`, "utf8");

    const events = await collectEvents(await activeSource(fixture));

    expect(events).toMatchObject([
      { eventType: "message", role: "user", content: [{ type: "text", text: "paginated user" }] },
      { eventType: "message", role: "assistant", content: [{ type: "Text", text: "paginated assistant" }] },
    ]);
  });

  it("emits an explicit parse_error event without copying the invalid raw line", async () => {
    const invalidLine = '{"token":"must-not-be-copied",broken';
    await writeFile(fixture.paths.activeSessionFile, `${invalidLine}\n`, "utf8");

    const events = await collectEvents(await activeSource(fixture));

    expect(events).toEqual([
      expect.objectContaining({
        schemaVersion: CANONICAL_SESSION_EVENT_VERSION,
        eventType: "parse_error",
        sessionId: FIXTURE_IDS.ACTIVE_ID,
        timestamp: null,
        recordType: null,
        payloadType: null,
        error: {
          code: "invalid_json",
          message: "Line is not valid JSON.",
        },
        source: expect.objectContaining({
          lineNumber: 1,
          recordOrdinal: 1,
          rawLineSha256: createHash("sha256").update(invalidLine).digest("hex"),
        }),
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain("must-not-be-copied");
  });

  it("paginates with an opaque cursor without duplicating events", async () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: `2026-07-11T01:00:0${index}.000Z`,
        payload: { type: "user_message", message: `message-${index + 1}` },
      }),
    );
    await writeFile(fixture.paths.activeSessionFile, `${rows.join("\n")}\n`, "utf8");
    const base = {
      ...(await activeSource(fixture)),
      limit: 2,
    };

    const first = await readCanonicalSessionEventPage(base);
    const second = await readCanonicalSessionEventPage({ ...base, cursor: first.nextCursor ?? undefined });
    const third = await readCanonicalSessionEventPage({ ...base, cursor: second.nextCursor ?? undefined });

    expect(first.events.map((event) => event.source.lineNumber)).toEqual([1, 2]);
    expect(second.events.map((event) => event.source.lineNumber)).toEqual([3, 4]);
    expect(third.events.map((event) => event.source.lineNumber)).toEqual([5]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.nextCursor).toEqual(expect.any(String));
    expect(third.nextCursor).toBeNull();
    expect(first.done).toBe(false);
    expect(third.done).toBe(true);
  });

  it("keeps MCP pages byte-bounded and reports oversized events without truncating them", async () => {
    const rows = [
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call_output", call_id: "large", output: "x".repeat(400_000) },
      }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "small-visible-event" } }),
    ];
    await writeFile(fixture.paths.activeSessionFile, `${rows.join("\n")}\n`, "utf8");

    const page = await readCanonicalSessionEventPage({ ...(await activeSource(fixture)), limit: 100 });

    expect(page.events).toHaveLength(1);
    expect(page.events[0]).toMatchObject({ eventType: "message", content: [{ text: "small-visible-event" }] });
    expect(page.omittedOversizedEventCount).toBe(1);
    expect(page.completeness).toBe("truncated_limit");
    expect(page.omittedReason).toContain("CLI");
    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(MAX_CANONICAL_EVENT_PAGE_BYTES + 16 * 1024);
  });

  it("rejects stale, mismatched, malformed, and oversized pagination cursors", async () => {
    const rows = [
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "one" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "two" } }),
    ];
    await writeFile(fixture.paths.activeSessionFile, `${rows.join("\n")}\n`, "utf8");
    const base = {
      ...(await activeSource(fixture)),
      limit: 1,
    };
    const first = await readCanonicalSessionEventPage(base);
    expect(first.nextCursor).toEqual(expect.any(String));

    await expect(
      readCanonicalSessionEventPage({ ...base, cursor: "not-a-cursor" }),
    ).rejects.toThrow("Invalid canonical event cursor");
    await expect(
      readCanonicalSessionEventPage({
        ...base,
        sessionId: FIXTURE_IDS.ARCHIVED_ID,
        cursor: first.nextCursor ?? undefined,
      }),
    ).rejects.toThrow("does not match");
    await expect(readCanonicalSessionEventPage({ ...base, limit: 101 })).rejects.toThrow("1 to 100");

    await appendFile(
      fixture.paths.activeSessionFile,
      `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "three" } })}\n`,
      "utf8",
    );
    await expect(
      readCanonicalSessionEventPage({ ...base, cursor: first.nextCursor ?? undefined }),
    ).rejects.toThrow(/source .*changed|content version changed/i);
  });

  it("normalizes custom tools, string message content, blank lines, and safe generic records", async () => {
    const rows = [
      "",
      JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: "plain assistant text" },
      }),
      "   ",
      JSON.stringify({
        type: "response_item",
        payload: { type: "custom_tool_call", id: "custom-1", name: "shell", input: { command: "pwd" } },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "custom_tool_call_output", id: "custom-1", result: { text: "full result" } },
      }),
      JSON.stringify({
        type: "session_meta",
        payload: {
          id: FIXTURE_IDS.ACTIVE_ID,
          nested: { reasoning: "remove-me", encrypted_content: "remove-cipher", keep: "keep-me" },
          parts: [
            { type: "reasoning", text: "remove-part" },
            { type: "metadata", text: "keep-part" },
          ],
        },
      }),
    ];
    await writeFile(fixture.paths.activeSessionFile, rows.join("\n"), "utf8");

    const events = await collectEvents(await activeSource(fixture));
    const serialized = JSON.stringify(events);

    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      eventType: "message",
      role: "assistant",
      content: [{ type: "text", text: "plain assistant text" }],
      source: { lineNumber: 2, recordOrdinal: 1 },
    });
    expect(events[1]).toMatchObject({
      eventType: "tool_call",
      callId: "custom-1",
      name: "shell",
      arguments: { command: "pwd" },
      source: { lineNumber: 4, recordOrdinal: 2 },
    });
    expect(events[2]).toMatchObject({
      eventType: "tool_output",
      callId: "custom-1",
      output: { text: "full result" },
    });
    expect(events[3]).toMatchObject({
      eventType: "record",
      recordType: "session_meta",
    });
    expect(serialized).not.toContain("remove-me");
    expect(serialized).not.toContain("remove-cipher");
    expect(serialized).not.toContain("remove-part");
  });

  it("does not expose payload data from unknown record or payload types", async () => {
    const privateText = "PRIVATE-UNKNOWN-PAYLOAD";
    await writeFile(
      fixture.paths.activeSessionFile,
      `${JSON.stringify({
        type: "mystery_record",
        timestamp: "2026-07-11T03:00:00.000Z",
        payload: { type: "mystery_payload", kind: "analysis", text: privateText },
      })}\n`,
      "utf8",
    );

    const events = await collectEvents(await activeSource(fixture));

    expect(events).toEqual([
      expect.objectContaining({
        eventType: "record",
        recordType: "mystery_record",
        payloadType: "mystery_payload",
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(privateText);
    expect(events[0]).not.toHaveProperty("payload");
  });

  it("maps real Codex search tool records and preserves their ids and payloads", async () => {
    const toolArguments = { query: "find docs", reasoning: "legitimate tool argument" };
    const toolOutput = [{ name: "docs", encrypted_content: "legitimate tool result field" }];
    const webAction = { type: "search", query: "official docs", reasoning: "legitimate web action field" };
    const rows = [
      JSON.stringify({
        type: "response_item",
        payload: { type: "web_search_call", id: "web-1", status: "completed", action: webAction },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "tool_search_call",
          call_id: "tool-search-1",
          status: "completed",
          execution: "server",
          arguments: toolArguments,
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "tool_search_output",
          call_id: "tool-search-1",
          status: "completed",
          execution: "server",
          tools: toolOutput,
        },
      }),
    ];
    await writeFile(fixture.paths.activeSessionFile, `${rows.join("\n")}\n`, "utf8");

    const events = await collectEvents(await activeSource(fixture));

    expect(events).toEqual([
      expect.objectContaining({
        eventType: "tool_call",
        payloadType: "web_search_call",
        callId: "web-1",
        name: "web_search",
        arguments: webAction,
      }),
      expect.objectContaining({
        eventType: "tool_call",
        payloadType: "tool_search_call",
        callId: "tool-search-1",
        name: "tool_search",
        arguments: toolArguments,
      }),
      expect.objectContaining({
        eventType: "tool_output",
        payloadType: "tool_search_output",
        callId: "tool-search-1",
        output: toolOutput,
      }),
    ]);
  });

  it("advances past trailing whitespace instead of returning the same cursor forever", async () => {
    const row = JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "one" } });
    await writeFile(fixture.paths.activeSessionFile, `${row}\n   \n\t\n`, "utf8");
    const base = {
      ...(await activeSource(fixture)),
      limit: 1,
    };

    const first = await readCanonicalSessionEventPage(base);
    const second = await readCanonicalSessionEventPage({ ...base, cursor: first.nextCursor ?? undefined });

    expect(first.done).toBe(false);
    expect(second.events).toEqual([]);
    expect(second.done).toBe(true);
    expect(second.nextCursor).toBeNull();
  });

  it("finishes a whitespace-only rollout without issuing a cursor", async () => {
    await writeFile(fixture.paths.activeSessionFile, " \n\t\r\n   ", "utf8");
    const page = await readCanonicalSessionEventPage({ ...(await activeSource(fixture)), limit: 1 });

    expect(page.events).toEqual([]);
    expect(page.done).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  it("does not copy unknown message content-part payloads", async () => {
    const privateText = "PRIVATE-UNKNOWN-CONTENT-PART";
    await writeFile(
      fixture.paths.activeSessionFile,
      `${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "future_private_part", text: privateText, secret: { nested: privateText } }],
        },
      })}\n`,
      "utf8",
    );

    const events = await collectEvents(await activeSource(fixture));
    expect(events).toEqual([
      expect.objectContaining({
        eventType: "message",
        content: [{ type: "future_private_part" }],
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(privateText);
  });

  it("rejects a cursor whose authenticated position metadata was modified", async () => {
    const rows = [
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "one" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "two" } }),
    ];
    await writeFile(fixture.paths.activeSessionFile, `${rows.join("\n")}\n`, "utf8");
    const base = {
      ...(await activeSource(fixture)),
      limit: 1,
    };
    const first = await readCanonicalSessionEventPage(base);
    const cursor = first.nextCursor as string;
    const [encodedPayload, originalMac] = cursor.split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(payload).toMatchObject({
      version: "codex-session-event-cursor.v2",
      rootBindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      fileBindingSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      contentVersion: expect.stringMatching(/^[a-f0-9]{64}$/),
      boundarySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      fileIdentity: expect.objectContaining({
        dev: expect.any(String),
        ino: expect.any(String),
        size: expect.any(String),
        mtimeNs: expect.any(String),
        ctimeNs: expect.any(String),
      }),
    });
    expect(JSON.stringify(payload)).not.toContain((await activeSource(fixture)).rootRealpath);
    expect(JSON.stringify(payload)).not.toContain((await activeSource(fixture)).fileRealpath);
    payload.nextLineNumber = 999;
    const forgedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const forgedCursor = originalMac ? `${forgedPayload}.${originalMac}` : forgedPayload;

    await expect(readCanonicalSessionEventPage({ ...base, cursor: forgedCursor })).rejects.toThrow();
  });

  it("binds cursors to the selected root and file identity", async () => {
    const otherFixture = await createFixture();
    const rows = [
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "one" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "two" } }),
    ];
    const text = `${rows.join("\n")}\n`;
    await writeFile(fixture.paths.activeSessionFile, text, "utf8");
    await writeFile(otherFixture.paths.activeSessionFile, text, "utf8");
    const fixedTime = new Date("2026-07-11T04:00:00.000Z");
    await utimes(fixture.paths.activeSessionFile, fixedTime, fixedTime);
    await utimes(otherFixture.paths.activeSessionFile, fixedTime, fixedTime);

    try {
      const firstSource = await activeSource(fixture);
      const first = await readCanonicalSessionEventPage({ ...firstSource, limit: 1 });
      const otherSource = await activeSource(otherFixture);
      await expect(
        readCanonicalSessionEventPage({ ...otherSource, limit: 1, cursor: first.nextCursor ?? undefined }),
      ).rejects.toThrow(/does not match.*root/i);
    } finally {
      await otherFixture.cleanup();
    }
  });

  it("rejects same-size replacement files even when mtime is restored", async () => {
    const rows = [
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "one" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "two" } }),
    ];
    const text = `${rows.join("\n")}\n`;
    await writeFile(fixture.paths.activeSessionFile, text, "utf8");
    const source = await activeSource(fixture);
    const first = await readCanonicalSessionEventPage({ ...source, limit: 1 });
    const before = await stat(fixture.paths.activeSessionFile);
    const replacement = `${fixture.paths.activeSessionFile}.replacement`;
    await writeFile(replacement, text.replace("one", "ONE"), "utf8");
    await rename(replacement, fixture.paths.activeSessionFile);
    await utimes(fixture.paths.activeSessionFile, before.atime, before.mtime);

    await expect(
      readCanonicalSessionEventPage({ ...source, limit: 1, cursor: first.nextCursor ?? undefined }),
    ).rejects.toThrow(/identity|content version/i);
  });

  it("checks the same open file descriptor again after streaming", async () => {
    const rows = [
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "one" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "two" } }),
    ];
    await writeFile(fixture.paths.activeSessionFile, `${rows.join("\n")}\n`, "utf8");
    const source = await activeSource(fixture);
    const iterator = streamCanonicalSessionEvents(source)[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await appendFile(
      fixture.paths.activeSessionFile,
      `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "three" } })}\n`,
      "utf8",
    );
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await expect(iterator.next()).rejects.toThrow(/content changed while.*read|identity.*changed/i);
  });

  it("defines byte ranges and hashes consistently for CRLF and LF", async () => {
    const firstRow = JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "crlf" } });
    const secondRow = JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "lf" } });
    await writeFile(fixture.paths.activeSessionFile, `${firstRow}\r\n${secondRow}\n`, "utf8");

    const events = await collectEvents(await activeSource(fixture));
    expect(events[0].source).toMatchObject({
      byteStart: 0,
      byteEnd: Buffer.byteLength(firstRow) + 2,
      lineTerminator: "crlf",
      rawLineSha256: createHash("sha256").update(firstRow).digest("hex"),
    });
    expect(events[1].source).toMatchObject({
      byteStart: Buffer.byteLength(firstRow) + 2,
      byteEnd: Buffer.byteLength(firstRow) + 2 + Buffer.byteLength(secondRow) + 1,
      lineTerminator: "lf",
      rawLineSha256: createHash("sha256").update(secondRow).digest("hex"),
    });
  });

  it("uses the narrow rollout path without reading history or global state", async () => {
    await rm(fixture.paths.history, { force: true });
    await mkdir(fixture.paths.history);
    await rm(fixture.paths.globalState, { force: true });
    await mkdir(fixture.paths.globalState);
    const capture = createIo();

    await expect(
      runCli(["events", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir], capture.io),
    ).resolves.toBe(0);
    expect(capture.stdout).toHaveLength(1);
  });

  it("rejects a rollout symlink that resolves outside the selected Codex root", async () => {
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "codex-events-outside-"));
    const outsideFile = path.join(outsideDir, "outside.jsonl");
    const symlinkId = "019d7777-8888-7999-8aaa-bbbbbbbbbbbb";
    const linkPath = path.join(
      path.dirname(fixture.paths.activeSessionFile),
      `rollout-2026-07-11T00-00-00-${symlinkId}.jsonl`,
    );
    await writeFile(
      outsideFile,
      `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "outside-private" } })}\n`,
      "utf8",
    );
    await symlink(outsideFile, linkPath);

    try {
      await expect(runCli(["events", symlinkId, "--root", fixture.rootDir], createIo().io)).rejects.toThrow(/symbolic link|symlink/i);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("rejects rollout files with multiple hard links", async () => {
    const secondLink = path.join(fixture.rootDir, "second-hard-link.jsonl");
    await link(fixture.paths.activeSessionFile, secondLink);

    await expect(activeSource(fixture)).rejects.toThrow(/hard link|multiple hard links/i);
  });

  it("streams CLI events to stdout or an output JSONL file without changing the source", async () => {
    const sourceBefore = await readFile(fixture.paths.activeSessionFile, "utf8");
    const stdoutCapture = createIo();

    const stdoutExit = await runCli(
      ["events", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir],
      stdoutCapture.io,
    );

    expect(stdoutExit).toBe(0);
    expect(stdoutCapture.stderr).toEqual([]);
    expect(stdoutCapture.stdout).toHaveLength(1);
    expect(JSON.parse(stdoutCapture.stdout[0])).toMatchObject({
      schemaVersion: CANONICAL_SESSION_EVENT_VERSION,
      eventType: "message",
      sessionId: FIXTURE_IDS.ACTIVE_ID,
    });

    const outputPath = `${fixture.rootDir}/events-output.jsonl`;
    const fileCapture = createIo();
    const fileExit = await runCli(
      ["events", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--output", outputPath],
      fileCapture.io,
    );

    expect(fileExit).toBe(0);
    expect(fileCapture.stdout.join("\n")).toContain("canonical event");
    expect((await readFile(outputPath, "utf8")).trim().split("\n")).toHaveLength(1);
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toBe(sourceBefore);
  });

  it("requires an exact CLI session id and refuses to overwrite an event file", async () => {
    await expect(
      runCli(["events", FIXTURE_IDS.ACTIVE_ID.slice(0, 12), "--root", fixture.rootDir], createIo().io),
    ).rejects.toThrow("complete exact session id");

    const outputPath = `${fixture.rootDir}/existing-events.jsonl`;
    await writeFile(outputPath, "keep-existing\n", "utf8");
    await expect(
      runCli(
        ["events", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--output", outputPath],
        createIo().io,
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(outputPath, "utf8")).resolves.toBe("keep-existing\n");
  });

  it("documents the stable event command in CLI help", async () => {
    const capture = createIo();
    await expect(runCli(["--help"], capture.io)).resolves.toBe(0);
    expect(capture.stdout.join("\n")).toContain(
      "codex-sessions events <exact-session-id> [--root PATH] [--output FILE]",
    );
    expect(capture.stdout.join("\n")).toContain("默认排除模型内部 reasoning");
  });
});
