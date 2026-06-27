import os from "node:os";
import path from "node:path";
import { access, readdir, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

import type { CodexRootPaths } from "./types.js";

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

async function getOptionalPath(filePath: string): Promise<string | null> {
  try {
    await access(filePath, fsConstants.F_OK);
    return filePath;
  } catch {
    return null;
  }
}

export async function listVersionedSqlitePaths(
  sqliteHomePath: string,
  basename: "state" | "logs" | "goals" | "memories",
): Promise<string[]> {
  try {
    const entries = await readdir(sqliteHomePath);
    return entries
      .map((entry) => {
        const match = entry.match(new RegExp(`^${basename}_(\\d+)\\.sqlite$`));
        return match ? { fileName: entry, version: Number(match[1]) } : null;
      })
      .filter((entry): entry is { fileName: string; version: number } => Boolean(entry))
      .sort((a, b) => b.version - a.version)
      .map((entry) => path.join(sqliteHomePath, entry.fileName));
  } catch {
    return [];
  }
}

async function getLatestVersionedSqlitePath(
  sqliteHomePath: string,
  basename: "state" | "logs" | "goals" | "memories",
): Promise<string | null> {
  const candidates = await listVersionedSqlitePaths(sqliteHomePath, basename);
  return candidates[0] ?? null;
}

async function readConfigSqliteHome(rootPath: string): Promise<{ path: string; configPath: string } | null> {
  const configPath = path.join(rootPath, "config.toml");
  let text: string;

  try {
    text = await readFile(configPath, "utf8");
  } catch {
    return null;
  }

  const match = text.match(/^\s*sqlite_home\s*=\s*(['"])(.*?)\1\s*(?:#.*)?$/m);
  const value = match?.[2]?.trim();
  if (!value) {
    return null;
  }

  return {
    path: normalizePath(value, rootPath),
    configPath,
  };
}

export async function resolveSqliteHome(rootPath: string): Promise<{
  sqliteHomePath: string;
  sqliteHomeSource: CodexRootPaths["sqliteHomeSource"];
  sqliteHomeConfigPath: string | null;
}> {
  const config = await readConfigSqliteHome(rootPath);
  if (config) {
    return {
      sqliteHomePath: config.path,
      sqliteHomeSource: "config.toml",
      sqliteHomeConfigPath: config.configPath,
    };
  }

  const envValue = process.env.CODEX_SQLITE_HOME?.trim();
  if (envValue) {
    return {
      sqliteHomePath: normalizePath(envValue),
      sqliteHomeSource: "CODEX_SQLITE_HOME",
      sqliteHomeConfigPath: null,
    };
  }

  return {
    sqliteHomePath: rootPath,
    sqliteHomeSource: "root",
    sqliteHomeConfigPath: null,
  };
}

function sameResolvedPath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

async function buildSqliteHomeWarnings(rootPath: string, sqliteHomePath: string): Promise<string[]> {
  if (sameResolvedPath(rootPath, sqliteHomePath)) {
    return [];
  }

  const rootCandidates = await Promise.all([
    listVersionedSqlitePaths(rootPath, "state"),
    listVersionedSqlitePaths(rootPath, "logs"),
    listVersionedSqlitePaths(rootPath, "goals"),
    listVersionedSqlitePaths(rootPath, "memories"),
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
  const rootPath = normalizePath(rootArg ?? "~/.codex");
  const sessionsDir = path.join(rootPath, "sessions");

  try {
    await access(sessionsDir, fsConstants.R_OK);
  } catch {
    throw new Error(
      `目录 ${rootPath} 不是有效的 .codex 根目录：缺少可读取的 sessions/ 目录。`,
    );
  }

  const sqliteHome = await resolveSqliteHome(rootPath);
  const warnings = await buildSqliteHomeWarnings(rootPath, sqliteHome.sqliteHomePath);

  return {
    rootPath,
    ...sqliteHome,
    sessionsDir,
    archivedDir: await getOptionalPath(path.join(rootPath, "archived_sessions")),
    sessionIndexPath: await getOptionalPath(path.join(rootPath, "session_index.jsonl")),
    historyPath: await getOptionalPath(path.join(rootPath, "history.jsonl")),
    sqlitePath: await getLatestVersionedSqlitePath(sqliteHome.sqliteHomePath, "state"),
    logsSqlitePath: await getLatestVersionedSqlitePath(sqliteHome.sqliteHomePath, "logs"),
    goalsSqlitePath: await getLatestVersionedSqlitePath(sqliteHome.sqliteHomePath, "goals"),
    memoriesSqlitePath: await getLatestVersionedSqlitePath(sqliteHome.sqliteHomePath, "memories"),
    globalStatePath: await getOptionalPath(path.join(rootPath, ".codex-global-state.json")),
    shellSnapshotsDir: await getOptionalPath(path.join(rootPath, "shell_snapshots")),
    warnings,
  };
}
