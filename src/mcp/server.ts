#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { exportSessionBackup } from "../core/backup.js";
import {
  buildDeletePreview,
  cleanupSessionIndexes,
  cleanupStaleIndexes,
  deleteSessions,
  validateDeletion,
} from "../core/delete.js";
import { filterSessions, resolveSessions } from "../core/query.js";
import { scanCodexRoot } from "../core/scan.js";
import { readSessionTimeline } from "../core/timeline.js";

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
      version: "0.3.1",
    },
    {
      capabilities: { logging: {} },
    },
  );

  server.registerTool(
    "list_sessions",
    {
      description: "List Codex sessions from a local ~/.codex root.",
      inputSchema: z.object({
        root: z.string().optional().describe("Optional explicit path to the .codex root."),
        query: z.string().optional().describe("Optional free-text filter."),
        status: z.enum(["all", "active", "archived", "db-only", "stale"]).optional(),
        limit: z.number().int().positive().optional(),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ root, query, status, limit }) => {
      const scan = await scanCodexRoot(root);
      const sessions = filterSessions(scan, { query, status, limit });
      return textResult(`Found ${sessions.length} matching sessions.`, {
        root: scan.root,
        warnings: scan.warnings,
        sessions,
      });
    },
  );

  server.registerTool(
    "get_session",
    {
      description: "Get one Codex session with timeline preview.",
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
    "export_session_backup",
    {
      description: "Export a full backup bundle for a single Codex session.",
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
      return textResult(`Prepared delete preview for ${sessions.length} sessions.`, { preview });
    },
  );

  server.registerTool(
    "delete_sessions",
    {
      description: "Permanently delete Codex sessions across files, JSONL indexes, and SQLite. Requires confirm=true; otherwise returns a preview only.",
      inputSchema: z.object({
        sessionIds: z.array(z.string()).min(1),
        root: z.string().optional(),
        confirm: z.boolean().optional().describe("Must be true to execute deletion. Omit or false to return preview only."),
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
        const preview = buildDeletePreview(scan, sessions);
        return textResult(`Deletion was not executed. Pass confirm=true to delete ${sessions.length} sessions.`, {
          preview,
          requiresConfirmation: true,
        });
      }

      const result = await deleteSessions(scan, sessions);
      return textResult(`Deleted ${sessions.length} sessions.`, { result });
    },
  );

  server.registerTool(
    "cleanup_session_indexes",
    {
      description: "Remove JSONL index traces for specific sessions without deleting raw files or SQLite rows.",
      inputSchema: z.object({
        sessionIds: z.array(z.string()).min(1),
        root: z.string().optional(),
      }),
      annotations: {
        destructiveHint: true,
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async ({ sessionIds, root }) => {
      const scan = await scanCodexRoot(root);
      const sessions = resolveSessions(scan, sessionIds);
      const result = await cleanupSessionIndexes(scan, sessions);
      return textResult(`Cleaned index traces for ${sessions.length} sessions.`, { result });
    },
  );

  server.registerTool(
    "cleanup_stale_indexes",
    {
      description: "Remove stale JSONL index entries that no longer have files or SQLite records.",
      inputSchema: z.object({
        root: z.string().optional(),
      }),
      annotations: {
        destructiveHint: true,
        readOnlyHint: false,
        idempotentHint: false,
      },
    },
    async ({ root }) => {
      const scan = await scanCodexRoot(root);
      const result = await cleanupStaleIndexes(scan);
      return textResult(`Cleaned ${result.staleSessionIds.length} stale session indexes.`, { result });
    },
  );

  server.registerTool(
    "verify_sessions",
    {
      description: "Verify whether sessions still have remaining files, JSONL index rows, or SQLite rows.",
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
