import os from "node:os";
import path from "node:path";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  captureManagedPath,
  createTrustedRootContext,
  reconstructManagedPath,
  revalidateManagedPath,
  toManagedRelativePath,
} from "../src/core/path-safety.js";
import { createDirectoryLink, createFileSymlink } from "./helpers/fs-links.js";

describe("path safety", () => {
  let sandbox: string;
  let rootDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), "csm-path-safety-"));
    rootDir = path.join(sandbox, "codex-root");
    outsideDir = path.join(sandbox, "outside");
    await mkdir(path.join(rootDir, "sessions", "2026", "07"), { recursive: true });
    await mkdir(outsideDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("canonicalizes a symlink supplied as the trusted root", async () => {
    const rootLink = path.join(sandbox, "codex-root-link");
    await createDirectoryLink(rootDir, rootLink);

    const context = await createTrustedRootContext(rootLink);
    const rootStat = await lstat(rootDir);

    expect(context.lexicalPath).toBe(path.resolve(rootLink));
    expect(context.realPath).toBe(await realpath(rootDir));
    expect(context.identity).toMatchObject({
      dev: rootStat.dev,
      ino: rootStat.ino,
      kind: "directory",
    });
    expect(toManagedRelativePath(context, path.join(rootLink, "sessions"))).toBe("sessions");
  });

  it("reconstructs only normalized paths contained by the trusted root", async () => {
    const context = await createTrustedRootContext(rootDir);

    expect(reconstructManagedPath(context, "sessions/./2026/07")).toEqual({
      relativePath: path.join("sessions", "2026", "07"),
      absolutePath: path.join(context.realPath, "sessions", "2026", "07"),
    });
    expect(() => reconstructManagedPath(context, "../outside/secret.jsonl")).toThrowError(
      expect.objectContaining({ code: "UNSAFE_PATH" }),
    );
    expect(() => reconstructManagedPath(context, "..\\outside\\secret.jsonl")).toThrowError(
      expect.objectContaining({ code: "UNSAFE_PATH" }),
    );
    expect(() => reconstructManagedPath(context, path.join(outsideDir, "secret.jsonl"))).toThrowError(
      expect.objectContaining({ code: "UNSAFE_PATH" }),
    );
    expect(() => reconstructManagedPath(context, ".")).toThrowError(
      expect.objectContaining({ code: "UNSAFE_PATH" }),
    );
  });

  it("does not confuse a sibling sharing the root path prefix with a child", async () => {
    const context = await createTrustedRootContext(rootDir);
    const sibling = `${context.realPath}-backup`;
    await mkdir(sibling);

    expect(() => toManagedRelativePath(context, path.join(sibling, "session.jsonl"))).toThrowError(
      expect.objectContaining({ code: "UNSAFE_PATH" }),
    );
  });

  it("rejects a managed top-level directory symlink without reading its target", async () => {
    await rm(path.join(rootDir, "sessions"), { recursive: true });
    await writeFile(path.join(outsideDir, "secret.jsonl"), "outside\n", "utf8");
    await createDirectoryLink(outsideDir, path.join(rootDir, "sessions"));
    const context = await createTrustedRootContext(rootDir);

    await expect(captureManagedPath(context, "sessions/secret.jsonl")).rejects.toMatchObject({
      code: "UNSAFE_PATH",
      path: path.join(context.realPath, "sessions"),
    });
  });

  it("rejects a nested parent symlink", async () => {
    await rm(path.join(rootDir, "sessions", "2026"), { recursive: true });
    await createDirectoryLink(outsideDir, path.join(rootDir, "sessions", "2026"));
    const context = await createTrustedRootContext(rootDir);

    await expect(captureManagedPath(context, "sessions/2026/secret.jsonl")).rejects.toMatchObject({
      code: "UNSAFE_PATH",
      path: path.join(context.realPath, "sessions", "2026"),
    });
  });

  it.runIf(process.platform !== "win32")("rejects a final file symlink", async () => {
    const outsideFile = path.join(outsideDir, "secret.jsonl");
    const managedFile = path.join(rootDir, "sessions", "secret.jsonl");
    await writeFile(outsideFile, "outside\n", "utf8");
    await createFileSymlink(outsideFile, managedFile);
    const context = await createTrustedRootContext(rootDir);

    await expect(captureManagedPath(context, "sessions/secret.jsonl")).rejects.toMatchObject({
      code: "UNSAFE_PATH",
      path: path.join(context.realPath, "sessions", "secret.jsonl"),
    });
  });

  it("rejects a regular file with multiple hard links", async () => {
    const outsideFile = path.join(outsideDir, "secret.jsonl");
    const managedFile = path.join(rootDir, "sessions", "secret.jsonl");
    await writeFile(outsideFile, "outside\n", "utf8");
    await link(outsideFile, managedFile);
    const context = await createTrustedRootContext(rootDir);

    await expect(captureManagedPath(context, "sessions/secret.jsonl")).rejects.toMatchObject({
      code: "UNSAFE_PATH",
      path: path.join(context.realPath, "sessions", "secret.jsonl"),
    });
  });

  it("captures a valid existing path and revalidates the same identities", async () => {
    const managedFile = path.join(rootDir, "sessions", "2026", "07", "session.jsonl");
    await writeFile(managedFile, "session\n", "utf8");
    const context = await createTrustedRootContext(rootDir);

    const snapshot = await captureManagedPath(context, "sessions/2026/07/session.jsonl", {
      expectedKind: "file",
      allowMissing: false,
    });

    expect(snapshot).toMatchObject({
      exists: true,
      absolutePath: path.join(context.realPath, "sessions", "2026", "07", "session.jsonl"),
      relativePath: path.join("sessions", "2026", "07", "session.jsonl"),
      deepestExistingPath: path.join(context.realPath, "sessions", "2026", "07", "session.jsonl"),
    });
    expect(snapshot.identity?.kind).toBe("file");
    await expect(revalidateManagedPath(context, snapshot)).resolves.toBeUndefined();
  });

  it("validates a missing target through its deepest existing parent", async () => {
    const context = await createTrustedRootContext(rootDir);
    const snapshot = await captureManagedPath(context, "sessions/new/deep/session.jsonl", {
      expectedKind: "file",
    });

    expect(snapshot).toMatchObject({
      exists: false,
      identity: null,
      deepestExistingPath: path.join(context.realPath, "sessions"),
      deepestExistingRelativePath: "sessions",
    });
    await expect(revalidateManagedPath(context, snapshot)).resolves.toBeUndefined();

    await mkdir(path.join(rootDir, "sessions", "new"));
    await expect(revalidateManagedPath(context, snapshot)).rejects.toMatchObject({
      code: "STALE_PLAN",
    });
  });

  it("reports STALE_PLAN when an existing file is swapped after capture", async () => {
    const managedFile = path.join(rootDir, "sessions", "session.jsonl");
    const oldFile = path.join(rootDir, "sessions", "session.old.jsonl");
    await writeFile(managedFile, "old\n", "utf8");
    const context = await createTrustedRootContext(rootDir);
    const snapshot = await captureManagedPath(context, "sessions/session.jsonl", {
      expectedKind: "file",
      allowMissing: false,
    });

    await rename(managedFile, oldFile);
    await writeFile(managedFile, "replacement\n", "utf8");

    await expect(revalidateManagedPath(context, snapshot)).rejects.toMatchObject({
      code: "STALE_PLAN",
      path: path.join(context.realPath, "sessions", "session.jsonl"),
    });
  });

  it("reports STALE_PLAN when a safe parent becomes a symlink after capture", async () => {
    const managedDir = path.join(rootDir, "sessions", "2026");
    const oldDir = path.join(rootDir, "sessions", "2026-old");
    const context = await createTrustedRootContext(rootDir);
    const snapshot = await captureManagedPath(context, "sessions/2026/07/new.jsonl", {
      expectedKind: "file",
    });

    await rename(managedDir, oldDir);
    await createDirectoryLink(outsideDir, managedDir);

    await expect(revalidateManagedPath(context, snapshot)).rejects.toMatchObject({
      code: "STALE_PLAN",
      path: path.join(context.realPath, "sessions", "2026"),
    });
  });

  it.runIf(process.platform === "win32")(
    "treats a Windows junction as an unsafe managed reparse point",
    async () => {
      await rm(path.join(rootDir, "sessions"), { recursive: true });
      await createDirectoryLink(outsideDir, path.join(rootDir, "sessions"));
      const context = await createTrustedRootContext(rootDir);

      await expect(captureManagedPath(context, "sessions/secret.jsonl")).rejects.toMatchObject({
        code: "UNSAFE_PATH",
        path: path.join(context.realPath, "sessions"),
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "accepts contained paths whose root casing differs on case-insensitive Windows filesystems",
    async () => {
      const context = await createTrustedRootContext(rootDir);
      const swappedCaseRoot = context.realPath.replace(/[A-Za-z]/gu, (character) =>
        character === character.toUpperCase() ? character.toLowerCase() : character.toUpperCase());

      expect(toManagedRelativePath(context, path.join(swappedCaseRoot, "sessions"))).toBe("sessions");
    },
  );
});
