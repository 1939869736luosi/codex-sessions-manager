import type { ScanResult, SessionEntry, SessionKind } from "./types.js";

export interface ListSessionsOptions {
  query?: string;
  status?: SessionKind | "all";
  limit?: number;
}

export function filterSessions(scan: ScanResult, options: ListSessionsOptions = {}): SessionEntry[] {
  const query = options.query?.trim().toLowerCase() ?? "";
  const status = options.status ?? "all";
  const limit = options.limit ?? Infinity;

  return scan.sessions
    .filter((session) => {
      if (status !== "all" && session.kind !== status) {
        return false;
      }

      if (!query) {
        return true;
      }

      const haystack = [
        session.title,
        session.id,
        session.cwd ?? "",
        session.rolloutPath ?? "",
        session.previewSummary,
        ...session.historyPreview,
      ]
        .join(" ")
        .toLowerCase();

      return haystack.includes(query);
    })
    .slice(0, limit);
}

export function resolveSessions(scan: ScanResult, sessionIds: string[]): SessionEntry[] {
  return sessionIds.map((sessionId) => {
    const exact = scan.sessions.find((session) => session.id === sessionId);

    if (exact) {
      return exact;
    }

    const prefixed = scan.sessions.filter((session) => session.id.startsWith(sessionId));

    if (prefixed.length === 1) {
      return prefixed[0];
    }

    if (prefixed.length > 1) {
      throw new Error(`会话 ID 前缀不唯一：${sessionId}`);
    }

    throw new Error(`找不到会话：${sessionId}`);
  });
}
