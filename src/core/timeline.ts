import path from "node:path";

import { safeJsonParse } from "./jsonl.js";
import { createTrustedRootContext, readManagedText } from "./path-safety.js";
import type {
  SessionEntry,
  SessionFileTarget,
  SessionTimelineResult,
  ThreadHistoryMode,
  TimelineItem,
} from "./types.js";

const TOOL_OUTPUT_LIMIT = 900;

const KNOWN_NON_SEMANTIC_OUTER_TYPES = new Set([
  "sessionmeta",
  "turncontext",
  "worldstate",
  "compacted",
  "interagentcommunicationmetadata",
]);

const KNOWN_NON_SEMANTIC_EVENT_TYPES = new Set([
  "taskstarted",
  "turnstarted",
  "taskcomplete",
  "turncomplete",
  "tokencount",
  "threadgoalupdated",
  "threadrolledback",
  "turnaborted",
  "threadsettingsapplied",
  "contextcompacted",
  "agentreasoning",
  "agentreasoningrawcontent",
  "enteredreviewmode",
  "exitedreviewmode",
  "patchapplyend",
  "mcptoolcallend",
  "websearchend",
  "imagegenerationend",
  "subagentactivity",
]);

function normalizeType(value: unknown): string {
  return typeof value === "string" ? value.replace(/[^a-z0-9]/giu, "").toLowerCase() : "";
}

function normalizeTimelineBody(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";

  return content
    .map((entry) => {
      const typed = entry as { type?: unknown; text?: unknown };
      const type = normalizeType(typed.type);
      if ((type === "text" || type === "inputtext" || type === "outputtext") && typeof typed.text === "string") {
        return typed.text.trim();
      }
      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function truncateText(text: string, limit = TOOL_OUTPUT_LIMIT): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}...`, truncated: true };
}

function stringifyCompact(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function timelineItem(
  partial: Pick<TimelineItem, "kind" | "roleLabel" | "timestamp" | "body"> & Partial<TimelineItem>,
): TimelineItem {
  return {
    source: "diagnostic",
    sourceType: null,
    lineNumber: null,
    truncated: false,
    unsupported: false,
    parseError: false,
    ...partial,
  };
}

function unsupportedItem(sourceType: string, lineNumber: number, timestamp: string | null): TimelineItem {
  return timelineItem({
    kind: "system",
    roleLabel: "未知项",
    timestamp,
    body: `不支持的 timeline item: ${sourceType || "unknown"}`,
    source: "diagnostic",
    sourceType: sourceType || "unknown",
    lineNumber,
    unsupported: true,
  });
}

function parseErrorItem(lineNumber: number): TimelineItem {
  return timelineItem({
    kind: "system",
    roleLabel: "解析错误",
    timestamp: null,
    body: `第 ${lineNumber} 行无法解析为 JSON`,
    source: "diagnostic",
    sourceType: "invalid_json",
    lineNumber,
    parseError: true,
  });
}

function itemTimestamp(record: Record<string, unknown>, payload?: Record<string, unknown>): string | null {
  if (typeof record.timestamp === "string") return record.timestamp;
  const completedAtMs = Number(payload?.completed_at_ms);
  if (Number.isFinite(completedAtMs) && completedAtMs > 0) {
    return new Date(completedAtMs).toISOString();
  }
  return null;
}

function summarizeCommand(item: Record<string, unknown>): { body: string; truncated: boolean } {
  const command = Array.isArray(item.command)
    ? item.command.map((part) => String(part)).join(" ")
    : stringifyCompact(item.command);
  const rawOutput = [item.formatted_output, item.aggregated_output, item.stdout, item.stderr]
    .find((value) => typeof value === "string" && value.trim()) as string | undefined;
  const output = truncateText(rawOutput?.trim() ?? "");
  return {
    body: [command, output.text].filter(Boolean).join("\n") || "命令执行",
    truncated: output.truncated,
  };
}

function summarizeCompletedTool(item: Record<string, unknown>, label: string): { text: string; truncated: boolean } {
  const toolName = [item.server, item.namespace, item.tool, item.name]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .join("/") || label;
  const argumentsText = stringifyCompact(item.arguments);
  const resultText = item.error
    ? stringifyCompact(item.error)
    : typeof item.result === "string"
      ? item.result
      : item.result
        ? stringifyCompact(item.result)
        : Array.isArray(item.content_items)
          ? stringifyCompact(item.content_items)
          : "";
  const combined = [toolName, argumentsText, resultText].filter(Boolean).join("\n");
  return truncateText(combined || label);
}

function parseCompletedItem(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  lineNumber: number,
): TimelineItem[] {
  const item = (payload.item as Record<string, unknown> | undefined) ?? {};
  const rawType = typeof item.type === "string" ? item.type : "unknown";
  const type = normalizeType(rawType);
  const timestamp = itemTimestamp(record, payload);

  if (type === "usermessage") {
    const body = extractTextContent(item.content);
    return body ? [timelineItem({
      kind: "user",
      roleLabel: "用户",
      timestamp,
      body,
      source: "event_msg",
      sourceType: rawType,
      lineNumber,
    })] : [];
  }

  if (type === "agentmessage") {
    const body = extractTextContent(item.content);
    return body ? [timelineItem({
      kind: "assistant",
      roleLabel: "助手",
      timestamp,
      body,
      source: "event_msg",
      sourceType: rawType,
      lineNumber,
    })] : [];
  }

  if (type === "commandexecution") {
    const summary = summarizeCommand(item);
    return [timelineItem({
      kind: "system",
      roleLabel: "命令执行",
      timestamp,
      body: summary.body,
      source: "event_msg",
      sourceType: rawType,
      lineNumber,
      truncated: summary.truncated,
    })];
  }

  if (type === "dynamictoolcall" || type === "mcptoolcall" || type === "collabagenttoolcall") {
    const summary = summarizeCompletedTool(item, type === "mcptoolcall" ? "MCP 工具" : "工具调用");
    return [timelineItem({
      kind: "system",
      roleLabel: type === "mcptoolcall" ? "MCP 工具" : "工具调用",
      timestamp,
      body: summary.text,
      source: "event_msg",
      sourceType: rawType,
      lineNumber,
      truncated: summary.truncated,
    })];
  }

  if (type === "plan") {
    const body = typeof item.text === "string" ? item.text.trim() : "";
    return body ? [timelineItem({
      kind: "system",
      roleLabel: "计划",
      timestamp,
      body,
      source: "event_msg",
      sourceType: rawType,
      lineNumber,
    })] : [];
  }

  if (type === "reasoning") {
    const body = Array.isArray(item.summary_text)
      ? item.summary_text.map(String).filter(Boolean).join("\n")
      : stringifyCompact(item.summary);
    return body ? [timelineItem({
      kind: "system",
      roleLabel: "推理摘要",
      timestamp,
      body,
      source: "event_msg",
      sourceType: rawType,
      lineNumber,
    })] : [];
  }

  if (
    type === "filechange" || type === "websearch" || type === "imageview" ||
    type === "imagegeneration" || type === "subagentactivity" || type === "sleep" ||
    type === "enteredreviewmode" || type === "exitedreviewmode" || type === "contextcompaction"
  ) {
    const summary = truncateText(
      stringifyCompact(item.text ?? item.query ?? item.status ?? item.action ?? item) || rawType,
    );
    return [timelineItem({
      kind: "system",
      roleLabel: rawType,
      timestamp,
      body: summary.text,
      source: "event_msg",
      sourceType: rawType,
      lineNumber,
      truncated: summary.truncated,
    })];
  }

  return [unsupportedItem(rawType, lineNumber, timestamp)];
}

function parseResponseItem(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  lineNumber: number,
): TimelineItem[] {
  const rawType = typeof payload.type === "string" ? payload.type : "unknown";
  const type = normalizeType(rawType);
  const timestamp = itemTimestamp(record);

  if (type === "message" && (payload.role === "user" || payload.role === "assistant")) {
    const body = Array.isArray(payload.content) ? extractTextContent(payload.content) : "";
    return body ? [timelineItem({
      kind: payload.role === "user" ? "user" : "assistant",
      roleLabel: payload.role === "user" ? "用户" : "助手",
      timestamp,
      body,
      source: "response_item",
      sourceType: rawType,
      lineNumber,
    })] : [];
  }

  if (type === "functioncall" || type === "customtoolcall" || type === "toolsearchcall") {
    const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : "工具调用";
    const args = typeof payload.arguments === "string" ? payload.arguments.trim() : stringifyCompact(payload.arguments);
    const summarizedArgs = truncateText(args);
    return [timelineItem({
      kind: "system",
      roleLabel: "工具调用",
      timestamp,
      body: summarizedArgs.text ? `${name}\n${summarizedArgs.text}` : name,
      source: "response_item",
      sourceType: rawType,
      lineNumber,
      truncated: summarizedArgs.truncated,
    })];
  }

  if (type === "functioncalloutput" || type === "customtoolcalloutput" || type === "toolsearchoutput") {
    const rawOutput = typeof payload.output === "string" ? payload.output.trim() : stringifyCompact(payload.output);
    if (!rawOutput) return [];
    const summary = truncateText(rawOutput);
    return [timelineItem({
      kind: "system",
      roleLabel: "工具输出",
      timestamp,
      body: summary.text,
      source: "response_item",
      sourceType: rawType,
      lineNumber,
      truncated: summary.truncated,
    })];
  }

  if (type === "reasoning" || type === "compaction" || type === "contextcompaction") {
    return [];
  }

  return [unsupportedItem(rawType, lineNumber, timestamp)];
}

function extractTimelineItems(
  record: Record<string, unknown>,
  lineNumber: number,
  historyMode: ThreadHistoryMode,
): TimelineItem[] {
  const rawOuterType = typeof record.type === "string" ? record.type : "unknown";
  const outerType = normalizeType(rawOuterType);

  if (outerType === "eventmsg") {
    const payload = (record.payload as Record<string, unknown> | undefined) ?? {};
    const rawEventType = typeof payload.type === "string" ? payload.type : "unknown";
    const eventType = normalizeType(rawEventType);
    if (eventType === "itemcompleted") return parseCompletedItem(record, payload, lineNumber);
    if (historyMode === "paginated") return [];

    const timestamp = itemTimestamp(record);
    if (eventType === "usermessage" && typeof payload.message === "string" && payload.message.trim()) {
      return [timelineItem({
        kind: "user",
        roleLabel: "用户",
        timestamp,
        body: payload.message.trim(),
        source: "event_msg",
        sourceType: rawEventType,
        lineNumber,
      })];
    }
    if (eventType === "agentmessage" && typeof payload.message === "string" && payload.message.trim()) {
      return [timelineItem({
        kind: "assistant",
        roleLabel: "助手",
        timestamp,
        body: payload.message.trim(),
        source: "event_msg",
        sourceType: rawEventType,
        lineNumber,
      })];
    }
    return KNOWN_NON_SEMANTIC_EVENT_TYPES.has(eventType)
      ? []
      : [unsupportedItem(rawEventType, lineNumber, timestamp)];
  }

  if (outerType === "responseitem") {
    if (historyMode === "paginated") return [];
    return parseResponseItem(
      record,
      (record.payload as Record<string, unknown> | undefined) ?? {},
      lineNumber,
    );
  }

  if (KNOWN_NON_SEMANTIC_OUTER_TYPES.has(outerType)) return [];
  return [unsupportedItem(rawOuterType, lineNumber, itemTimestamp(record))];
}

function dedupeTimeline(items: TimelineItem[]): TimelineItem[] {
  const results: TimelineItem[] = [];
  for (const item of items) {
    const previous = results.at(-1);
    if (
      !item.parseError && !item.unsupported && previous &&
      !previous.parseError && !previous.unsupported &&
      previous.kind === item.kind &&
      normalizeTimelineBody(previous.body) === normalizeTimelineBody(item.body)
    ) {
      continue;
    }
    results.push(item);
  }
  return results;
}

function historyItems(session: SessionEntry): TimelineItem[] {
  return session.historyPreview.map((body, index) => timelineItem({
    kind: "user",
    roleLabel: `历史输入 ${index + 1}`,
    timestamp: null,
    body,
    source: "history",
    sourceType: "history_preview",
  }));
}

function getPrimaryFileTarget(session: SessionEntry): SessionFileTarget | null {
  if (!session.fileTargets.length) return null;
  return (
    session.fileTargets.find((target) => target.bucket === "sessions" && !target.compressed) ??
    session.fileTargets.find((target) => !target.compressed) ??
    null
  );
}

function historyModeFromRecords(
  records: Array<{ parsed: Record<string, unknown>; lineNumber: number }>,
  fallback: ThreadHistoryMode,
): ThreadHistoryMode {
  for (const { parsed } of records) {
    if (normalizeType(parsed.type) !== "sessionmeta") continue;
    const value = (parsed.payload as Record<string, unknown> | undefined)?.history_mode;
    if (value === "legacy" || value === "paginated") return value;
    if (value !== null && value !== undefined) return "unknown";
  }
  return fallback;
}

function diagnosticReason(parseErrors: number, unsupportedItems: number): string | null {
  const reasons: string[] = [];
  if (parseErrors) reasons.push(`${parseErrors} parse error${parseErrors === 1 ? "" : "s"}`);
  if (unsupportedItems) reasons.push(`${unsupportedItems} unsupported item${unsupportedItems === 1 ? "" : "s"}`);
  return reasons.length ? reasons.join("; ") : null;
}

export async function readSessionTimelineResult(
  session: SessionEntry,
  rootPath?: string,
): Promise<SessionTimelineResult> {
  const primaryFile = getPrimaryFileTarget(session);
  const exactExportAvailable = session.fileTargets.length > 0;

  if (!primaryFile) {
    const items = historyItems(session);
    const compressedUnread = session.fileTargets.some((target) => target.compressed);
    return {
      historyMode: session.historyMode,
      items,
      completeness: compressedUnread ? "compressed_unread" : "complete",
      itemsReturned: items.length,
      itemsKnown: compressedUnread ? null : items.length,
      omittedReason: compressedUnread ? "compressed rollout cannot be read as semantic timeline" : null,
      exactExportAvailable,
      unsupportedItemCount: 0,
      parseErrorCount: 0,
      toolOutputTruncatedCount: 0,
    };
  }

  const relativeParts = primaryFile.relativePath.split(/[\\/]+/u).filter(Boolean);
  const inferredRoot = path.resolve(primaryFile.absolutePath, ...relativeParts.map(() => ".."));
  const trustedRoot = await createTrustedRootContext(rootPath ?? inferredRoot);
  const text = await readManagedText(trustedRoot, primaryFile.relativePath);
  const records: Array<{ parsed: Record<string, unknown>; lineNumber: number }> = [];
  const diagnostics: TimelineItem[] = [];

  text.split(/\r?\n/u).forEach((line, index) => {
    if (!line.trim()) return;
    const lineNumber = index + 1;
    const parsed = safeJsonParse<Record<string, unknown>>(line);
    if (!parsed) diagnostics.push(parseErrorItem(lineNumber));
    else records.push({ parsed, lineNumber });
  });

  const historyMode = historyModeFromRecords(records, session.historyMode);
  if (historyMode === "unknown") {
    diagnostics.unshift(unsupportedItem("history_mode", 1, null));
  }
  const parsedItems = records.flatMap(({ parsed, lineNumber }) =>
    extractTimelineItems(parsed, lineNumber, historyMode),
  );
  let items = dedupeTimeline([...parsedItems, ...diagnostics].sort((a, b) =>
    (a.lineNumber ?? Number.MAX_SAFE_INTEGER) - (b.lineNumber ?? Number.MAX_SAFE_INTEGER),
  ));
  const semanticItems = items.filter((item) => !item.parseError && !item.unsupported);
  if (!semanticItems.length && session.historyPreview.length) {
    items = [...historyItems(session), ...items];
  }

  const parseErrorCount = items.filter((item) => item.parseError).length;
  const unsupportedItemCount = items.filter((item) => item.unsupported).length;
  const completeness = parseErrorCount > 0
    ? "parse_error"
    : unsupportedItemCount > 0
      ? "unsupported_items"
      : "complete";

  return {
    historyMode,
    items,
    completeness,
    itemsReturned: items.length,
    itemsKnown: items.length,
    omittedReason: diagnosticReason(parseErrorCount, unsupportedItemCount),
    exactExportAvailable,
    unsupportedItemCount,
    parseErrorCount,
    toolOutputTruncatedCount: items.filter((item) => item.truncated).length,
  };
}

export async function readSessionTimeline(session: SessionEntry, rootPath?: string): Promise<TimelineItem[]> {
  const result = await readSessionTimelineResult(session, rootPath);
  return result.items.filter((item) => !item.parseError && !item.unsupported);
}
