import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import {
  appendFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { exportSessionBackup } from "../src/core/backup.js";
import {
  cleanupSessionIndexes,
  cleanupStaleIndexes,
  deleteSessions,
} from "../src/core/delete.js";
import { inspectCodexRoot } from "../src/core/doctor.js";
import { scanCodexRoot } from "../src/core/scan.js";
import { readSessionTimeline } from "../src/core/timeline.js";
import { deleteStateRows } from "../src/core/sqlite.js";
import {
  moveSessionsToTrash,
  purgeTrashEntry,
  restoreTrashEntry,
} from "../src/core/trash.js";
import { createFixture, FIXTURE_IDS } from "./helpers/fixture.js";
import { createDirectoryLink, createFileSymlink } from "./helpers/fs-links.js";
import { setMutationCheckpointHookForTests } from "../src/core/mutation-safety.js";

const cleanupPaths: string[] = [];

async function fileSha256(filePath: string): Promise<string> {
  return crypto.createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function makeTempRoot(prefix: string): Promise<string> {
  const tempPath = await mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupPaths.push(tempPath);
  return tempPath;
}

afterEach(async () => {
  setMutationCheckpointHookForTests(null);
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("filesystem containment regressions", () => {
  it.runIf(process.platform !== "win32")("binds SQLite writes to the canonical root captured by the scan", async () => {
    const original = await createFixture();
    const replacement = await createFixture();
    cleanupPaths.push(original.rootDir, replacement.rootDir);
    const base = await makeTempRoot("csm-security-root-alias-");
    const rootAlias = path.join(base, "codex-root");
    await createDirectoryLink(original.rootDir, rootAlias);

    const scan = await scanCodexRoot(rootAlias);
    const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID);
    expect(session).toBeTruthy();
    expect(scan.root.sqlitePath).toBe(path.join(await realpath(original.rootDir), path.basename(original.paths.sqlite)));
    const originalBefore = await fileSha256(original.paths.sqlite);
    const replacementBefore = await fileSha256(replacement.paths.sqlite);

    await rm(rootAlias, { force: true });
    await createDirectoryLink(replacement.rootDir, rootAlias);

    await expect(deleteSessions(scan, [session!], { allowActive: true })).rejects.toThrow(/STALE_PLAN/u);
    await expect(fileSha256(original.paths.sqlite)).resolves.toBe(originalBefore);
    await expect(fileSha256(replacement.paths.sqlite)).resolves.toBe(replacementBefore);
  });

  it.runIf(process.platform !== "win32")("refuses a SQLite journal symlink without changing its external sentinel", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const outside = await makeTempRoot("csm-security-sqlite-journal-");
    const sentinel = path.join(outside, "sentinel");
    await writeFile(sentinel, "outside journal sentinel\n", "utf8");
    await createFileSymlink(sentinel, `${fixture.paths.sqlite}-journal`);
    const before = await fileSha256(sentinel);

    const scan = await scanCodexRoot(fixture.rootDir);
    expect(scan.root.sqlitePath).toBeNull();
    expect(scan.warnings.join("\n")).toMatch(/UNSAFE_PATH|symbolic link|junction/iu);
    const doctor = await inspectCodexRoot(fixture.rootDir);
    expect(doctor.sqlite.activeStatePath).toBeNull();
    expect(doctor.warnings.join("\n")).toMatch(/UNSAFE_PATH|symbolic link|junction/iu);
    expect(() => deleteStateRows(fixture.paths.sqlite, [FIXTURE_IDS.ARCHIVED_ID])).toThrow(/UNSAFE_PATH|sidecar/iu);
    await expect(fileSha256(sentinel)).resolves.toBe(before);
  });

  it.runIf(process.platform !== "win32")("refuses a hard-linked SQLite WAL without changing the external link", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const outside = await makeTempRoot("csm-security-sqlite-wal-");
    const externalWal = path.join(outside, "external-wal");
    const db = new Database(fixture.paths.sqlite);
    db.pragma("journal_mode = WAL");
    db.prepare("update threads set updated_at = updated_at + 1 where id = ?").run(FIXTURE_IDS.ARCHIVED_ID);
    await link(`${fixture.paths.sqlite}-wal`, externalWal);
    const before = await fileSha256(externalWal);
    try {
      const scan = await scanCodexRoot(fixture.rootDir);
      expect(scan.root.sqlitePath).toBeNull();
      expect(scan.warnings.join("\n")).toMatch(/UNSAFE_PATH|hard link/iu);
      expect(() => deleteStateRows(fixture.paths.sqlite, [FIXTURE_IDS.ARCHIVED_ID])).toThrow(/UNSAFE_PATH|hard links/iu);
      await expect(fileSha256(externalWal)).resolves.toBe(before);
    } finally {
      db.close();
    }
  });

  it("does not follow a managed sessions symlink during a read-only scan", async () => {
    const base = await makeTempRoot("csm-security-scan-");
    const root = path.join(base, "root");
    const outside = path.join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await createDirectoryLink(outside, path.join(root, "sessions"));

    const outsideRollout = path.join(
      outside,
      `rollout-2026-07-11T00-00-00-${FIXTURE_IDS.ACTIVE_ID}.jsonl`,
    );
    await writeFile(outsideRollout, '{"type":"event_msg"}\n', "utf8");

    const scan = await scanCodexRoot(root);

    expect(scan.sessions).toHaveLength(0);
    expect(scan.warnings.join("\n")).toContain("UNSAFE_PATH");
    await expect(readFile(outsideRollout, "utf8")).resolves.toContain("event_msg");
  });

  it.runIf(process.platform !== "win32")("does not read an external global-state symlink during doctor", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const outside = await makeTempRoot("csm-security-doctor-outside-");
    const outsideState = path.join(outside, "outside-global-state.json");
    await writeFile(
      outsideState,
      `${JSON.stringify({ "pinned-thread-ids": [FIXTURE_IDS.ACTIVE_ID] })}\n`,
      "utf8",
    );
    await rm(fixture.paths.globalState, { force: true });
    await createFileSymlink(outsideState, fixture.paths.globalState);

    const report = await inspectCodexRoot(fixture.rootDir);

    expect(report.globalState.knownRefs).toEqual([]);
    expect(report.warnings.join("\n")).toMatch(/UNSAFE_PATH|symbolic link|junction/iu);
  });

  it.runIf(process.platform !== "win32")("does not open an external SQLite symlink during doctor", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const outside = await makeTempRoot("csm-security-doctor-sqlite-");
    const outsideState = path.join(outside, "state.sqlite");
    await rename(fixture.paths.sqlite, outsideState);
    await createFileSymlink(outsideState, fixture.paths.sqlite);

    const report = await inspectCodexRoot(fixture.rootDir);

    expect(report.sqlite.activeStatePath).toBeNull();
    expect(report.warnings.join("\n")).toMatch(/UNSAFE_PATH|symbolic link|junction/iu);
    await expect(readFile(outsideState)).resolves.not.toHaveLength(0);
  });

  it.runIf(process.platform !== "win32")("does not fall back to a writable SQLite database when config.toml is unsafe", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const outside = await makeTempRoot("csm-security-config-");
    const outsideConfig = path.join(outside, "config.toml");
    await writeFile(outsideConfig, `sqlite_home = ${JSON.stringify(outside)}\n`, "utf8");
    await createFileSymlink(outsideConfig, path.join(fixture.rootDir, "config.toml"));

    const scan = await scanCodexRoot(fixture.rootDir);

    expect(scan.root.sqliteHomeTrusted).toBe(false);
    expect(scan.root.sqlitePath).toBeNull();
    expect(scan.root.logsSqlitePath).toBeNull();
    expect(scan.root.goalsSqlitePath).toBeNull();
    expect(scan.root.warnings.join("\n")).toMatch(/UNSAFE_PATH|symbolic link|junction/iu);
  });

  it("refuses a delete when the scanned sessions parent is swapped for an external symlink", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const outside = await makeTempRoot("csm-security-delete-outside-");
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID);
    expect(session).toBeTruthy();

    const originalSessions = path.join(fixture.rootDir, "sessions-original");
    await rename(path.join(fixture.rootDir, "sessions"), originalSessions);
    const outsideTarget = path.join(outside, "2026", "04", "03", path.basename(fixture.paths.activeSessionFile));
    await mkdir(path.dirname(outsideTarget), { recursive: true });
    await writeFile(outsideTarget, "outside sentinel\n", "utf8");
    await createDirectoryLink(outside, path.join(fixture.rootDir, "sessions"));

    await expect(deleteSessions(scan, [session!], { allowActive: true })).rejects.toThrow(/UNSAFE_PATH|STALE_PLAN/);
    await expect(readFile(outsideTarget, "utf8")).resolves.toBe("outside sentinel\n");
    await expect(readFile(path.join(originalSessions, "2026", "04", "03", path.basename(fixture.paths.activeSessionFile)), "utf8"))
      .resolves.toContain("active user input");
  });

  it("refuses a same-size same-mtime rollout replacement after scan", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID)!;
    const originalBytes = await readFile(fixture.paths.activeSessionFile);
    const originalStat = await stat(fixture.paths.activeSessionFile);
    const displacedPath = `${fixture.paths.activeSessionFile}.displaced`;
    await rename(fixture.paths.activeSessionFile, displacedPath);
    await writeFile(fixture.paths.activeSessionFile, originalBytes);
    await utimes(fixture.paths.activeSessionFile, originalStat.atime, originalStat.mtime);

    await expect(deleteSessions(scan, [session], { allowActive: true })).rejects.toThrow(/STALE_PLAN/u);
    await expect(readFile(fixture.paths.activeSessionFile)).resolves.toEqual(originalBytes);
  });

  it("enforces the active-session override inside core mutation APIs", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID)!;

    await expect(deleteSessions(scan, [session])).rejects.toThrow(/ACTIVE_SESSION/u);
    await expect(moveSessionsToTrash(scan, [session])).rejects.toThrow(/ACTIVE_SESSION/u);
    await expect(cleanupSessionIndexes(scan, [session])).rejects.toThrow(/ACTIVE_SESSION/u);
    await expect(readFile(fixture.paths.activeSessionFile, "utf8")).resolves.toContain("active user input");
  });

  it("refuses an archived delete when the same session becomes active after preview", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const archived = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ARCHIVED_ID)!;
    const archivedRelative = path.relative(path.join(fixture.rootDir, "archived_sessions"), fixture.paths.archivedSessionFile);
    const newActivePath = path.join(fixture.rootDir, "sessions", archivedRelative);
    await mkdir(path.dirname(newActivePath), { recursive: true });
    const archivedBytes = await readFile(fixture.paths.archivedSessionFile);
    await writeFile(newActivePath, archivedBytes);

    await expect(deleteSessions(scan, [archived])).rejects.toThrow(/STALE_PLAN|ACTIVE_SESSION/u);
    await expect(cleanupSessionIndexes(scan, [archived])).rejects.toThrow(/STALE_PLAN|ACTIVE_SESSION/u);
    await expect(readFile(fixture.paths.archivedSessionFile)).resolves.toEqual(archivedBytes);
    await expect(readFile(newActivePath)).resolves.toEqual(archivedBytes);
  });

  it("rechecks active state after the recovery journal and before the first user-data write", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const archived = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ARCHIVED_ID)!;
    const archivedBytes = await readFile(fixture.paths.archivedSessionFile);
    const lateActivePath = path.join(
      fixture.rootDir,
      "sessions/2026/07/11",
      `rollout-2026-07-11T00-00-00-${FIXTURE_IDS.ARCHIVED_ID}.jsonl`,
    );
    setMutationCheckpointHookForTests(async (event) => {
      if (event.kind === "delete" && event.name === "recovery-payload" && event.status === "committed") {
        await mkdir(path.dirname(lateActivePath), { recursive: true });
        await writeFile(lateActivePath, archivedBytes);
      }
    });

    await expect(deleteSessions(scan, [archived])).rejects.toThrow(/STALE_PLAN|ACTIVE_SESSION/u);

    await expect(readFile(fixture.paths.archivedSessionFile)).resolves.toEqual(archivedBytes);
    await expect(readFile(lateActivePath)).resolves.toEqual(archivedBytes);
    await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toContain(FIXTURE_IDS.ARCHIVED_ID);
  });

  it("does not overwrite a concurrent JSONL append detected at the commit boundary", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const archived = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ARCHIVED_ID)!;
    const sentinel = `${JSON.stringify({
      id: FIXTURE_IDS.UNRELATED_ID,
      thread_name: "concurrent append",
      updated_at: "2026-07-11T00:00:00.000Z",
    })}\n`;
    setMutationCheckpointHookForTests(async (event) => {
      if (event.kind === "delete" && event.name === "session-index" && event.status === "started") {
        await appendFile(fixture.paths.sessionIndex, sentinel, "utf8");
      }
    });

    await expect(deleteSessions(scan, [archived], { allowActive: true })).rejects.toThrow(/STALE_PLAN/u);

    const index = await readFile(fixture.paths.sessionIndex, "utf8");
    expect(index).toContain(FIXTURE_IDS.ARCHIVED_ID);
    expect(index).toContain("concurrent append");
    await expect(readFile(fixture.paths.archivedSessionFile, "utf8")).resolves.toContain("archived assistant output");
  });

  it("refuses stale-index cleanup when a stale ID gains an active rollout after preview", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const activePath = path.join(
      fixture.rootDir,
      "sessions/2026/07/11",
      `rollout-2026-07-11T00-00-00-${FIXTURE_IDS.STALE_ID}.jsonl`,
    );
    await mkdir(path.dirname(activePath), { recursive: true });
    await writeFile(
      activePath,
      `${JSON.stringify({ type: "session_meta", payload: { id: FIXTURE_IDS.STALE_ID } })}\n`,
      "utf8",
    );

    await expect(cleanupStaleIndexes(scan)).rejects.toThrow(/STALE_PLAN/u);
    await expect(readFile(fixture.paths.sessionIndex, "utf8")).resolves.toContain(FIXTURE_IDS.STALE_ID);
    await expect(readFile(activePath, "utf8")).resolves.toContain(FIXTURE_IDS.STALE_ID);
  });

  it.runIf(process.platform !== "win32")("refuses stale-index cleanup when session_index is an external symlink", async () => {
    const base = await makeTempRoot("csm-security-index-");
    const root = path.join(base, "root");
    const outsideIndex = path.join(base, "outside-index.jsonl");
    await mkdir(path.join(root, "sessions"), { recursive: true });
    const original = `${JSON.stringify({
      id: FIXTURE_IDS.STALE_ID,
      thread_name: "outside stale",
      updated_at: "2026-07-11T00:00:00.000Z",
    })}\n`;
    await writeFile(outsideIndex, original, "utf8");
    await createFileSymlink(outsideIndex, path.join(root, "session_index.jsonl"));

    const scan = await scanCodexRoot(root);
    await expect(cleanupStaleIndexes(scan)).rejects.toThrow(/UNSAFE_PATH/);
    await expect(readFile(outsideIndex, "utf8")).resolves.toBe(original);
  });

  it("rejects malformed session ids before they can become trash metadata paths", async () => {
    const base = await makeTempRoot("csm-security-id-");
    const root = path.join(base, "root");
    const malformedId = "../../../../outside-victim";
    const outsideVictim = path.join(base, "outside-victim.json");
    await mkdir(path.join(root, "sessions"), { recursive: true });
    await writeFile(
      path.join(root, "session_index.jsonl"),
      `${JSON.stringify({ id: malformedId, thread_name: "malformed" })}\n`,
      "utf8",
    );
    await writeFile(outsideVictim, "outside sentinel\n", "utf8");

    const scan = await scanCodexRoot(root);
    const session = scan.sessions.find((entry) => entry.id === malformedId);
    expect(session).toBeTruthy();

    await expect(moveSessionsToTrash(scan, [session!])).rejects.toThrow(/MALFORMED_ID/);
    await expect(readFile(outsideVictim, "utf8")).resolves.toBe("outside sentinel\n");
  });

  it("refuses export and timeline reads after the rollout parent is swapped", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const outside = await makeTempRoot("csm-security-read-outside-");
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID)!;

    await rename(path.join(fixture.rootDir, "sessions"), path.join(fixture.rootDir, "sessions-original"));
    const outsideTarget = path.join(outside, "2026", "04", "03", path.basename(fixture.paths.activeSessionFile));
    await mkdir(path.dirname(outsideTarget), { recursive: true });
    await writeFile(outsideTarget, "outside secret\n", "utf8");
    await createDirectoryLink(outside, path.join(fixture.rootDir, "sessions"));

    await expect(exportSessionBackup(scan, session)).rejects.toThrow(/UNSAFE_PATH|STALE_PLAN/);
    await expect(readSessionTimeline(session, scan.root.rootPath)).rejects.toThrow(/UNSAFE_PATH|STALE_PLAN/);
  });

  it("refuses to create trash through an external trash-root symlink", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const outsideTrash = await makeTempRoot("csm-security-trash-outside-");
    await createDirectoryLink(outsideTrash, path.join(fixture.rootDir, ".codex-sessions-trash"));
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID)!;

    await expect(moveSessionsToTrash(scan, [session], { allowActive: true })).rejects.toThrow(/UNSAFE_PATH/);
    expect(await readdir(outsideTrash)).toEqual([]);
  });

  it("refuses purge when the trash root is swapped for an external symlink", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ARCHIVED_ID)!;
    const trashed = await moveSessionsToTrash(scan, [session], { allowActive: true });
    const externalTrashRoot = await makeTempRoot("csm-security-purge-outside-");
    const originalTrashRoot = path.join(fixture.rootDir, ".codex-sessions-trash");
    const externalEntry = path.join(externalTrashRoot, trashed.trashEntry.trashId);
    await rename(path.join(originalTrashRoot, trashed.trashEntry.trashId), externalEntry);
    await rename(originalTrashRoot, path.join(fixture.rootDir, ".codex-sessions-trash-original"));
    await createDirectoryLink(externalTrashRoot, originalTrashRoot);

    await expect(purgeTrashEntry(fixture.rootDir, trashed.trashEntry.trashId)).rejects.toThrow(/UNSAFE_PATH/);
    await expect(readFile(path.join(externalEntry, "manifest.json"), "utf8")).resolves.toContain(
      trashed.trashEntry.trashId,
    );
  });

  it("refuses restore when the sessions parent is replaced by an external symlink", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID)!;
    const trashed = await moveSessionsToTrash(scan, [session], { allowActive: true });
    const outsideSessions = await makeTempRoot("csm-security-restore-outside-");
    await rename(path.join(fixture.rootDir, "sessions"), path.join(fixture.rootDir, "sessions-original"));
    await createDirectoryLink(outsideSessions, path.join(fixture.rootDir, "sessions"));

    await expect(restoreTrashEntry(fixture.rootDir, trashed.trashEntry.trashId)).rejects.toThrow(/UNSAFE_PATH/);
    expect(await readdir(outsideSessions)).toEqual([]);
  });

  it("rejects a manifest that tries to restore a rollout as config.toml", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ARCHIVED_ID)!;
    const trashed = await moveSessionsToTrash(scan, [session]);
    const manifestPath = path.join(
      fixture.rootDir,
      ".codex-sessions-trash",
      trashed.trashEntry.trashId,
      "manifest.json",
    );
    const bundle = JSON.parse(await readFile(manifestPath, "utf8")) as {
      sessionFiles: Array<{ path: string }>;
    };
    bundle.sessionFiles[0].path = "config.toml";
    await writeFile(manifestPath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

    await expect(restoreTrashEntry(fixture.rootDir, trashed.trashEntry.trashId))
      .rejects.toThrow(/manifest|UNSAFE_PATH|白名单/);
    await expect(readFile(path.join(fixture.rootDir, "config.toml"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
