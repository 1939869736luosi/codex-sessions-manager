import path from "node:path";
import { symlink } from "node:fs/promises";

/**
 * Directory links must not depend on Windows Developer Mode or symlink
 * privileges. Junctions are reparse points and exercise the same containment
 * boundary that production code must reject for managed descendants.
 */
export async function createDirectoryLink(target: string, linkPath: string): Promise<void> {
  await symlink(
    process.platform === "win32" ? path.resolve(target) : target,
    linkPath,
    process.platform === "win32" ? "junction" : "dir",
  );
}

/** File symlink tests are POSIX-only; Windows coverage uses junctions and hard links. */
export async function createFileSymlink(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, "file");
}
