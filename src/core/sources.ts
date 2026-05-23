import type { SessionEntry, SourceKind, SourceSummary, SourceSummaryRow } from "./types.js";

export const SOURCE_KINDS = ["subagent", "mcp", "vscode", "cli", "exec", "unknown"] as const satisfies readonly SourceKind[];

interface SourceMetadata {
  source: string | null;
  threadSource: string | null;
  agentRole: string | null;
  agentNickname: string | null;
  agentPath: string | null;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value?.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function hasSubagentSignal(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || value === undefined) {
    return false;
  }

  if (typeof value === "string") {
    return value.toLowerCase().includes("subagent");
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasSubagentSignal(item, depth + 1));
  }

  if (typeof value !== "object") {
    return false;
  }

  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
    const normalizedKey = key.toLowerCase();
    return normalizedKey.includes("subagent") || hasSubagentSignal(nested, depth + 1);
  });
}

function normalizeKnownKind(value: string | null): SourceKind | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "mcp" || normalized === "vscode" || normalized === "cli" || normalized === "exec") {
    return normalized;
  }

  if (normalized === "subagent") {
    return "subagent";
  }

  return null;
}

export function parseSourceKind(value: string): SourceKind {
  const normalized = value.trim().toLowerCase();
  if (SOURCE_KINDS.includes(normalized as SourceKind)) {
    return normalized as SourceKind;
  }

  throw new Error(`sourceKind 可选: ${SOURCE_KINDS.join(" | ")}`);
}

export function deriveSourceKind(metadata: SourceMetadata): SourceKind {
  const sourceObject = parseJsonObject(metadata.source);

  if (
    hasSubagentSignal(sourceObject) ||
    normalizeKnownKind(metadata.source) === "subagent" ||
    Boolean(metadata.agentRole || metadata.agentNickname || metadata.agentPath)
  ) {
    return "subagent";
  }

  return normalizeKnownKind(metadata.source) ?? normalizeKnownKind(metadata.threadSource) ?? "unknown";
}

function emptySourceKindCounts(): Record<SourceKind, number> {
  return {
    subagent: 0,
    mcp: 0,
    vscode: 0,
    cli: 0,
    exec: 0,
    unknown: 0,
  };
}

function sourceSummaryKey(row: Omit<SourceSummaryRow, "count" | "latestUpdatedAt">): string {
  return JSON.stringify([
    row.sourceKind,
    row.source,
    row.threadSource,
    row.modelProvider,
    row.model,
    row.agentRole,
  ]);
}

function latestDate(left: string | null, right: string | null): string | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  const leftTime = new Date(left).getTime();
  const rightTime = new Date(right).getTime();
  if (Number.isNaN(leftTime)) {
    return right;
  }
  if (Number.isNaN(rightTime)) {
    return left;
  }
  return rightTime > leftTime ? right : left;
}

export function summarizeSources(sessions: SessionEntry[]): SourceSummary {
  const bySourceKind = emptySourceKindCounts();
  const rowsByKey = new Map<string, SourceSummaryRow>();

  for (const session of sessions) {
    bySourceKind[session.sourceKind] += 1;
    const rowIdentity = {
      sourceKind: session.sourceKind,
      source: session.source,
      threadSource: session.threadSource,
      modelProvider: session.modelProvider,
      model: session.model,
      agentRole: session.agentRole,
    };
    const key = sourceSummaryKey(rowIdentity);
    const existing = rowsByKey.get(key);

    if (existing) {
      existing.count += 1;
      existing.latestUpdatedAt = latestDate(existing.latestUpdatedAt, session.updatedAt);
      continue;
    }

    rowsByKey.set(key, {
      ...rowIdentity,
      count: 1,
      latestUpdatedAt: session.updatedAt,
    });
  }

  const rows = [...rowsByKey.values()].sort((left, right) => {
    if (right.count !== left.count) {
      return right.count - left.count;
    }
    return [
      left.sourceKind.localeCompare(right.sourceKind),
      (left.source ?? "").localeCompare(right.source ?? ""),
      (left.threadSource ?? "").localeCompare(right.threadSource ?? ""),
      (left.modelProvider ?? "").localeCompare(right.modelProvider ?? ""),
      (left.model ?? "").localeCompare(right.model ?? ""),
      (left.agentRole ?? "").localeCompare(right.agentRole ?? ""),
    ].find((result) => result !== 0) ?? 0;
  });

  return {
    totalSessions: sessions.length,
    bySourceKind,
    rows,
  };
}
