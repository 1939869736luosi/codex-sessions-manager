import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupSessionIndexes,
  cleanupStaleIndexes,
  deleteSessions,
} from "../src/core/delete.js";
import {
  MUTATION_CHECKPOINT_INVENTORY,
  setMutationCheckpointHookForTests,
  type MutationCheckpointName,
  type MutationCheckpointStatus,
  type MutationOperationKind,
} from "../src/core/mutation-safety.js";
import { resolveSessions } from "../src/core/query.js";
import { getRecoveryStatus, recoverInterruptedOperation } from "../src/core/recovery.js";
import { scanCodexRoot } from "../src/core/scan.js";
import { collectSqliteDeletionCounts } from "../src/core/sqlite.js";
import {
  listTrashEntries,
  moveSessionsToTrash,
  purgeTrashEntry,
  restoreTrashEntry,
} from "../src/core/trash.js";
import { createFixture, FIXTURE_IDS, type Fixture } from "./helpers/fixture.js";

interface ProductionOperationCase {
  fixture: Fixture;
  sessionId: string;
  execute(): Promise<unknown>;
}

interface CoreState {
  session: null | {
    kind: string;
    archived: boolean;
    fileTargets: string[];
    hasSessionIndex: boolean;
    sessionIndexCount: number;
    hasHistory: boolean;
    historyCount: number;
    hasThread: boolean;
  };
  shellSnapshots: string[];
  sqlite: {
    threadRows: number;
    logRows: number;
    spawnEdgeRows: number;
    assignedAgentJobs: number;
    dynamicToolRows: number;
    stage1Rows: number;
    threadGoalRows: number;
  };
  globalStateKnown: number;
  globalStateExact: number;
  globalStateUnknown: number;
  matchingValidTrashEntries: number;
  matchingInvalidTrashEntries: number;
}

async function captureCoreState(operationCase: ProductionOperationCase): Promise<CoreState> {
  const { fixture, sessionId } = operationCase;
  const scan = await scanCodexRoot(fixture.rootDir);
  const session = scan.sessions.find((candidate) => candidate.id === sessionId) ?? null;
  const trashEntries = await listTrashEntries(fixture.rootDir);
  const matchingTrashEntries = trashEntries.filter((entry) => entry.sessionIds.includes(sessionId));
  const sqlite = collectSqliteDeletionCounts(
    scan.root.sqlitePath,
    [sessionId],
    null,
    scan.root.goalsSqlitePath,
  ).get(sessionId) ?? {
    threadRows: 0,
    logRows: 0,
    spawnEdgeRows: 0,
    assignedAgentJobs: 0,
    dynamicToolRows: 0,
    stage1Rows: 0,
    threadGoalRows: 0,
  };
  return {
    session: session
      ? {
          kind: session.kind,
          archived: session.archived,
          fileTargets: session.fileTargets.map((target) => target.relativePath).sort(),
          hasSessionIndex: session.hasSessionIndex,
          sessionIndexCount: session.sessionIndexCount,
          hasHistory: session.hasHistory,
          historyCount: session.historyCount,
          hasThread: session.hasThread,
        }
      : null,
    shellSnapshots: (scan.shellSnapshots.filesById.get(sessionId) ?? [])
      .map((target) => target.relativePath)
      .sort(),
    sqlite,
    globalStateKnown: scan.globalState.refsById.get(sessionId)?.length ?? 0,
    globalStateExact: scan.globalState.exactKeyRefsById.get(sessionId)?.length ?? 0,
    globalStateUnknown: scan.globalState.possibleUnknownRefsById.get(sessionId)?.length ?? 0,
    matchingValidTrashEntries: matchingTrashEntries.filter((entry) => entry.status === "valid").length,
    matchingInvalidTrashEntries: matchingTrashEntries.filter((entry) => entry.status === "invalid").length,
  };
}

async function prepareOperation(kind: MutationOperationKind): Promise<ProductionOperationCase> {
  const fixture = await createFixture();
  const sessionId = kind === "cleanup-stale" ? FIXTURE_IDS.STALE_ID : FIXTURE_IDS.ACTIVE_ID;

  if (kind === "restore" || kind === "purge") {
    const scan = await scanCodexRoot(fixture.rootDir);
    const trashed = await moveSessionsToTrash(
      scan,
      resolveSessions(scan, [sessionId]),
      { allowActive: true },
    );
    const trashId = trashed.trashEntry.trashId;
    return {
      fixture,
      sessionId,
      execute: kind === "restore"
        ? () => restoreTrashEntry(fixture.rootDir, trashId)
        : () => purgeTrashEntry(fixture.rootDir, trashId),
    };
  }

  const scan = await scanCodexRoot(fixture.rootDir);
  const sessions = resolveSessions(scan, [sessionId]);
  switch (kind) {
    case "delete":
      return { fixture, sessionId, execute: () => deleteSessions(scan, sessions, { allowActive: true }) };
    case "trash":
      return { fixture, sessionId, execute: () => moveSessionsToTrash(scan, sessions, { allowActive: true }) };
    case "cleanup-index":
      return { fixture, sessionId, execute: () => cleanupSessionIndexes(scan, sessions, { allowActive: true }) };
    case "cleanup-stale":
      return { fixture, sessionId, execute: () => cleanupStaleIndexes(scan) };
    default: {
      const exhaustive: never = kind;
      throw new Error(`unsupported production operation: ${String(exhaustive)}`);
    }
  }
}

function allRegisteredBoundaries(): Array<{
  kind: MutationOperationKind;
  name: MutationCheckpointName;
  status: MutationCheckpointStatus;
}> {
  return (Object.keys(MUTATION_CHECKPOINT_INVENTORY) as MutationOperationKind[]).flatMap((kind) =>
    MUTATION_CHECKPOINT_INVENTORY[kind].flatMap((entry) =>
      entry.statuses.map((status) => ({ kind, name: entry.name, status }))),
  );
}

async function sha256File(filePath: string): Promise<string> {
  return crypto.createHash("sha256").update(await readFile(filePath)).digest("hex");
}

describe("production operation checkpoint injection", () => {
  afterEach(() => {
    setMutationCheckpointHookForTests(null);
  });

  it.runIf(process.platform !== "win32")(
    "executes every registered boundary through its real operation and recovers to a complete state",
    async () => {
      const sentinelDirectory = await mkdtemp(path.join(os.tmpdir(), "csm-checkpoint-sentinel-"));
      const sentinelPath = path.join(sentinelDirectory, "outside.txt");
      await writeFile(sentinelPath, "outside sentinel must never change\n", "utf8");
      const sentinelBefore = await sha256File(sentinelPath);
      const expectedStates = new Map<MutationOperationKind, { before: CoreState; after: CoreState }>();

      try {
        for (const kind of Object.keys(MUTATION_CHECKPOINT_INVENTORY) as MutationOperationKind[]) {
          const control = await prepareOperation(kind);
          try {
            const before = await captureCoreState(control);
            await control.execute();
            const after = await captureCoreState(control);
            expect(after, `${kind} control operation must change its normalized state`).not.toEqual(before);
            expectedStates.set(kind, { before, after });
          } finally {
            await control.fixture.cleanup();
          }
        }

        for (const boundary of allRegisteredBoundaries()) {
          const operationCase = await prepareOperation(boundary.kind);
          const label = `${boundary.kind}:${boundary.name}:${boundary.status}`;
          try {
            const expected = expectedStates.get(boundary.kind)!;
            expect(await captureCoreState(operationCase), `${label} deterministic before state`).toEqual(expected.before);
            setMutationCheckpointHookForTests((event) => {
              if (
                event.kind === boundary.kind
                && event.name === boundary.name
                && event.status === boundary.status
              ) {
                throw new Error(`injected production boundary ${label}`);
              }
            });

            let returnedResult: unknown;
            let thrownError: unknown;
            try {
              returnedResult = await operationCase.execute();
            } catch (error) {
              thrownError = error;
            }
            if (thrownError === undefined) {
              expect(returnedResult, `${label} handled post-commit injection`).toMatchObject({
                operationStatus: "committed",
                verificationStatus: "failed",
                errorCode: "POST_COMMIT_VERIFY_FAILED",
              });
            } else {
              expect(String(thrownError), `${label} propagated injection`).toContain(`injected production boundary ${label}`);
            }
            setMutationCheckpointHookForTests(null);

            const interrupted = await getRecoveryStatus(operationCase.fixture.rootDir);
            if (interrupted.pending) {
              expect(interrupted.invalidReason, `${label} recovery metadata`).toBeNull();
              await recoverInterruptedOperation(operationCase.fixture.rootDir);
            }
            expect(await getRecoveryStatus(operationCase.fixture.rootDir), `${label} lock cleanup`)
              .toMatchObject({ pending: false });

            const finalState = await captureCoreState(operationCase);
            const isCompleteBefore = JSON.stringify(finalState) === JSON.stringify(expected.before);
            const isCompleteAfter = JSON.stringify(finalState) === JSON.stringify(expected.after);
            expect(isCompleteBefore || isCompleteAfter, `${label} must end in the complete before or after state`).toBe(true);
            expect(await sha256File(sentinelPath), `${label} external sentinel`).toBe(sentinelBefore);
          } finally {
            setMutationCheckpointHookForTests(null);
            await operationCase.fixture.cleanup();
          }
        }
      } finally {
        await rm(sentinelDirectory, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
