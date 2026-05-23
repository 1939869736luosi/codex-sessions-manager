#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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
import { resolveSessionFamily } from "../core/family.js";
import { groupSessionsByProject, listProjectSummaries } from "../core/project.js";
import { filterSessions, resolveSessions } from "../core/query.js";
import { scanCodexRoot } from "../core/scan.js";
import { readSessionTimeline } from "../core/timeline.js";
import { listTrashEntries, moveSessionsToTrash, purgeTrashEntry, restoreTrashEntry } from "../core/trash.js";

const TOOL_OUTPUT_SCHEMA = z.object({}).passthrough();

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
      version: "0.3.2",
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
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ root, query, project, groupBy, status, limit, updatedAfter, updatedBefore, createdAfter, createdBefore }) => {
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
      description: "Inspect parent, child, side/fork, and related family sessions for one Codex session without modifying anything.",
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
      const family = resolveSessionFamily(scan, sessionId);
      return textResult(`Loaded session family for ${family.current.sessionId}.`, {
        root: scan.root,
        warnings: scan.warnings,
        family,
      });
    },
  );

  server.registerTool(
    "export_session_backup",
    {
      description: "Export a full backup bundle for a single Codex session.",
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
      description: "Preview what would be removed by deleting one or more Codex sessions.",
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
      description: "Delete Codex sessions across files, JSONL indexes, and SQLite. Pass trash=true to move them to recoverable trash. Requires confirm=true; otherwise returns a preview only.",
      outputSchema: TOOL_OUTPUT_SCHEMA,
      inputSchema: z.object({
        sessionIds: z.array(z.string()).min(1),
        root: z.string().optional(),
        confirm: z.boolean().optional().describe("Must be true to execute deletion. Omit or false to return preview only."),
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
      return textResult(`Found ${entries.length} trash entries.`, { root: scan.root, entries });
    },
  );

  server.registerTool(
    "restore_sessions",
    {
      description: "Restore one trash entry by trash id or contained session id. Requires confirm=true; otherwise previews the matching trash entries.",
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
        const entries = (await listTrashEntries(scan.root.rootPath)).filter(
          (entry) =>
            entry.trashId === id ||
            entry.trashId.startsWith(id) ||
            entry.sessionIds.includes(id) ||
            entry.sessionIds.some((sessionId) => sessionId.startsWith(id)),
        );
        return textResult("Restore was not executed. Pass confirm=true to restore.", {
          entries,
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
      description: "Permanently remove one trash entry without touching live sessions. Requires confirm=true; otherwise previews matching entries.",
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
        const entries = (await listTrashEntries(scan.root.rootPath)).filter(
          (entry) =>
            entry.trashId === id ||
            entry.trashId.startsWith(id) ||
            entry.sessionIds.includes(id) ||
            entry.sessionIds.some((sessionId) => sessionId.startsWith(id)),
        );
        return textResult("Purge was not executed. Pass confirm=true to purge.", {
          entries,
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
      description: "Verify whether sessions still have remaining files, JSONL index rows, or SQLite rows.",
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
