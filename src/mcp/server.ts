#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { buildRootDeletePreview, buildRootResidueAudit, buildSessionResidueAudit } from "../core/audit.js";
import { exportSessionBackup } from "../core/backup.js";
import { inspectCodexRoot } from "../core/doctor.js";
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
import { groupSessionsByProject, listProjectSummaries } from "../core/project.js";
import { filterSessions, resolveSessions } from "../core/query.js";
import { scanCodexRoot } from "../core/scan.js";
import { SOURCE_KINDS, summarizeSources } from "../core/sources.js";
import { readSessionTimeline } from "../core/timeline.js";
import {
  listTrashEntries,
  moveSessionsToTrash,
  purgeTrashEntry,
  restoreTrashEntry,
  summarizeTrashDuplicateSessions,
  trashEntryMatches,
} from "../core/trash.js";

const TOOL_OUTPUT_SCHEMA = z.object({}).passthrough();
const stringOrStringArraySchema = z.union([z.string(), z.array(z.string())]);
const sourceKindSchema = z.union([z.enum(SOURCE_KINDS), z.array(z.enum(SOURCE_KINDS))]);

function textResult(text: string, structuredContent?: Record<string, unknown> | undefined) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
  };
}

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "codex-sessions",
      version: "0.4.0",
    },
    {
      capabilities: { logging: {} },
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
      const report = await inspectCodexRoot(root);
      return textResult(`Inspected Codex root ${report.rootPath}.`, { report, warnings: report.warnings });
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
        limit: z.number().int().positive().optional(),
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
      const scan = await scanCodexRoot(root);
      const sessions = filterSessions(scan, {
        query,
        project,
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
      });
      return textResult(`Found ${sessions.length} matching sessions.`, {
        root: scan.root,
        warnings: scan.warnings,
        sessions,
        projectSummaries: groupBy === "project" ? listProjectSummaries(sessions) : undefined,
        groupedSessions: groupBy === "project" ? groupSessionsByProject(sessions) : undefined,
      });
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
      description: "Get one Codex session with timeline preview.",
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
      const session = resolveSessions(scan, [sessionId])[0];
      const timeline = await readSessionTimeline(session);
      return textResult(`Loaded session ${session.id}.`, { session, timeline });
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
    "delete_sessions",
    {
      description:
        "Delete explicit Codex sessions across files, JSONL indexes, SQLite, known global-state refs, and the two P11 exact-key global-state refs only. Pass trash=true to move them to recoverable trash. Without confirm=true this returns a preview only; with confirm=true it executes after the caller has reviewed the intended scope. There is no preview token binding a prior preview call to the confirmed call. Unknown global-state refs outside the exact-key rules remain warnings, and unknown-only cleanup is refused. This tool never recursively adds parent, child, or family sessions.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        sessionIds: z.array(z.string()).min(1),
        root: z.string().optional(),
        confirm: z.boolean().optional().describe("Must be true to execute deletion after you have inspected a separate preview. Omit or false to return preview only."),
        trash: z.boolean().optional().describe("Move sessions to recoverable trash before deleting live surfaces. Defaults to false for permanent delete compatibility."),
      }),
      annotations: {
        destructiveHint: true,
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async ({ sessionIds, root, confirm, trash }) => {
      const scan = await scanCodexRoot(root);
      const sessions = resolveSessions(scan, sessionIds);
      if (!confirm) {
        const preview = buildDeletePreview(scan, sessions);
        return textResult(`Deletion was not executed. Pass confirm=true to ${trash ? "move to trash" : "delete"} ${sessions.length} sessions.`, {
          preview,
          warnings: scan.warnings,
          requiresConfirmation: true,
          action: trash ? "trash" : "delete",
        });
      }

      if (trash) {
        const result = await moveSessionsToTrash(scan, sessions);
        return textResult(`Moved ${sessions.length} sessions to trash.`, { result });
      }

      const result = await deleteSessions(scan, sessions);
      return textResult(`Deleted ${sessions.length} sessions.`, { result });
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
    "restore_sessions",
    {
      description:
        "Restore one trash entry by trash id or contained session id. If a session id matches multiple trash entries, confirm=true refuses it and requires an exact trash id.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        id: z.string().describe("Trash id, trash id prefix, session id, or session id prefix."),
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
          requiresExactTrashId: entries.length > 1,
          preflight: entries.map((entry) => ({
            trashId: entry.trashId,
            sessionIds: entry.sessionIds,
            warnings: entry.rootPath === scan.root.rootPath ? [] : [`回收站记录来自不同 root：${entry.rootPath}`],
          })),
          requiresConfirmation: true,
        });
      }

      const result = await restoreTrashEntry(root, id);
      return textResult(`Restored ${result.restoredSessionIds.length} sessions.`, { result });
    },
  );

  server.registerTool(
    "purge_trash",
    {
      description:
        "Permanently remove one trash entry without touching live sessions. If a session id matches multiple trash entries, confirm=true refuses it and requires an exact trash id.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        id: z.string().describe("Trash id, trash id prefix, session id, or session id prefix."),
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
          requiresExactTrashId: entries.length > 1,
          requiresConfirmation: true,
        });
      }

      const result = await purgeTrashEntry(root, id);
      return textResult(`Purged trash entry ${result.trashEntry.trashId}.`, { result });
    },
  );

  server.registerTool(
    "cleanup_session_indexes",
    {
      description:
        "Remove JSONL index traces for specific sessions without deleting raw files or SQLite rows. Requires confirm=true; otherwise returns a preview only.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        sessionIds: z.array(z.string()).min(1),
        root: z.string().optional(),
        confirm: z.boolean().optional().describe("Must be true to rewrite JSONL indexes. Omit or false to return preview only."),
      }),
      annotations: {
        destructiveHint: true,
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async ({ sessionIds, root, confirm }) => {
      const scan = await scanCodexRoot(root);
      const sessions = resolveSessions(scan, sessionIds);
      if (!confirm) {
        const preview = previewCleanupSessionIndexes(scan, sessions);
        return textResult("Cleanup was not executed. Pass confirm=true to rewrite JSONL indexes.", {
          preview,
          requiresConfirmation: true,
        });
      }

      const result = await cleanupSessionIndexes(scan, sessions);
      return textResult(`Cleaned index traces for ${sessions.length} sessions.`, { result });
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
      return textResult(`Cleaned ${result.staleSessionIds.length} stale session indexes.`, { result });
    },
  );

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
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("codex-sessions MCP server running on stdio");
}

const isEntrypoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  startServer().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
