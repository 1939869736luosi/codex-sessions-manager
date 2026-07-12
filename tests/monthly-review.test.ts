import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli/run.js";
import { buildRootResidueAudit } from "../src/core/audit.js";
import { scanCodexRoot } from "../src/core/scan.js";
import { createFixture, type Fixture } from "./helpers/fixture.js";

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

describe("monthly residue review", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await createFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("combines the existing read-only audit and preview into one monthly report", async () => {
    const beforeIndex = await fixture.readText("session_index.jsonl");
    const beforeHistory = await fixture.readText("history.jsonl");
    const capture = createIo();

    await expect(runCli(["monthly-review", "--root", fixture.rootDir, "--json"], capture.io)).resolves.toBe(0);
    const result = JSON.parse(capture.stdout.join("\n")) as {
      readOnly: boolean;
      officialDeleteFirst: boolean;
      audit: { totalCandidatesAfterFilter: number };
      preview: { previewedCandidates: number };
      nextSteps: string[];
    };

    expect(result.readOnly).toBe(true);
    expect(result.officialDeleteFirst).toBe(true);
    expect(result.audit.totalCandidatesAfterFilter).toBeGreaterThan(0);
    expect(result.preview.previewedCandidates).toBeGreaterThan(0);
    expect(result.nextSteps.join("\n")).toContain("codex-sessions audit");
    expect(result.nextSteps.join("\n")).not.toContain("--yes");
    await expect(fixture.readText("session_index.jsonl")).resolves.toBe(beforeIndex);
    await expect(fixture.readText("history.jsonl")).resolves.toBe(beforeHistory);
  });

  it("returns at most five warning samples by default and all warnings only with details", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    scan.warnings = Array.from({ length: 12 }, (_, index) => `warning-${index + 1}`);

    const summary = buildRootResidueAudit(scan);
    expect(summary.warningSummary).toEqual({ total: 12, returned: 5, omitted: 7 });
    expect(summary.warnings).toHaveLength(5);
    expect(summary.candidates.every((candidate) =>
      candidate.warnings.every((warning) => !warning.startsWith("warning-")))).toBe(true);
    expect(JSON.stringify(summary).match(/warning-/gu)).toHaveLength(5);

    const details = buildRootResidueAudit(scan, { includeDetails: true });
    expect(details.warningSummary).toEqual({ total: 12, returned: 12, omitted: 0 });
    expect(details.warnings).toHaveLength(12);
  });
});
