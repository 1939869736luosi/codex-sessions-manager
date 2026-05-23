import { parseSourceKind } from "./sources.js";
import type { ScanResult, SessionEntry, SessionKind, SourceKind } from "./types.js";
import { matchesProject } from "./project.js";

export interface ListSessionsOptions {
  query?: string;
  project?: string;
  status?: SessionKind | "all";
  limit?: number;
  updatedAfter?: string;
  updatedBefore?: string;
  createdAfter?: string;
  createdBefore?: string;
  sourceKind?: SourceKind | SourceKind[] | string | string[];
  source?: string | string[];
  threadSource?: string | string[];
  agentRole?: string | string[];
  agentNickname?: string | string[];
  modelProvider?: string | string[];
  model?: string | string[];
}

function getDatePrefix(value: string): string | null {
  return value.match(/^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/)?.[1] ?? null;
}

function isDateOnly(value: string): boolean {
  return getDatePrefix(value) === value;
}

function hasExplicitTimezone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/i.test(value.trim());
}

function assertValidDatePrefix(value: string, optionName: string): void {
  const prefix = getDatePrefix(value);
  const match = prefix?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${optionName} 不是有效日期：${value}`);
  }
}

function parseDateBoundary(value: string | undefined, optionName: string, boundary: "start" | "end"): number | null {
  if (!value?.trim()) {
    return null;
  }

  assertValidDatePrefix(value, optionName);
  if (!isDateOnly(value) && getDatePrefix(value) && !hasExplicitTimezone(value)) {
    throw new Error(`${optionName} 必须带明确时区：${value}`);
  }

  if (isDateOnly(value)) {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(
      year,
      month - 1,
      day,
      boundary === "start" ? 0 : 23,
      boundary === "start" ? 0 : 59,
      boundary === "start" ? 0 : 59,
      boundary === "start" ? 0 : 999,
    );
    return date.getTime();
  }

  const time = new Date(value).getTime();

  if (Number.isNaN(time)) {
    throw new Error(`${optionName} 不是有效日期：${value}`);
  }

  return time;
}

function matchesDateRange(
  value: string | null,
  after: number | null,
  before: number | null,
): boolean {
  if (after === null && before === null) {
    return true;
  }

  if (!value) {
    return false;
  }

  const time = new Date(value).getTime();
  if (Number.isNaN(time)) {
    return false;
  }

  if (after !== null && time < after) {
    return false;
  }

  if (before !== null && time > before) {
    return false;
  }

  return true;
}

function normalizeTextFilters(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }

  return (Array.isArray(value) ? value : [value])
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeSourceKindFilters(value: ListSessionsOptions["sourceKind"]): SourceKind[] {
  if (value === undefined) {
    return [];
  }

  return (Array.isArray(value) ? value : [value]).map((item) => parseSourceKind(String(item)));
}

function matchesTextFilters(value: string | null, filters: string[]): boolean {
  if (filters.length === 0) {
    return true;
  }

  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && filters.includes(normalized));
}

export function filterSessions(scan: ScanResult, options: ListSessionsOptions = {}): SessionEntry[] {
  const query = options.query?.trim().toLowerCase() ?? "";
  const project = options.project?.trim() ?? "";
  const status = options.status ?? "all";
  const limit = options.limit ?? Infinity;
  const updatedAfter = parseDateBoundary(options.updatedAfter, "updatedAfter", "start");
  const updatedBefore = parseDateBoundary(options.updatedBefore, "updatedBefore", "end");
  const createdAfter = parseDateBoundary(options.createdAfter, "createdAfter", "start");
  const createdBefore = parseDateBoundary(options.createdBefore, "createdBefore", "end");
  const sourceKindFilters = normalizeSourceKindFilters(options.sourceKind);
  const sourceFilters = normalizeTextFilters(options.source);
  const threadSourceFilters = normalizeTextFilters(options.threadSource);
  const agentRoleFilters = normalizeTextFilters(options.agentRole);
  const agentNicknameFilters = normalizeTextFilters(options.agentNickname);
  const modelProviderFilters = normalizeTextFilters(options.modelProvider);
  const modelFilters = normalizeTextFilters(options.model);

  return scan.sessions
    .filter((session) => {
      if (status !== "all" && session.kind !== status) {
        return false;
      }

      if (project && !matchesProject(session, project)) {
        return false;
      }

      if (!matchesDateRange(session.updatedAt, updatedAfter, updatedBefore)) {
        return false;
      }

      if (!matchesDateRange(session.createdAt, createdAfter, createdBefore)) {
        return false;
      }

      if (sourceKindFilters.length > 0 && !sourceKindFilters.includes(session.sourceKind)) {
        return false;
      }

      if (!matchesTextFilters(session.source, sourceFilters)) {
        return false;
      }

      if (!matchesTextFilters(session.threadSource, threadSourceFilters)) {
        return false;
      }

      if (!matchesTextFilters(session.agentRole, agentRoleFilters)) {
        return false;
      }

      if (!matchesTextFilters(session.agentNickname, agentNicknameFilters)) {
        return false;
      }

      if (!matchesTextFilters(session.modelProvider, modelProviderFilters)) {
        return false;
      }

      if (!matchesTextFilters(session.model, modelFilters)) {
        return false;
      }

      if (!query) {
        return true;
      }

      const haystack = [
        session.displayTitle,
        session.indexTitle ?? "",
        session.sqliteTitle ?? "",
        session.firstUserMessage ?? "",
        session.title,
        session.id,
        session.cwd ?? "",
        session.rolloutPath ?? "",
        session.previewSummary,
        ...session.historyPreview,
        ...session.titleCandidates.map((candidate) => candidate.title),
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

    const residualIds = new Set([
      ...scan.shellSnapshots.filesById.keys(),
      ...scan.globalState.refsById.keys(),
      ...scan.globalState.exactKeyRefsById.keys(),
      ...scan.globalState.possibleUnknownRefsById.keys(),
    ]);
    const residualExact = residualIds.has(sessionId) ? sessionId : null;
    const residualPrefixed = [...residualIds].filter((id) => id.startsWith(sessionId));

    if (residualExact || residualPrefixed.length === 1) {
      const id = residualExact ?? residualPrefixed[0];
      return {
        id,
        displayTitle: id,
        indexTitle: null,
        sqliteTitle: null,
        firstUserMessage: null,
        titleSource: "id",
        titleMismatch: false,
        titleCandidates: [{ source: "id", title: id }],
        title: id,
        kind: "stale",
        archived: false,
        projectPath: null,
        projectName: "unknown",
        projectKey: "unknown",
        createdAt: null,
        updatedAt: null,
        model: null,
        modelProvider: null,
        cwd: null,
        rolloutPath: null,
        sourceKind: "unknown",
        source: null,
        threadSource: null,
        agentRole: null,
        agentNickname: null,
        agentPath: null,
        previewSummary: "仅有本地残留",
        historyPreview: [],
        totalFileSize: 0,
        fileTargets: [],
        hasThread: false,
        hasSessionIndex: false,
        hasHistory: false,
        sessionIndexCount: 0,
        historyCount: 0,
        thread: null,
      } satisfies SessionEntry;
    }

    if (residualPrefixed.length > 1) {
      throw new Error(`会话 ID 前缀不唯一：${sessionId}`);
    }

    throw new Error(`找不到会话：${sessionId}`);
  });
}
