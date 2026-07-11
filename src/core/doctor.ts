import path from "node:path";
import { readdir } from "node:fs/promises";

import {
  collectExactKeyGlobalStateReferences,
  collectGlobalStateReferences,
  collectPossibleUnknownGlobalStateReferences,
} from "./global-state.js";
import { expandCodexPath, listVersionedSqlitePaths, resolveSqliteHome } from "./root.js";
import { scanCodexRoot } from "./scan.js";
import {
  captureManagedPath,
  createTrustedRootContext,
  isPathSafetyError,
  readManagedText,
  revalidateManagedPath,
  type TrustedRootContext,
} from "./path-safety.js";
import { inspectMemoryDoctorStats, inspectNamedSqliteTables, inspectSqliteTables } from "./sqlite.js";
import { getRecoveryStatus } from "./recovery.js";
import type { DoctorReport, GlobalStateReference } from "./types.js";

const TRASH_DIR_NAME = ".codex-sessions-trash";

async function pathStatus(
  context: TrustedRootContext,
  relativePath: string,
  expectedKind: "file" | "directory",
  warnings: string[],
): Promise<{ path: string; exists: boolean; readable: boolean }> {
  const filePath = path.join(context.lexicalPath, relativePath);
  try {
    const snapshot = await captureManagedPath(context, relativePath, {
      expectedKind,
      allowMissing: true,
    });
    return { path: filePath, exists: snapshot.exists, readable: snapshot.exists };
  } catch (error) {
    if (!isPathSafetyError(error)) throw error;
    warnings.push(error.message);
    return { path: filePath, exists: false, readable: false };
  }
}

async function countTrashEntries(context: TrustedRootContext, warnings: string[]): Promise<number> {
  try {
    const trashSnapshot = await captureManagedPath(context, TRASH_DIR_NAME, {
      expectedKind: "directory",
      allowMissing: true,
    });
    if (!trashSnapshot.exists) return 0;
    const entries = await readdir(trashSnapshot.absolutePath, { withFileTypes: true });
    await revalidateManagedPath(context, trashSnapshot);
    let count = 0;
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      try {
        const snapshot = await captureManagedPath(context, path.join(TRASH_DIR_NAME, entry.name), {
          expectedKind: "directory",
          allowMissing: false,
        });
        await revalidateManagedPath(context, snapshot);
        count += 1;
      } catch (error) {
        if (!isPathSafetyError(error)) throw error;
        warnings.push(error.message);
      }
    }
    return count;
  } catch (error) {
    if (isPathSafetyError(error)) warnings.push(error.message);
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
  const rootContext = await createTrustedRootContext(rootPath);
  const warnings: string[] = [];
  const sqliteHome = await resolveSqliteHome(rootPath, rootContext, warnings);

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
    pathStatus(rootContext, "sessions", "directory", warnings),
    pathStatus(rootContext, "archived_sessions", "directory", warnings),
    pathStatus(rootContext, "session_index.jsonl", "file", warnings),
    pathStatus(rootContext, "history.jsonl", "file", warnings),
    pathStatus(rootContext, ".codex-global-state.json", "file", warnings),
    pathStatus(rootContext, "shell_snapshots", "directory", warnings),
    pathStatus(rootContext, TRASH_DIR_NAME, "directory", warnings),
    sqliteHome.sqliteHomeTrusted
      ? listVersionedSqlitePaths(sqliteHome.sqliteHomePath, "state", warnings)
      : Promise.resolve([]),
    sqliteHome.sqliteHomeTrusted
      ? listVersionedSqlitePaths(sqliteHome.sqliteHomePath, "logs", warnings)
      : Promise.resolve([]),
    sqliteHome.sqliteHomeTrusted
      ? listVersionedSqlitePaths(sqliteHome.sqliteHomePath, "goals", warnings)
      : Promise.resolve([]),
    sqliteHome.sqliteHomeTrusted
      ? listVersionedSqlitePaths(sqliteHome.sqliteHomePath, "memories", warnings)
      : Promise.resolve([]),
    listVersionedSqlitePaths(rootPath, "state", warnings),
    listVersionedSqlitePaths(rootPath, "logs", warnings),
    listVersionedSqlitePaths(rootPath, "goals", warnings),
    listVersionedSqlitePaths(rootPath, "memories", warnings),
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
      const text = await readManagedText(rootContext, ".codex-global-state.json");
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
  let memory = inspectMemoryDoctorStats(null);

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

  try {
    memory = inspectMemoryDoctorStats(activeMemoriesPath);
  } catch (error) {
    const message = `memories statistics unavailable: ${error instanceof Error ? error.message : String(error)}`;
    memory = {
      enabled: Boolean(activeMemoriesPath),
      databaseExists: Boolean(activeMemoriesPath),
      schemaStatus: "unrecognized",
      stage1: { total: 0, withRolloutSummary: 0, selectedForPhase2: 0 },
      jobs: { total: 0, byStatus: {} },
      warnings: [message],
    };
    sqliteWarnings.push(message);
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
  const recoveryStatus = await getRecoveryStatus(rootPath);
  if (recoveryStatus.pending) {
    warnings.push(`RECOVERY_REQUIRED: interrupted ${recoveryStatus.kind} operation ${recoveryStatus.operationId} is at ${recoveryStatus.stage}.`);
    if (recoveryStatus.invalidReason) warnings.push(recoveryStatus.invalidReason);
  }

  return {
    rootPath,
    recovery: {
      pending: recoveryStatus.pending,
      operationId: recoveryStatus.operationId,
      kind: recoveryStatus.kind,
      stage: recoveryStatus.stage,
      targetIds: recoveryStatus.targetIds,
      hasRecoveryPayload: recoveryStatus.hasRecoveryPayload,
      invalidReason: recoveryStatus.invalidReason,
    },
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
        entryCount: await countTrashEntries(rootContext, warnings),
      },
    },
    sqlite: {
      sqliteHomePath: sqliteHome.sqliteHomePath,
      sqliteHomeSource: sqliteHome.sqliteHomeSource,
      sqliteHomeTrusted: sqliteHome.sqliteHomeTrusted,
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
    memory,
    warnings: uniqueMessages(warnings),
  };
}
