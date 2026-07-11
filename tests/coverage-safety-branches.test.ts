import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { createTrustedRootContext } from "../src/core/path-safety.js";
import {
  buildDeletePlanFile,
  buildDeletePlanRootFingerprint,
} from "../src/core/plan-file.js";
import { buildPlanDelete } from "../src/core/plan-delete.js";
import {
  createRecoveryFileTransition,
  parseOperationRecoveryPayload,
  reconcileRecoveryFiles,
  type OperationRecoveryPayloadV1,
} from "../src/core/recovery.js";
import { scanCodexRoot } from "../src/core/scan.js";
import { createFixture, FIXTURE_IDS } from "./helpers/fixture.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe("safety branch coverage", () => {
  it("sorts selected family edges deterministically and accepts a missing SQLite home", async () => {
    const fixture = await createFixture();
    cleanupPaths.push(fixture.rootDir);
    const scan = await scanCodexRoot(fixture.rootDir);
    const selected = FIXTURE_IDS.ARCHIVED_ID;
    const changed = {
      ...scan,
      root: { ...scan.root, sqliteHomePath: null },
      sqlite: {
        ...scan.sqlite,
        threadSpawnEdges: [
          { parentThreadId: selected, childThreadId: "z", status: "z" },
          { parentThreadId: selected, childThreadId: "a", status: "b" },
          { parentThreadId: selected, childThreadId: "a", status: "a" },
          { parentThreadId: "aaa", childThreadId: selected, status: null },
        ],
      },
    } as typeof scan;

    const fingerprint = await buildDeletePlanRootFingerprint(changed);
    const plan = await buildDeletePlanFile(changed, buildPlanDelete(changed, [selected]));

    expect(fingerprint.sqliteHomeRealpath).toBeNull();
    expect(plan.selectedSnapshot.familyEdges).toEqual([
      { parentThreadId: selected, childThreadId: "a", status: "a" },
      { parentThreadId: selected, childThreadId: "a", status: "b" },
      { parentThreadId: selected, childThreadId: "z", status: "z" },
      { parentThreadId: "aaa", childThreadId: selected, status: null },
    ]);
  });

  it("rejects duplicate recovery paths before touching the filesystem", () => {
    const operationId = "019daaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
    const transition = createRecoveryFileTransition("session_index.jsonl", "before\n", "after\n");
    const payload: OperationRecoveryPayloadV1 = {
      schemaVersion: "codex-sessions-recovery.v1",
      operationId,
      kind: "cleanup-index",
      strategy: "rollforward",
      rootRealPath: "/safe/root",
      targetIds: [FIXTURE_IDS.ARCHIVED_ID],
      files: [transition, transition],
    };

    expect(() => parseOperationRecoveryPayload(payload, {
      operationId,
      kind: "cleanup-index",
      targetIds: [FIXTURE_IDS.ARCHIVED_ID],
    })).toThrow("duplicate recovery file path");
  });

  it("rolls an interrupted file creation back to a missing file idempotently", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "csm-coverage-reconcile-"));
    cleanupPaths.push(root);
    await mkdir(path.join(root, "sessions"));
    await writeFile(path.join(root, "session_index.jsonl"), "created\n", "utf8");
    const context = await createTrustedRootContext(root);
    const payload: OperationRecoveryPayloadV1 = {
      schemaVersion: "codex-sessions-recovery.v1",
      operationId: "019daaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee",
      kind: "delete",
      strategy: "rollback",
      rootRealPath: context.realPath,
      targetIds: [FIXTURE_IDS.ARCHIVED_ID],
      files: [createRecoveryFileTransition("session_index.jsonl", null, "created\n")],
    };

    await reconcileRecoveryFiles(context, payload);
    await expect(access(path.join(root, "session_index.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });

    await expect(reconcileRecoveryFiles(context, payload)).resolves.toBeUndefined();
  });
});
