import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFile, readFile } from "node:fs/promises";
import Database from "better-sqlite3";

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
    expect(capture.stdout.join("\n")).toContain(FIXTURE_IDS.ACTIVE_ID);
    expect(capture.stdout.join("\n")).toContain("Active thread");
    expect(capture.stdout.join("\n")).not.toContain(`Title ${FIXTURE_IDS.ACTIVE_ID}`);
  });

  it("shows title source details in show output", async () => {
    const capture = createIo();
    const exitCode = await runCli(["show", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir], capture.io);
    const output = capture.stdout.join("\n");

    expect(exitCode).toBe(0);
    expect(output).toContain("标题: Active thread");
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
