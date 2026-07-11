import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { cleanupStaleIndexes, deleteSessions } from "../src/core/delete.js";
import { buildDeletePlanRootFingerprint } from "../src/core/plan-file.js";
import { scanCodexRoot } from "../src/core/scan.js";
import {
  moveSessionsToTrash,
  purgeTrashEntry,
  restoreTrashEntry,
} from "../src/core/trash.js";
import type { DeletePlanSurfaceFingerprint } from "../src/core/types.js";
import { createFixture, FIXTURE_IDS } from "./helpers/fixture.js";
import { createDirectoryLink, createFileSymlink } from "./helpers/fs-links.js";

const cleanupPaths: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("delete-plan managed fingerprints", () => {
  it.runIf(process.platform !== "win32")(
    "marks every symlinked fingerprint surface unsafe without reading the external sentinel",
    async () => {
      const fixture = await createFixture({ logsDatabase: true, goalsDatabase: true });
      cleanupPaths.push(fixture.rootDir);
      const memoriesPath = path.join(fixture.rootDir, "memories_1.sqlite");
      await copyFile(fixture.paths.sqlite, memoriesPath);
      const scan = await scanCodexRoot(fixture.rootDir);
      const outside = await makeTempRoot("csm-plan-fingerprint-outside-");
      const surfaces: Array<{
        name: keyof Pick<
          Awaited<ReturnType<typeof buildDeletePlanRootFingerprint>>,
          "sessionIndex" | "history" | "globalState" | "sqlite" | "logsSqlite" | "goalsSqlite" | "memoriesSqlite"
        >;
        filePath: string;
      }> = [
        { name: "sessionIndex", filePath: fixture.paths.sessionIndex },
        { name: "history", filePath: fixture.paths.history },
        { name: "globalState", filePath: fixture.paths.globalState },
        { name: "sqlite", filePath: fixture.paths.sqlite },
        { name: "logsSqlite", filePath: fixture.paths.logsSqlite! },
        { name: "goalsSqlite", filePath: fixture.paths.goalsSqlite! },
        { name: "memoriesSqlite", filePath: memoriesPath },
      ];
      const sentinelHashes = new Map<string, string>();

      for (const surface of surfaces) {
        const outsidePath = path.join(outside, `${surface.name}-${path.basename(surface.filePath)}`);
        await rename(surface.filePath, outsidePath);
        sentinelHashes.set(outsidePath, crypto.createHash("sha256").update(await readFile(outsidePath)).digest("hex"));
        await createFileSymlink(outsidePath, surface.filePath);
      }

      const fingerprint = await buildDeletePlanRootFingerprint(scan);

      for (const surface of surfaces) {
        expect(fingerprint[surface.name]).toMatchObject({
          availability: "unsafe",
          exists: false,
          parseable: false,
          sha256: null,
        } satisfies Partial<DeletePlanSurfaceFingerprint>);
      }
      for (const [outsidePath, expectedHash] of sentinelHashes) {
        expect(crypto.createHash("sha256").update(await readFile(outsidePath)).digest("hex")).toBe(expectedHash);
      }
    },
  );
});

describe("typed incomplete-scan mutation gate", () => {
  it("refuses cleanup-stale from typed unsafe state even when warning strings are removed", async () => {
    const base = await makeTempRoot("csm-incomplete-scan-");
    const root = path.join(base, "root");
    const outside = path.join(base, "outside-sessions");
    await mkdir(root);
    await mkdir(outside);
    await createDirectoryLink(outside, path.join(root, "sessions"));
    const indexText = `${JSON.stringify({
      id: FIXTURE_IDS.STALE_ID,
      thread_name: "must remain",
      updated_at: "2026-07-11T00:00:00.000Z",
    })}\n`;
    const indexPath = path.join(root, "session_index.jsonl");
    await writeFile(indexPath, indexText, "utf8");

    const scan = await scanCodexRoot(root);
    expect(scan.safety.unsafeSurfaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ surface: "sessions", code: "UNSAFE_PATH" }),
    ]));
    scan.warnings = [];
    scan.root.warnings = [];

    await expect(cleanupStaleIndexes(scan)).rejects.toThrow(/UNSAFE_PATH.*scan is incomplete/iu);
    await expect(readFile(indexPath, "utf8")).resolves.toBe(indexText);
  });

  it.runIf(process.platform !== "win32")(
    "refuses delete and trash when the starting scan has an unsafe managed surface",
    async () => {
      const fixture = await createFixture();
      cleanupPaths.push(fixture.rootDir);
      const outside = await makeTempRoot("csm-incomplete-global-");
      const outsideState = path.join(outside, "global.json");
      await rename(fixture.paths.globalState, outsideState);
      await createFileSymlink(outsideState, fixture.paths.globalState);
      const scan = await scanCodexRoot(fixture.rootDir);
      const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID)!;
      expect(scan.safety.unsafeSurfaces.some((issue) => issue.surface === "global_state")).toBe(true);

      await expect(deleteSessions(scan, [session], { allowActive: true })).rejects.toThrow(/UNSAFE_PATH/iu);
      await expect(moveSessionsToTrash(scan, [session], { allowActive: true })).rejects.toThrow(/UNSAFE_PATH/iu);
      await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
    },
  );

  it.runIf(process.platform !== "win32")(
    "refuses restore and purge when their fresh scan sees an unsafe surface",
    async () => {
      const fixture = await createFixture();
      cleanupPaths.push(fixture.rootDir);
      const scan = await scanCodexRoot(fixture.rootDir);
      const archived = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ARCHIVED_ID)!;
      const trashed = await moveSessionsToTrash(scan, [archived]);
      const outside = await makeTempRoot("csm-incomplete-trash-ops-");
      const outsideHistory = path.join(outside, "history.jsonl");
      await rename(fixture.paths.history, outsideHistory);
      await createFileSymlink(outsideHistory, fixture.paths.history);

      await expect(restoreTrashEntry(fixture.rootDir, trashed.trashEntry.trashId)).rejects.toThrow(/UNSAFE_PATH/iu);
      await expect(purgeTrashEntry(fixture.rootDir, trashed.trashEntry.trashId)).rejects.toThrow(/UNSAFE_PATH/iu);
      await expect(readFile(outsideHistory, "utf8")).resolves.toBeDefined();
    },
  );

  it("refuses a shallow-cloned scan after the root pathname is replaced", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID)!;
    const clone = { ...scan, root: { ...scan.root } };
    const displacedRoot = `${fixture.rootDir}-displaced`;
    cleanupPaths.push(displacedRoot);
    await rename(fixture.rootDir, displacedRoot);
    await mkdir(path.join(fixture.rootDir, "sessions"), { recursive: true });
    const replacementSentinel = path.join(fixture.rootDir, "sessions", "replacement.txt");
    await writeFile(replacementSentinel, "replacement sentinel\n", "utf8");

    await expect(deleteSessions(clone, [session], { allowActive: true })).rejects.toThrow(/UNSAFE_PATH/iu);
    await expect(readFile(replacementSentinel, "utf8")).resolves.toBe("replacement sentinel\n");
    await expect(readFile(path.join(displacedRoot, path.relative(fixture.rootDir, fixture.paths.activeSessionFile)), "utf8"))
      .resolves.toContain("active user input");
  });

  it.runIf(process.platform !== "win32")(
    "records every unsafe top-level mutation surface as typed state",
    async () => {
      const base = await makeTempRoot("csm-typed-surfaces-");
      const root = path.join(base, "root");
      const outside = path.join(base, "outside");
      await mkdir(root);
      await mkdir(outside);
      for (const directory of ["sessions", "archived_sessions", "shell_snapshots"]) {
        const target = path.join(outside, directory);
        await mkdir(target);
        await createDirectoryLink(target, path.join(root, directory));
      }
      for (const fileName of [
        "session_index.jsonl",
        "history.jsonl",
        ".codex-global-state.json",
        "state_1.sqlite",
      ]) {
        const target = path.join(outside, fileName);
        await writeFile(target, "external sentinel\n", "utf8");
        await createFileSymlink(target, path.join(root, fileName));
      }

      const scan = await scanCodexRoot(root);
      const unsafeNames = new Set(scan.safety.unsafeSurfaces.map((issue) => issue.surface));
      expect(unsafeNames).toEqual(new Set([
        "sessions",
        "archived_sessions",
        "shell_snapshots",
        "session_index",
        "history",
        "global_state",
        "sqlite_state",
      ]));
      await expect(cleanupStaleIndexes(scan)).rejects.toThrow(/UNSAFE_PATH/iu);
      for (const fileName of ["session_index.jsonl", "history.jsonl", ".codex-global-state.json", "state_1.sqlite"]) {
        await expect(readFile(path.join(outside, fileName), "utf8")).resolves.toBe("external sentinel\n");
      }
    },
  );
});
