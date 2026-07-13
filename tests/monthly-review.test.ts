import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli/run.js";
import { deleteSessionsOperation } from "../src/application/mutation-operations.js";
import { buildRootDeletePreview, buildRootResidueAudit, buildSessionResidueAudit } from "../src/core/audit.js";
import { formatPreview } from "../src/cli/format.js";
import { scanCodexRoot } from "../src/core/scan.js";
import Database from "better-sqlite3";
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

  it("reports logs-only residue without pretending it is clean or directly deletable", async () => {
    const logsOnlyId = "019d7777-8888-7999-8aaa-bbbbbbbbbbbb";
    const db = new Database(fixture.paths.logsSqlite as string);
    db.prepare(`
      insert into logs (ts, ts_nanos, level, target, feedback_log_body, thread_id, process_uuid, estimated_bytes)
      values (99, 0, 'INFO', 'logs-only', 'residue', ?, 'fixture-process', 7)
    `).run(logsOnlyId);
    db.close();

    const scan = await scanCodexRoot(fixture.rootDir);
    const audit = buildSessionResidueAudit(scan, logsOnlyId);
    expect(audit.overallStatus).toContain("db-only");
    expect(audit.counts.sqliteRows).toBe(1);
    expect(audit.warnings.join("\n")).toContain("logs-only");
    expect(audit.warnings.join("\n")).not.toContain("当前默认保留");
    expect(audit.recommendedNextCommand).toBeNull();
    expect(audit.recommendedNextCommandNote).toContain("logs-only");

    const rootAudit = buildRootResidueAudit(scan);
    const candidate = rootAudit.candidates.find((item) => item.sessionId === logsOnlyId);
    expect(candidate?.surfaces.sqliteRows).toBe(1);
    const rootPreview = buildRootDeletePreview(scan);
    const previewCandidate = rootPreview.candidates.find((item) => item.sessionId === logsOnlyId);
    expect(previewCandidate).toMatchObject({ deleteSupported: false });
    expect(previewCandidate?.deleteUnsupportedReason).toContain("logs-only");
    expect(previewCandidate?.recommendedPreviewCommand).toBe(candidate?.recommendedAuditCommand);
  });

  it("distinguishes permanent-delete logs from trash-retained logs in previews", async () => {
    const permanent = await deleteSessionsOperation({
      root: fixture.rootDir,
      sessionIds: [FIXTURE_IDS.ACTIVE_ID],
      confirm: false,
    });
    const trash = await deleteSessionsOperation({
      root: fixture.rootDir,
      sessionIds: [FIXTURE_IDS.ACTIVE_ID],
      confirm: false,
      trash: true,
    });
    if (permanent.executed || trash.executed) throw new Error("expected preview results");

    expect(permanent.data.preview.dedicatedLogsRetained).toBe(false);
    expect(trash.data.preview.dedicatedLogsRetained).toBe(true);
    expect(permanent.data.preview.totals.sqliteRows).toBe(trash.data.preview.totals.sqliteRows + 1);
    expect(formatPreview(permanent.data.preview)).toContain("sqlite_delete: logs=1");
    expect(formatPreview(trash.data.preview)).toContain("sqlite_retained: logs=1");
  });
});
