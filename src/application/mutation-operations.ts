import { assertConfirmedSessionSelection } from "../core/destructive-policy.js";
import {
  buildDeletePreview,
  cleanupSessionIndexes,
  cleanupStaleIndexes,
  deleteSessions,
  previewCleanupSessionIndexes,
  previewCleanupStaleIndexes,
} from "../core/delete.js";
import { assertCanonicalSessionIds, MutationSafetyError } from "../core/mutation-safety.js";
import { resolveSessions } from "../core/query.js";
import { getRecoveryStatus, recoverInterruptedOperation } from "../core/recovery.js";
import { scanCodexRoot } from "../core/scan.js";
import {
  listTrashEntries,
  moveSessionsToTrash,
  purgeTrashEntry,
  restoreTrashEntry,
  summarizeTrashDuplicateSessions,
  trashEntryMatches,
} from "../core/trash.js";

export interface MutationRootInput {
  root?: string;
}

export async function deleteSessionsOperation(input: MutationRootInput & {
  sessionIds: string[];
  confirm: boolean;
  trash?: boolean;
  allowActive?: boolean;
}) {
  if (input.confirm) {
    assertCanonicalSessionIds(input.sessionIds);
  }
  const scan = await scanCodexRoot(input.root);
  const sessions = resolveSessions(scan, input.sessionIds);

  if (!input.confirm) {
    const activeSessionIds = sessions
      .filter((session) => session.kind === "active")
      .map((session) => session.id);
    return {
      scan,
      sessions,
      executed: false as const,
      action: input.trash ? "trash" as const : "delete" as const,
      data: {
        preview: buildDeletePreview(scan, sessions),
        warnings: scan.warnings,
        action: input.trash ? "trash" as const : "delete" as const,
        requiresConfirmation: true,
        requiresFullSessionIds: true,
        activeSessionIds,
        requiresAllowActive: activeSessionIds.length > 0,
      },
    };
  }

  assertConfirmedSessionSelection(input.sessionIds, sessions, { allowActive: input.allowActive });
  if (input.trash) {
    const result = await moveSessionsToTrash(scan, sessions, { allowActive: input.allowActive });
    return { scan, sessions, executed: true as const, action: "trash" as const, data: result, result };
  }
  const result = await deleteSessions(scan, sessions, { allowActive: input.allowActive });
  return { scan, sessions, executed: true as const, action: "delete" as const, data: result, result };
}

export async function restoreTrashOperation(input: MutationRootInput & {
  id: string;
  confirm: boolean;
}) {
  if (!input.confirm) {
    const scan = await scanCodexRoot(input.root);
    const matches = (await listTrashEntries(scan.root.rootPath))
      .filter((entry) => trashEntryMatches(entry, input.id));
    const duplicateSessionIds = summarizeTrashDuplicateSessions(matches);
    return {
      scan,
      executed: false as const,
      data: {
        matches,
        entries: matches,
        duplicateSessionIds,
        preflight: matches.map((entry) => ({
          trashId: entry.trashId,
          sessionIds: entry.sessionIds,
          warnings: entry.rootPath === scan.root.rootPath
            ? []
            : [`回收站记录来自不同 root：${entry.rootPath}`],
        })),
        requiresExactTrashId: true,
        requiresConfirmation: true,
      },
    };
  }
  const result = await restoreTrashEntry(input.root, input.id);
  return { executed: true as const, data: result, result };
}

export async function purgeTrashOperation(input: MutationRootInput & {
  id: string;
  confirm: boolean;
}) {
  if (!input.confirm) {
    const scan = await scanCodexRoot(input.root);
    const matches = (await listTrashEntries(scan.root.rootPath))
      .filter((entry) => trashEntryMatches(entry, input.id));
    const duplicateSessionIds = summarizeTrashDuplicateSessions(matches);
    return {
      scan,
      executed: false as const,
      data: {
        matches,
        entries: matches,
        duplicateSessionIds,
        requiresExactTrashId: true,
        requiresConfirmation: true,
      },
    };
  }
  const result = await purgeTrashEntry(input.root, input.id);
  return { executed: true as const, data: result, result };
}

export async function cleanupSessionIndexesOperation(input: MutationRootInput & {
  sessionIds: string[];
  confirm: boolean;
  allowActive?: boolean;
}) {
  if (input.confirm) {
    assertCanonicalSessionIds(input.sessionIds);
  }
  const scan = await scanCodexRoot(input.root);
  const sessions = resolveSessions(scan, input.sessionIds);

  if (!input.confirm) {
    const activeSessionIds = sessions
      .filter((session) => session.kind === "active")
      .map((session) => session.id);
    return {
      scan,
      sessions,
      executed: false as const,
      data: {
        preview: previewCleanupSessionIndexes(scan, sessions),
        warnings: scan.warnings,
        requiresConfirmation: true,
        requiresFullSessionIds: true,
        activeSessionIds,
        requiresAllowActive: activeSessionIds.length > 0,
      },
    };
  }

  assertConfirmedSessionSelection(input.sessionIds, sessions, { allowActive: input.allowActive });
  const result = await cleanupSessionIndexes(scan, sessions, { allowActive: input.allowActive });
  return { scan, sessions, executed: true as const, data: result, result };
}

export async function cleanupStaleIndexesOperation(input: MutationRootInput & {
  confirm: boolean;
}) {
  const scan = await scanCodexRoot(input.root);
  if (!input.confirm) {
    return {
      scan,
      executed: false as const,
      data: {
        preview: previewCleanupStaleIndexes(scan),
        warnings: scan.warnings,
        requiresConfirmation: true,
      },
    };
  }
  const result = await cleanupStaleIndexes(scan);
  return { scan, executed: true as const, data: result, result };
}

export async function recoverOperation(input: MutationRootInput & {
  operationId: string;
  confirm: boolean;
}) {
  assertCanonicalSessionIds([input.operationId]);
  const status = await getRecoveryStatus(input.root);
  if (!status.pending || status.operationId !== input.operationId) {
    throw new MutationSafetyError(
      "RECOVERY_REQUIRED",
      `找不到匹配的待恢复操作：${input.operationId}`,
    );
  }
  if (!input.confirm) {
    return {
      executed: false as const,
      data: {
        status,
        requiresConfirmation: true,
        exactOperationIdRequired: true,
      },
    };
  }
  const result = await recoverInterruptedOperation(input.root);
  return { executed: true as const, data: result, result };
}
