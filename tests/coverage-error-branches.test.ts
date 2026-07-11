import os from "node:os";
import path from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatDoctor,
  formatGroupedList,
  formatList,
  formatProjects,
  formatShow,
  formatTrashEntries,
  formatTrashRestoreResult,
} from "../src/cli/format.js";
import { inspectCodexRoot } from "../src/core/doctor.js";
import { acquireMutationLock } from "../src/core/mutation-safety.js";
import { createTrustedRootContext } from "../src/core/path-safety.js";
import {
  buildDeletePlanFile,
  buildDeletePlanRootFingerprint,
  parseDeletePlanObject,
  previewDeletePlan,
  readDeletePlanFile,
  writeDeletePlanFile,
} from "../src/core/plan-file.js";
import { buildPlanDelete } from "../src/core/plan-delete.js";
import {
  createRecoveryFileState,
  parseOperationRecoveryPayload,
  recoverInterruptedOperation,
  type OperationRecoveryPayloadV1,
} from "../src/core/recovery.js";
import { scanCodexRoot } from "../src/core/scan.js";
import type { DeletePlanSurfaceFingerprint, SessionEntry, TrashEntrySummary } from "../src/core/types.js";
import { isMcpEntrypoint, parseProfile } from "../src/mcp/server.js";
import { createFixture, FIXTURE_IDS } from "./helpers/fixture.js";

const cleanupPaths: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("delete plan error and stale branches", () => {
  it("rejects unsupported, tampered, and invalid-json plan files", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const plan = await buildDeletePlanFile(scan, buildPlanDelete(scan, [FIXTURE_IDS.ARCHIVED_ID]));
    const output = path.join(await makeTempRoot("csm-plan-errors-"), "plan.json");

    expect(() => parseDeletePlanObject({ ...plan, schemaVersion: "future" })).toThrow("不支持的 plan schema");
    expect(() => parseDeletePlanObject({ ...plan, selectedIds: [FIXTURE_IDS.STALE_ID] })).toThrow("planHash 校验失败");
    await writeDeletePlanFile(output, scan, buildPlanDelete(scan, [FIXTURE_IDS.ARCHIVED_ID]));
    await expect(readDeletePlanFile(output)).resolves.toMatchObject({ schemaVersion: plan.schemaVersion });
    await writeFile(output, "not json\n", "utf8");
    await expect(readDeletePlanFile(output)).rejects.toThrow();
  });

  it("fingerprints missing, unreadable, malformed JSONL, and malformed SQLite surfaces", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const malformed = path.join(fixture.rootDir, "malformed.txt");
    const missing = path.join(fixture.rootDir, "missing.jsonl");
    await writeFile(malformed, "not json and not sqlite\n", "utf8");
    Object.assign(scan.root, {
      sessionIndexPath: null,
      historyPath: missing,
      globalStatePath: malformed,
      sqlitePath: malformed,
      logsSqlitePath: null,
      goalsSqlitePath: malformed,
      memoriesSqlitePath: null,
    });

    const fingerprint = await buildDeletePlanRootFingerprint(scan);

    expect(fingerprint.sessionIndex).toMatchObject({ path: null, exists: false, parseable: false });
    expect(fingerprint.history).toMatchObject({ path: missing, exists: false, parseable: false });
    expect(fingerprint.globalState).toMatchObject({ exists: true, parseable: false });
    expect(fingerprint.sqlite).toMatchObject({ exists: true, parseable: false });
    expect(fingerprint.logsSqlite).toMatchObject({ path: null, exists: false });
    expect(fingerprint.sqliteHomeRealpath).toMatch(new RegExp(`${path.basename(fixture.rootDir)}$`));
  });

  it("reports every changed root fingerprint field and selected snapshot component as stale", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const plan = await buildDeletePlanFile(scan, buildPlanDelete(scan, [FIXTURE_IDS.ARCHIVED_ID]));
    const changedSurface = (surface: DeletePlanSurfaceFingerprint): DeletePlanSurfaceFingerprint => ({
      path: surface.path === null ? "/changed" : `${surface.path}.changed`,
      availability: surface.availability === "available" ? "unsafe" : "available",
      unsafeReason: surface.unsafeReason === null ? "changed" : null,
      exists: !surface.exists,
      size: surface.size === null ? 1 : surface.size + 1,
      mtimeMs: surface.mtimeMs === null ? 1 : surface.mtimeMs + 1,
      sha256: surface.sha256 === null ? "changed" : null,
      parseable: !surface.parseable,
    });
    const changedPlan = {
      ...plan,
      rootFingerprint: {
        ...plan.rootFingerprint,
        rootRealpath: `${plan.rootFingerprint.rootRealpath}.changed`,
        sqliteHomeRealpath: `${plan.rootFingerprint.sqliteHomeRealpath ?? "missing"}.changed`,
        sqliteHomeSource: plan.rootFingerprint.sqliteHomeSource === "default"
          ? "CODEX_SQLITE_HOME"
          : "default",
        sessionIndex: changedSurface(plan.rootFingerprint.sessionIndex),
        history: changedSurface(plan.rootFingerprint.history),
        globalState: changedSurface(plan.rootFingerprint.globalState),
        sqlite: changedSurface(plan.rootFingerprint.sqlite),
        logsSqlite: changedSurface(plan.rootFingerprint.logsSqlite),
        goalsSqlite: changedSurface(plan.rootFingerprint.goalsSqlite),
        memoriesSqlite: changedSurface(plan.rootFingerprint.memoriesSqlite),
      },
      selectedSnapshot: {
        surfaceCounts: { ...plan.selectedSnapshot.surfaceCounts, historyRows: 999 },
        familyEdges: [{ parentThreadId: "p", childThreadId: "c", status: null }],
        exactKeyGlobalStatePaths: ["$.changed"],
      },
    };

    const preview = await previewDeletePlan(scan, changedPlan);

    expect(preview.stale).toBe(true);
    expect(preview.deletePreview).toBeNull();
    expect(preview.staleReasons).toEqual(expect.arrayContaining([
      expect.stringContaining("root realpath changed"),
      expect.stringContaining("sqlite home realpath changed"),
      expect.stringContaining("sqlite home source changed"),
      "session_index path changed",
      "session_index exists changed",
      "session_index size changed",
      "session_index mtimeMs changed",
      "session_index parseable changed",
      "selected surface counts changed",
      "sqlite family edges changed",
      "global-state exact-key paths changed",
    ]));
  });

  it("rejects active and missing selected IDs during plan preview", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const base = await buildDeletePlanFile(scan, buildPlanDelete(scan, [FIXTURE_IDS.ARCHIVED_ID]));
    const unknownId = "019dffff-eeee-7ddd-8ccc-bbbbbbbbbbbb";

    const active = await previewDeletePlan(scan, { ...base, selectedIds: [FIXTURE_IDS.ACTIVE_ID], rejectedIds: [] });
    const missing = await previewDeletePlan(scan, { ...base, selectedIds: [unknownId], rejectedIds: [] });

    expect(active.deletableSelectedIds).toEqual([]);
    expect(active.rejectedIds).toContainEqual({
      sessionId: FIXTURE_IDS.ACTIVE_ID,
      reason: "active-session-refused-by-preview-plan",
    });
    expect(missing.rejectedIds).toContainEqual({
      sessionId: unknownId,
      reason: "selected-session-missing-in-current-scan",
    });
  });
});

describe("formatter condition branches", () => {
  it("formats null, invalid, long, warning, and large-size session fields", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const base = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID)!;
    const variants: SessionEntry[] = [
      { ...base, updatedAt: null, totalFileSize: 0, model: null, modelProvider: null, displayTitle: "short" },
      { ...base, id: FIXTURE_IDS.ARCHIVED_ID, updatedAt: "invalid-date", totalFileSize: 1536, displayTitle: "x".repeat(80) },
      { ...base, id: FIXTURE_IDS.STALE_ID, updatedAt: base.updatedAt, totalFileSize: 2 * 1024 * 1024 },
      { ...base, id: FIXTURE_IDS.UNRELATED_ID, updatedAt: base.updatedAt, totalFileSize: 2 * 1024 * 1024 * 1024 },
    ];
    const warnedScan = { ...scan, warnings: ["scan warning"] };

    const list = formatList(warnedScan, variants);
    const grouped = formatGroupedList(warnedScan, variants);
    const projects = formatProjects([
      {
        projectName: "p",
        projectPath: null,
        sessionCount: 1,
        activeCount: 1,
        archivedCount: 0,
        dbOnlyCount: 0,
        staleCount: 0,
        latestUpdatedAt: "invalid-date",
        totalFileSize: 0,
      },
    ]);

    expect(list).toContain("invalid-date");
    expect(list).toContain("1.5 KB");
    expect(list).toContain("2.0 MB");
    expect(list).toContain("2.0 GB");
    expect(list).toContain("scan warning");
    expect(grouped).toContain("scan warning");
    expect(projects).toContain("invalid-date");
  });

  it("formats doctor missing, warning, recovery, absent SQLite, and warning-table states", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const report = await inspectCodexRoot(fixture.rootDir);
    const changed = structuredClone(report);
    changed.paths.sessionsDir.exists = false;
    changed.paths.sessionsDir.readable = false;
    changed.paths.archivedSessionsDir.exists = true;
    changed.paths.archivedSessionsDir.readable = false;
    changed.paths.globalState.parseable = false;
    changed.sqlite.sqliteHomeConfigPath = "/tmp/config.toml";
    changed.sqlite.activeStatePath = null;
    changed.sqlite.activeLogsPath = null;
    changed.sqlite.activeGoalsPath = null;
    changed.sqlite.activeMemoriesPath = null;
    changed.sqlite.stateTables = [{ table: "missing_table", exists: false, associationColumns: [] }];
    changed.sqlite.logsTables = [];
    changed.sqlite.goalsTables = [];
    changed.sqlite.memoriesTables = [];
    changed.scan.sessionCount = null;
    changed.recovery = {
      pending: true,
      operationId: null,
      kind: "invalid",
      stage: "recovery_required",
      targetIds: [],
      hasRecoveryPayload: false,
      invalidReason: "bad lock",
    };
    changed.warnings = ["doctor warning"];

    const text = formatDoctor(changed);

    expect(text).toMatch(/sessions\s+missing/u);
    expect(text).toMatch(/archived_sessions\s+warning/u);
    expect(text).toContain("SQLite home config: /tmp/config.toml");
    expect(text).toContain("sessions: unknown");
    expect(text).toContain("recovery pending: 是");
    expect(text).toContain("doctor warning");
  });

  it("formats empty and long show fields plus timeline overflow", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID)!;
    const changed: SessionEntry = {
      ...session,
      displayTitle: " ",
      titleMismatch: false,
      indexTitle: null,
      sqliteTitle: "z".repeat(220),
      firstUserMessage: null,
      titleCandidates: [{ source: "id", title: "" }],
      createdAt: null,
      updatedAt: "invalid-date",
      source: null,
      threadSource: null,
      modelProvider: null,
      model: null,
      agentRole: null,
      agentNickname: null,
      cwd: null,
      rolloutPath: null,
      hasThread: false,
    };
    const timeline = Array.from({ length: 21 }, (_, index) => ({
      kind: "user" as const,
      roleLabel: "用户",
      timestamp: null,
      body: `line ${index}\nmore`,
    }));

    const text = formatShow(changed, timeline);

    expect(text).toContain("标题: -");
    expect(text).toContain("220 chars");
    expect(text).toContain("更新时间: invalid-date");
    expect(text).toContain("还有 1 条");
    expect(text).toContain("SQLite 线程: 否");
  });

  it("formats empty, invalid, valid, and duplicate trash entries", () => {
    const valid = (trashId: string, sessionId: string): TrashEntrySummary => ({
      trashId,
      status: "valid",
      invalidReason: null,
      createdAt: null,
      sessionIds: [sessionId],
      sessions: [{ sessionId, title: "Title", archived: false }],
      path: `/trash/${trashId}`,
    });
    const invalid: TrashEntrySummary = {
      trashId: "invalid-entry",
      status: "invalid",
      invalidReason: null,
      createdAt: "bad-date",
      sessionIds: [],
      sessions: [],
      path: "/trash/invalid-entry",
    };

    expect(formatTrashEntries([])).toBe("回收站为空");
    expect(formatTrashEntries([invalid])).toContain("manifest invalid");
    const duplicateText = formatTrashEntries([
      valid("one", FIXTURE_IDS.ARCHIVED_ID),
      valid("two", FIXTURE_IDS.ARCHIVED_ID),
    ]);
    expect(duplicateText).toContain("重复 session_id");
    expect(duplicateText).toContain("2 条 trash entry");
  });

  it("formats passed and partial trash restore results with optional details", () => {
    const base = {
      trashEntry: {
        trashId: "trash-id",
        status: "valid",
        invalidReason: null,
        createdAt: null,
        sessionIds: [FIXTURE_IDS.ARCHIVED_ID],
        sessions: [],
        path: "/trash/trash-id",
      },
      restoredSessionIds: [FIXTURE_IDS.ARCHIVED_ID],
      restoredSessionFiles: 1,
      restoredShellSnapshots: 0,
      restoredSessionIndexRecords: 1,
      restoredHistoryRecords: 1,
      restoredGlobalStateRefs: 0,
      restoredSqliteRows: { total: 1 },
      skippedSqliteRows: { total: 0 },
      skippedSqliteTables: [],
      operationStatus: "committed",
      verificationStatus: "passed",
      verificationScope: {},
      warnings: [],
      errorCode: null,
    } as unknown as Parameters<typeof formatTrashRestoreResult>[0];

    expect(formatTrashRestoreResult(base)).toContain("验证通过");
    expect(formatTrashRestoreResult({
      ...base,
      verificationStatus: "partial",
      skippedSqliteTables: ["logs"],
      warnings: ["retained"],
    })).toContain("验证不完整");
  });
});

describe("recovery schema and terminal branches", () => {
  const interrupted = {
    operationId: "019daaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee",
    kind: "delete",
    targetIds: [FIXTURE_IDS.ACTIVE_ID],
  };

  function validPayload(): OperationRecoveryPayloadV1 {
    return {
      schemaVersion: "codex-sessions-recovery.v1",
      operationId: interrupted.operationId,
      kind: "delete",
      strategy: "rollback",
      rootRealPath: "/trusted/root",
      targetIds: [...interrupted.targetIds],
      files: [{
        relativePath: "session_index.jsonl",
        before: createRecoveryFileState("before\n"),
        after: createRecoveryFileState(null),
      }],
    };
  }

  it("rejects each malformed recovery payload boundary", () => {
    expect(() => parseOperationRecoveryPayload(null, interrupted)).toThrow("missing or invalid");
    expect(() => parseOperationRecoveryPayload([], interrupted)).toThrow("missing or invalid");
    const changes: Array<(payload: Record<string, unknown>) => void> = [
      (payload) => { payload.schemaVersion = "future"; },
      (payload) => { payload.operationId = "019dbbbb-cccc-7ddd-8eee-ffffffffffff"; },
      (payload) => { payload.kind = "restore"; },
      (payload) => { payload.strategy = "sideways"; },
      (payload) => { payload.rootRealPath = 42; },
      (payload) => { payload.targetIds = "invalid"; },
      (payload) => { payload.targetIds = []; },
      (payload) => { payload.files = "invalid"; },
    ];
    for (const change of changes) {
      const payload = validPayload() as unknown as Record<string, unknown>;
      change(payload);
      expect(() => parseOperationRecoveryPayload(payload, interrupted)).toThrow("does not match its lock");
    }

    const invalidTransitions: unknown[] = [
      null,
      {},
      { relativePath: 7, before: createRecoveryFileState(null), after: createRecoveryFileState(null) },
      { relativePath: "x", before: null, after: createRecoveryFileState(null) },
      { relativePath: "x", before: { exists: "yes" }, after: createRecoveryFileState(null) },
      { relativePath: "x", before: { exists: true, sha256: null, dataBase64: null }, after: createRecoveryFileState(null) },
      { relativePath: "x", before: { exists: true, sha256: "0".repeat(64), dataBase64: "YQ==" }, after: createRecoveryFileState(null) },
      { relativePath: "x", before: { exists: false, sha256: "0".repeat(64), dataBase64: "" }, after: createRecoveryFileState(null) },
    ];
    for (const transition of invalidTransitions) {
      const payload = validPayload() as unknown as Record<string, unknown>;
      payload.files = [transition];
      expect(() => parseOperationRecoveryPayload(payload, interrupted)).toThrow("RECOVERY_REQUIRED");
    }
    expect(parseOperationRecoveryPayload(validPayload(), interrupted)).toMatchObject({ strategy: "rollback" });
    expect(createRecoveryFileState(Buffer.from("bytes"))).toMatchObject({ exists: true });
  });

  it("refuses recovery without a lock and clears a prepared no-payload lock", async () => {
    const emptyRoot = await makeTempRoot("csm-recovery-empty-");
    await mkdir(path.join(emptyRoot, "sessions"));
    await expect(recoverInterruptedOperation(emptyRoot)).rejects.toThrow("no interrupted mutation");

    const root = await makeTempRoot("csm-recovery-prepared-");
    await mkdir(path.join(root, "sessions"));
    const context = await createTrustedRootContext(root);
    const lock = await acquireMutationLock(context, "cleanup-index", [FIXTURE_IDS.ACTIVE_ID]);
    const result = await recoverInterruptedOperation(root);
    expect(result).toMatchObject({
      operationId: lock.operationId,
      recoveredBy: "rollback",
      operationStatus: "rolled_back",
    });
    expect(result.warnings.join("\n")).toContain("任何 mutation 前中断");
  });

  it("finalizes a rolled-back stale lock", async () => {
    const root = await makeTempRoot("csm-recovery-rolled-back-");
    await mkdir(path.join(root, "sessions"));
    const context = await createTrustedRootContext(root);
    const lock = await acquireMutationLock(context, "cleanup-index", [FIXTURE_IDS.ACTIVE_ID]);
    await lock.release("recovery_required");
    const journalPath = path.join(root, lock.journalRelativePath);
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
    journal.stage = "rolled_back";
    await writeFile(journalPath, `${JSON.stringify(journal)}\n`, "utf8");

    const result = await recoverInterruptedOperation(root);

    expect(result).toMatchObject({ recoveredBy: "finalize-rolled-back", operationStatus: "rolled_back" });
  });

  it("refuses a recovery payload belonging to another root", async () => {
    const root = await makeTempRoot("csm-recovery-wrong-root-");
    await mkdir(path.join(root, "sessions"));
    const context = await createTrustedRootContext(root);
    const lock = await acquireMutationLock(context, "delete", [FIXTURE_IDS.ACTIVE_ID]);
    await lock.writeRecoveryPayload({
      ...validPayload(),
      operationId: lock.operationId,
      rootRealPath: `${context.realPath}.other`,
    });
    await lock.setStage("committing");

    await expect(recoverInterruptedOperation(root)).rejects.toThrow("different trusted root");
  });
});

describe("MCP argument and entrypoint branches", () => {
  it("rejects an invalid MCP profile value", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    expect(() => parseProfile(["node", "server.js", "--profile", "writer"])).toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("invalid --profile value"));
  });

  it("returns false for missing and different MCP entrypoint paths", async () => {
    const root = await makeTempRoot("csm-mcp-entry-");
    const first = path.join(root, "one.js");
    const second = path.join(root, "two.js");
    await writeFile(first, "", "utf8");
    await writeFile(second, "", "utf8");

    expect(isMcpEntrypoint(undefined, pathToFileURL(first).href)).toBe(false);
    expect(isMcpEntrypoint(second, pathToFileURL(first).href)).toBe(false);
  });
});
