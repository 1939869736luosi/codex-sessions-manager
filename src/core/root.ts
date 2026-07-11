import os from "node:os";
import path from "node:path";
import { readdir } from "node:fs/promises";

import {
  captureManagedPath,
  createTrustedRootContext,
  isPathSafetyError,
  readManagedText,
  reconstructManagedPath,
  registerTrustedRoots,
  type TrustedRootContext,
} from "./path-safety.js";
import type { CodexRootPaths, ScanSafetyIssue, ScanSurface } from "./types.js";

function recordUnsafeSurface(
  issues: ScanSafetyIssue[],
  surface: ScanSurface,
  targetPath: string,
  error: unknown,
): void {
  issues.push({
    surface,
    path: isPathSafetyError(error) ? error.path : targetPath,
    code: isPathSafetyError(error) ? error.code : "UNSAFE_PATH",
    reason: isPathSafetyError(error)
      ? error.reason
      : error instanceof Error ? error.message : String(error),
  });
}

export function expandCodexPath(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

function normalizePath(inputPath: string, basePath?: string): string {
  const expanded = expandCodexPath(inputPath.trim());
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(basePath ?? process.cwd(), expanded);
}

async function getOptionalManagedPath(
  context: TrustedRootContext,
  relativePath: string,
  expectedKind: "file" | "directory",
  warnings: string[],
  unsafeSurfaces: ScanSafetyIssue[],
  surface: ScanSurface,
): Promise<string | null> {
  const reconstructed = reconstructManagedPath(context, relativePath);
  const lexicalPath = path.join(context.lexicalPath, reconstructed.relativePath);
  try {
    const snapshot = await captureManagedPath(context, relativePath, {
      expectedKind,
      allowMissing: true,
    });
    return snapshot.exists ? lexicalPath : null;
  } catch (error) {
    if (!isPathSafetyError(error)) throw error;
    warnings.push(error.message);
    recordUnsafeSurface(unsafeSurfaces, surface, lexicalPath, error);
    return lexicalPath;
  }
}

export async function listVersionedSqlitePaths(
  sqliteHomePath: string,
  basename: "state" | "logs" | "goals" | "memories",
  warnings: string[] = [],
  unsafeSurfaces: ScanSafetyIssue[] = [],
  trustedContext?: TrustedRootContext,
): Promise<string[]> {
  try {
    const context = trustedContext ?? await createTrustedRootContext(sqliteHomePath);
    const entries = await readdir(context.realPath);
    const candidates = entries
      .map((entry) => {
        const match = entry.match(new RegExp(`^${basename}_(\\d+)\\.sqlite$`));
        return match ? { fileName: entry, version: Number(match[1]) } : null;
      })
      .filter((entry): entry is { fileName: string; version: number } => Boolean(entry))
      .sort((a, b) => b.version - a.version);
    const safePaths: Array<{ path: string; version: number }> = [];
    for (const candidate of candidates) {
      try {
        await captureManagedPath(context, candidate.fileName, {
          expectedKind: "file",
          allowMissing: false,
        });
        for (const suffix of ["-wal", "-shm", "-journal"] as const) {
          await captureManagedPath(context, `${candidate.fileName}${suffix}`, {
            expectedKind: "file",
            allowMissing: true,
          });
        }
        safePaths.push({ path: path.join(context.realPath, candidate.fileName), version: candidate.version });
      } catch (error) {
        warnings.push(
          error instanceof Error
            ? error.message
            : `UNSAFE_PATH: ignored unsafe SQLite candidate ${candidate.fileName}`,
        );
        recordUnsafeSurface(
          unsafeSurfaces,
          `sqlite_${basename}` as ScanSurface,
          path.join(context.lexicalPath, candidate.fileName),
          error,
        );
      }
    }
    return safePaths.sort((a, b) => b.version - a.version).map((entry) => entry.path);
  } catch {
    return [];
  }
}

async function getLatestVersionedSqlitePath(
  sqliteHomePath: string,
  basename: "state" | "logs" | "goals" | "memories",
  warnings: string[] = [],
  unsafeSurfaces: ScanSafetyIssue[] = [],
  trustedContext?: TrustedRootContext,
): Promise<string | null> {
  const candidates = await listVersionedSqlitePaths(
    sqliteHomePath,
    basename,
    warnings,
    unsafeSurfaces,
    trustedContext,
  );
  return candidates[0] ?? null;
}

async function readConfigSqliteHome(
  rootPath: string,
  rootContext?: TrustedRootContext,
): Promise<
  | { status: "absent" }
  | { status: "valid"; path: string; configPath: string }
  | { status: "unsafe"; configPath: string; warning: string }
> {
  const context = rootContext ?? await createTrustedRootContext(rootPath);
  const configPath = path.join(context.lexicalPath, "config.toml");

  try {
    const snapshot = await captureManagedPath(context, "config.toml", {
      expectedKind: "file",
      allowMissing: true,
    });
    if (!snapshot.exists) return { status: "absent" };
    const text = await readManagedText(context, "config.toml");
    const match = text.match(/^\s*sqlite_home\s*=\s*(['"])(.*?)\1\s*(?:#.*)?$/m);
    const value = match?.[2]?.trim();
    if (!value) return { status: "absent" };
    return {
      status: "valid",
      path: normalizePath(value, rootPath),
      configPath,
    };
  } catch (error) {
    return {
      status: "unsafe",
      configPath,
      warning: error instanceof Error
        ? error.message
        : `UNSAFE_PATH: config.toml could not be read safely (${configPath})`,
    };
  }
}

export async function resolveSqliteHome(
  rootPath: string,
  rootContext?: TrustedRootContext,
  warnings: string[] = [],
): Promise<{
  sqliteHomePath: string;
  sqliteHomeSource: CodexRootPaths["sqliteHomeSource"];
  sqliteHomeTrusted: boolean;
  sqliteHomeConfigPath: string | null;
}> {
  const config = await readConfigSqliteHome(rootPath, rootContext);
  if (config.status === "unsafe") {
    warnings.push(config.warning);
    return {
      sqliteHomePath: rootPath,
      sqliteHomeSource: "root",
      sqliteHomeTrusted: false,
      sqliteHomeConfigPath: config.configPath,
    };
  }
  if (config.status === "valid") {
    return {
      sqliteHomePath: config.path,
      sqliteHomeSource: "config.toml",
      sqliteHomeTrusted: true,
      sqliteHomeConfigPath: config.configPath,
    };
  }

  const envValue = process.env.CODEX_SQLITE_HOME?.trim();
  if (envValue) {
    return {
      sqliteHomePath: normalizePath(envValue),
      sqliteHomeSource: "CODEX_SQLITE_HOME",
      sqliteHomeTrusted: true,
      sqliteHomeConfigPath: null,
    };
  }

  return {
    sqliteHomePath: rootPath,
    sqliteHomeSource: "root",
    sqliteHomeTrusted: true,
    sqliteHomeConfigPath: null,
  };
}

function sameResolvedPath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

async function buildSqliteHomeWarnings(
  rootPath: string,
  sqliteHomePath: string,
  rootContext: TrustedRootContext,
): Promise<string[]> {
  if (sameResolvedPath(rootPath, sqliteHomePath)) {
    return [];
  }

  const rootCandidates = await Promise.all([
    listVersionedSqlitePaths(rootPath, "state", [], [], rootContext),
    listVersionedSqlitePaths(rootPath, "logs", [], [], rootContext),
    listVersionedSqlitePaths(rootPath, "goals", [], [], rootContext),
    listVersionedSqlitePaths(rootPath, "memories", [], [], rootContext),
  ]);
  const rootCandidateCount = rootCandidates.flat().length;

  if (rootCandidateCount === 0) {
    return [];
  }

  return [
    `SQLite home 与 Codex root 分离：active SQLite home=${sqliteHomePath}，root=${rootPath}；root 顶层仍有 ${rootCandidateCount} 个 SQLite 候选，当前仅作 dual-home 警告，不作为 active DB。`,
  ];
}

export async function resolveCodexRoot(rootArg?: string): Promise<CodexRootPaths> {
  const lexicalRootPath = normalizePath(rootArg ?? "~/.codex");
  const rootContext = await createTrustedRootContext(lexicalRootPath);
  const rootPath = rootContext.lexicalPath;
  const warnings: string[] = [];
  const unsafeSurfaces: ScanSafetyIssue[] = [];
  const sessionsDir = path.join(rootPath, "sessions");
  try {
    const sessionsSnapshot = await captureManagedPath(rootContext, "sessions", {
      expectedKind: "directory",
      allowMissing: true,
    });
    if (!sessionsSnapshot.exists) {
      throw new Error(`目录 ${rootPath} 不是有效的 .codex 根目录：缺少可读取的 sessions/ 目录。`);
    }
  } catch (error) {
    if (!isPathSafetyError(error)) throw error;
    warnings.push(error.message);
    recordUnsafeSurface(unsafeSurfaces, "sessions", sessionsDir, error);
  }

  const sqliteHome = await resolveSqliteHome(rootPath, rootContext, warnings);
  let sqliteHomeTrusted = sqliteHome.sqliteHomeTrusted;
  let sqliteContext: TrustedRootContext | null = null;
  if (sqliteHomeTrusted) {
    try {
      sqliteContext = sqliteHome.sqliteHomeSource === "root"
        ? rootContext
        : await createTrustedRootContext(sqliteHome.sqliteHomePath);
    } catch (error) {
      if (isPathSafetyError(error)) {
        warnings.push(error.message);
        recordUnsafeSurface(unsafeSurfaces, "sqlite_home", sqliteHome.sqliteHomePath, error);
        sqliteHomeTrusted = false;
      } else {
        throw error;
      }
    }
  }
  if (!sqliteHome.sqliteHomeTrusted) {
    recordUnsafeSurface(
      unsafeSurfaces,
      "sqlite_home",
      sqliteHome.sqliteHomeConfigPath ?? sqliteHome.sqliteHomePath,
      new Error("SQLite home trust could not be established safely"),
    );
  }
  if (sqliteHomeTrusted) {
    warnings.push(...await buildSqliteHomeWarnings(rootPath, sqliteHome.sqliteHomePath, rootContext));
  }

  const result: CodexRootPaths = {
    rootPath,
    sqliteHomePath: sqliteHome.sqliteHomePath,
    sqliteHomeSource: sqliteHome.sqliteHomeSource,
    sqliteHomeTrusted,
    sqliteHomeConfigPath: sqliteHome.sqliteHomeConfigPath,
    sessionsDir,
    archivedDir: await getOptionalManagedPath(rootContext, "archived_sessions", "directory", warnings, unsafeSurfaces, "archived_sessions"),
    sessionIndexPath: await getOptionalManagedPath(rootContext, "session_index.jsonl", "file", warnings, unsafeSurfaces, "session_index"),
    historyPath: await getOptionalManagedPath(rootContext, "history.jsonl", "file", warnings, unsafeSurfaces, "history"),
    sqlitePath: sqliteHomeTrusted
      ? await getLatestVersionedSqlitePath(sqliteHome.sqliteHomePath, "state", warnings, unsafeSurfaces, sqliteContext ?? undefined)
      : null,
    logsSqlitePath: sqliteHomeTrusted
      ? await getLatestVersionedSqlitePath(sqliteHome.sqliteHomePath, "logs", warnings, unsafeSurfaces, sqliteContext ?? undefined)
      : null,
    goalsSqlitePath: sqliteHomeTrusted
      ? await getLatestVersionedSqlitePath(sqliteHome.sqliteHomePath, "goals", warnings, unsafeSurfaces, sqliteContext ?? undefined)
      : null,
    memoriesSqlitePath: sqliteHomeTrusted
      ? await getLatestVersionedSqlitePath(sqliteHome.sqliteHomePath, "memories", warnings, unsafeSurfaces, sqliteContext ?? undefined)
      : null,
    globalStatePath: await getOptionalManagedPath(rootContext, ".codex-global-state.json", "file", warnings, unsafeSurfaces, "global_state"),
    shellSnapshotsDir: await getOptionalManagedPath(rootContext, "shell_snapshots", "directory", warnings, unsafeSurfaces, "shell_snapshots"),
    unsafeSurfaces,
    warnings,
  };
  registerTrustedRoots(result, rootContext, sqliteContext);
  return result;
}
