import os from "node:os";
import path from "node:path";
import { access, readdir, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

import {
  collectExactKeyGlobalStateReferences,
  collectGlobalStateReferences,
  collectPossibleUnknownGlobalStateReferences,
} from "./global-state.js";
import { scanCodexRoot } from "./scan.js";
import { inspectSqliteTables } from "./sqlite.js";
import type { DoctorReport, GlobalStateReference } from "./types.js";

const TRASH_DIR_NAME = ".codex-sessions-trash";

function expandHome(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

async function pathStatus(filePath: string): Promise<{ path: string; exists: boolean; readable: boolean }> {
  try {
    await access(filePath, fsConstants.F_OK);
  } catch {
    return { path: filePath, exists: false, readable: false };
  }

  try {
    await access(filePath, fsConstants.R_OK);
    return { path: filePath, exists: true, readable: true };
  } catch {
    return { path: filePath, exists: true, readable: false };
  }
}

async function listVersionedSqlite(rootPath: string, basename: "state" | "logs" | "goals"): Promise<string[]> {
  try {
    const entries = await readdir(rootPath);
    return entries
      .map((entry) => {
        const match = entry.match(new RegExp(`^${basename}_(\\d+)\\.sqlite$`));
        return match ? { entry, version: Number(match[1]) } : null;
      })
      .filter((entry): entry is { entry: string; version: number } => Boolean(entry))
      .sort((left, right) => right.version - left.version)
      .map((entry) => path.join(rootPath, entry.entry));
  } catch {
    return [];
  }
}

async function countTrashEntries(trashDir: string): Promise<number> {
  try {
    const entries = await readdir(trashDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    return 0;
  }
}

function flattenRefs(refsById: Map<string, GlobalStateReference[]>): DoctorReport["globalState"]["knownRefs"] {
  return [...refsById.values()]
    .flat()
    .map((ref) => ({
      sessionId: ref.sessionId,
      path: ref.path,
      kind: ref.kind,
    }));
}

function flattenExactKeyRefs(refsById: Map<string, GlobalStateReference[]>): DoctorReport["globalState"]["exactKeyRefs"] {
  return [...refsById.values()]
    .flat()
    .flatMap((ref) => {
      if (!ref.ruleId) {
        return [];
      }

      return [{
        sessionId: ref.sessionId,
        path: ref.path,
        kind: ref.kind,
        ruleId: ref.ruleId,
        valueShape: ref.valueShape ?? "unknown",
        byteEstimate: ref.byteEstimate ?? 0,
      }];
    });
}

export async function inspectCodexRoot(rootArg?: string): Promise<DoctorReport> {
  const rootPath = path.resolve(expandHome(rootArg ?? "~/.codex"));
  const sessionsDir = path.join(rootPath, "sessions");
  const archivedSessionsDir = path.join(rootPath, "archived_sessions");
  const sessionIndexPath = path.join(rootPath, "session_index.jsonl");
  const historyPath = path.join(rootPath, "history.jsonl");
  const globalStatePath = path.join(rootPath, ".codex-global-state.json");
  const shellSnapshotsDir = path.join(rootPath, "shell_snapshots");
  const trashDir = path.join(rootPath, TRASH_DIR_NAME);
  const warnings: string[] = [];

  const [
    sessionsStatus,
    archivedStatus,
    sessionIndexStatus,
    historyStatus,
    globalStateBaseStatus,
    shellSnapshotsStatus,
    trashBaseStatus,
    stateCandidates,
    logsCandidates,
    goalsCandidates,
  ] = await Promise.all([
    pathStatus(sessionsDir),
    pathStatus(archivedSessionsDir),
    pathStatus(sessionIndexPath),
    pathStatus(historyPath),
    pathStatus(globalStatePath),
    pathStatus(shellSnapshotsDir),
    pathStatus(trashDir),
    listVersionedSqlite(rootPath, "state"),
    listVersionedSqlite(rootPath, "logs"),
    listVersionedSqlite(rootPath, "goals"),
  ]);

  if (!sessionsStatus.readable) warnings.push("sessions/ 缺失或不可读。");
  if (!sessionIndexStatus.readable) warnings.push("session_index.jsonl 缺失或不可读。");
  if (!historyStatus.readable) warnings.push("history.jsonl 缺失或不可读。");

  let globalStateParseable: boolean | null = null;
  const globalStateWarnings: string[] = [];
  let knownRefs = new Map<string, GlobalStateReference[]>();
  let exactKeyRefs = new Map<string, GlobalStateReference[]>();
  let possibleUnknownRefs = new Map<string, GlobalStateReference[]>();

  if (globalStateBaseStatus.exists && globalStateBaseStatus.readable) {
    try {
      const text = await readFile(globalStatePath, "utf8");
      knownRefs = collectGlobalStateReferences(text);
      exactKeyRefs = collectExactKeyGlobalStateReferences(text);
      possibleUnknownRefs = collectPossibleUnknownGlobalStateReferences(text);
      globalStateParseable = true;
      if (exactKeyRefs.size > 0) {
        globalStateWarnings.push("global state 存在 P11 认可的 exact-key 引用；只允许预览后显式确认删除。");
      }
      if (possibleUnknownRefs.size > 0) {
        globalStateWarnings.push("global state 存在未知位置的 session/thread 引用，工具只报警，不自动修改。");
      }
    } catch (error) {
      globalStateParseable = false;
      globalStateWarnings.push(`global state 无法解析：${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (globalStateBaseStatus.exists) {
    globalStateParseable = null;
    globalStateWarnings.push("global state 存在但不可读。");
  }

  warnings.push(...globalStateWarnings);

  const sqliteWarnings: string[] = [];
  const activeStatePath = stateCandidates[0] ?? null;
  const activeLogsPath = logsCandidates[0] ?? null;
  const activeGoalsPath = goalsCandidates[0] ?? null;
  let stateTables: DoctorReport["sqlite"]["stateTables"] = [];
  let logsTables: DoctorReport["sqlite"]["logsTables"] = [];
  let goalsTables: DoctorReport["sqlite"]["goalsTables"] = [];

  try {
    stateTables = inspectSqliteTables(activeStatePath);
  } catch (error) {
    sqliteWarnings.push(`state SQLite 无法读取：${error instanceof Error ? error.message : String(error)}`);
    stateTables = inspectSqliteTables(null);
  }

  try {
    logsTables = inspectSqliteTables(activeLogsPath);
  } catch (error) {
    sqliteWarnings.push(`logs SQLite 无法读取：${error instanceof Error ? error.message : String(error)}`);
    logsTables = inspectSqliteTables(null);
  }

  try {
    goalsTables = inspectSqliteTables(activeGoalsPath);
  } catch (error) {
    sqliteWarnings.push(`goals SQLite 无法读取：${error instanceof Error ? error.message : String(error)}`);
    goalsTables = inspectSqliteTables(null);
  }

  warnings.push(...sqliteWarnings);

  let sessionCount: number | null = null;
  let scanWarnings: string[] = [];
  if (sessionsStatus.readable) {
    try {
      const scan = await scanCodexRoot(rootPath);
      sessionCount = scan.sessions.length;
      scanWarnings = scan.warnings;
    } catch (error) {
      scanWarnings = [`scan 失败：${error instanceof Error ? error.message : String(error)}`];
    }
  }
  warnings.push(...scanWarnings);

  return {
    rootPath,
    paths: {
      sessionsDir: sessionsStatus,
      archivedSessionsDir: archivedStatus,
      sessionIndex: sessionIndexStatus,
      history: historyStatus,
      globalState: {
        ...globalStateBaseStatus,
        parseable: globalStateParseable,
      },
      shellSnapshotsDir: shellSnapshotsStatus,
      trashDir: {
        ...trashBaseStatus,
        entryCount: await countTrashEntries(trashDir),
      },
    },
    sqlite: {
      stateCandidates,
      activeStatePath,
      logsCandidates,
      activeLogsPath,
      goalsCandidates,
      activeGoalsPath,
      stateTables,
      logsTables,
      goalsTables,
      warnings: sqliteWarnings,
    },
    globalState: {
      knownRefs: flattenRefs(knownRefs),
      exactKeyRefs: flattenExactKeyRefs(exactKeyRefs),
      possibleUnknownRefs: flattenRefs(possibleUnknownRefs),
      warnings: globalStateWarnings,
    },
    scan: {
      sessionCount,
      warnings: scanWarnings,
    },
    warnings,
  };
}
