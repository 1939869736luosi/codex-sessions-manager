import { assertCanonicalSessionIds, MutationSafetyError } from "./mutation-safety.js";
import type { SessionEntry } from "./types.js";

export interface ConfirmedSessionSelectionOptions {
  allowActive?: boolean;
}

export function isDestructivePlatformSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/**
 * v0.6.1 cannot claim safe mutation semantics on Windows until the real
 * junction/reparse/case and abrupt-termination matrix has passed. Keep every
 * production mutation entrypoint closed there; read-only inspection remains
 * available.
 */
export function assertDestructivePlatformSupported(platform: NodeJS.Platform = process.platform): void {
  if (!isDestructivePlatformSupported(platform)) {
    throw new MutationSafetyError(
      "UNSAFE_PATH",
      "Windows destructive operations are disabled in v0.6.1; this platform is read-only until the crash and reparse-point safety matrix is verified",
    );
  }
}

/**
 * Apply the extra policy gates that only confirmed destructive operations need.
 * Read-only previews intentionally resolve unique prefixes before reaching here.
 */
export function assertConfirmedSessionSelection(
  requestedSessionIds: readonly string[],
  sessions: readonly Pick<SessionEntry, "id" | "kind" | "fileTargets">[],
  options: ConfirmedSessionSelectionOptions = {},
): void {
  assertDestructivePlatformSupported();
  assertCanonicalSessionIds(requestedSessionIds);

  const activeSessionIds = sessions
    .filter((session) =>
      session.kind === "active"
      || session.fileTargets.some((target) => target.relativePath.replaceAll("\\", "/").startsWith("sessions/")))
    .map((session) => session.id);
  if (activeSessionIds.length > 0 && !options.allowActive) {
    throw new MutationSafetyError(
      "ACTIVE_SESSION",
      `active sessions require an explicit override (--allow-active or allowActive=true): ${activeSessionIds.join(", ")}`,
    );
  }
}
