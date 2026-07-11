import path from "node:path";

import { safeJsonParse, splitJsonLines } from "./jsonl.js";
import { createTrustedRootContext, readManagedText } from "./path-safety.js";
import type { SessionEntry, SessionFileTarget, TimelineItem } from "./types.js";

const TOOL_OUTPUT_LIMIT = 900;

function normalizeTimelineBody(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

function extractMessageContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((item) => {
      const typed = item as { type?: string; text?: string };
      if (typed.type === "input_text" || typed.type === "output_text" || typed.type === "text") {
        return typed.text ?? "";
      }

      return "";
    })
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}...`;
}

function summarizeToolInvocation(payload: Record<string, unknown>): string {
  const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : "工具调用";
  const args = typeof payload.arguments === "string" ? payload.arguments.trim() : "";

  return args ? `${name}\n${truncateText(args, TOOL_OUTPUT_LIMIT)}` : name;
}

function summarizeToolOutput(payload: Record<string, unknown>): string {
  const output = typeof payload.output === "string" ? payload.output.trim() : "";
  return output ? truncateText(output, TOOL_OUTPUT_LIMIT) : "";
}

function extractTimelineItems(parsed: Record<string, unknown>): TimelineItem[] {
  const items: TimelineItem[] = [];
  const type = parsed.type;

  if (type === "event_msg") {
    const payload = parsed.payload as { type?: string; message?: string } | undefined;
    const eventType = payload?.type;

    if (eventType === "user_message" && payload?.message) {
      items.push({
        kind: "user",
        roleLabel: "用户",
        timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
        body: payload.message.trim(),
      });
    }

    if (eventType === "agent_message" && payload?.message) {
      items.push({
        kind: "assistant",
        roleLabel: "助手",
        timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
        body: payload.message.trim(),
      });
    }
  }

  if (type === "response_item") {
    const payload = (parsed.payload as Record<string, unknown> | undefined) ?? {};
    const payloadType = payload.type;
    const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : null;

    if (payloadType === "message" && (payload.role === "user" || payload.role === "assistant")) {
      const body = extractMessageContent(payload.content);

      if (body) {
        items.push({
          kind: payload.role === "user" ? "user" : "assistant",
          roleLabel: payload.role === "user" ? "用户" : "助手",
          timestamp,
          body,
        });
      }
    }

    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      const body = summarizeToolInvocation(payload);
      if (body) {
        items.push({
          kind: "system",
          roleLabel: "工具调用",
          timestamp,
          body,
        });
      }
    }

    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      const body = summarizeToolOutput(payload);
      if (body) {
        items.push({
          kind: "system",
          roleLabel: "工具输出",
          timestamp,
          body,
        });
      }
    }
  }

  return items;
}

function dedupeTimeline(items: TimelineItem[]): TimelineItem[] {
  const results: TimelineItem[] = [];

  for (const item of items) {
    const previous = results[results.length - 1];

    if (
      previous &&
      previous.kind === item.kind &&
      normalizeTimelineBody(previous.body) === normalizeTimelineBody(item.body)
    ) {
      continue;
    }

    results.push(item);
  }

  return results;
}

function getPrimaryFileTarget(session: SessionEntry): SessionFileTarget | null {
  if (!session.fileTargets.length) {
    return null;
  }

  return (
    session.fileTargets.find((target) => target.bucket === "sessions" && !target.compressed) ??
    session.fileTargets.find((target) => !target.compressed) ??
    null
  );
}

export async function readSessionTimeline(session: SessionEntry, rootPath?: string): Promise<TimelineItem[]> {
  const primaryFile = getPrimaryFileTarget(session);

  if (!primaryFile) {
    return session.historyPreview.map((text, index) => ({
      kind: "user",
      roleLabel: `历史输入 ${index + 1}`,
      timestamp: null,
      body: text,
    }));
  }

  const relativeParts = primaryFile.relativePath.split(/[\\/]+/u).filter(Boolean);
  const inferredRoot = path.resolve(primaryFile.absolutePath, ...relativeParts.map(() => ".."));
  const trustedRoot = await createTrustedRootContext(rootPath ?? inferredRoot);
  const text = await readManagedText(trustedRoot, primaryFile.relativePath);
  const items: TimelineItem[] = [];

  for (const line of splitJsonLines(text)) {
    const parsed = safeJsonParse<Record<string, unknown>>(line);

    if (!parsed) {
      continue;
    }

    items.push(...extractTimelineItems(parsed));
  }

  if (!items.length) {
    return session.historyPreview.map((historyText, index) => ({
      kind: "user",
      roleLabel: `历史输入 ${index + 1}`,
      timestamp: null,
      body: historyText,
    }));
  }

  return dedupeTimeline(items);
}
