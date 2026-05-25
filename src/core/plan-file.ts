import crypto from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import Database from "better-sqlite3";

import { buildDeletePreview } from "./delete.js";
import { safeJsonParse, splitJsonLines } from "./jsonl.js";
import { resolveSessions } from "./query.js";
import type {
  DeletePlanFile,
  DeletePlanRootFingerprint,
  DeletePlanSelectedSnapshot,
  DeletePlanSurfaceFingerprint,
  PlanDeleteResult,
  PreviewPlanResult,
  ScanResult,
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

function parseSqlite(filePath: string): boolean {
  try {
    const db = new Database(filePath, { readonly: true, fileMustExist: true });
    db.prepare("select name from sqlite_master limit 1").all();
    db.close();
    return true;
  } catch {
    return false;
  }
}

async function fingerprintFile(
  filePath: string | null,
  parseable: (textOrPath: string) => boolean,
  mode: "text" | "path" = "text",
): Promise<DeletePlanSurfaceFingerprint> {
  if (!filePath) {
    return { path: null, exists: false, size: null, mtimeMs: null, parseable: false };
  }

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(filePath);
  } catch {
    return { path: filePath, exists: false, size: null, mtimeMs: null, parseable: false };
  }

  let isParseable = false;
  try {
    isParseable = mode === "path" ? parseable(filePath) : parseable(await readFile(filePath, "utf8"));
  } catch {
    isParseable = false;
  }

  return {
    path: filePath,
    exists: true,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    parseable: isParseable,
  };
}

export async function buildDeletePlanRootFingerprint(scan: ScanResult): Promise<DeletePlanRootFingerprint> {
  return {
    rootRealpath: await realpath(scan.root.rootPath),
    sessionIndex: await fingerprintFile(scan.root.sessionIndexPath, parseJsonlText),
    history: await fingerprintFile(scan.root.historyPath, parseJsonlText),
    globalState: await fingerprintFile(scan.root.globalStatePath, (text) => {
      JSON.parse(text);
      return true;
    }),
    sqlite: await fingerprintFile(scan.root.sqlitePath, parseSqlite, "path"),
    logsSqlite: await fingerprintFile(scan.root.logsSqlitePath, parseSqlite, "path"),
    goalsSqlite: await fingerprintFile(scan.root.goalsSqlitePath, parseSqlite, "path"),
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
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(planFile, null, 2)}\n`, "utf8");
  return planFile;
}

function compareFingerprint(
  label: string,
  planned: DeletePlanSurfaceFingerprint,
  current: DeletePlanSurfaceFingerprint,
): string[] {
  const reasons: string[] = [];
  for (const key of ["path", "exists", "size", "mtimeMs", "parseable"] as const) {
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
    ...compareFingerprint("session_index", plan.rootFingerprint.sessionIndex, currentFingerprint.sessionIndex),
    ...compareFingerprint("history", plan.rootFingerprint.history, currentFingerprint.history),
    ...compareFingerprint("global-state", plan.rootFingerprint.globalState, currentFingerprint.globalState),
    ...compareFingerprint("sqlite", plan.rootFingerprint.sqlite, currentFingerprint.sqlite),
    ...compareFingerprint("sqlite logs", plan.rootFingerprint.logsSqlite, currentFingerprint.logsSqlite),
    ...compareFingerprint("sqlite goals", plan.rootFingerprint.goalsSqlite, currentFingerprint.goalsSqlite),
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
