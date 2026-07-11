import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

import { buildDeletePreview } from "./delete.js";
import { safeJsonParse, splitJsonLines } from "./jsonl.js";
import { resolveSessions } from "./query.js";
import { writePrivateOutputFile } from "./private-output.js";
import {
  assertTrustedRootCurrent,
  getRegisteredTrustedRoots,
  isPathSafetyError,
  readManagedFileWithMetadata,
  toManagedRelativePath,
  type TrustedRootContext,
} from "./path-safety.js";
import type {
  DeletePlanFile,
  DeletePlanRootFingerprint,
  DeletePlanSelectedSnapshot,
  DeletePlanSurfaceFingerprint,
  PlanDeleteResult,
  PreviewPlanResult,
  ScanResult,
  ScanSafetyIssue,
  SessionEntry,
} from "./types.js";

const PLAN_SCHEMA_VERSION = "codex-sessions-delete-plan.v1";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

function hashPlan(plan: Omit<DeletePlanFile, "planHash">): string {
  return crypto.createHash("sha256").update(stableJson(plan)).digest("hex");
}

function parseJsonlText(text: string): boolean {
  return splitJsonLines(text).every((line) => safeJsonParse<unknown>(line) !== null);
}

function parseSqlite(bytes: Buffer): boolean {
  if (bytes.length < 100 || !bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0", "binary"))) {
    return false;
  }
  const encodedPageSize = bytes.readUInt16BE(16);
  const pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
  return pageSize >= 512
    && pageSize <= 65_536
    && (pageSize & (pageSize - 1)) === 0
    && bytes.length % pageSize === 0;
}

function missingFingerprint(filePath: string | null): DeletePlanSurfaceFingerprint {
  return {
    path: filePath,
    availability: "missing",
    unsafeReason: null,
    exists: false,
    size: null,
    mtimeMs: null,
    sha256: null,
    parseable: false,
  };
}

function unsafeFingerprint(filePath: string | null, reason: string): DeletePlanSurfaceFingerprint {
  return {
    path: filePath,
    availability: "unsafe",
    unsafeReason: reason,
    exists: false,
    size: null,
    mtimeMs: null,
    sha256: null,
    parseable: false,
  };
}

async function fingerprintManagedFile(
  context: TrustedRootContext | null,
  filePath: string | null,
  parseable: (bytes: Buffer) => boolean,
  scanIssue?: ScanSafetyIssue,
): Promise<DeletePlanSurfaceFingerprint> {
  if (scanIssue) {
    return unsafeFingerprint(filePath ?? scanIssue.path, `${scanIssue.code}: ${scanIssue.reason}`);
  }
  if (!filePath) {
    return missingFingerprint(null);
  }
  if (!context) {
    return unsafeFingerprint(filePath, "UNSAFE_PATH: registered trusted root is unavailable");
  }

  try {
    const relativePath = toManagedRelativePath(context, filePath);
    const { bytes, size, mtimeMs } = await readManagedFileWithMetadata(context, relativePath);
    let isParseable = false;
    try {
      isParseable = parseable(bytes);
    } catch {
      isParseable = false;
    }
    return {
      path: filePath,
      availability: "available",
      unsafeReason: null,
      exists: true,
      size,
      mtimeMs,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      parseable: isParseable,
    };
  } catch (error) {
    if (isPathSafetyError(error)) {
      if (error.reason.includes("does not exist")) return missingFingerprint(filePath);
      return unsafeFingerprint(filePath, error.message);
    }
    return unsafeFingerprint(
      filePath,
      `UNSAFE_PATH: managed fingerprint read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function issueFor(scan: ScanResult, surface: ScanSafetyIssue["surface"]): ScanSafetyIssue | undefined {
  return scan.safety?.unsafeSurfaces.find((issue) => issue.surface === surface)
    ?? scan.root.unsafeSurfaces?.find((issue) => issue.surface === surface);
}

export async function buildDeletePlanRootFingerprint(scan: ScanResult): Promise<DeletePlanRootFingerprint> {
  const registered = getRegisteredTrustedRoots(scan.root);
  const rootContext = registered?.root ?? null;
  const sqliteContext = registered?.sqliteHome ?? null;
  if (rootContext) await assertTrustedRootCurrent(rootContext);
  if (sqliteContext) await assertTrustedRootCurrent(sqliteContext);
  const parseJsonl = (bytes: Buffer): boolean => parseJsonlText(bytes.toString("utf8"));
  return {
    rootRealpath: rootContext?.realPath ?? null,
    sqliteHomeRealpath: sqliteContext?.realPath ?? null,
    sqliteHomeSource: scan.root.sqliteHomeSource,
    sessionIndex: await fingerprintManagedFile(rootContext, scan.root.sessionIndexPath, parseJsonl, issueFor(scan, "session_index")),
    history: await fingerprintManagedFile(rootContext, scan.root.historyPath, parseJsonl, issueFor(scan, "history")),
    globalState: await fingerprintManagedFile(rootContext, scan.root.globalStatePath, (bytes) => {
      JSON.parse(bytes.toString("utf8"));
      return true;
    }, issueFor(scan, "global_state")),
    sqlite: await fingerprintManagedFile(sqliteContext, scan.root.sqlitePath, parseSqlite, issueFor(scan, "sqlite_state") ?? issueFor(scan, "sqlite_home")),
    logsSqlite: await fingerprintManagedFile(sqliteContext, scan.root.logsSqlitePath, parseSqlite, issueFor(scan, "sqlite_logs") ?? issueFor(scan, "sqlite_home")),
    goalsSqlite: await fingerprintManagedFile(sqliteContext, scan.root.goalsSqlitePath, parseSqlite, issueFor(scan, "sqlite_goals") ?? issueFor(scan, "sqlite_home")),
    memoriesSqlite: await fingerprintManagedFile(sqliteContext, scan.root.memoriesSqlitePath, parseSqlite, issueFor(scan, "sqlite_memories") ?? issueFor(scan, "sqlite_home")),
  };
}

function buildSelectedSnapshot(scan: ScanResult, selectedIds: string[]): DeletePlanSelectedSnapshot {
  const selected = new Set(selectedIds);
  const selectedSessions = selectedIds
    .map((id) => scan.sessions.find((session) => session.id === id))
    .filter((session): session is SessionEntry => Boolean(session));

  return {
    surfaceCounts: buildDeletePreview(scan, selectedSessions).totals,
    familyEdges: scan.sqlite.threadSpawnEdges
      .filter((edge) => selected.has(edge.parentThreadId) || selected.has(edge.childThreadId))
      .map((edge) => ({
        parentThreadId: edge.parentThreadId,
        childThreadId: edge.childThreadId,
        status: edge.status,
      }))
      .sort((left, right) =>
        left.parentThreadId.localeCompare(right.parentThreadId) ||
        left.childThreadId.localeCompare(right.childThreadId) ||
        (left.status ?? "").localeCompare(right.status ?? ""),
      ),
    exactKeyGlobalStatePaths: selectedIds
      .flatMap((id) => scan.globalState.exactKeyRefsById.get(id) ?? [])
      .map((ref) => ref.path)
      .sort(),
  };
}

export async function buildDeletePlanFile(scan: ScanResult, plan: PlanDeleteResult): Promise<DeletePlanFile> {
  const withoutHash: Omit<DeletePlanFile, "planHash"> = {
    ...plan,
    schemaVersion: PLAN_SCHEMA_VERSION,
    scanTimestamp: new Date().toISOString(),
    rootFingerprint: await buildDeletePlanRootFingerprint(scan),
    selectedSnapshot: buildSelectedSnapshot(scan, plan.selectedIds),
  };

  return { ...withoutHash, planHash: hashPlan(withoutHash) };
}

export async function writeDeletePlanFile(outputPath: string, scan: ScanResult, plan: PlanDeleteResult): Promise<DeletePlanFile> {
  const planFile = await buildDeletePlanFile(scan, plan);
  await writePrivateOutputFile(outputPath, `${JSON.stringify(planFile, null, 2)}\n`);
  return planFile;
}

function compareFingerprint(
  label: string,
  planned: DeletePlanSurfaceFingerprint,
  current: DeletePlanSurfaceFingerprint,
): string[] {
  const reasons: string[] = [];
  for (const key of [
    "path",
    "availability",
    "unsafeReason",
    "exists",
    "size",
    "mtimeMs",
    "sha256",
    "parseable",
  ] as const) {
    if (planned[key] !== current[key]) {
      reasons.push(`${label} ${key} changed`);
    }
  }
  return reasons;
}

function compareSnapshot(planned: DeletePlanSelectedSnapshot, current: DeletePlanSelectedSnapshot): string[] {
  const reasons: string[] = [];
  if (stableJson(planned.surfaceCounts) !== stableJson(current.surfaceCounts)) {
    reasons.push("selected surface counts changed");
  }
  if (stableJson(planned.familyEdges) !== stableJson(current.familyEdges)) {
    reasons.push("sqlite family edges changed");
  }
  if (stableJson(planned.exactKeyGlobalStatePaths) !== stableJson(current.exactKeyGlobalStatePaths)) {
    reasons.push("global-state exact-key paths changed");
  }
  return reasons;
}

export async function readDeletePlanFile(planPath: string): Promise<DeletePlanFile> {
  return parseDeletePlanObject(JSON.parse(await readFile(planPath, "utf8")));
}

export function parseDeletePlanObject(value: unknown): DeletePlanFile {
  const plan = value as DeletePlanFile;
  if (plan.schemaVersion !== PLAN_SCHEMA_VERSION) {
    throw new Error(`不支持的 plan schema：${String(plan.schemaVersion)}`);
  }
  const { planHash, ...withoutHash } = plan;
  const expectedHash = hashPlan(withoutHash);
  if (planHash !== expectedHash) {
    throw new Error("planHash 校验失败；plan file 可能被修改，请重新生成。");
  }
  return plan;
}

export async function previewDeletePlan(scan: ScanResult, plan: DeletePlanFile): Promise<PreviewPlanResult> {
  const currentFingerprint = await buildDeletePlanRootFingerprint(scan);
  const staleReasons = [
    ...(plan.rootFingerprint.rootRealpath !== currentFingerprint.rootRealpath
      ? [`root realpath changed: ${plan.rootFingerprint.rootRealpath} -> ${currentFingerprint.rootRealpath}`]
      : []),
    ...(plan.rootFingerprint.sqliteHomeRealpath !== currentFingerprint.sqliteHomeRealpath
      ? [`sqlite home realpath changed: ${plan.rootFingerprint.sqliteHomeRealpath ?? "missing"} -> ${currentFingerprint.sqliteHomeRealpath ?? "missing"}`]
      : []),
    ...(plan.rootFingerprint.sqliteHomeSource !== currentFingerprint.sqliteHomeSource
      ? [`sqlite home source changed: ${plan.rootFingerprint.sqliteHomeSource} -> ${currentFingerprint.sqliteHomeSource}`]
      : []),
    ...compareFingerprint("session_index", plan.rootFingerprint.sessionIndex, currentFingerprint.sessionIndex),
    ...compareFingerprint("history", plan.rootFingerprint.history, currentFingerprint.history),
    ...compareFingerprint("global-state", plan.rootFingerprint.globalState, currentFingerprint.globalState),
    ...compareFingerprint("sqlite", plan.rootFingerprint.sqlite, currentFingerprint.sqlite),
    ...compareFingerprint("sqlite logs", plan.rootFingerprint.logsSqlite, currentFingerprint.logsSqlite),
    ...compareFingerprint("sqlite goals", plan.rootFingerprint.goalsSqlite, currentFingerprint.goalsSqlite),
    ...compareFingerprint("sqlite memories", plan.rootFingerprint.memoriesSqlite, currentFingerprint.memoriesSqlite),
    ...compareSnapshot(plan.selectedSnapshot, buildSelectedSnapshot(scan, plan.selectedIds)),
  ];
  const stale = staleReasons.length > 0;
  const rejectedIds = [...plan.rejectedIds];
  const selectedSessions = plan.selectedIds.flatMap((id) => {
    let session: SessionEntry | undefined;
    try {
      session = resolveSessions(scan, [id])[0];
    } catch {
      rejectedIds.push({ sessionId: id, reason: "selected-session-missing-in-current-scan" });
      return [];
    }
    if (!session) {
      rejectedIds.push({ sessionId: id, reason: "selected-session-missing-in-current-scan" });
      return [];
    }
    if (session.kind === "active") {
      rejectedIds.push({ sessionId: id, reason: "active-session-refused-by-preview-plan" });
      return [];
    }
    return [session];
  });
  const deletableSelectedIds = selectedSessions.map((session) => session.id);
  const deletePreview = stale ? null : buildDeletePreview(scan, selectedSessions);

  return {
    readOnly: true,
    executionSupported: false,
    planSchemaVersion: plan.schemaVersion,
    planHash: plan.planHash,
    scanTimestamp: new Date().toISOString(),
    stale,
    staleReasons,
    rejectedIds,
    selectedIds: plan.selectedIds,
    deletableSelectedIds,
    deletePreview,
  };
}
