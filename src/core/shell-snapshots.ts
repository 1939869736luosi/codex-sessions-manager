import path from "node:path";
import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";

import {
  captureManagedPath,
  createTrustedRootContext,
  isPathSafetyError,
  revalidateManagedPath,
  toManagedRelativePath,
  type TrustedRootContext,
} from "./path-safety.js";
import type { ScanSafetyIssue, ShellSnapshotFile } from "./types.js";

const SNAPSHOT_FILE_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\..+\.sh$/i;

export async function scanShellSnapshots(
  directoryPath: string | null,
  rootPath: string,
  trustedContext?: TrustedRootContext,
  warnings: string[] = [],
  unsafeSurfaces: ScanSafetyIssue[] = [],
): Promise<Map<string, ShellSnapshotFile[]>> {
  const byId = new Map<string, ShellSnapshotFile[]>();

  if (!directoryPath) {
    return byId;
  }

  const context = trustedContext ?? await createTrustedRootContext(rootPath);
  let relativeDirectoryPath: string;
  let directorySnapshot;
  try {
    relativeDirectoryPath = toManagedRelativePath(context, directoryPath);
    directorySnapshot = await captureManagedPath(context, relativeDirectoryPath, {
      expectedKind: "directory",
      allowMissing: false,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return byId;
    if (!isPathSafetyError(error)) throw error;
    warnings.push(error.message);
    unsafeSurfaces.push({
      surface: "shell_snapshots",
      path: error.path,
      code: error.code,
      reason: error.reason,
    });
    return byId;
  }

  let entries: Dirent[];
  try {
    entries = await readdir(directorySnapshot.absolutePath, { withFileTypes: true });
    await revalidateManagedPath(context, directorySnapshot);
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

    const relativePath = path.join(relativeDirectoryPath, entry.name);
    let snapshot;
    try {
      snapshot = await captureManagedPath(context, relativePath, {
        expectedKind: "file",
        allowMissing: false,
      });
    } catch (error) {
      if (!isPathSafetyError(error)) throw error;
      warnings.push(error.message);
      unsafeSurfaces.push({
        surface: "shell_snapshots",
        path: error.path,
        code: error.code,
        reason: error.reason,
      });
      continue;
    }
    const fileStat = await lstat(snapshot.absolutePath);
    await revalidateManagedPath(context, snapshot);
    const target: ShellSnapshotFile = {
      id: match[1],
      absolutePath: snapshot.absolutePath,
      relativePath: snapshot.relativePath,
      fileName: entry.name,
      size: fileStat.size,
      lastModified: fileStat.mtimeMs,
      device: fileStat.dev,
      inode: fileStat.ino,
    };
    const existing = byId.get(target.id) ?? [];
    existing.push(target);
    byId.set(target.id, existing);
  }

  return byId;
}
