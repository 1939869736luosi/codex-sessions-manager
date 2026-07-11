import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getSessionOperation,
  inspectRootOperation,
  listSessionsOperation,
} from "../src/application/session-operations.js";
import { runCli } from "../src/cli/run.js";
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

describe("shared application operations", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("returns the same canonical list result used by CLI JSON", async () => {
    const operation = await listSessionsOperation({
      root: fixture.rootDir,
      filters: { status: "active" },
      groupBy: "project",
    });
    const capture = createIo();

    await expect(
      runCli(["list", "--root", fixture.rootDir, "--status", "active", "--group-by", "project", "--json"], capture.io),
    ).resolves.toBe(0);

    expect(JSON.parse(capture.stdout.join("\n"))).toEqual(operation.data);
    expect(operation.data.sessions.map((session) => session.id)).toEqual([FIXTURE_IDS.ACTIVE_ID]);
  });

  it("returns the same canonical session result used by CLI JSON", async () => {
    const operation = await getSessionOperation({
      root: fixture.rootDir,
      sessionId: FIXTURE_IDS.ACTIVE_ID,
    });
    const capture = createIo();

    await expect(
      runCli(["show", FIXTURE_IDS.ACTIVE_ID, "--root", fixture.rootDir, "--json"], capture.io),
    ).resolves.toBe(0);

    expect(JSON.parse(capture.stdout.join("\n"))).toEqual(operation.data);
    expect(operation.data.session.id).toBe(FIXTURE_IDS.ACTIVE_ID);
    expect(operation.data.timeline.length).toBeGreaterThan(0);
  });

  it("keeps root inspection in the shared application layer", async () => {
    const result = await inspectRootOperation({ root: fixture.rootDir });

    expect(result.report.rootPath).toBe(fixture.rootDir);
    expect(result.warnings).toEqual(result.report.warnings);
    expect(result.report.detailsIncluded).toBe(false);
    expect(result.report.sampleLimit).toBe(5);
    expect(result.report.globalState.knownRefs.length).toBeLessThanOrEqual(5);
    expect(result.report.globalState.exactKeyRefs.length).toBeLessThanOrEqual(5);
    expect(result.report.globalState.possibleUnknownRefs.length).toBeLessThanOrEqual(5);
    expect(result.report.warnings.length).toBeLessThanOrEqual(20);
  });

  it("returns complete doctor references only when details are explicit", async () => {
    const summary = await inspectRootOperation({ root: fixture.rootDir });
    const details = await inspectRootOperation({ root: fixture.rootDir, includeDetails: true });

    expect(details.report.detailsIncluded).toBe(true);
    expect(details.report.sampleLimit).toBeNull();
    expect(details.report.counts.globalStateKnownRefs).toBe(details.report.globalState.knownRefs.length);
    expect(details.report.counts.globalStateExactKeyRefs).toBe(details.report.globalState.exactKeyRefs.length);
    expect(details.report.counts.globalStatePossibleUnknownRefs).toBe(details.report.globalState.possibleUnknownRefs.length);
    expect(summary.report.counts).toEqual(details.report.counts);
  });

  it("exposes doctor details through an explicit CLI flag", async () => {
    const compact = createIo();
    const detailed = createIo();

    await expect(runCli(["doctor", "--root", fixture.rootDir, "--json"], compact.io)).resolves.toBe(0);
    await expect(runCli(["doctor", "--root", fixture.rootDir, "--json", "--details"], detailed.io)).resolves.toBe(0);

    expect(JSON.parse(compact.stdout.join("\n"))).toMatchObject({ detailsIncluded: false, sampleLimit: 5 });
    expect(JSON.parse(detailed.stdout.join("\n"))).toMatchObject({ detailsIncluded: true, sampleLimit: null });
  });
});
