import path from "node:path";
import { access, readdir, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

import {
  collectExactKeyGlobalStateReferences,
  collectGlobalStateReferences,
  collectPossibleUnknownGlobalStateReferences,
} from "./global-state.js";
import { expandCodexPath, listVersionedSqlitePaths, resolveSqliteHome } from "./root.js";
import { scanCodexRoot } from "./scan.js";
import { inspectNamedSqliteTables, inspectSqliteTables } from "./sqlite.js";
import type { DoctorReport, GlobalStateReference } from "./types.js";

const TRASH_DIR_NAME = ".codex-sessions-trash";

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

function uniqueMessages(messages: string[]): string[] {
  return [...new Set(messages)];
}

export async function inspectCodexRoot(rootArg?: string): Promise<DoctorReport> {
  const rootPath = path.resolve(expandCodexPath(rootArg ?? "~/.codex"));
  const sqliteHome = await resolveSqliteHome(rootPath);
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
    memoriesCandidates,
    rootStateCandidates,
    rootLogsCandidates,
    rootGoalsCandidates,
    rootMemoriesCandidates,
  ] = await Promise.all([
    pathStatus(sessionsDir),
    pathStatus(archivedSessionsDir),
    pathStatus(sessionIndexPath),
    pathStatus(historyPath),
    pathStatus(globalStatePath),
    pathStatus(shellSnapshotsDir),
    pathStatus(trashDir),
    listVersionedSqlitePaths(sqliteHome.sqliteHomePath, "state"),
    listVersionedSqlitePaths(sqliteHome.sqliteHomePath, "logs"),
    listVersionedSqlitePaths(sqliteHome.sqliteHomePath, "goals"),
    listVersionedSqlitePaths(sqliteHome.sqliteHomePath, "memories"),
    listVersionedSqlitePaths(rootPath, "state"),
    listVersionedSqlitePaths(rootPath, "logs"),
    listVersionedSqlitePaths(rootPath, "goals"),
    listVersionedSqlitePaths(rootPath, "memories"),
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
  const activeMemoriesPath = memoriesCandidates[0] ?? null;
  const dualHomeRootCandidateCount = [
    ...rootStateCandidates,
    ...rootLogsCandidates,
    ...rootGoalsCandidates,
    ...rootMemoriesCandidates,
  ].length;

  if (path.resolve(sqliteHome.sqliteHomePath) !== path.resolve(rootPath) && dualHomeRootCandidateCount > 0) {
    sqliteWarnings.push(
      `SQLite home 与 Codex root 分离：active SQLite home=${sqliteHome.sqliteHomePath}，root=${rootPath}；root 顶层仍有 ${dualHomeRootCandidateCount} 个 SQLite 候选，当前仅作 dual-home 警告，不作为 active DB。`,
    );
  }

  let stateTables: DoctorReport["sqlite"]["stateTables"] = [];
  let logsTables: DoctorReport["sqlite"]["logsTables"] = [];
  let goalsTables: DoctorReport["sqlite"]["goalsTables"] = [];
  let memoriesTables: DoctorReport["sqlite"]["memoriesTables"] = [];

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

  try {
    memoriesTables = inspectNamedSqliteTables(activeMemoriesPath, ["stage1_outputs", "jobs"]);
  } catch (error) {
    sqliteWarnings.push(`memories SQLite 无法读取：${error instanceof Error ? error.message : String(error)}`);
    memoriesTables = inspectNamedSqliteTables(null, ["stage1_outputs", "jobs"]);
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
      sqliteHomePath: sqliteHome.sqliteHomePath,
      sqliteHomeSource: sqliteHome.sqliteHomeSource,
      sqliteHomeConfigPath: sqliteHome.sqliteHomeConfigPath,
      stateCandidates,
      activeStatePath,
      logsCandidates,
      activeLogsPath,
      goalsCandidates,
      activeGoalsPath,
      memoriesCandidates,
      activeMemoriesPath,
      rootStateCandidates,
      rootLogsCandidates,
      rootGoalsCandidates,
      rootMemoriesCandidates,
      stateTables,
      logsTables,
      goalsTables,
      memoriesTables,
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
    warnings: uniqueMessages(warnings),
  };
}
