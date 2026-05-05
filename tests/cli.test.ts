import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

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
