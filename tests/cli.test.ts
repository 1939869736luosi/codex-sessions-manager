import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

  it("shows delete preview without --yes", async () => {
    const capture = createIo();
    const exitCode = await runCli(["delete", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("\n")).toContain("将处理 1 条会话");
    expect(capture.stdout.join("\n")).toContain("session_index");
  });

  it("deletes sessions when --yes is passed", async () => {
    const capture = createIo();
    const exitCode = await runCli(["delete", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--yes"], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("\n")).toContain("已清理干净");

    const list = createIo();
    const listExitCode = await runCli(["list", "--root", fixture.rootDir], list.io);
    expect(listExitCode).toBe(0);
    expect(list.stdout.join("\n")).not.toContain(FIXTURE_IDS.ACTIVE_ID);
  });

  it("exports bundle as json to stdout", async () => {
    const capture = createIo();
    const exitCode = await runCli(["export", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--json"], capture.io);

    expect(exitCode).toBe(0);
    expect(capture.stdout.join("\n")).toContain(`"sessionId": "${FIXTURE_IDS.ACTIVE_ID}"`);
    expect(capture.stdout.join("\n")).toContain('"logs": [');
  });
});
