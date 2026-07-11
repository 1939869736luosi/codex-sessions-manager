import os from "node:os";
import path from "node:path";
import {
  mkdir,
  mkdtemp,
  link,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { exportSessionBackup } from "../src/core/backup.js";
import { inspectCodexRoot } from "../src/core/doctor.js";
import { scanCodexRoot } from "../src/core/scan.js";
import { scanShellSnapshots } from "../src/core/shell-snapshots.js";
import { readSessionTimeline } from "../src/core/timeline.js";
import {
  createFixture,
  FIXTURE_IDS,
  writeExactGlobalStateFixture,
} from "./helpers/fixture.js";
import { createDirectoryLink } from "./helpers/fs-links.js";

const cleanupPaths: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("low-coverage core branches", () => {
  it("parses all legacy timeline item variants, skips malformed content, truncates tools, and deduplicates neighbors", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID)!;
    const longArgument = "a".repeat(950);
    const longOutput = "o".repeat(950);
    const rows = [
      "not json",
      JSON.stringify({ type: "event_msg", timestamp: 42, payload: { type: "user_message", message: "dupe   body" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "dupe body" } }),
      JSON.stringify({ type: "event_msg", timestamp: "2026-01-01T00:00:00Z", payload: { type: "agent_message", message: "agent event" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "ignored", message: "ignored event" } }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-01-01T00:00:01Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "input" },
            { type: "output_text", text: "output" },
            { type: "text", text: "plain" },
            { type: "image", text: "ignored image" },
            { type: "text" },
          ],
        },
      }),
      JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: "invalid" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", name: " ", arguments: "" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", name: "short", arguments: "{}" } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call", name: "exec", arguments: longArgument } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "short output" } }),
      JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", output: longOutput } }),
      JSON.stringify({ type: "unknown" }),
    ];
    await writeFile(fixture.paths.activeSessionFile, `${rows.join("\n")}\n`, "utf8");

    const timeline = await readSessionTimeline(session, fixture.rootDir);

    expect(timeline.map((item) => item.body)).toEqual([
      "dupe   body",
      "agent event",
      "input\n\noutput\n\nplain",
      "工具调用",
      "short\n{}",
      `exec\n${"a".repeat(900)}...`,
      "short output",
      `${"o".repeat(900)}...`,
    ]);
    expect(timeline[0]).toMatchObject({ kind: "user", timestamp: null });
    expect(timeline[1]).toMatchObject({ kind: "assistant", roleLabel: "助手" });
    expect(timeline.at(-1)).toMatchObject({ kind: "system", roleLabel: "工具输出" });
  });

  it("falls back to history when a readable rollout has no semantic timeline items", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID)!;
    await writeFile(
      fixture.paths.activeSessionFile,
      `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "system", content: [] } })}\ninvalid\n`,
      "utf8",
    );

    await expect(readSessionTimeline(session, fixture.rootDir)).resolves.toEqual([
      expect.objectContaining({ roleLabel: "历史输入 1", body: "active prompt", timestamp: null }),
    ]);
    await expect(readSessionTimeline({ ...session, fileTargets: [] }, fixture.rootDir)).resolves.toEqual([
      expect.objectContaining({ roleLabel: "历史输入 1", body: "active prompt", timestamp: null }),
    ]);
  });

  it("reports an empty Codex root without turning missing optional surfaces into a crash", async () => {
    const root = await makeTempRoot("csm-doctor-empty-");

    const report = await inspectCodexRoot(root);

    expect(report.scan.sessionCount).toBeNull();
    expect(report.paths.trashDir.entryCount).toBe(0);
    expect(report.paths.globalState.parseable).toBeNull();
    expect(report.sqlite.activeStatePath).toBeNull();
    expect(report.sqlite.stateTables).toEqual(expect.arrayContaining([expect.objectContaining({ exists: false })]));
    expect(report.warnings).toEqual(expect.arrayContaining([
      "sessions/ 缺失或不可读。",
      "session_index.jsonl 缺失或不可读。",
      "history.jsonl 缺失或不可读。",
    ]));

    await mkdir(path.join(root, ".codex-sessions-trash"));
    await writeFile(path.join(root, ".codex-sessions-trash", ".operation.lock"), "not json\n", "utf8");
    const interruptedReport = await inspectCodexRoot(root);
    expect(interruptedReport.recovery).toMatchObject({
      pending: true,
      operationId: null,
      kind: "invalid",
      stage: "recovery_required",
    });
    expect(interruptedReport.warnings.join("\n")).toContain("RECOVERY_REQUIRED");
    expect(interruptedReport.warnings.join("\n")).toContain("mutation lock is invalid JSON");
  });

  it("reports exact-key and unknown global-state references without exposing their values", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    await writeExactGlobalStateFixture(fixture.paths.globalState);

    const report = await inspectCodexRoot(fixture.rootDir);

    expect(report.globalState.exactKeyRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: FIXTURE_IDS.EXACT_GLOBAL_STATE_ID,
        ruleId: expect.any(String),
        valueShape: expect.any(String),
        byteEstimate: expect.any(Number),
      }),
    ]));
    expect(report.globalState.warnings.join("\n")).toContain("exact-key");
    expect(report.globalState.warnings.join("\n")).toContain("未知位置");
    expect(JSON.stringify(report.globalState.exactKeyRefs)).not.toContain("secret prompt text must not be printed");
  });

  it("counts only safe visible trash directories and reports unsafe entries", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const outside = await makeTempRoot("csm-doctor-trash-outside-");
    const trashRoot = path.join(fixture.rootDir, ".codex-sessions-trash");
    await mkdir(path.join(trashRoot, "valid-entry"), { recursive: true });
    await mkdir(path.join(trashRoot, ".operations"), { recursive: true });
    await createDirectoryLink(outside, path.join(trashRoot, "unsafe-entry"));

    const report = await inspectCodexRoot(fixture.rootDir);

    expect(report.paths.trashDir.entryCount).toBe(1);
    expect(report.warnings.join("\n")).toMatch(/UNSAFE_PATH|symbolic link|junction/iu);
  });

  it("reports unreadable SQLite candidates while retaining a usable doctor report", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    await writeFile(fixture.paths.sqlite, "not a sqlite database", "utf8");
    await writeFile(fixture.paths.logsSqlite!, "not a sqlite database", "utf8");
    await writeFile(fixture.paths.goalsSqlite!, "not a sqlite database", "utf8");
    const memoriesPath = path.join(fixture.rootDir, "memories_1.sqlite");
    await writeFile(memoriesPath, "not a sqlite database", "utf8");

    const report = await inspectCodexRoot(fixture.rootDir);

    expect(report.sqlite.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("state SQLite 无法读取"),
      expect.stringContaining("logs SQLite 无法读取"),
      expect.stringContaining("goals SQLite 无法读取"),
      expect.stringContaining("memories SQLite 无法读取"),
    ]));
    expect(report.sqlite.stateTables).toEqual(expect.arrayContaining([expect.objectContaining({ exists: false })]));
  });

  it("scans shell snapshots while ignoring directories and malformed names", async () => {
    const root = await makeTempRoot("csm-shell-snapshots-");
    const directory = path.join(root, "shell_snapshots");
    await mkdir(directory);
    await mkdir(path.join(directory, `${FIXTURE_IDS.ACTIVE_ID}.directory.sh`));
    await writeFile(path.join(directory, "not-a-session.sh"), "ignored\n", "utf8");
    await writeFile(path.join(directory, `${FIXTURE_IDS.ACTIVE_ID}.one.sh`), "one\n", "utf8");
    await writeFile(path.join(directory, `${FIXTURE_IDS.ACTIVE_ID}.two.sh`), "two\n", "utf8");

    const snapshots = await scanShellSnapshots(directory, root);

    expect(snapshots.get(FIXTURE_IDS.ACTIVE_ID)).toHaveLength(2);
    expect(snapshots.get(FIXTURE_IDS.ACTIVE_ID)?.map((entry) => entry.size).sort()).toEqual([4, 4]);
    await expect(scanShellSnapshots(null, root)).resolves.toEqual(new Map());
    await expect(scanShellSnapshots(path.join(root, "missing"), root)).resolves.toEqual(new Map());
  });

  it("skips a hard-linked snapshot and returns a path-safety warning", async () => {
    const root = await makeTempRoot("csm-shell-hardlink-");
    const outside = await makeTempRoot("csm-shell-outside-");
    const directory = path.join(root, "shell_snapshots");
    const outsideFile = path.join(outside, "outside.sh");
    await mkdir(directory);
    await writeFile(outsideFile, "secret\n", "utf8");
    await link(outsideFile, path.join(directory, `${FIXTURE_IDS.ACTIVE_ID}.linked.sh`));
    const warnings: string[] = [];

    const snapshots = await scanShellSnapshots(directory, root, undefined, warnings);

    expect(snapshots.size).toBe(0);
    expect(warnings.join("\n")).toMatch(/UNSAFE_PATH|hard link/iu);
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("secret\n");
  });

  it("exports compressed rollout bytes as base64 and supports sessions without shell snapshots", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const compressedPath = `${fixture.paths.activeSessionFile}.zst`;
    const compressedBytes = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x01, 0x02, 0x03]);
    await writeFile(compressedPath, compressedBytes);
    await rm(fixture.paths.activeShellSnapshot);
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID)!;

    const backup = await exportSessionBackup(scan, session);
    const unregisteredScan = { ...scan, root: { ...scan.root } };
    const backupWithoutRegisteredContexts = await exportSessionBackup(unregisteredScan, session);

    expect(backup.sessionFiles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: path.relative(fixture.rootDir, compressedPath),
        text: compressedBytes.toString("base64"),
        encoding: "base64",
      }),
      expect.objectContaining({ encoding: "utf8" }),
    ]));
    expect(backup.shellSnapshots).toEqual([]);
    expect(backupWithoutRegisteredContexts.sessionFiles).toEqual(backup.sessionFiles);
  });
});
