import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { getHelpText, runCli } from "../src/cli/run.js";
import { createFixture, FIXTURE_IDS, writeExactGlobalStateFixture, type Fixture } from "./helpers/fixture.js";

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

describe("cli", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("lists sessions in human-readable mode", async () => {
    const capture = createIo();
    const exitCode = await runCli(["list", "--root", fixture.rootDir], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("\n")).toContain("状态");
    expect(capture.stdout.join("\n")).toContain("来源");
    expect(capture.stdout.join("\n")).toContain("provider");
    expect(capture.stdout.join("\n")).toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(capture.stdout.join("\n")).toContain("Active thread");
    expect(capture.stdout.join("\n")).toContain("cli");
    expect(capture.stdout.join("\n")).toContain("openai");
    expect(capture.stdout.join("\n")).not.toContain(`Title ${FIXTURE_IDS.ACTIVE_ID}`);
  });

  it("shows title source details in show output", async () => {
    const capture = createIo();
    const exitCode = await runCli(["show", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir], capture.io);
    const output = capture.stdout.join("\n");

    expect(exitCode).toBe(0);
    expect(output).toContain("标题: Active thread");
    expect(output).toContain("来源分类: cli");
    expect(output).toContain("raw source: cli");
    expect(output).toContain("thread_source: cli");
    expect(output).toContain("model_provider: openai");
    expect(output).toContain("标题来源: session_index");
    expect(output).toContain("标题不一致: 是");
    expect(output).toContain(`session_index 标题: Active thread`);
    expect(output).toContain(`SQLite 标题: Title ${FIXTURE_IDS.ACTIVE_ID}`);
    expect(output).toContain("第一条用户请求: active input");
  });

  it("shows session family relationships in human-readable mode", async () => {
    const db = new Database(fixture.paths.sqlite);
    db.prepare("update threads set source = ?, thread_source = ?, agent_role = ?, agent_nickname = ? where id = ?").run(
      JSON.stringify({
        subagent: {
          thread_spawn: {
            parent_thread_id: FIXTURE_IDS.ACTIVE_ID,
            depth: 1,
            agent_nickname: "helper",
            agent_role: "explorer",
          },
        },
      }),
      "subagent",
      "explorer",
      "helper",
      FIXTURE_IDS.ARCHIVED_ID,
    );
    db.close();

    const capture = createIo();
    const exitCode = await runCli(["family", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir], capture.io);
    const output = capture.stdout.join("\n");

    expect(exitCode).toBe(0);
    expect(output).toContain(`当前会话: ${FIXTURE_IDS.ACTIVE_ID}`);
    expect(output).toContain(`root: ${FIXTURE_IDS.ACTIVE_ID}`);
    expect(output).toContain(`children: ${FIXTURE_IDS.ARCHIVED_ID}`);
    expect(output).toContain("thread_source");
    expect(output).toContain("subagent");
    expect(output).toContain("helper");
    expect(output).not.toContain("thread_spawn");
    expect(output).not.toContain("parent_thread_id");
  });

  it("shows an unrelated session family normally", async () => {
    const capture = createIo();
    const exitCode = await runCli(["family", FIXTURE_IDS.STALE_ID, "--root", fixture.rootDir], capture.io);
    const output = capture.stdout.join("\n");

    expect(exitCode).toBe(0);
    expect(output).toContain(`当前会话: ${FIXTURE_IDS.STALE_ID}`);
    expect(output).toContain(`root: ${FIXTURE_IDS.STALE_ID}`);
    expect(output).toContain("parent: -");
    expect(output).toContain("children: -");
    expect(output).toContain("family members: 1");
  });

  it("shows broken family edge warnings in family and delete preview output", async () => {
    const missingChildId = "019d7777-8888-7999-8aaa-111111111111";
    const db = new Database(fixture.paths.sqlite);
    db.prepare(
      "insert into thread_spawn_edges (parent_thread_id, child_thread_id, status) values (?, ?, 'missing-child')",
    ).run(FIXTURE_IDS.ACTIVE_ID, missingChildId);
    db.close();

    const family = createIo();
    const familyExitCode = await runCli(["family", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir], family.io);
    const preview = createIo();
    const previewExitCode = await runCli(["delete", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir], preview.io);

    expect(familyExitCode).toBe(0);
    expect(family.stdout.join("\n")).toContain(`missing child session: ${missingChildId}`);
    expect(previewExitCode).toBe(0);
    expect(preview.stdout.join("\n")).toContain(`missing child session: ${missingChildId}`);
  });

  it("returns session family as json", async () => {
    const capture = createIo();
    const exitCode = await runCli(["family", FIXTURE_IDS.ARCHIVED_ID, "--root", fixture.rootDir, "--json"], capture.io);
    const result = JSON.parse(capture.stdout.join("\n")) as {
      family: {
        current: { sessionId: string; parentIds: string[]; source: string; sourceLabel: string; threadSource: string };
        root: { sessionId: string };
        parents: Array<{ sessionId: string }>;
        directChildren: Array<{ sessionId: string }>;
      };
    };

    expect(exitCode).toBe(0);
    expect(result.family.current.sessionId).toBe(FIXTURE_IDS.ARCHIVED_ID);
    expect(result.family.current.parentIds).toEqual([FIXTURE_IDS.ACTIVE_ID]);
    expect(result.family.current.source).toBe("side");
    expect(result.family.current.sourceLabel).toBe("subagent");
    expect(result.family.current.threadSource).toBe("side");
    expect(result.family.root.sessionId).toBe(FIXTURE_IDS.ACTIVE_ID);
    expect(result.family.parents.map((node) => node.sessionId)).toEqual([FIXTURE_IDS.ACTIVE_ID]);
    expect(result.family.directChildren).toEqual([]);
  });

  it("supports family query modes without producing confirmation flags", async () => {
    const children = createIo();
    const childrenExit = await runCli(["family", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--children"], children.io);
    const childrenOutput = children.stdout.join("\n");
    expect(childrenExit).toBe(0);
    expect(childrenOutput).toContain("mode: children");
    expect(childrenOutput).toContain("直接 children");
    expect(childrenOutput).toContain(FIXTURE_IDS.ARCHIVED_ID);
    expect(childrenOutput).toContain("sourceKind");
    expect(childrenOutput).toContain("childType");
    expect(childrenOutput).toContain("index");
    expect(childrenOutput).toContain("thread");

    const parents = createIo();
    const parentsExit = await runCli(["family", FIXTURE_IDS.ARCHIVED_ID, "--root", fixture.rootDir, "--parents"], parents.io);
    expect(parentsExit).toBe(0);
    expect(parents.stdout.join("\n")).toContain("mode: parents");
    expect(parents.stdout.join("\n")).toContain(FIXTURE_IDS.ACTIVE_ID);

    const subagents = createIo();
    const subagentsExit = await runCli(["family", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--subagents"], subagents.io);
    expect(subagentsExit).toBe(0);
    expect(subagents.stdout.join("\n")).toContain("mode: subagents");
    expect(subagents.stdout.join("\n")).toContain("helper");
    expect(subagents.stdout.join("\n")).toContain(FIXTURE_IDS.ARCHIVED_ID);

    const impact = createIo();
    const impactExit = await runCli(["family", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--impact"], impact.io);
    const impactOutput = impact.stdout.join("\n");
    expect(impactExit).toBe(0);
    expect(impactOutput).toContain("family impact（只读，未执行删除，不是删除建议，不生成 --yes）");
    expect(impactOutput).toContain("unselected children:");
    expect(impactOutput).toContain(FIXTURE_IDS.ARCHIVED_ID);
    expect(impactOutput).toContain("missing relations:");
    expect(impactOutput).toContain("missing surfaces:");
  });

  it("prints plan-delete as read-only and not a deletion confirmation", async () => {
    const capture = createIo();
    const exitCode = await runCli(["plan-delete", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir], capture.io);
    const output = capture.stdout.join("\n");

    expect(exitCode).toBe(0);
    expect(output).toContain("只读 plan-delete");
    expect(output).toContain("未执行删除");
    expect(output).toContain("不是删除确认");
    expect(output).toContain("family 不默认递归包含");
    expect(output).toContain("T7-P1 不支持执行");
    expect(output).not.toContain("--yes");
  });

  it("prints plan-delete json with readOnly and executionSupported safety fields", async () => {
    const capture = createIo();
    const exitCode = await runCli(["plan-delete", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--json"], capture.io);
    const result = JSON.parse(capture.stdout.join("\n")) as {
      readOnly: boolean;
      executionSupported: boolean;
      seedSessionIds: string[];
      selectedIds: string[];
      includedIds: Array<{ sessionId: string; reason: string }>;
      rejectedIds: Array<{ sessionId: string; reason: string }>;
    };

    expect(exitCode).toBe(0);
    expect(result.readOnly).toBe(true);
    expect(result.executionSupported).toBe(false);
    expect(result.seedSessionIds).toEqual([FIXTURE_IDS.ACTIVE_ID]);
    expect(result.selectedIds).toEqual([]);
    expect(result.includedIds).toEqual([]);
    expect(result.rejectedIds).toEqual([
      { sessionId: FIXTURE_IDS.ACTIVE_ID, reason: "active-session-refused-by-default" },
    ]);
  });

  it("writes an auditable redacted plan file and previews it read-only", async () => {
    await writeExactGlobalStateFixture(fixture.paths.globalState);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-plan-test-"));
    const planPath = path.join(tempDir, "delete-plan.json");

    try {
      const writeCapture = createIo();
      const writeExitCode = await runCli(
        ["plan-delete", FIXTURE_IDS.EXACT_GLOBAL_STATE_ID, "--root", fixture.rootDir, "--write-plan", planPath, "--json"],
        writeCapture.io,
      );
      const plan = JSON.parse(await readFile(planPath, "utf8")) as {
        schemaVersion: string;
        readOnly: boolean;
        executionSupported: boolean;
        selectedIds: string[];
        planHash: string;
        rootFingerprint: { rootRealpath: string };
      };
      const planText = await readFile(planPath, "utf8");

      expect(writeExitCode).toBe(0);
      expect(JSON.parse(writeCapture.stdout.join("\n")).planFile).toBe(planPath);
      expect(plan.schemaVersion).toBe("codex-sessions-delete-plan.v1");
      expect(plan.readOnly).toBe(true);
      expect(plan.executionSupported).toBe(false);
      expect(plan.selectedIds).toEqual([FIXTURE_IDS.EXACT_GLOBAL_STATE_ID]);
      expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
      expect(plan.rootFingerprint.rootRealpath.endsWith(path.basename(fixture.rootDir))).toBe(true);
      expect(planText).not.toContain("secret prompt text must not be printed");
      expect(planText).not.toContain("second prompt");
      expect(planText).not.toContain("archived prompt");

      const beforeSessionIndex = await readFile(fixture.paths.sessionIndex, "utf8");
      const beforeHistory = await readFile(fixture.paths.history, "utf8");
      const beforeGlobalState = await readFile(fixture.paths.globalState, "utf8");
      const previewCapture = createIo();
      const previewExitCode = await runCli(["preview-plan", planPath, "--root", fixture.rootDir, "--json"], previewCapture.io);
      const preview = JSON.parse(previewCapture.stdout.join("\n")) as {
        readOnly: boolean;
        stale: boolean;
        deletePreview: { items: Array<{ sessionId: string }>; totals: { exactKeyGlobalStateRefs: number } } | null;
      };

      expect(previewExitCode).toBe(0);
      expect(preview.readOnly).toBe(true);
      expect(preview.stale).toBe(false);
      expect(preview.deletePreview?.items.map((item) => item.sessionId)).toEqual([FIXTURE_IDS.EXACT_GLOBAL_STATE_ID]);
      expect(preview.deletePreview?.totals.exactKeyGlobalStateRefs).toBe(2);
      await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toBe(beforeSessionIndex);
      await expect(readFile(fixture.paths.history, "utf8")).resolves.toBe(beforeHistory);
      await expect(readFile(fixture.paths.globalState, "utf8")).resolves.toBe(beforeGlobalState);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("marks preview-plan stale when indexed, history, global-state, or sqlite surfaces change", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-plan-stale-"));

    try {
      for (const [name, mutate] of [
        ["session_index", async () => appendFile(fixture.paths.sessionIndex, `${JSON.stringify({ id: FIXTURE_IDS.UNRELATED_ID })}\n`, "utf8")],
        ["history", async () => appendFile(fixture.paths.history, `${JSON.stringify({ session_id: FIXTURE_IDS.ARCHIVED_ID, text: "new" })}\n`, "utf8")],
        ["global-state", async () => writeFile(fixture.paths.globalState, "{bad json\n", "utf8")],
        ["sqlite", async () => {
          const db = new Database(fixture.paths.sqlite);
          db.prepare("delete from thread_spawn_edges where child_thread_id = ?").run(FIXTURE_IDS.ARCHIVED_ID);
          db.close();
        }],
      ] as const) {
        await fixture.cleanup();
        fixture = await createFixture();
        const planPath = path.join(tempDir, `${name}.json`);
        await runCli(["plan-delete", FIXTURE_IDS.ARCHIVED_ID, "--root", fixture.rootDir, "--write-plan", planPath], createIo().io);

        await mutate();

        const capture = createIo();
        const exitCode = await runCli(["preview-plan", planPath, "--root", fixture.rootDir, "--json"], capture.io);
        const result = JSON.parse(capture.stdout.join("\n")) as {
          stale: boolean;
          staleReasons: string[];
          deletePreview: unknown;
        };

        expect(exitCode).toBe(0);
        expect(result.stale).toBe(true);
        expect(result.staleReasons.some((reason) => reason.includes(name))).toBe(true);
        expect(result.deletePreview).toBeNull();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not preview active/rejected plan IDs as deletable and has no delete-plan entrypoint", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "codex-plan-active-"));
    const planPath = path.join(tempDir, "active.json");

    try {
      await runCli(["plan-delete", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--write-plan", planPath], createIo().io);

      const capture = createIo();
      const exitCode = await runCli(["preview-plan", planPath, "--root", fixture.rootDir, "--json"], capture.io);
      const result = JSON.parse(capture.stdout.join("\n")) as {
        stale: boolean;
        deletePreview: { items: Array<{ sessionId: string }> } | null;
        rejectedIds: Array<{ sessionId: string }>;
      };

      expect(exitCode).toBe(0);
      expect(result.stale).toBe(false);
      expect(result.deletePreview?.items).toEqual([]);
      expect(result.rejectedIds.map((item) => item.sessionId)).toContain(FIXTURE_IDS.ACTIVE_ID);
      await expect(runCli(["plan-delete", FIXTURE_IDS.ARCHIVED_ID, "--root", fixture.rootDir, "--yes"], createIo().io)).rejects.toThrow(
        "plan-delete 不支持 --yes",
      );
      await expect(runCli(["delete-plan", planPath, "--root", fixture.rootDir, "--yes"], createIo().io)).rejects.toThrow();
      expect(getHelpText()).not.toContain("delete-plan");
      expect(getHelpText()).not.toContain("--force");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("documents plan-delete plan-file support without execution options", () => {
    const help = getHelpText();

    expect(help).toContain("codex-sessions plan-delete <session-id...> [--root PATH] [--json] [--write-plan FILE]");
    expect(help).toContain("codex-sessions preview-plan <plan-file> [--root PATH] [--json]");
    expect(help).toContain("--include-children");
    expect(help).toContain("plan-delete 是只读删除计划");
    expect(help).toContain("plan file 是审计材料");
    expect(help).not.toContain("--include-side");
    expect(help).not.toContain("delete-plan");
  });

  it("rejects root-level selection filters for plan-delete", async () => {
    const capture = createIo();

    await expect(runCli(["plan-delete", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--source-kind", "subagent"], capture.io))
      .rejects.toThrow("plan-delete 只支持 explicit session IDs");
  });

  it("filters family modes by sourceKind and keeps complete json fields", async () => {
    const rawSource = JSON.stringify({
      subagent: {
        thread_spawn: {
          parent_thread_id: FIXTURE_IDS.ACTIVE_ID,
          agent_nickname: "helper",
          agent_role: "explorer",
        },
      },
    });
    const db = new Database(fixture.paths.sqlite);
    db.prepare("update threads set source = ?, thread_source = ?, agent_role = ?, agent_nickname = ? where id = ?").run(
      rawSource,
      "subagent",
      "explorer",
      "helper",
      FIXTURE_IDS.ARCHIVED_ID,
    );
    db.close();

    const human = createIo();
    const humanExit = await runCli(
      ["family", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--children", "--source-kind", "subagent"],
      human.io,
    );
    expect(humanExit).toBe(0);
    expect(human.stdout.join("\n")).toContain("sourceKind filter: subagent");
    expect(human.stdout.join("\n")).toContain("结果数: 1");
    expect(human.stdout.join("\n")).toContain(FIXTURE_IDS.ARCHIVED_ID);

    const full = createIo();
    const fullExit = await runCli(["family", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--children", "--full"], full.io);
    expect(fullExit).toBe(0);
    expect(full.stdout.join("\n")).toContain("thread_spawn");
    expect(full.stdout.join("\n")).toContain("parent_thread_id");

    const json = createIo();
    const jsonExit = await runCli(
      ["family", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--children", "--source-kind", "subagent", "--json"],
      json.io,
    );
    const result = JSON.parse(json.stdout.join("\n")) as {
      mode: string;
      sourceKinds: string[];
      nodes: Array<{
        sessionId: string;
        sourceKind: string;
        source: string;
        threadSource: string;
        agentRole: string;
        agentNickname: string;
        hasSessionIndex: boolean;
        hasThread: boolean;
        fileExists: boolean;
      }>;
      family: { current: { sessionId: string } };
    };
    expect(jsonExit).toBe(0);
    expect(result.mode).toBe("children");
    expect(result.sourceKinds).toEqual(["subagent"]);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]).toMatchObject({
      sessionId: FIXTURE_IDS.ARCHIVED_ID,
      sourceKind: "subagent",
      source: rawSource,
      threadSource: "subagent",
      agentRole: "explorer",
      agentNickname: "helper",
      hasSessionIndex: true,
      hasThread: true,
      fileExists: true,
    });
    expect(result.family.current.sessionId).toBe(FIXTURE_IDS.ACTIVE_ID);
  });

  it("keeps default family output compact and expands full fields as blocks", async () => {
    const longTitle = `Long family title start ${"x".repeat(240)} long family title end`;
    const longSource = JSON.stringify({
      subagent: {
        thread_spawn: {
          parent_thread_id: FIXTURE_IDS.ACTIVE_ID,
          agent_nickname: "helper",
          agent_role: "explorer",
        },
      },
      payload: "y".repeat(240),
    });
    const db = new Database(fixture.paths.sqlite);
    db.prepare("update threads set title = ?, source = ?, thread_source = ?, agent_role = ?, agent_nickname = ? where id = ?").run(
      longTitle,
      longSource,
      "side",
      "explorer",
      "helper",
      FIXTURE_IDS.ARCHIVED_ID,
    );
    db.close();
    await writeFile(
      fixture.paths.sessionIndex,
      `${[
        { id: FIXTURE_IDS.ACTIVE_ID, thread_name: "Active thread", updated_at: "2026-04-03T04:01:00.000Z" },
        { id: FIXTURE_IDS.ARCHIVED_ID, thread_name: longTitle, updated_at: "2026-04-02T03:01:00.000Z" },
        { id: FIXTURE_IDS.STALE_ID, thread_name: "Stale only", updated_at: "2026-04-01T01:00:00.000Z" },
      ].map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );

    const compact = createIo();
    const compactExit = await runCli(["family", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--children"], compact.io);
    const compactOutput = compact.stdout.join("\n");

    expect(compactExit).toBe(0);
    expect(compactOutput).toContain("显示模式: 默认短输出");
    expect(compactOutput).toContain("完整内容用 --full、--json 或 MCP get_session_family 查看");
    expect(compactOutput).toContain("childTypeLabels: subagent, side/fork");
    expect(compactOutput).not.toContain("thread_spawn");
    expect(compactOutput).not.toContain("parent_thread_id");
    expect(compactOutput).not.toContain("long family title end");
    expect(compactOutput).not.toContain("y".repeat(120));

    const full = createIo();
    const fullExit = await runCli(["family", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--children", "--full"], full.io);
    const fullOutput = full.stdout.join("\n");

    expect(fullExit).toBe(0);
    expect(fullOutput).toContain("显示模式: --full");
    expect(fullOutput).toContain("raw source:");
    expect(fullOutput).toContain("thread_spawn");
    expect(fullOutput).toContain("parent_thread_id");
    expect(fullOutput).toContain("long family title end");
  });

  it("truncates long title metadata in human-readable show output", async () => {
    const longSqliteTitle = `sqlite-title-start ${"x".repeat(260)} sqlite-title-end`;
    const longFirstUserMessage = `first-message-start ${"y".repeat(260)} first-message-end`;
    const db = new Database(fixture.paths.sqlite);
    db.prepare("update threads set title = ?, first_user_message = ? where id = ?").run(
      longSqliteTitle,
      longFirstUserMessage,
      FIXTURE_IDS.ACTIVE_ID,
    );
    db.close();

    const capture = createIo();
    const exitCode = await runCli(["show", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir], capture.io);
    const output = capture.stdout.join("\n");

    expect(exitCode).toBe(0);
    expect(output).toContain("SQLite 标题: sqlite-title-start");
    expect(output).toContain("第一条用户请求: first-message-start");
    expect(output).toContain("chars)");
    expect(output).not.toContain("sqlite-title-end");
    expect(output).not.toContain("first-message-end");
  });

  it("limits human-readable timeline preview in show output", async () => {
    const extraRows = Array.from({ length: 25 }, (_, index) =>
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-04-03T04:00:00.000Z",
        payload: { type: "user_message", message: `extra timeline row ${index}` },
      }),
    ).join("\n");
    await appendFile(fixture.paths.activeSessionFile, `${extraRows}\n`, "utf8");

    const capture = createIo();
    const exitCode = await runCli(["show", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir], capture.io);
    const output = capture.stdout.join("\n");

    expect(exitCode).toBe(0);
    expect(output).toContain("还有");
    expect(output).toContain("show --json");
    expect(output).toContain("extra timeline row 18");
    expect(output).not.toContain("extra timeline row 19");
  });

  it("lists sessions with project and updated date filters", async () => {
    const capture = createIo();
    const exitCode = await runCli(
      [
        "list",
        "--root",
        fixture.rootDir,
        "--project",
        "demo",
        "--updated-after",
        "2026-04-03",
        "--updated-before",
        "2026-04-03",
      ],
      capture.io,
    );

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("\n")).toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(capture.stdout.join("\n")).not.toContain(FIXTURE_IDS.ARCHIVED_ID);
  });

  it("lists sessions with source and model filters", async () => {
    const capture = createIo();
    const exitCode = await runCli(
      [
        "list",
        "--root",
        fixture.rootDir,
        "--source-kind",
        "subagent",
        "--source",
        "side",
        "--thread-source",
        "side",
        "--agent-role",
        "subagent",
        "--agent-nickname",
        "helper",
        "--model-provider",
        "sub2api",
        "--model",
        "gpt-5.4",
      ],
      capture.io,
    );
    const output = capture.stdout.join("\n");

    expect(exitCode).toBe(0);
    expect(output).toContain(FIXTURE_IDS.ARCHIVED_ID);
    expect(output).toContain("subagent");
    expect(output).toContain("sub2api");
    expect(output).not.toContain(FIXTURE_IDS.ACTIVE_ID);
  });

  it("summarizes session sources from the cli", async () => {
    const beforeSessionIndex = await readFile(fixture.paths.sessionIndex, "utf8");
    const human = createIo();
    const humanExitCode = await runCli(["sources", "--root", fixture.rootDir], human.io);
    const humanOutput = human.stdout.join("\n");
    const json = createIo();
    const jsonExitCode = await runCli(["sources", "--root", fixture.rootDir, "--json"], json.io);
    const result = JSON.parse(json.stdout.join("\n")) as {
      summary: {
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
    };

    expect(humanExitCode).toBe(0);
    expect(humanOutput).toContain("按 sourceKind");
    expect(humanOutput).toContain("raw source");
    expect(humanOutput).toContain("model_provider");
    expect(humanOutput).toContain("cli");
    expect(humanOutput).toContain("side");
    expect(jsonExitCode).toBe(0);
    expect(result.summary.totalSessions).toBe(3);
    expect(result.summary.bySourceKind).toMatchObject({ cli: 1, subagent: 1, unknown: 1 });
    expect(result.summary.rows).toEqual(
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
        expect.objectContaining({
          sourceKind: "subagent",
          source: "side",
          threadSource: "side",
          modelProvider: "sub2api",
          model: "gpt-5.4",
          agentRole: "subagent",
          count: 1,
        }),
      ]),
    );
    await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toBe(beforeSessionIndex);
  });

  it("lists project summaries and grouped sessions", async () => {
    const projects = createIo();
    const projectsExitCode = await runCli(["projects", "--root", fixture.rootDir], projects.io);
    const grouped = createIo();
    const groupedExitCode = await runCli(["list", "--root", fixture.rootDir, "--group-by", "project"], grouped.io);

    expect(projectsExitCode).toBe(0);
    expect(projects.stdout.join("\n")).toContain("demo");
    expect(projects.stdout.join("\n")).toContain("archive-demo");
    expect(groupedExitCode).toBe(0);
    expect(grouped.stdout.join("\n")).toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(grouped.stdout.join("\n")).toContain(FIXTURE_IDS.ARCHIVED_ID);
  });

  it("shows delete preview without --yes", async () => {
    const capture = createIo();
    const exitCode = await runCli(["delete", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("\n")).toContain("将处理 1 条会话");
    expect(capture.stdout.join("\n")).toContain("session_index");
    expect(capture.stdout.join("\n")).toContain("global state 引用");
    expect(capture.stdout.join("\n")).toContain("shell snapshot 文件");
    expect(capture.stdout.join("\n")).toContain("关系提醒");
    expect(capture.stdout.join("\n")).toContain(FIXTURE_IDS.ARCHIVED_ID);
    await expect(readFile(fixture.paths.activeShellSnapshot, "utf8")).resolves.toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(await readFile(fixture.paths.globalState, "utf8")).toContain(FIXTURE_IDS.ACTIVE_ID);
  });

  it("returns stable json for exact-key global-state preview", async () => {
    await writeExactGlobalStateFixture(fixture.paths.globalState);

    const capture = createIo();
    const exitCode = await runCli(["delete", FIXTURE_IDS.EXACT_GLOBAL_STATE_ID, "--root", fixture.rootDir, "--json"], capture.io);
    const output = JSON.parse(capture.stdout.join("\n")) as {
      action: string;
      requiresConfirmation: boolean;
      preview: {
        totals: { exactKeyGlobalStateRefs: number; possibleUnknownGlobalStateRefs: number };
        items: Array<{
          sessionId: string;
          exactKeyGlobalStateRefs: number;
          exactKeyGlobalStateRefsDetail: Array<{
            path: string;
            ruleId: string;
            valueShape: string;
            byteEstimate: number;
            requiresConfirmation: boolean;
            value?: unknown;
          }>;
        }>;
      };
    };

    expect(exitCode).toBe(0);
    expect(output.action).toBe("delete");
    expect(output.requiresConfirmation).toBe(true);
    expect(output.preview.totals.exactKeyGlobalStateRefs).toBe(2);
    expect(output.preview.totals.possibleUnknownGlobalStateRefs).toBe(0);
    expect(output.preview.items[0].sessionId).toBe(FIXTURE_IDS.EXACT_GLOBAL_STATE_ID);
    expect(output.preview.items[0].exactKeyGlobalStateRefs).toBe(2);
    expect(output.preview.items[0].exactKeyGlobalStateRefsDetail[0]).toMatchObject({
      ruleId: "electronPromptHistoryByThreadId",
      valueShape: "array(3)",
      requiresConfirmation: true,
    });
    expect(output.preview.items[0].exactKeyGlobalStateRefsDetail[0]).not.toHaveProperty("value");
    expect(capture.stdout.join("\n")).not.toContain("secret prompt text");
  });

  it("keeps exact-key values out of human delete previews", async () => {
    await writeExactGlobalStateFixture(fixture.paths.globalState);

    const capture = createIo();
    const exitCode = await runCli(["delete", FIXTURE_IDS.EXACT_GLOBAL_STATE_ID, "--root", fixture.rootDir], capture.io);
    const output = capture.stdout.join("\n");

    expect(exitCode).toBe(0);
    expect(output).toContain(`$.electron-persisted-atom-state.prompt-history.${FIXTURE_IDS.EXACT_GLOBAL_STATE_ID}`);
    expect(output).toContain("shape=array(3)");
    expect(output).not.toContain("secret prompt text");
    expect(output).not.toContain("second prompt");
    expect(output).not.toContain(FIXTURE_IDS.PROMPT_HISTORY_VALUE_ID);
    expect(output).not.toContain("workspace-write");
  });

  it("deletes exact-key global-state refs through CLI --yes without touching siblings", async () => {
    await writeExactGlobalStateFixture(fixture.paths.globalState);

    const capture = createIo();
    const exitCode = await runCli(["delete", FIXTURE_IDS.EXACT_GLOBAL_STATE_ID, "--root", fixture.rootDir, "--yes"], capture.io);
    const globalState = JSON.parse(await readFile(fixture.paths.globalState, "utf8")) as {
      "electron-persisted-atom-state": {
        "prompt-history": Record<string, unknown>;
        "heartbeat-thread-permissions-by-id": Record<string, unknown>;
      };
      "electron-local-remote-control-installation-id": string;
    };
    const atomState = globalState["electron-persisted-atom-state"];

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("\n")).toContain("exact_key=0");
    expect(atomState["prompt-history"]).not.toHaveProperty(FIXTURE_IDS.EXACT_GLOBAL_STATE_ID);
    expect(atomState["heartbeat-thread-permissions-by-id"]).not.toHaveProperty(FIXTURE_IDS.EXACT_GLOBAL_STATE_ID);
    expect(atomState["prompt-history"]).toHaveProperty(FIXTURE_IDS.EXACT_GLOBAL_STATE_SIBLING_ID);
    expect(atomState["heartbeat-thread-permissions-by-id"]).toHaveProperty(FIXTURE_IDS.EXACT_GLOBAL_STATE_SIBLING_ID);
    expect(atomState["prompt-history"]).toHaveProperty(FIXTURE_IDS.BAD_HEARTBEAT_GLOBAL_STATE_ID);
    expect(atomState["heartbeat-thread-permissions-by-id"]).toHaveProperty(FIXTURE_IDS.BAD_HEARTBEAT_GLOBAL_STATE_ID);
    expect(globalState["electron-local-remote-control-installation-id"]).toBe(FIXTURE_IDS.INSTALLATION_GLOBAL_STATE_ID);
  });

  it("refuses unknown-only global-state cleanup from the cli", async () => {
    await writeExactGlobalStateFixture(fixture.paths.globalState);

    const capture = createIo();

    await expect(runCli(["delete", FIXTURE_IDS.BAD_HEARTBEAT_GLOBAL_STATE_ID, "--root", fixture.rootDir, "--yes"], capture.io)).rejects.toThrow(
      "拒绝删除 unknown global-state",
    );
    expect(await readFile(fixture.paths.globalState, "utf8")).toContain(FIXTURE_IDS.BAD_HEARTBEAT_GLOBAL_STATE_ID);
  });

  it("refuses installation-id global-state cleanup from the cli", async () => {
    await writeExactGlobalStateFixture(fixture.paths.globalState);

    const capture = createIo();

    await expect(runCli(["delete", FIXTURE_IDS.INSTALLATION_GLOBAL_STATE_ID, "--root", fixture.rootDir, "--yes"], capture.io)).rejects.toThrow(
      "拒绝删除 unknown global-state",
    );
    expect(await readFile(fixture.paths.globalState, "utf8")).toContain(FIXTURE_IDS.INSTALLATION_GLOBAL_STATE_ID);
  });

  it("keeps exact-key documentation commands aligned with real cli help", async () => {
    const readme = await readFile("README.md", "utf8");
    const safety = await readFile("docs/SAFETY.md", "utf8");
    const help = getHelpText();

    expect(help).toContain("codex-sessions delete <session-id...>");
    expect(readme).toContain("codex-sessions delete <session-id>");
    expect(safety).toContain("codex-sessions delete <session-id> --root <path-to-codex-root>");
    expect(`${readme}\n${safety}`).not.toContain("cleanup-global-state");
  });

  it("keeps package delivery metadata aligned", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      version: string;
      files: string[];
    };
    const packageLock = JSON.parse(await readFile("package-lock.json", "utf8")) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    const trashSource = await readFile("src/core/trash.ts", "utf8");
    const mcpServerSource = await readFile("src/mcp/server.ts", "utf8");
    const unknownRules = await readFile("docs/UNKNOWN_GLOBAL_STATE_RULES.md", "utf8");

    expect(packageJson.files).toContain("docs/UNKNOWN_GLOBAL_STATE_RULES.md");
    expect(packageJson).toHaveProperty("scripts.build", expect.stringContaining("chmod +x dist/cli/index.js dist/mcp/server.js"));
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[""].version).toBe(packageJson.version);
    expect(trashSource).toContain(`const TOOL_VERSION = "${packageJson.version}"`);
    expect(mcpServerSource).toContain(`version: "${packageJson.version}"`);
    expect(unknownRules).not.toContain("/Users/");
    expect(unknownRules).not.toContain("2026-");
    expect(unknownRules).toContain("do not issue a preview token");
  });

  it("deletes sessions when --yes is passed", async () => {
    const capture = createIo();
    const exitCode = await runCli(["delete", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--yes"], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("\n")).toContain("possible_unknown_global_state_refs=1");

    const list = createIo();
    const listExitCode = await runCli(["list", "--root", fixture.rootDir], list.io);
    expect(listExitCode).toBe(0);
    expect(list.stdout.join("\n")).not.toContain(FIXTURE_IDS.ACTIVE_ID);
    await expect(readFile(fixture.paths.activeShellSnapshot, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const globalState = JSON.parse(await readFile(fixture.paths.globalState, "utf8")) as {
      "pinned-thread-ids": string[];
      "queued-follow-ups": Record<string, unknown>;
      diffViewThreadSettings: Record<string, unknown>;
      "some-user-setting": string;
      "prompt-history": string[];
    };
    expect(globalState["pinned-thread-ids"]).not.toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(globalState["queued-follow-ups"]).not.toHaveProperty(FIXTURE_IDS.ACTIVE_ID);
    expect(globalState.diffViewThreadSettings).not.toHaveProperty(FIXTURE_IDS.ACTIVE_ID);
    expect(globalState["some-user-setting"]).toBe(FIXTURE_IDS.ACTIVE_ID);
    expect(globalState["prompt-history"][0]).toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(globalState["pinned-thread-ids"]).toContain(FIXTURE_IDS.ARCHIVED_ID);
  });

  it("runs doctor in human and json modes", async () => {
    const human = createIo();
    const humanExitCode = await runCli(["doctor", "--root", fixture.rootDir], human.io);
    const json = createIo();
    const jsonExitCode = await runCli(["doctor", "--root", fixture.rootDir, "--json"], json.io);
    const report = JSON.parse(json.stdout.join("\n")) as {
      sqlite: { activeStatePath: string; activeLogsPath: string; stateTables: Array<{ table: string; exists: boolean }> };
      globalState: { possibleUnknownRefs: Array<{ path: string }> };
    };

    expect(humanExitCode).toBe(0);
    expect(human.stdout.join("\n")).toContain("Root:");
    expect(human.stdout.join("\n")).toContain("possible unknown global state refs");
    expect(jsonExitCode).toBe(0);
    expect(report.sqlite.activeStatePath).toBe(fixture.paths.sqlite);
    expect(report.sqlite.activeLogsPath).toBe(fixture.paths.logsSqlite);
    expect(report.sqlite.stateTables.some((table) => table.table === "threads" && table.exists)).toBe(true);
    expect(report.globalState.possibleUnknownRefs.some((ref) => ref.path === "$.some-user-setting")).toBe(true);
  });

  it("verifies known and unknown global state refs from the cli", async () => {
    const capture = createIo();
    const exitCode = await runCli(["verify", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--json"], capture.io);
    const result = JSON.parse(capture.stdout.join("\n")) as Array<{
      globalStateRefsRemaining: number;
      possibleUnknownGlobalStateRefsRemaining: number;
      possibleUnknownGlobalStateRefPaths: string[];
    }>;

    expect(exitCode).toBe(0);
    expect(result[0].globalStateRefsRemaining).toBe(3);
    expect(result[0].possibleUnknownGlobalStateRefsRemaining).toBe(1);
    expect(result[0].possibleUnknownGlobalStateRefPaths).toEqual(["$.some-user-setting"]);
  });

  it("audits local residue from the cli without changing files", async () => {
    const beforeSessionIndex = await readFile(fixture.paths.sessionIndex, "utf8");
    const beforeHistory = await readFile(fixture.paths.history, "utf8");
    const beforeGlobalState = await readFile(fixture.paths.globalState, "utf8");
    const capture = createIo();
    const exitCode = await runCli(["audit", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir], capture.io);
    const output = capture.stdout.join("\n");

    expect(exitCode).toBe(0);
    expect(output).toContain("审计结论");
    expect(output).toContain("本地残留面");
    expect(output).toContain("家族关系");
    expect(output).toContain("建议下一步");
    expect(output).toContain("预览命令");
    expect(output).toContain("只有用户加 --yes 才会真的删除");
    expect(output).toContain("global-state 未知位置引用");
    expect(output).not.toContain("active user input");
    await expect(readFile(fixture.paths.activeShellSnapshot, "utf8")).resolves.toContain(FIXTURE_IDS.ACTIVE_ID);
    await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toBe(beforeSessionIndex);
    await expect(readFile(fixture.paths.history, "utf8")).resolves.toBe(beforeHistory);
    await expect(readFile(fixture.paths.globalState, "utf8")).resolves.toBe(beforeGlobalState);
  });

  it("returns structured audit json from the cli", async () => {
    const capture = createIo();
    const exitCode = await runCli(["audit", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--json"], capture.io);
    const audit = JSON.parse(capture.stdout.join("\n")) as {
      sessionId: string;
      overallStatus: string[];
      surfaces: {
        globalStateUnknown: { count: number; paths: string[] };
        sqlite: { rows: number };
      };
      familySummary: { childIds: string[] };
      recommendedNextCommand: string;
      recommendedNextCommandNote: string;
    };

    expect(exitCode).toBe(0);
    expect(audit.sessionId).toBe(FIXTURE_IDS.ACTIVE_ID);
    expect(audit.overallStatus).toEqual(["present", "risky-global-state"]);
    expect(audit.surfaces.globalStateUnknown.count).toBe(1);
    expect(audit.surfaces.globalStateUnknown.paths).toEqual(["$.some-user-setting"]);
    expect(audit.surfaces.sqlite.rows).toBe(7);
    expect(audit.familySummary.childIds).toEqual([FIXTURE_IDS.ARCHIVED_ID]);
    expect(audit.recommendedNextCommand).toBe(`codex-sessions delete ${FIXTURE_IDS.ACTIVE_ID} --root ${fixture.rootDir}`);
    expect(audit.recommendedNextCommand).not.toContain("--yes");
    expect(audit.recommendedNextCommandNote).toContain("--yes");
  });

  it("audits an unknown valid uuid without suggesting deletion", async () => {
    const unknownId = "019e0000-0000-7000-8000-000000000000";
    const human = createIo();
    const humanExitCode = await runCli(["audit", unknownId, "--root", fixture.rootDir], human.io);
    const humanOutput = human.stdout.join("\n");
    const json = createIo();
    const jsonExitCode = await runCli(["audit", unknownId, "--root", fixture.rootDir, "--json"], json.io);
    const audit = JSON.parse(json.stdout.join("\n")) as {
      sessionId: string;
      knownLocally: boolean;
      overallStatus: string[];
      currentState: { kind: string; message: string };
      recommendedNextCommand: string | null;
      recommendedNextCommandNote: string;
    };

    expect(humanExitCode).toBe(0);
    expect(humanOutput).toContain("状态: absent");
    expect(humanOutput).toContain("未发现这个 ID 的本地记录或残留");
    expect(humanOutput).toContain("不需要处理，当前没有发现这个 ID 的本地记录或残留");
    expect(humanOutput).not.toContain("未发现这个会话的本地残留");
    expect(humanOutput).not.toContain("预览命令");
    expect(jsonExitCode).toBe(0);
    expect(audit.sessionId).toBe(unknownId);
    expect(audit.knownLocally).toBe(false);
    expect(audit.overallStatus).toEqual(["absent"]);
    expect(audit.currentState).toMatchObject({
      kind: "absent",
      message: "未发现这个 ID 的本地记录或残留。",
    });
    expect(audit.recommendedNextCommand).toBeNull();
    expect(audit.recommendedNextCommandNote).toBe("不需要处理，当前没有发现这个 ID 的本地记录或残留。");
  });

  it("lists root residue candidates in human and json modes", async () => {
    const human = createIo();
    const humanExitCode = await runCli(["audit-root", "--root", fixture.rootDir], human.io);
    const humanOutput = human.stdout.join("\n");
    const json = createIo();
    const jsonExitCode = await runCli(["audit-root", "--root", fixture.rootDir, "--json", "--limit", "1"], json.io);
    const result = JSON.parse(json.stdout.join("\n")) as {
      rootPath: string;
      filters: { statuses: string[]; sources: string[]; includeAll: boolean };
      totalCandidatesBeforeFilter: number;
      totalCandidatesAfterFilter: number;
      totalCandidates: number;
      returnedCandidates: number;
      limit: number;
      byStatus: Record<string, number>;
      bySource: Record<string, number>;
      candidates: Array<{ sessionId: string; statuses: string[]; recommendedAuditCommand: string }>;
      warnings: string[];
    };

    expect(humanExitCode).toBe(0);
    expect(humanOutput).toContain("疑似残留");
    expect(humanOutput).toContain("筛选前候选");
    expect(humanOutput).toContain("筛选: 无");
    expect(humanOutput).toContain("按状态（筛选后，limit 前）");
    expect(humanOutput).toContain("按来源（筛选后，limit 前）");
    expect(humanOutput).toContain(FIXTURE_IDS.STALE_ID);
    expect(humanOutput).toContain(FIXTURE_IDS.UNRELATED_ID);
    expect(humanOutput).toContain("codex-sessions audit");
    expect(humanOutput).not.toContain("active user input");
    expect(jsonExitCode).toBe(0);
    expect(result.rootPath).toBe(fixture.rootDir);
    expect(result.filters).toEqual({ statuses: [], sources: [], includeAll: false });
    expect(result.totalCandidatesBeforeFilter).toBe(2);
    expect(result.totalCandidatesAfterFilter).toBe(2);
    expect(result.totalCandidates).toBe(2);
    expect(result.returnedCandidates).toBe(1);
    expect(result.limit).toBe(1);
    expect(result.byStatus).toMatchObject({ partial: 2, "partial-residue": 2 });
    expect(result.bySource).toMatchObject({ session_index: 1, shell_snapshots: 1 });
    expect(result.candidates[0].recommendedAuditCommand).toContain("codex-sessions audit");
    expect(result.warnings).toEqual([]);
  });

  it("previews root residue delete candidates in human and json modes without deleting", async () => {
    const beforeSessionIndex = await readFile(fixture.paths.sessionIndex, "utf8");
    const beforeHistory = await readFile(fixture.paths.history, "utf8");
    const beforeGlobalState = await readFile(fixture.paths.globalState, "utf8");
    const human = createIo();
    const humanExitCode = await runCli(["preview-root", "--root", fixture.rootDir, "--limit", "10"], human.io);
    const humanOutput = human.stdout.join("\n");
    const json = createIo();
    const jsonExitCode = await runCli(["preview-root", "--root", fixture.rootDir, "--json", "--limit", "1"], json.io);
    const result = JSON.parse(json.stdout.join("\n")) as {
      rootPath: string;
      filters: { statuses: string[]; sources: string[]; includeAll: boolean };
      totalCandidatesBeforeFilter: number;
      totalCandidatesAfterFilter: number;
      previewedCandidates: number;
      omittedCandidates: number;
      limit: number;
      aggregatePreview: {
        rolloutFiles: number;
        shellSnapshots: number;
        sessionIndexRows: number;
        historyRows: number;
        sqliteRows: number;
        knownGlobalStateRefs: number;
        possibleUnknownGlobalStateRefs: number;
        threadSpawnEdges: number;
      };
      familyWarningSummary: { candidatesWithFamilyWarnings: number };
      candidates: Array<{
        sessionId: string;
        statuses: string[];
        sources: string[];
        previewCounts: { sessionIndexRows: number; shellSnapshots: number };
        recommendedAuditCommand: string;
        previewOnlyCommand: string;
        recommendedPreviewCommand: string;
      }>;
      warnings: string[];
    };

    expect(humanExitCode).toBe(0);
    expect(humanOutput).toContain("root 批量 delete preview（只读，未删除）");
    expect(humanOutput).toContain("候选不是删除清单");
    expect(humanOutput).toContain("没有建议删除任何 session");
    expect(humanOutput).toContain("Root:");
    expect(humanOutput).toContain("筛选条件");
    expect(humanOutput).toContain("匹配候选数");
    expect(humanOutput).toContain("本次预览 ID 数");
    expect(humanOutput).toContain("省略 ID 数");
    expect(humanOutput).toContain("rollout files");
    expect(humanOutput).toContain("shell snapshots");
    expect(humanOutput).toContain("session_index");
    expect(humanOutput).toContain("history");
    expect(humanOutput).toContain("SQLite");
    expect(humanOutput).toContain("known global-state");
    expect(humanOutput).toContain("unknown global-state");
    expect(humanOutput).toContain("thread_spawn_edges");
    expect(humanOutput).toContain("family 风险摘要");
    expect(humanOutput).toContain("建议 audit 命令");
    expect(humanOutput).toContain(FIXTURE_IDS.STALE_ID);
    expect(humanOutput).toContain(FIXTURE_IDS.UNRELATED_ID);
    expect(humanOutput).not.toContain("active user input");
    expect(humanOutput).not.toContain("--yes");

    expect(jsonExitCode).toBe(0);
    expect(result.rootPath).toBe(fixture.rootDir);
    expect(result.filters).toEqual({ statuses: [], sources: [], includeAll: false });
    expect(result.totalCandidatesBeforeFilter).toBe(2);
    expect(result.totalCandidatesAfterFilter).toBe(2);
    expect(result.previewedCandidates).toBe(1);
    expect(result.omittedCandidates).toBe(1);
    expect(result.limit).toBe(1);
    expect(result.aggregatePreview.sessionIndexRows + result.aggregatePreview.shellSnapshots).toBeGreaterThan(0);
    expect(result.familyWarningSummary.candidatesWithFamilyWarnings).toBe(0);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].recommendedAuditCommand).toContain("codex-sessions audit");
    expect(result.candidates[0].previewOnlyCommand).toContain("codex-sessions delete");
    expect(result.candidates[0].recommendedPreviewCommand).toContain("codex-sessions delete");
    expect(result.candidates[0].recommendedAuditCommand).not.toContain("--yes");
    expect(result.candidates[0].previewOnlyCommand).not.toContain("--yes");
    expect(result.candidates[0].recommendedPreviewCommand).not.toContain("--yes");
    expect(result.warnings).toEqual([]);
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
    await expect(readFile(fixture.paths.unrelatedShellSnapshot, "utf8")).resolves.toContain(FIXTURE_IDS.UNRELATED_ID);
    await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toBe(beforeSessionIndex);
    await expect(readFile(fixture.paths.history, "utf8")).resolves.toBe(beforeHistory);
    await expect(readFile(fixture.paths.globalState, "utf8")).resolves.toBe(beforeGlobalState);
  });

  it("refuses write-like flags on root audit and root preview commands", async () => {
    await expect(runCli(["audit-root", "--root", fixture.rootDir, "--yes"], createIo().io)).rejects.toThrow(
      "audit-root 不支持 --yes",
    );
    await expect(runCli(["audit-root", "--root", fixture.rootDir, "--trash"], createIo().io)).rejects.toThrow(
      "audit-root 不支持 --trash",
    );
    await expect(runCli(["preview-root", "--root", fixture.rootDir, "--yes"], createIo().io)).rejects.toThrow(
      "preview-root 不支持 --yes",
    );
    await expect(runCli(["preview-root", "--root", fixture.rootDir, "--trash"], createIo().io)).rejects.toThrow(
      "preview-root 不支持 --trash",
    );
  });

  it("filters preview-root candidates with repeated status and source options", async () => {
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

    const capture = createIo();
    const exitCode = await runCli(
      [
        "preview-root",
        "--root",
        fixture.rootDir,
        "--json",
        "--status",
        "db-only",
        "--status",
        "risky-global-state",
        "--source",
        "sqlite",
        "--source",
        "global-state-unknown",
        "--limit",
        "1",
      ],
      capture.io,
    );
    const result = JSON.parse(capture.stdout.join("\n")) as {
      filters: { statuses: string[]; sources: string[] };
      totalCandidatesBeforeFilter: number;
      totalCandidatesAfterFilter: number;
      previewedCandidates: number;
      omittedCandidates: number;
      candidates: Array<{ sessionId: string; previewOnlyCommand: string; recommendedPreviewCommand: string }>;
    };

    expect(exitCode).toBe(0);
    expect(result.filters.statuses).toEqual(["db-only", "risky-global-state"]);
    expect(result.filters.sources).toEqual(["global_state_unknown", "sqlite"]);
    expect(result.totalCandidatesBeforeFilter).toBe(4);
    expect(result.totalCandidatesAfterFilter).toBe(2);
    expect(result.previewedCandidates).toBe(1);
    expect(result.omittedCandidates).toBe(1);
    expect([unknownGlobalId, dbOnlyId]).toContain(result.candidates[0].sessionId);
    expect(result.candidates[0].previewOnlyCommand).not.toContain("--yes");
    expect(result.candidates[0].recommendedPreviewCommand).not.toContain("--yes");
  });

  it("filters root residue candidates from the cli with repeated status and source options", async () => {
    const capture = createIo();
    const exitCode = await runCli(
      [
        "audit-root",
        "--root",
        fixture.rootDir,
        "--json",
        "--status",
        "index-only",
        "--status",
        "shell-snapshot-residue",
        "--source",
        "session-index",
        "--source",
        "shell-snapshot",
      ],
      capture.io,
    );
    const result = JSON.parse(capture.stdout.join("\n")) as {
      filters: { statuses: string[]; sources: string[] };
      totalCandidatesBeforeFilter: number;
      totalCandidatesAfterFilter: number;
      candidates: Array<{ sessionId: string }>;
    };

    expect(exitCode).toBe(0);
    expect(result.filters.statuses).toEqual(["index-only", "shell-snapshot-residue"]);
    expect(result.filters.sources).toEqual(["session_index", "shell_snapshots"]);
    expect(result.totalCandidatesBeforeFilter).toBe(2);
    expect(result.totalCandidatesAfterFilter).toBe(2);
    expect(result.candidates.map((candidate) => candidate.sessionId).sort()).toEqual(
      [FIXTURE_IDS.STALE_ID, FIXTURE_IDS.UNRELATED_ID].sort(),
    );
  });

  it("previews trash delete without --yes", async () => {
    const capture = createIo();
    const exitCode = await runCli(["delete", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--trash"], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("\n")).toContain("将移入回收站，未执行");
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
  });

  it("moves sessions to trash and restores them from the cli", async () => {
    const deletion = createIo();
    const deleteExitCode = await runCli(
      ["delete", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--trash", "--yes"],
      deletion.io,
    );
    const trashList = createIo();
    const trashListExitCode = await runCli(["trash-list", "--root", fixture.rootDir], trashList.io);

    expect(deleteExitCode).toBe(0);
    expect(deletion.stdout.join("\n")).toContain("已移入回收站");
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(trashListExitCode).toBe(0);
    expect(trashList.stdout.join("\n")).toContain(FIXTURE_IDS.ACTIVE_ID);

    const restore = createIo();
    const restoreExitCode = await runCli(["restore", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--yes"], restore.io);

    expect(restoreExitCode).toBe(0);
    expect(restore.stdout.join("\n")).toContain("已恢复");
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
  });

  it("previews and purges trash from the cli without touching live sessions", async () => {
    const deletion = createIo();
    await runCli(["delete", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--trash", "--yes"], deletion.io);
    const restore = createIo();
    await runCli(["restore", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--yes"], restore.io);

    const preview = createIo();
    const previewExitCode = await runCli(["purge", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir], preview.io);
    expect(previewExitCode).toBe(0);
    expect(preview.stdout.join("\n")).toContain("永久清除未执行");
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");

    const purge = createIo();
    const purgeExitCode = await runCli(["purge", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--yes"], purge.io);
    expect(purgeExitCode).toBe(0);
    expect(purge.stdout.join("\n")).toContain("已永久清除回收站记录");
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
  });

  it("requires exact trash ids for duplicate trash writes from the cli", async () => {
    const firstDelete = createIo();
    await runCli(["delete", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--trash", "--yes", "--json"], firstDelete.io);
    const firstTrashId = (JSON.parse(firstDelete.stdout.join("\n")) as { trashEntry: { trashId: string } }).trashEntry.trashId;

    const restoreFirst = createIo();
    await runCli(["restore", firstTrashId, "--root", fixture.rootDir, "--yes", "--json"], restoreFirst.io);

    const secondDelete = createIo();
    await runCli(["delete", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--trash", "--yes", "--json"], secondDelete.io);
    const secondTrashId = (JSON.parse(secondDelete.stdout.join("\n")) as { trashEntry: { trashId: string } }).trashEntry.trashId;

    const trashList = createIo();
    await runCli(["trash-list", "--root", fixture.rootDir, "--json"], trashList.io);
    const listed = JSON.parse(trashList.stdout.join("\n")) as {
      entries: Array<{ trashId: string; sessionIds: string[] }>;
      duplicateSessionIds: Array<{ sessionId: string; trashIds: string[] }>;
    };
    expect(listed.entries.filter((entry) => entry.sessionIds.includes(FIXTURE_IDS.ACTIVE_ID))).toHaveLength(2);
    expect(listed.duplicateSessionIds).toEqual([
      expect.objectContaining({
        sessionId: FIXTURE_IDS.ACTIVE_ID,
        trashIds: expect.arrayContaining([firstTrashId, secondTrashId]),
      }),
    ]);

    await expect(runCli(["restore", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--yes"], createIo().io)).rejects.toThrow(
      "精确 trashId",
    );
    await expect(runCli(["purge", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--yes"], createIo().io)).rejects.toThrow(
      "精确 trashId",
    );

    const exactRestore = createIo();
    const restoreExitCode = await runCli(["restore", secondTrashId, "--root", fixture.rootDir, "--yes"], exactRestore.io);
    expect(restoreExitCode).toBe(0);
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");

    const exactPurge = createIo();
    const purgeExitCode = await runCli(["purge", firstTrashId, "--root", fixture.rootDir, "--yes"], exactPurge.io);
    expect(purgeExitCode).toBe(0);
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");

    const trashListAfterPurge = createIo();
    await runCli(["trash-list", "--root", fixture.rootDir, "--json"], trashListAfterPurge.io);
    const afterPurge = JSON.parse(trashListAfterPurge.stdout.join("\n")) as { entries: Array<{ trashId: string }> };
    expect(afterPurge.entries.map((entry) => entry.trashId)).toEqual([secondTrashId]);
  });

  it("previews cleanup-stale without rewriting jsonl indexes", async () => {
    const beforeSessionIndex = await readFile(fixture.paths.sessionIndex, "utf8");
    const beforeHistory = await readFile(fixture.paths.history, "utf8");
    const capture = createIo();
    const exitCode = await runCli(["cleanup-stale", "--root", fixture.rootDir, "--json"], capture.io);
    const output = JSON.parse(capture.stdout.join("\n")) as {
      preview: { staleSessionIds: string[]; removedSessionIndexRows: number; removedHistoryRows: number };
      requiresConfirmation: boolean;
    };

    expect(exitCode).toBe(0);
    expect(output.requiresConfirmation).toBe(true);
    expect(output.preview.staleSessionIds).toEqual([FIXTURE_IDS.STALE_ID]);
    expect(output.preview.removedSessionIndexRows).toBe(1);
    expect(output.preview.removedHistoryRows).toBe(1);
    await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toBe(beforeSessionIndex);
    await expect(readFile(fixture.paths.history, "utf8")).resolves.toBe(beforeHistory);
  });

  it("executes cleanup-stale only with --yes", async () => {
    const capture = createIo();
    const exitCode = await runCli(["cleanup-stale", "--root", fixture.rootDir, "--yes", "--json"], capture.io);
    const output = JSON.parse(capture.stdout.join("\n")) as {
      staleSessionIds: string[];
      removedSessionIndexRows: number;
      removedHistoryRows: number;
    };

    expect(exitCode).toBe(0);
    expect(output.staleSessionIds).toEqual([FIXTURE_IDS.STALE_ID]);
    expect(output.removedSessionIndexRows).toBe(1);
    expect(output.removedHistoryRows).toBe(1);
    expect(await readFile(fixture.paths.sessionIndex, "utf8")).not.toContain(FIXTURE_IDS.STALE_ID);
    expect(await readFile(fixture.paths.history, "utf8")).not.toContain(FIXTURE_IDS.STALE_ID);
  });

  it("previews cleanup-index without rewriting jsonl indexes", async () => {
    const beforeSessionIndex = await readFile(fixture.paths.sessionIndex, "utf8");
    const beforeHistory = await readFile(fixture.paths.history, "utf8");
    const capture = createIo();
    const exitCode = await runCli(["cleanup-index", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--json"], capture.io);
    const output = JSON.parse(capture.stdout.join("\n")) as {
      preview: { sessionIds: string[]; removedSessionIndexRows: number; removedHistoryRows: number };
      requiresConfirmation: boolean;
    };

    expect(exitCode).toBe(0);
    expect(output.requiresConfirmation).toBe(true);
    expect(output.preview.sessionIds).toEqual([FIXTURE_IDS.ACTIVE_ID]);
    expect(output.preview.removedSessionIndexRows).toBe(1);
    expect(output.preview.removedHistoryRows).toBe(1);
    await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toBe(beforeSessionIndex);
    await expect(readFile(fixture.paths.history, "utf8")).resolves.toBe(beforeHistory);
  });

  it("executes cleanup-index only with --yes", async () => {
    const capture = createIo();
    const exitCode = await runCli(
      ["cleanup-index", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--yes", "--json"],
      capture.io,
    );
    const output = JSON.parse(capture.stdout.join("\n")) as {
      sessionIds: string[];
      removedSessionIndexRows: number;
      removedHistoryRows: number;
    };

    expect(exitCode).toBe(0);
    expect(output.sessionIds).toEqual([FIXTURE_IDS.ACTIVE_ID]);
    expect(output.removedSessionIndexRows).toBe(1);
    expect(output.removedHistoryRows).toBe(1);
    expect(await readFile(fixture.paths.sessionIndex, "utf8")).not.toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(await readFile(fixture.paths.history, "utf8")).not.toContain(FIXTURE_IDS.ACTIVE_ID);
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
  });

  it("reports restore errors readably when the trash directory is missing", async () => {
    const capture = createIo();

    try {
      await runCli(["restore", "missing-trash-id", "--root", fixture.rootDir, "--yes"], capture.io);
      throw new Error("restore should have failed");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("找不到回收站记录：missing-trash-id");
      expect((error as Error).message).not.toMatch(/ENOENT|scandir/);
    }
  });

  it("exports bundle as json to stdout", async () => {
    const capture = createIo();
    const exitCode = await runCli(["export", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--json"], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("\n")).toContain(`"sessionId": "${FIXTURE_IDS.ACTIVE_ID}"`);
    expect(capture.stdout.join("\n")).toContain('"logs": [');
    expect(capture.stdout.join("\n")).toContain('"shellSnapshots": [');
    expect(capture.stdout.join("\n")).toContain('"globalStateRefs": [');
  });
});
