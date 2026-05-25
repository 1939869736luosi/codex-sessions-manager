import type {
  OfficialCodexSourceKind,
  SessionEntry,
  SourceEvidence,
  SourceInfo,
  SourceKind,
  SourceSummary,
  SourceSummaryRow,
  ThreadSourceKind,
} from "./types.js";

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

function evidence(
  field: SourceEvidence["field"],
  value: string | null,
  coarseSourceKind: SourceKind,
  officialSourceKind: OfficialCodexSourceKind | null,
  reason: string,
): SourceEvidence | null {
  const trimmed = value?.trim();
  return trimmed ? { field, value: trimmed, coarseSourceKind, officialSourceKind, reason } : null;
}

function parseThreadSourceKind(value: string | null): ThreadSourceKind | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "user" || normalized === "subagent" || normalized === "memory_consolidation") {
    return normalized;
  }
  return null;
}

function officialKindFromRawSource(value: string | null): OfficialCodexSourceKind | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  if (lower === "cli") return "cli";
  if (lower === "vscode") return "vscode";
  if (lower === "exec") return "exec";
  if (lower === "mcp") return "appServer";
  if (lower === "unknown") return "unknown";
  return null;
}

function officialKindFromSourceJson(sourceObject: Record<string, unknown> | null): OfficialCodexSourceKind | null {
  const subAgent = sourceObject?.sub_agent ?? sourceObject?.subagent;
  if (!subAgent || typeof subAgent !== "object" || Array.isArray(subAgent)) {
    return null;
  }
  const keys = Object.keys(subAgent as Record<string, unknown>).map((key) => key.toLowerCase());
  if (keys.includes("review")) return "subAgentReview";
  if (keys.includes("compact")) return "subAgentCompact";
  if (keys.includes("thread_spawn")) return "subAgentThreadSpawn";
  if (keys.length > 0) return "subAgentOther";
  return "subAgent";
}

export function parseSourceKind(value: string): SourceKind {
  const normalized = value.trim().toLowerCase();
  if (SOURCE_KINDS.includes(normalized as SourceKind)) {
    return normalized as SourceKind;
  }

  throw new Error(`sourceKind 可选: ${SOURCE_KINDS.join(" | ")}`);
}

export function deriveSourceKind(metadata: SourceMetadata): SourceKind {
  return deriveSourceInfo(metadata).sourceKind;
}

export function deriveSourceInfo(metadata: SourceMetadata): SourceInfo {
  const sourceObject = parseJsonObject(metadata.source);
  const officialFromJson = officialKindFromSourceJson(sourceObject);
  const officialFromRaw = officialKindFromRawSource(metadata.source);
  const officialSourceKind = officialFromJson ?? officialFromRaw;
  const threadSourceKind = parseThreadSourceKind(metadata.threadSource);
  const knownSource = normalizeKnownKind(metadata.source);
  const knownThreadSource = normalizeKnownKind(metadata.threadSource);
  const evidenceItems: SourceEvidence[] = [];

  if (officialFromJson || hasSubagentSignal(sourceObject)) {
    evidenceItems.push({
      field: "source_json",
      value: metadata.source ?? "",
      coarseSourceKind: "subagent",
      officialSourceKind: officialFromJson ?? "subAgent",
      reason: "source JSON contains official sub_agent evidence",
    });
  }

  if (knownSource) {
    const item = evidence("source", metadata.source, knownSource, officialFromRaw, "raw source matches a stable sourceKind");
    if (item) evidenceItems.push(item);
  }

  if (knownThreadSource) {
    const item = evidence("thread_source", metadata.threadSource, knownThreadSource, null, "thread_source matches a local stable sourceKind");
    if (item) evidenceItems.push(item);
  } else if (threadSourceKind) {
    const item = evidence(
      "thread_source",
      metadata.threadSource,
      threadSourceKind === "subagent" ? "subagent" : "unknown",
      null,
      "thread_source is official analytics metadata, not the primary source field",
    );
    if (item) evidenceItems.push(item);
  }

  for (const [field, value] of [
    ["agent_role", metadata.agentRole],
    ["agent_nickname", metadata.agentNickname],
    ["agent_path", metadata.agentPath],
  ] as const) {
    const item = evidence(field, value, "subagent", officialSourceKind, `${field} is present as subagent evidence`);
    if (item) evidenceItems.push(item);
  }

  const hasSubagent = evidenceItems.some((item) => item.coarseSourceKind === "subagent");
  const sourceKind = hasSubagent ? "subagent" : knownSource ?? knownThreadSource ?? "unknown";

  return {
    sourceKind,
    rawSource: metadata.source,
    rawThreadSource: metadata.threadSource,
    officialSourceKind,
    threadSourceKind,
    inferenceConfidence: sourceKind === "unknown" ? "unknown" : officialSourceKind || knownSource ? "exact" : "derived",
    evidence: evidenceItems,
  };
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
