import path from "node:path";
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";

import type { ShellSnapshotFile } from "./types.js";

const SNAPSHOT_FILE_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\..+\.sh$/i;

export async function scanShellSnapshots(
  directoryPath: string | null,
  rootPath: string,
): Promise<Map<string, ShellSnapshotFile[]>> {
  const byId = new Map<string, ShellSnapshotFile[]>();

  if (!directoryPath) {
    return byId;
  }

  let entries: Dirent[];
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return byId;
    }

    throw error;
  }

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const match = entry.name.match(SNAPSHOT_FILE_PATTERN);

    if (!match) {
      continue;
    }

    const absolutePath = path.join(directoryPath, entry.name);
    const fileStat = await stat(absolutePath);
    const target: ShellSnapshotFile = {
      id: match[1],
      absolutePath,
      relativePath: path.relative(rootPath, absolutePath),
      fileName: entry.name,
      size: fileStat.size,
      lastModified: fileStat.mtimeMs,
    };
    const existing = byId.get(target.id) ?? [];
    existing.push(target);
    byId.set(target.id, existing);
  }

  return byId;
}
