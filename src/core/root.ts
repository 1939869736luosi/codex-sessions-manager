import os from "node:os";
import path from "node:path";
import { access, readdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";

import type { CodexRootPaths } from "./types.js";

function expandHome(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

async function getOptionalPath(filePath: string): Promise<string | null> {
  try {
    await access(filePath, fsConstants.F_OK);
    return filePath;
  } catch {
    return null;
  }
}

async function getLatestVersionedSqlitePath(rootPath: string, basename: string): Promise<string | null> {
  try {
    const entries = await readdir(rootPath);
    const candidates = entries
      .map((entry) => {
        const match = entry.match(new RegExp(`^${basename}_(\\d+)\\.sqlite$`));
        return match ? { fileName: entry, version: Number(match[1]) } : null;
      })
      .filter((entry): entry is { fileName: string; version: number } => Boolean(entry))
      .sort((a, b) => b.version - a.version);

    return candidates[0] ? path.join(rootPath, candidates[0].fileName) : null;
  } catch {
    return null;
  }
}

export async function resolveCodexRoot(rootArg?: string): Promise<CodexRootPaths> {
  const rootPath = path.resolve(expandHome(rootArg ?? "~/.codex"));
  const sessionsDir = path.join(rootPath, "sessions");

  try {
    await access(sessionsDir, fsConstants.R_OK);
  } catch {
    throw new Error(
      `目录 ${rootPath} 不是有效的 .codex 根目录：缺少可读取的 sessions/ 目录。`,
    );
  }

  return {
    rootPath,
    sessionsDir,
    archivedDir: await getOptionalPath(path.join(rootPath, "archived_sessions")),
    sessionIndexPath: await getOptionalPath(path.join(rootPath, "session_index.jsonl")),
    historyPath: await getOptionalPath(path.join(rootPath, "history.jsonl")),
    sqlitePath: await getLatestVersionedSqlitePath(rootPath, "state"),
    logsSqlitePath: await getLatestVersionedSqlitePath(rootPath, "logs"),
    goalsSqlitePath: await getLatestVersionedSqlitePath(rootPath, "goals"),
    globalStatePath: await getOptionalPath(path.join(rootPath, ".codex-global-state.json")),
    shellSnapshotsDir: await getOptionalPath(path.join(rootPath, "shell_snapshots")),
  };
}
