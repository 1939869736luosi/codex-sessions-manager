#!/usr/bin/env node

import { realpathSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  getSessionOperation,
  inspectRootOperation,
  listSessionsOperation,
} from "../application/session-operations.js";
import { buildRootDeletePreview, buildRootResidueAudit, buildSessionResidueAudit } from "../core/audit.js";
import { exportSessionBackup } from "../core/backup.js";
import { assertConfirmedSessionSelection, isDestructivePlatformSupported } from "../core/destructive-policy.js";
import {
  buildDeletePreview,
  cleanupSessionIndexes,
  cleanupStaleIndexes,
  deleteSessions,
  previewCleanupSessionIndexes,
  previewCleanupStaleIndexes,
  validateDeletion,
} from "../core/delete.js";
import { buildSessionFamilyQuery, FAMILY_MODES } from "../core/family.js";
import { parseDeletePlanObject, previewDeletePlan, readDeletePlanFile } from "../core/plan-file.js";
import { buildPlanDelete } from "../core/plan-delete.js";
import { groupSessionsByProject, listProjectSummaries } from "../core/project.js";
import { resolveSessions } from "../core/query.js";
import { scanCodexRoot } from "../core/scan.js";
import { assertCanonicalSessionIds, MutationSafetyError } from "../core/mutation-safety.js";
import { getRecoveryStatus, recoverInterruptedOperation } from "../core/recovery.js";
import { SOURCE_KINDS, summarizeSources } from "../core/sources.js";
import {
  listTrashEntries,
  moveSessionsToTrash,
  purgeTrashEntry,
  restoreTrashEntry,
  summarizeTrashDuplicateSessions,
  trashEntryMatches,
} from "../core/trash.js";
import type { ScanResult, SessionEntry, SessionKind, SessionTimelineResult, SourceKind } from "../core/types.js";
import { TOOL_VERSION } from "../version.js";

const VALID_PROFILES = ["read-only", "admin"] as const;
export type McpProfile = (typeof VALID_PROFILES)[number];

export function parseProfile(argv: string[] = process.argv): McpProfile {
  const idx = argv.indexOf("--profile");
  if (idx === -1) return "read-only";
  if (idx + 1 >= argv.length) {
    process.stderr.write(
      `Error: --profile requires a value. Valid values: ${VALID_PROFILES.join(", ")}\n`,
    );
    process.exit(1);
  }
  const val = argv[idx + 1];
  if (!(VALID_PROFILES as readonly string[]).includes(val)) {
    process.stderr.write(
      `Error: invalid --profile value "${val}". Valid values: ${VALID_PROFILES.join(", ")}\n`,
    );
    process.exit(1);
  }
  return val as McpProfile;
}

const TOOL_OUTPUT_SCHEMA = z.object({}).passthrough();
const stringOrStringArraySchema = z.union([z.string(), z.array(z.string())]);
const sourceKindSchema = z.union([z.enum(SOURCE_KINDS), z.array(z.enum(SOURCE_KINDS))]);
const planDeleteStatusSchema = z.union([
  z.enum(["active", "archived", "db-only", "stale"]),
  z.array(z.enum(["active", "archived", "db-only", "stale"])),
]);

function textResult(text: string, structuredContent?: Record<string, unknown> | undefined) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
  };
}

function normalizeArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function normalizePlanDeleteLimit(limit: number | undefined): number {
  if (limit === undefined) {
    throw new Error("plan_delete_sessions sourceKind candidate mode requires explicit limit, maximum 50.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("plan_delete_sessions sourceKind candidate mode limit must be an integer from 1 to 50.");
  }
  return limit;
}

const MCP_SESSION_LIMITS = {
  compact: { items: 20, bytes: 64 * 1024, readBytes: 1 * 1024 * 1024 },
  full: { items: 200, bytes: 256 * 1024, readBytes: 8 * 1024 * 1024 },
} as const;

const MCP_LIST_DEFAULT_LIMIT = 50;
const MCP_LIST_MAX_LIMIT = 200;
const MCP_LIST_RESPONSE_BYTES = 256 * 1024;

type McpSessionDetail = keyof typeof MCP_SESSION_LIMITS;

function truncateMcpText(value: string | null, limit: number): { value: string | null; truncated: boolean } {
  if (value === null || value.length <= limit) return { value, truncated: false };
  return { value: `${value.slice(0, Math.max(0, limit - 3))}...`, truncated: true };
}

function toMcpSessionListItem(session: SessionEntry): Record<string, unknown> {
  const textFields = {
    id: truncateMcpText(session.id, 256),
    displayTitle: truncateMcpText(session.displayTitle, 512),
    indexTitle: truncateMcpText(session.indexTitle, 512),
    sqliteTitle: truncateMcpText(session.sqliteTitle, 512),
    title: truncateMcpText(session.title, 512),
    firstUserMessage: truncateMcpText(session.firstUserMessage, 512),
    previewSummary: truncateMcpText(session.previewSummary, 512),
    projectPath: truncateMcpText(session.projectPath, 512),
    projectName: truncateMcpText(session.projectName, 512),
    projectKey: truncateMcpText(session.projectKey, 512),
    model: truncateMcpText(session.model, 256),
    modelProvider: truncateMcpText(session.modelProvider, 256),
    cwd: truncateMcpText(session.cwd, 512),
    rolloutPath: truncateMcpText(session.rolloutPath, 512),
    source: truncateMcpText(session.source, 256),
    threadSource: truncateMcpText(session.threadSource, 256),
    agentRole: truncateMcpText(session.agentRole, 256),
    agentNickname: truncateMcpText(session.agentNickname, 256),
    agentPath: truncateMcpText(session.agentPath, 512),
  };
  const selectedTitleCandidates = session.titleCandidates.slice(0, 8);
  const boundedTitleCandidates = selectedTitleCandidates.map((candidate) => {
    const title = truncateMcpText(candidate.title, 512);
    return { value: { source: candidate.source, title: title.value }, truncated: title.truncated };
  });
  const boundedSourceInfo = boundMcpValue(session.sourceInfo, { maxString: 256, maxArray: 8, maxDepth: 5 });
  const metadataTruncated = Object.values(textFields).some((entry) => entry.truncated)
    || session.titleCandidates.length > selectedTitleCandidates.length
    || boundedTitleCandidates.some((entry) => entry.truncated)
    || boundedSourceInfo.truncated;
  return {
    id: textFields.id.value,
    displayTitle: textFields.displayTitle.value,
    indexTitle: textFields.indexTitle.value,
    sqliteTitle: textFields.sqliteTitle.value,
    title: textFields.title.value,
    titleSource: session.titleSource,
    titleMismatch: session.titleMismatch,
    titleCandidates: boundedTitleCandidates.map((entry) => entry.value),
    firstUserMessage: textFields.firstUserMessage.value,
    previewSummary: textFields.previewSummary.value,
    kind: session.kind,
    archived: session.archived,
    projectPath: textFields.projectPath.value,
    projectName: textFields.projectName.value,
    projectKey: textFields.projectKey.value,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    recencyAt: session.recencyAt,
    recencyAtMs: session.recencyAtMs,
    historyMode: session.historyMode,
    model: textFields.model.value,
    modelProvider: textFields.modelProvider.value,
    cwd: textFields.cwd.value,
    rolloutPath: textFields.rolloutPath.value,
    sourceKind: session.sourceKind,
    sourceInfo: boundedSourceInfo.value,
    source: textFields.source.value,
    threadSource: textFields.threadSource.value,
    agentRole: textFields.agentRole.value,
    agentNickname: textFields.agentNickname.value,
    agentPath: textFields.agentPath.value,
    totalFileSize: session.totalFileSize,
    fileTargetCount: session.fileTargets.length,
    fileFormats: [...new Set(session.fileTargets.map((target) => target.format))],
    hasThread: session.hasThread,
    hasSessionIndex: session.hasSessionIndex,
    hasHistory: session.hasHistory,
    metadataTruncated,
  };
}

function boundMcpValue(
  value: unknown,
  limits: { maxString: number; maxArray: number; maxDepth: number },
  depth = 0,
): { value: unknown; truncated: boolean } {
  if (typeof value === "string") {
    const bounded = truncateMcpText(value, limits.maxString);
    return bounded;
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return { value, truncated: false };
  }
  if (depth >= limits.maxDepth) {
    return { value: "[metadata depth omitted]", truncated: true };
  }
  if (Array.isArray(value)) {
    const selected = value.slice(0, limits.maxArray);
    const bounded = selected.map((entry) => boundMcpValue(entry, limits, depth + 1));
    return {
      value: bounded.map((entry) => entry.value),
      truncated: value.length > selected.length || bounded.some((entry) => entry.truncated),
    };
  }

  let truncated = false;
  const entries = Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
    const bounded = boundMcpValue(nested, limits, depth + 1);
    truncated ||= bounded.truncated;
    return [key, bounded.value];
  });
  return { value: Object.fromEntries(entries), truncated };
}

function boundMcpSession(session: SessionEntry, detail: McpSessionDetail): {
  session: Record<string, unknown>;
  truncated: boolean;
} {
  const bounded = boundMcpValue(
    session,
    detail === "compact"
      ? { maxString: 512, maxArray: 8, maxDepth: 6 }
      : { maxString: 2_048, maxArray: 32, maxDepth: 8 },
  );
  return { session: bounded.value as Record<string, unknown>, truncated: bounded.truncated };
}

export function buildMcpSessionListPayload(
  scan: Pick<ScanResult, "root" | "warnings">,
  matches: SessionEntry[],
  limitApplied: number,
  groupBy?: "project",
): Record<string, unknown> {
  const selected = matches.slice(0, limitApplied);
  const boundedRoot = boundMcpValue(scan.root, { maxString: 512, maxArray: 20, maxDepth: 6 });
  const boundedWarnings = scan.warnings.slice(0, 20).map((warning) => truncateMcpText(warning, 512));

  const createPayload = (sessionCount: number, byteLimited: boolean) => {
    const sessions = selected.slice(0, sessionCount);
    const projectSummaries = groupBy === "project"
      ? listProjectSummaries(sessions).map((project) => (
        boundMcpValue(project, { maxString: 512, maxArray: 8, maxDepth: 4 }).value
      ))
      : undefined;
    const groupedSessions = groupBy === "project"
      ? groupSessionsByProject(sessions).map((group) => ({
        project: boundMcpValue(group.project, { maxString: 512, maxArray: 8, maxDepth: 4 }).value,
        sessions: group.sessions.map(toMcpSessionListItem),
      }))
      : undefined;
    return {
      root: boundedRoot.value,
      warnings: boundedWarnings.map((warning) => warning.value),
      warningsKnown: scan.warnings.length,
      warningsTruncated: scan.warnings.length > boundedWarnings.length
        || boundedWarnings.some((warning) => warning.truncated),
      rootMetadataTruncated: boundedRoot.truncated,
      sessions: sessions.map(toMcpSessionListItem),
      totalMatches: matches.length,
      sessionsReturned: sessions.length,
      limitApplied,
      hasMore: matches.length > sessions.length,
      byteLimited,
      responseByteLimit: MCP_LIST_RESPONSE_BYTES,
      omittedReason: byteLimited
        ? `MCP list response byte limit (${MCP_LIST_RESPONSE_BYTES}); use CLI list --json for complete local results`
        : null,
      projectSummaries,
      groupedSessions,
    };
  };

  let payload = createPayload(selected.length, false);
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") <= MCP_LIST_RESPONSE_BYTES) {
    return payload;
  }

  let lower = 0;
  let upper = selected.length;
  while (lower < upper) {
    const candidate = Math.ceil((lower + upper) / 2);
    const candidatePayload = createPayload(candidate, true);
    if (Buffer.byteLength(JSON.stringify(candidatePayload), "utf8") <= MCP_LIST_RESPONSE_BYTES) {
      lower = candidate;
    } else {
      upper = candidate - 1;
    }
  }
  payload = createPayload(lower, true);

  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MCP_LIST_RESPONSE_BYTES) {
    throw new Error(`Unable to construct a bounded MCP list response (${MCP_LIST_RESPONSE_BYTES} bytes). Use CLI list --json.`);
  }
  return payload;
}

export function buildMcpSessionPayload(
  session: SessionEntry,
  result: SessionTimelineResult,
  detail: McpSessionDetail,
): Record<string, unknown> {
  const limit = MCP_SESSION_LIMITS[detail];
  const { items, ...metadata } = result;
  let boundedSession = boundMcpSession(session, detail);
  let timeline = items.slice(0, limit.items);
  const itemLimited = items.length > limit.items || result.collectionLimitReason === "items";
  let byteLimited = result.collectionLimitReason === "bytes";
  const readLimited = result.collectionLimitReason === "read_bytes";
  let sessionMetadataTruncated = boundedSession.truncated;

  const createPayload = () => {
    const limitReasons = [
      byteLimited ? `MCP ${detail} byte limit (${limit.bytes})` : null,
      readLimited ? `MCP ${detail} source read limit (${limit.readBytes})` : null,
      itemLimited ? `MCP ${detail} item limit (${limit.items})` : null,
      sessionMetadataTruncated ? `MCP ${detail} session metadata limit` : null,
    ].filter(Boolean);
    const limited = limitReasons.length > 0;
    const omittedReason = [...limitReasons, result.omittedReason].filter(Boolean).join("; ") || null;
    return {
      session: boundedSession.session,
      timeline,
      detail,
      ...metadata,
      sourceCompleteness: result.completeness,
      completeness: limited ? "truncated_limit" : result.completeness,
      itemsReturned: timeline.length,
      omittedReason,
      sessionMetadataTruncated,
    };
  };

  let payload = createPayload();
  while (Buffer.byteLength(JSON.stringify(payload), "utf8") > limit.bytes && timeline.length > 0) {
    timeline = timeline.slice(0, -1);
    byteLimited = true;
    payload = createPayload();
  }

  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > limit.bytes) {
    const title = truncateMcpText(session.displayTitle, 256).value;
    boundedSession = {
      session: {
        id: session.id,
        displayTitle: title,
        kind: session.kind,
        archived: session.archived,
        updatedAt: session.updatedAt,
        recencyAt: session.recencyAt,
        historyMode: session.historyMode,
      },
      truncated: true,
    };
    sessionMetadataTruncated = true;
    payload = createPayload();
  }

  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > limit.bytes) {
    throw new Error(`Unable to construct a bounded MCP ${detail} response (${limit.bytes} bytes). Use CLI show --json.`);
  }

  return payload;
}

export function createServer(profile: McpProfile = "read-only"): McpServer {
  const server = new McpServer(
    {
      name: "codex-sessions",
      version: TOOL_VERSION,
    },
    {
      capabilities: { logging: {} },
      instructions:
        "Prefer the codex-sessions CLI for large or complete JSON output and byte-exact exports. Use MCP for bounded structured reads and explicitly approved management actions. get_session responses always report completeness and limits.",
    },
  );

  server.registerTool(
    "inspect_root",
    {
      description: "Inspect a local Codex root structure without modifying it.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        root: z.string().optional().describe("Optional explicit path to the .codex root."),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ root }) => {
      const result = await inspectRootOperation({ root });
      return textResult(`Inspected Codex root ${result.report.rootPath}.`, {
        report: result.report,
        warnings: result.warnings,
      });
    },
  );

  server.registerTool(
    "list_sessions",
    {
      description: "List Codex sessions from a local ~/.codex root.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        root: z.string().optional().describe("Optional explicit path to the .codex root."),
        query: z.string().optional().describe("Optional free-text filter."),
        project: z.string().optional().describe("Optional project filter matched against cwd-derived project fields."),
        groupBy: z.enum(["project"]).optional(),
        status: z.enum(["all", "active", "archived", "db-only", "stale"]).optional(),
        limit: z.number().int().min(1).max(MCP_LIST_MAX_LIMIT).optional()
          .describe(`Maximum sessions to return. Defaults to ${MCP_LIST_DEFAULT_LIMIT}; maximum ${MCP_LIST_MAX_LIMIT}.`),
        updatedAfter: z.string().optional(),
        updatedBefore: z.string().optional(),
        createdAfter: z.string().optional(),
        createdBefore: z.string().optional(),
        sourceKind: sourceKindSchema.optional().describe("Filter by inferred sourceKind."),
        source: stringOrStringArraySchema.optional().describe("Filter by raw threads.source value."),
        threadSource: stringOrStringArraySchema.optional().describe("Filter by threads.thread_source value."),
        agentRole: stringOrStringArraySchema.optional().describe("Filter by threads.agent_role value."),
        agentNickname: stringOrStringArraySchema.optional().describe("Filter by threads.agent_nickname value."),
        modelProvider: stringOrStringArraySchema.optional().describe("Filter by threads.model_provider value."),
        model: stringOrStringArraySchema.optional().describe("Filter by threads.model value."),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({
      root,
      query,
      project,
      groupBy,
      status,
      limit,
      updatedAfter,
      updatedBefore,
      createdAfter,
      createdBefore,
      sourceKind,
      source,
      threadSource,
      agentRole,
      agentNickname,
      modelProvider,
      model,
    }) => {
      const operation = await listSessionsOperation({
        root,
        filters: {
          query,
          project,
          status,
          updatedAfter,
          updatedBefore,
          createdAfter,
          createdBefore,
          sourceKind,
          source,
          threadSource,
          agentRole,
          agentNickname,
          modelProvider,
          model,
        },
      });
      const matches = operation.data.sessions;
      const limitApplied = limit ?? MCP_LIST_DEFAULT_LIMIT;
      const payload = buildMcpSessionListPayload(operation.scan, matches, limitApplied, groupBy);
      return textResult(
        `Returned ${payload.sessionsReturned as number} of ${matches.length} matching sessions.`,
        payload,
      );
    },
  );

  server.registerTool(
    "summarize_sources",
    {
      description: "Summarize Codex session source fields from a local ~/.codex root without modifying anything.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        root: z.string().optional().describe("Optional explicit path to the .codex root."),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ root }) => {
      const scan = await scanCodexRoot(root);
      const summary = summarizeSources(scan.sessions);
      return textResult(`Summarized sources for ${summary.totalSessions} sessions.`, {
        root: scan.root,
        warnings: scan.warnings,
        summary,
      });
    },
  );

  server.registerTool(
    "list_projects",
    {
      description: "List Codex session project summaries from a local ~/.codex root.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        root: z.string().optional().describe("Optional explicit path to the .codex root."),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ root }) => {
      const scan = await scanCodexRoot(root);
      const projects = listProjectSummaries(scan.sessions);
      return textResult(`Found ${projects.length} projects.`, {
        root: scan.root,
        warnings: scan.warnings,
        projects,
      });
    },
  );

  server.registerTool(
    "get_session",
    {
      description: "Get one Codex session with a bounded timeline and explicit completeness metadata. Use CLI show --json or export for complete/local byte-exact content.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        sessionId: z.string().describe("Exact session id or unique prefix."),
        root: z.string().optional(),
        detail: z.enum(["compact", "full"]).optional().describe("compact: up to 20 items/64 KiB; full: up to 200 items/256 KiB."),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ sessionId, root, detail = "compact" }) => {
      const limit = MCP_SESSION_LIMITS[detail];
      const operation = await getSessionOperation({
        root,
        sessionId,
        timelineLimits: {
          maxItems: limit.items,
          maxTimelineBytes: limit.bytes,
          maxReadBytes: limit.readBytes,
        },
      });
      const { session, timeline: items, ...metadata } = operation.data;
      const payload = buildMcpSessionPayload(session, { items, ...metadata }, detail);
      return textResult(
        `Loaded ${payload.itemsReturned as number}/${payload.itemsKnown ?? "unknown"} timeline items for session ${session.id} (${payload.completeness as string}).`,
        payload,
      );
    },
  );

  server.registerTool(
    "get_session_family",
    {
      description: "Inspect parent, child, side/fork, subagent, broken-relation, and related family sessions for one Codex session without modifying anything. The impact mode is read-only relationship context, not deletion advice and not a delete preview.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        sessionId: z.string().describe("Exact session id or unique prefix."),
        root: z.string().optional(),
        mode: z.enum(FAMILY_MODES).optional().describe("Family view: full, children, parents, subagents, or impact. impact is read-only and does not recommend or execute deletion."),
        sourceKind: sourceKindSchema.optional().describe("Optional inferred sourceKind filter for returned family nodes."),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ sessionId, root, mode, sourceKind }) => {
      const scan = await scanCodexRoot(root);
      const query = buildSessionFamilyQuery(scan, sessionId, { mode, sourceKind });
      return textResult(`Loaded session family for ${query.family.current.sessionId}.`, {
        root: scan.root,
        warnings: scan.warnings,
        ...query,
      });
    },
  );

  server.registerTool(
    "audit_session",
    {
      description:
        "Audit local Codex residue for one session after official UI archive/delete actions, without modifying anything. Reports known, P11 exact-key, and unknown global-state refs separately.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        sessionId: z.string().describe("Exact session id or unique prefix."),
        root: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ sessionId, root }) => {
      const scan = await scanCodexRoot(root);
      const audit = buildSessionResidueAudit(scan, sessionId);
      return textResult(`Audited session ${audit.sessionId}. Status: ${audit.overallStatus.join(", ")}.`, {
        audit,
      });
    },
  );

  server.registerTool(
    "audit_root",
    {
      description:
        "Read-only scan of a Codex root for likely local residue candidates without requiring a session id. Candidates are not deletion recommendations. P11 exact-key global-state candidates are reported separately from unknown refs.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        root: z.string().optional().describe("Optional explicit path to the .codex root."),
        limit: z.number().int().positive().optional().describe("Maximum candidates to return. Defaults to 50."),
        status: z.union([z.string(), z.array(z.string())]).optional().describe("Filter by one or more audit-root statuses. Multiple values use OR."),
        source: z.union([z.string(), z.array(z.string())]).optional().describe("Filter by one or more audit-root sources. Multiple values use OR."),
        all: z.boolean().optional().describe("Include complete non-residue sessions too. Defaults to false."),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ root, limit, status, source, all }) => {
      const scan = await scanCodexRoot(root);
      const audit = buildRootResidueAudit(scan, {
        limit,
        includeAll: all,
        statuses: typeof status === "string" ? [status] : status,
        sources: typeof source === "string" ? [source] : source,
      });
      return textResult(
        audit.totalCandidatesAfterFilter === 0
          ? `No likely residue candidates found in ${audit.rootPath}.`
          : `Found ${audit.totalCandidatesAfterFilter} likely residue candidates in ${audit.rootPath}. These are not deletion recommendations.`,
        audit as unknown as Record<string, unknown>,
      );
    },
  );

  server.registerTool(
    "preview_root_delete",
    {
      description:
        "Read-only batch delete preview for candidates selected by audit_root filters. It never deletes, never recommends deletion, and never recursively selects parent/child/family sessions. It is not approval to delete unknown global-state refs.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        root: z.string().optional().describe("Optional explicit path to the .codex root."),
        limit: z.number().int().positive().optional().describe("Maximum candidates to preview. Defaults to 50."),
        status: z.union([z.string(), z.array(z.string())]).optional().describe("Filter by one or more audit-root statuses. Multiple values use OR."),
        source: z.union([z.string(), z.array(z.string())]).optional().describe("Filter by one or more audit-root sources. Multiple values use OR."),
        all: z.boolean().optional().describe("Include complete non-residue sessions too. Defaults to false."),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ root, limit, status, source, all }) => {
      const scan = await scanCodexRoot(root);
      const preview = buildRootDeletePreview(scan, {
        limit,
        includeAll: all,
        statuses: typeof status === "string" ? [status] : status,
        sources: typeof source === "string" ? [source] : source,
      });
      return textResult(
        `Prepared read-only root delete preview for ${preview.previewedCandidates} of ${preview.totalCandidatesAfterFilter} matching candidates. No session was deleted or recommended for deletion.`,
        preview as unknown as Record<string, unknown>,
      );
    },
  );

  server.registerTool(
    "export_session_backup",
    {
      description:
        "Export a full backup bundle for a single Codex session. This is recovery data, not a preview: globalStateRefs may include full exact-key values such as prompt-history content.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        sessionId: z.string(),
        root: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ sessionId, root }) => {
      const scan = await scanCodexRoot(root);
      const session = resolveSessions(scan, [sessionId])[0];
      const bundle = await exportSessionBackup(scan, session);
      return textResult(`Exported backup bundle for ${session.id}.`, { bundle });
    },
  );

  server.registerTool(
    "preview_delete_sessions",
    {
      description:
        "Read-only preview of what would be removed by deleting one or more explicit Codex sessions. This is the single-session or explicit-ID preview to inspect before any confirmed delete. P11 exact-key global-state refs show path, rule id, shape, byte estimate, and confirmation requirement without printing values.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        sessionIds: z.array(z.string()).min(1),
        root: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ sessionIds, root }) => {
      const scan = await scanCodexRoot(root);
      const sessions = resolveSessions(scan, sessionIds);
      const preview = buildDeletePreview(scan, sessions);
      return textResult(`Prepared delete preview for ${sessions.length} sessions.`, { preview, warnings: scan.warnings });
    },
  );

  server.registerTool(
    "plan_delete_sessions",
    {
      description:
        "Read-only delete planning only. For explicit sessionIds it returns the same relationship-aware plan as CLI plan-delete, including optional includeChildren/includeSubagents/includeDescendants/includeFamily flags. For sourceKind + limit candidate mode it returns candidateIds only and keeps selectedIds empty. This is not deletion authorization, has executionSupported=false, creates no preview token, writes no plan file, and cannot execute delete-by-plan.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        root: z.string().optional().describe("Optional explicit path to the .codex root."),
        sessionIds: z.array(z.string()).min(1).optional().describe("Explicit session ids or unique prefixes. Required unless using sourceKind candidate mode."),
        includeChildren: z.boolean().optional().describe("Read-only include flag matching CLI --include-children."),
        includeSubagents: z.boolean().optional().describe("Read-only include flag matching CLI --include-subagents."),
        includeDescendants: z.boolean().optional().describe("Read-only include flag matching CLI --include-descendants."),
        includeFamily: z.boolean().optional().describe("High-risk read-only include flag matching CLI --include-family."),
        sourceKind: sourceKindSchema.optional().describe("Root-level candidate mode. Requires limit, rejects unknown, and returns candidateIds only."),
        status: planDeleteStatusSchema.optional().describe("Optional candidate statuses for sourceKind mode. Omit for all non-unknown statuses."),
        limit: z.number().int().positive().max(50).optional().describe("Required in sourceKind candidate mode; maximum 50."),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({
      root,
      sessionIds,
      includeChildren,
      includeSubagents,
      includeDescendants,
      includeFamily,
      sourceKind,
      status,
      limit,
    }) => {
      const sourceKinds = normalizeArray(sourceKind) as SourceKind[];
      const statuses = normalizeArray(status) as SessionKind[];
      if (sourceKinds.length > 0) {
        if (sessionIds && sessionIds.length > 0) {
          throw new Error("plan_delete_sessions sourceKind candidate mode cannot be combined with explicit sessionIds.");
        }
        if (includeChildren || includeSubagents || includeDescendants || includeFamily) {
          throw new Error("plan_delete_sessions sourceKind candidate mode does not support include flags.");
        }
        if (sourceKinds.includes("unknown")) {
          throw new Error("unknown sourceKind must be reviewed by explicit session ID；不支持 root-level unknown candidate plan。");
        }
        const scan = await scanCodexRoot(root);
        const plan = buildPlanDelete(scan, [], {
          candidateSource: {
            sourceKinds,
            statuses,
            limit: normalizePlanDeleteLimit(limit),
          },
        });
        return textResult(
          `Prepared read-only sourceKind candidate plan with ${plan.candidateIds?.length ?? 0} candidates. No selectedIds were produced and no deletion can be executed from this plan.`,
          { readOnly: true, executionSupported: false, plan, warnings: scan.warnings },
        );
      }

      if (!sessionIds || sessionIds.length === 0) {
        throw new Error("plan_delete_sessions requires explicit sessionIds unless sourceKind candidate mode is used.");
      }
      if (statuses.length > 0 || limit !== undefined) {
        throw new Error("plan_delete_sessions explicit-ID mode does not support status or limit filters.");
      }
      const scan = await scanCodexRoot(root);
      const plan = buildPlanDelete(scan, sessionIds, {
        includeChildren,
        includeSubagents,
        includeDescendants,
        includeFamily,
      });
      return textResult(
        `Prepared read-only delete plan for ${plan.seedSessionIds.length} explicit sessions. No deletion can be executed from this plan.`,
        { readOnly: true, executionSupported: false, plan, warnings: scan.warnings },
      );
    },
  );

  server.registerTool(
    "preview_delete_plan",
    {
      description:
        "Read-only preview of a codex-sessions-delete-plan.v1 audit plan file or inline plan object. It reuses CLI preview-plan stale detection. If stale=true, deletePreview is null and the old plan must not be treated as a current preview. It accepts no confirm/trash/yes/force options, creates no preview token, and cannot execute delete-by-plan.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        root: z.string().optional().describe("Optional explicit path to the .codex root."),
        planFile: z.string().optional().describe("Path to a codex-sessions-delete-plan.v1 file."),
        plan: z.object({}).passthrough().optional().describe("Inline codex-sessions-delete-plan.v1 object, including planHash."),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ root, planFile, plan }) => {
      if ((planFile ? 1 : 0) + (plan ? 1 : 0) !== 1) {
        throw new Error("preview_delete_plan requires exactly one of planFile or plan.");
      }
      const scan = await scanCodexRoot(root);
      const deletePlan = planFile ? await readDeletePlanFile(planFile) : parseDeletePlanObject(plan);
      const preview = await previewDeletePlan(scan, deletePlan);
      return textResult(
        preview.stale
          ? "Plan is stale; no current delete preview was produced."
          : "Prepared read-only preview for a current delete plan. No deletion was executed.",
        { readOnly: true, executionSupported: false, preview },
      );
    },
  );

  server.registerTool(
    "list_trash",
    {
      description: "List recoverable Codex session trash entries.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        root: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ root }) => {
      const scan = await scanCodexRoot(root);
      const entries = await listTrashEntries(scan.root.rootPath);
      const duplicateSessionIds = summarizeTrashDuplicateSessions(entries);
      return textResult(`Found ${entries.length} trash entries.`, { root: scan.root, entries, duplicateSessionIds });
    },
  );

  server.registerTool(
    "get_recovery_status",
    {
      description: "Read-only status for an interrupted local mutation. Returns its exact operationId and durable checkpoints without changing data.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({ root: z.string().optional() }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ root }) => {
      const status = await getRecoveryStatus(root);
      const message = !status.pending
        ? "No interrupted mutation is pending."
        : status.invalidReason
          ? "Interrupted mutation metadata is invalid; recovery is blocked until it is reviewed."
          : `Interrupted operation ${status.operationId} requires review.`;
      return textResult(message, { status });
    },
  );

  if (profile === "admin" && isDestructivePlatformSupported()) {
    server.registerTool(
      "recover_operation",
      {
        description: "Recover one interrupted mutation from its durable journal. Requires the exact operationId and confirm=true. Recovery refuses any file or SQLite value outside the recorded before/after states.",
        outputSchema: TOOL_OUTPUT_SCHEMA,
        inputSchema: z.object({
          operationId: z.string().describe("Exact operationId returned by get_recovery_status."),
          root: z.string().optional(),
          confirm: z.boolean().optional(),
        }),
        annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
      },
      async ({ operationId, root, confirm }) => {
        assertCanonicalSessionIds([operationId]);
        const status = await getRecoveryStatus(root);
        if (!status.pending || status.operationId !== operationId) {
          throw new MutationSafetyError("RECOVERY_REQUIRED", `no matching interrupted operation: ${operationId}`);
        }
        if (!confirm) {
          return textResult("Recovery was not executed. Pass confirm=true with the exact operationId after reviewing checkpoints.", {
            status,
            requiresConfirmation: true,
            exactOperationIdRequired: true,
          });
        }
        const result = await recoverInterruptedOperation(root);
        return textResult(`Recovered operation ${operationId} by ${result.recoveredBy}.`, { result });
      },
    );
    server.registerTool(
      "delete_sessions",
      {
        description:
          "Delete explicit Codex sessions across files, JSONL indexes, SQLite, known global-state refs, and the two P11 exact-key global-state refs only. Preview may use a unique short prefix. Confirmed execution requires full UUID session IDs. Pass trash=true to move them to recoverable trash. Active sessions additionally require allowActive=true. Without confirm=true this returns a preview only; with confirm=true it executes after the caller has reviewed the intended scope. There is no preview token binding a prior preview call to the confirmed call. Unknown global-state refs outside the exact-key rules remain warnings, and unknown-only cleanup is refused. This tool never recursively adds parent, child, or family sessions.",
        outputSchema: TOOL_OUTPUT_SCHEMA,
        inputSchema: z.object({
          sessionIds: z.array(z.string()).min(1),
          root: z.string().optional(),
          confirm: z.boolean().optional().describe("Must be true to execute deletion after you have inspected a separate preview. Omit or false to return preview only."),
          trash: z.boolean().optional().describe("Move sessions to recoverable trash before deleting live surfaces. Defaults to false for permanent delete compatibility."),
          allowActive: z.boolean().optional().describe("Must be true, together with confirm=true and full UUIDs, to delete or trash an active session."),
        }),
        annotations: {
          destructiveHint: true,
          readOnlyHint: false,
          idempotentHint: false,
        },
      },
      async ({ sessionIds, root, confirm, trash, allowActive }) => {
        const scan = await scanCodexRoot(root);
        if (confirm) {
          assertCanonicalSessionIds(sessionIds);
        }
        const sessions = resolveSessions(scan, sessionIds);
        if (!confirm) {
          const preview = buildDeletePreview(scan, sessions);
          const activeSessionIds = sessions.filter((session) => session.kind === "active").map((session) => session.id);
          return textResult(`Deletion was not executed. Pass confirm=true to ${trash ? "move to trash" : "delete"} ${sessions.length} sessions.`, {
            preview,
            warnings: scan.warnings,
            requiresConfirmation: true,
            requiresFullSessionIds: true,
            activeSessionIds,
            requiresAllowActive: activeSessionIds.length > 0,
            action: trash ? "trash" : "delete",
          });
        }

        assertConfirmedSessionSelection(sessionIds, sessions, { allowActive });
  
        if (trash) {
          const result = await moveSessionsToTrash(scan, sessions, { allowActive });
          return textResult(
            `Trash mutation committed for ${sessions.length} sessions; verification=${result.verificationStatus}.`,
            { result },
          );
        }
  
        const result = await deleteSessions(scan, sessions, { allowActive });
        return textResult(
          `Delete mutation committed for ${sessions.length} sessions; verification=${result.verificationStatus}.`,
          { result },
        );
      },
    );
  
    server.registerTool(
      "restore_sessions",
      {
        description:
          "Preview one restore candidate by trash id, contained session id, or unique prefix. Confirmed restore requires the exact trashId returned by the preview or list_trash.",
        outputSchema: TOOL_OUTPUT_SCHEMA,
        inputSchema: z.object({
          id: z.string().describe("Preview accepts trash id, session id, or a unique prefix. confirm=true requires an exact trashId."),
          root: z.string().optional(),
          confirm: z.boolean().optional(),
        }),
        annotations: {
          destructiveHint: true,
          readOnlyHint: false,
          idempotentHint: false,
        },
      },
      async ({ id, root, confirm }) => {
        const scan = await scanCodexRoot(root);
        if (!confirm) {
          const entries = (await listTrashEntries(scan.root.rootPath)).filter((entry) => trashEntryMatches(entry, id));
          const duplicateSessionIds = summarizeTrashDuplicateSessions(entries);
          return textResult("Restore was not executed. Pass confirm=true to restore.", {
            entries,
            duplicateSessionIds,
            requiresExactTrashId: true,
            preflight: entries.map((entry) => ({
              trashId: entry.trashId,
              sessionIds: entry.sessionIds,
              warnings: entry.rootPath === scan.root.rootPath ? [] : [`回收站记录来自不同 root：${entry.rootPath}`],
            })),
            requiresConfirmation: true,
          });
        }
  
        const result = await restoreTrashEntry(root, id);
        return textResult(
          `Restore mutation committed for ${result.restoredSessionIds.length} sessions; verification=${result.verificationStatus}.`,
          { result },
        );
      },
    );
  
    server.registerTool(
      "purge_trash",
      {
        description:
          "Preview one purge candidate by trash id, contained session id, or unique prefix. Confirmed purge requires the exact trashId returned by the preview or list_trash.",
        outputSchema: TOOL_OUTPUT_SCHEMA,
        inputSchema: z.object({
          id: z.string().describe("Preview accepts trash id, session id, or a unique prefix. confirm=true requires an exact trashId."),
          root: z.string().optional(),
          confirm: z.boolean().optional(),
        }),
        annotations: {
          destructiveHint: true,
          readOnlyHint: false,
          idempotentHint: false,
        },
      },
      async ({ id, root, confirm }) => {
        const scan = await scanCodexRoot(root);
        if (!confirm) {
          const entries = (await listTrashEntries(scan.root.rootPath)).filter((entry) => trashEntryMatches(entry, id));
          const duplicateSessionIds = summarizeTrashDuplicateSessions(entries);
          return textResult("Purge was not executed. Pass confirm=true to purge.", {
            entries,
            duplicateSessionIds,
            requiresExactTrashId: true,
            requiresConfirmation: true,
          });
        }
  
        const result = await purgeTrashEntry(root, id);
        return textResult(
          `Purge mutation committed for ${result.trashEntry.trashId}; verification=${result.verificationStatus}.`,
          { result },
        );
      },
    );
  
    server.registerTool(
      "cleanup_session_indexes",
      {
        description:
          "Remove JSONL index traces for specific sessions without deleting raw files or SQLite rows. Preview may use a unique short prefix. Confirmed execution requires full UUID session IDs; active sessions additionally require allowActive=true. Requires confirm=true; otherwise returns a preview only.",
        outputSchema: TOOL_OUTPUT_SCHEMA,
        inputSchema: z.object({
          sessionIds: z.array(z.string()).min(1),
          root: z.string().optional(),
          confirm: z.boolean().optional().describe("Must be true to rewrite JSONL indexes. Omit or false to return preview only."),
          allowActive: z.boolean().optional().describe("Must be true, together with confirm=true and full UUIDs, to rewrite indexes for an active session."),
        }),
        annotations: {
          destructiveHint: true,
          readOnlyHint: false,
          idempotentHint: false,
        },
      },
      async ({ sessionIds, root, confirm, allowActive }) => {
        const scan = await scanCodexRoot(root);
        if (confirm) {
          assertCanonicalSessionIds(sessionIds);
        }
        const sessions = resolveSessions(scan, sessionIds);
        if (!confirm) {
          const preview = previewCleanupSessionIndexes(scan, sessions);
          const activeSessionIds = sessions.filter((session) => session.kind === "active").map((session) => session.id);
          return textResult("Cleanup was not executed. Pass confirm=true to rewrite JSONL indexes.", {
            preview,
            requiresConfirmation: true,
            requiresFullSessionIds: true,
            activeSessionIds,
            requiresAllowActive: activeSessionIds.length > 0,
          });
        }

        assertConfirmedSessionSelection(sessionIds, sessions, { allowActive });
  
        const result = await cleanupSessionIndexes(scan, sessions, { allowActive });
        return textResult(
          `Index cleanup committed for ${sessions.length} sessions; verification=${result.verificationStatus}.`,
          { result },
        );
      },
    );
  
    server.registerTool(
      "cleanup_stale_indexes",
      {
        description:
          "Remove stale JSONL index entries that no longer have files or SQLite records. Requires confirm=true; otherwise returns a preview only.",
        outputSchema: TOOL_OUTPUT_SCHEMA,
        inputSchema: z.object({
          root: z.string().optional(),
          confirm: z.boolean().optional().describe("Must be true to rewrite JSONL indexes. Omit or false to return preview only."),
        }),
        annotations: {
          destructiveHint: true,
          readOnlyHint: false,
          idempotentHint: false,
        },
      },
      async ({ root, confirm }) => {
        const scan = await scanCodexRoot(root);
        if (!confirm) {
          const preview = previewCleanupStaleIndexes(scan);
          return textResult("Cleanup was not executed. Pass confirm=true to rewrite JSONL indexes.", {
            preview,
            requiresConfirmation: true,
          });
        }
  
        const result = await cleanupStaleIndexes(scan);
        return textResult(
          `Stale-index cleanup committed for ${result.staleSessionIds.length} sessions; verification=${result.verificationStatus}.`,
          { result },
        );
      },
    );
  } // end if (profile === "admin")

  server.registerTool(
    "verify_sessions",
    {
      description:
        "Verify whether sessions still have remaining files, JSONL index rows, SQLite rows, known global-state refs, P11 exact-key global-state refs, unknown global-state refs, or warnings.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        sessionIds: z.array(z.string()).min(1),
        root: z.string().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ sessionIds, root }) => {
      const scan = await scanCodexRoot(root);
      const sessions = resolveSessions(scan, sessionIds);
      const result = await validateDeletion(scan, sessions);
      return textResult(`Verified ${sessions.length} sessions.`, { results: result });
    },
  );

  return server;
}

export async function startServer(): Promise<void> {
  const profile = parseProfile();
  const server = createServer(profile);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`codex-sessions MCP server running on stdio (profile: ${profile})`);
}

export function getMcpVersionText(): string {
  return TOOL_VERSION;
}

export function isMcpEntrypoint(entryPath: string | undefined, moduleUrl: string): boolean {
  if (!entryPath) {
    return false;
  }

  return realpathSync(entryPath) === realpathSync(fileURLToPath(moduleUrl));
}

const isEntrypoint = isMcpEntrypoint(process.argv[1], import.meta.url);

if (isEntrypoint) {
  if (process.argv.includes("--version")) {
    console.log(getMcpVersionText());
    process.exit(0);
  }

  startServer().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
