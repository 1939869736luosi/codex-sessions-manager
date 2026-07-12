import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { constants as fsConstants, createWriteStream } from "node:fs";
import type { BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";

import { expandCodexPath } from "./root.js";

export const CANONICAL_SESSION_EVENT_VERSION = "codex-session-event.v1" as const;
const PAGE_CURSOR_VERSION = "codex-session-event-cursor.v2" as const;
const CURSOR_HMAC_KEY = randomBytes(32);
const CURSOR_BOUNDARY_WINDOW_BYTES = 64;
const CONTENT_VERSION_SAMPLE_BYTES = 4096;
const MAX_CURSOR_LENGTH = 16_384;
export const MAX_CANONICAL_EVENT_PAGE_SIZE = 100;
export const MAX_CANONICAL_EVENT_PAGE_BYTES = 240 * 1024;

export type LineTerminator = "lf" | "crlf" | "none";

export interface CanonicalEventSource {
  path: string;
  lineNumber: number;
  recordOrdinal: number;
  byteStart: number;
  byteEnd: number;
  lineTerminator: LineTerminator;
  rawLineSha256: string;
}

interface CanonicalEventBase {
  schemaVersion: typeof CANONICAL_SESSION_EVENT_VERSION;
  sessionId: string;
  timestamp: string | null;
  recordType: string | null;
  payloadType: string | null;
  source: CanonicalEventSource;
}

export interface CanonicalContentPart {
  type: string;
  text?: string;
}

export interface CanonicalMessageEvent extends CanonicalEventBase {
  eventType: "message";
  role: string | null;
  content: CanonicalContentPart[];
}

export interface CanonicalToolCallEvent extends CanonicalEventBase {
  eventType: "tool_call";
  callId: string | null;
  name: string | null;
  arguments: unknown;
}

export interface CanonicalToolOutputEvent extends CanonicalEventBase {
  eventType: "tool_output";
  callId: string | null;
  output: unknown;
}

export interface CanonicalRecordEvent extends CanonicalEventBase {
  eventType: "record";
}

export interface CanonicalParseErrorEvent extends CanonicalEventBase {
  eventType: "parse_error";
  error: {
    code: "invalid_json";
    message: "Line is not valid JSON.";
  };
}

export type CanonicalSessionEvent =
  | CanonicalMessageEvent
  | CanonicalToolCallEvent
  | CanonicalToolOutputEvent
  | CanonicalRecordEvent
  | CanonicalParseErrorEvent;

interface RawPhysicalLine {
  contentBytes: Buffer;
  lineNumber: number;
  recordOrdinal: number;
  isBlank: boolean;
  byteStart: number;
  byteEnd: number;
  lineTerminator: LineTerminator;
}

interface RawLineStreamOptions {
  startByteOffset?: number;
  startLineNumber?: number;
  startRecordOrdinal?: number;
  endByteOffset?: number;
}

export interface ResolvedSessionEventSource {
  sessionId: string;
  rootPath: string;
  rootRealpath: string;
  filePath: string;
  fileRealpath: string;
  sourcePath: string;
}

export type StreamCanonicalSessionEventsOptions = ResolvedSessionEventSource;

interface FileIdentity {
  dev: string;
  ino: string;
  mode: string;
  nlink: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}

interface PageCursorPayload {
  version: typeof PAGE_CURSOR_VERSION;
  sessionId: string;
  rootBindingSha256: string;
  fileBindingSha256: string;
  sourcePath: string;
  fileIdentity: FileIdentity;
  contentVersion: string;
  nextByteOffset: number;
  nextLineNumber: number;
  recordOrdinal: number;
  boundarySha256: string;
}

export interface ReadCanonicalSessionEventPageOptions extends ResolvedSessionEventSource {
  limit?: number;
  cursor?: string;
}

export interface CanonicalSessionEventPage {
  schemaVersion: typeof CANONICAL_SESSION_EVENT_VERSION;
  sessionId: string;
  sourcePath: string;
  events: CanonicalSessionEvent[];
  nextCursor: string | null;
  done: boolean;
  excludedReasoningCount: number;
  omittedOversizedEventCount: number;
  completeness: "complete" | "truncated_limit";
  omittedReason: string | null;
  responseByteLimit: number;
}

export interface CanonicalSessionEventFileResult {
  schemaVersion: typeof CANONICAL_SESSION_EVENT_VERSION;
  sessionId: string;
  sourcePath: string;
  outputPath: string;
  eventCount: number;
}

interface OpenVerifiedSource {
  handle: FileHandle;
  identity: FileIdentity;
  contentVersion: string;
  fileSize: number;
}

function isPathInside(rootRealpath: string, candidateRealpath: string): boolean {
  const relative = path.relative(rootRealpath, candidateRealpath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertExactSessionId(sessionId: string): string {
  const normalized = sessionId.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(normalized)) {
    throw new Error("Canonical event export requires a complete exact session id; prefixes are refused.");
  }
  return normalized;
}

function sessionFileKind(fileName: string, sessionId: string): "jsonl" | "compressed" | null {
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`(?:^|-)${escaped}\\.jsonl$`, "i").test(fileName)) {
    return "jsonl";
  }
  if (new RegExp(`(?:^|-)${escaped}\\.jsonl\\.zst$`, "i").test(fileName)) {
    return "compressed";
  }
  return null;
}

async function lstatIfPresent(directoryPath: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function collectExactRolloutCandidates(
  directoryPath: string,
  sessionId: string,
  results: { jsonl: string[]; compressed: string[]; symlinks: string[] },
): Promise<void> {
  const directoryStats = await lstat(directoryPath);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error(`Canonical event rollout directory cannot be a symbolic link: ${directoryPath}`);
  }
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    const kind = sessionFileKind(entry.name, sessionId);

    if (entry.isSymbolicLink()) {
      if (kind) {
        results.symlinks.push(entryPath);
      }
      continue;
    }
    if (entry.isDirectory()) {
      await collectExactRolloutCandidates(entryPath, sessionId, results);
      continue;
    }
    if (!entry.isFile() || !kind) {
      continue;
    }
    results[kind].push(entryPath);
  }
}

async function assertNoSymlinkBelowRoot(rootRealpath: string, filePath: string): Promise<void> {
  if (!isPathInside(rootRealpath, filePath)) {
    throw new Error("Canonical event rollout resolves outside the selected Codex root.");
  }
  const relative = path.relative(rootRealpath, filePath);
  let current = rootRealpath;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`Canonical event rollout path contains a symbolic link: ${current}`);
    }
  }
}

export async function resolveExactSessionEventSource(
  rootArg: string | undefined,
  requestedSessionId: string,
): Promise<ResolvedSessionEventSource> {
  const sessionId = assertExactSessionId(requestedSessionId);
  const rootPath = path.resolve(expandCodexPath(rootArg?.trim() || "~/.codex"));
  const rootRealpath = await realpath(rootPath);
  const rootStats = await lstat(rootRealpath);
  if (!rootStats.isDirectory()) {
    throw new Error(`Not a Codex root directory: ${rootPath}`);
  }

  const sessionsDir = path.join(rootRealpath, "sessions");
  const sessionsStats = await lstat(sessionsDir);
  if (!sessionsStats.isDirectory() || sessionsStats.isSymbolicLink()) {
    throw new Error("Codex sessions directory must be a real directory, not a symbolic link.");
  }

  const results = { jsonl: [] as string[], compressed: [] as string[], symlinks: [] as string[] };
  await collectExactRolloutCandidates(sessionsDir, sessionId, results);

  const archivedDir = path.join(rootRealpath, "archived_sessions");
  const archivedStats = await lstatIfPresent(archivedDir);
  if (archivedStats) {
    if (!archivedStats.isDirectory() || archivedStats.isSymbolicLink()) {
      throw new Error("Codex archived_sessions directory must be a real directory, not a symbolic link.");
    }
    await collectExactRolloutCandidates(archivedDir, sessionId, results);
  }

  if (results.symlinks.length > 0) {
    throw new Error(`Canonical event rollout cannot be a symbolic link: ${results.symlinks[0]}`);
  }
  if (results.jsonl.length > 1) {
    throw new Error(`Session ${sessionId} has multiple JSONL rollout files; explicit source disambiguation is required.`);
  }
  if (results.jsonl.length === 0) {
    if (results.compressed.length > 0) {
      throw new Error(`Session ${sessionId} only has compressed rollout files; canonical event streaming requires JSONL.`);
    }
    throw new Error(`Session not found or has no readable JSONL rollout: ${sessionId}`);
  }

  const filePath = results.jsonl[0];
  await assertNoSymlinkBelowRoot(rootRealpath, filePath);
  const fileStats = await lstat(filePath);
  if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
    throw new Error("Canonical event rollout must be a regular non-symlink file.");
  }
  if (fileStats.nlink > 1) {
    throw new Error("Canonical event rollout must not have multiple hard links.");
  }
  const fileRealpath = await realpath(filePath);
  if (!isPathInside(rootRealpath, fileRealpath)) {
    throw new Error("Canonical event rollout resolves outside the selected Codex root.");
  }

  return {
    sessionId,
    rootPath,
    rootRealpath,
    filePath,
    fileRealpath,
    sourcePath: path.relative(rootRealpath, fileRealpath),
  };
}

function identityFromStats(stats: BigIntStats): FileIdentity {
  return {
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    mode: stats.mode.toString(),
    nlink: stats.nlink.toString(),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
    ctimeNs: stats.ctimeNs.toString(),
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function hashBinding(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function buildContentVersion(
  handle: FileHandle,
  identity: FileIdentity,
  fileSize: number,
): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify(identity));
  const starts = new Set([
    0,
    Math.max(0, Math.floor(fileSize / 2) - Math.floor(CONTENT_VERSION_SAMPLE_BYTES / 2)),
    Math.max(0, fileSize - CONTENT_VERSION_SAMPLE_BYTES),
  ]);
  for (const start of [...starts].sort((left, right) => left - right)) {
    const length = Math.min(CONTENT_VERSION_SAMPLE_BYTES, Math.max(0, fileSize - start));
    const bytes = await readExactRange(handle, start, length);
    hash.update(`${start}:${bytes.length}:`).update(bytes);
  }
  return hash.digest("hex");
}

function fileSizeAsNumber(identity: FileIdentity): number {
  const size = Number(identity.size);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error("Canonical event rollout is too large for safe byte addressing.");
  }
  return size;
}

async function verifyResolvedPath(
  source: ResolvedSessionEventSource,
  expectedIdentity?: FileIdentity,
): Promise<FileIdentity> {
  const currentRootRealpath = await realpath(source.rootPath);
  if (currentRootRealpath !== source.rootRealpath) {
    throw new Error("Canonical event root identity changed; resolve the session again.");
  }
  await assertNoSymlinkBelowRoot(source.rootRealpath, source.filePath);
  const pathStats = await lstat(source.filePath, { bigint: true });
  if (!pathStats.isFile() || pathStats.isSymbolicLink()) {
    throw new Error("Canonical event rollout must remain a regular non-symlink file.");
  }
  if (pathStats.nlink > 1n) {
    throw new Error("Canonical event rollout must not have multiple hard links.");
  }
  const currentFileRealpath = await realpath(source.filePath);
  if (currentFileRealpath !== source.fileRealpath || !isPathInside(source.rootRealpath, currentFileRealpath)) {
    throw new Error("Canonical event rollout path identity changed or left the selected root.");
  }
  const identity = identityFromStats(pathStats);
  if (expectedIdentity && !sameIdentity(identity, expectedIdentity)) {
    throw new Error("Canonical event source identity or content version changed during reading.");
  }
  return identity;
}

async function openVerifiedSource(source: ResolvedSessionEventSource): Promise<OpenVerifiedSource> {
  const pathIdentity = await verifyResolvedPath(source);
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(source.filePath, fsConstants.O_RDONLY | noFollow);

  try {
    const handleStats = await handle.stat({ bigint: true });
    if (!handleStats.isFile()) {
      throw new Error("Canonical event source file descriptor is not a regular file.");
    }
    if (handleStats.nlink > 1n) {
      throw new Error("Canonical event rollout must not have multiple hard links.");
    }
    const identity = identityFromStats(handleStats);
    if (!sameIdentity(identity, pathIdentity)) {
      throw new Error("Canonical event rollout changed between path validation and open.");
    }
    const fileSize = fileSizeAsNumber(identity);
    return {
      handle,
      identity,
      contentVersion: await buildContentVersion(handle, identity, fileSize),
      fileSize,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function verifyOpenSourceUnchanged(
  source: ResolvedSessionEventSource,
  opened: OpenVerifiedSource,
): Promise<void> {
  const handleIdentity = identityFromStats(await opened.handle.stat({ bigint: true }));
  if (!sameIdentity(handleIdentity, opened.identity)) {
    throw new Error("Canonical event source content changed while it was being read.");
  }
  const contentVersion = await buildContentVersion(opened.handle, handleIdentity, opened.fileSize);
  if (contentVersion !== opened.contentVersion) {
    throw new Error("Canonical event source sampled content version changed while it was being read.");
  }
  await verifyResolvedPath(source, opened.identity);
}

function isWhitespaceOnly(bytes: Buffer): boolean {
  for (const byte of bytes) {
    if (byte !== 0x20 && byte !== 0x09) {
      return false;
    }
  }
  return true;
}

function splitLineContent(rawBytes: Buffer, hasLf: boolean): { contentBytes: Buffer; lineTerminator: LineTerminator } {
  if (!hasLf) {
    return { contentBytes: rawBytes, lineTerminator: "none" };
  }
  if (rawBytes.length > 0 && rawBytes[rawBytes.length - 1] === 0x0d) {
    return { contentBytes: rawBytes.subarray(0, rawBytes.length - 1), lineTerminator: "crlf" };
  }
  return { contentBytes: rawBytes, lineTerminator: "lf" };
}

async function* streamRawJsonLines(
  handle: FileHandle,
  options: RawLineStreamOptions = {},
): AsyncGenerator<RawPhysicalLine> {
  const startByteOffset = options.startByteOffset ?? 0;
  let lineNumber = options.startLineNumber ?? 1;
  let recordOrdinal = options.startRecordOrdinal ?? 0;
  let absoluteOffset = startByteOffset;
  let lineStart = startByteOffset;
  let lineLength = 0;
  let lineParts: Buffer[] = [];
  let readPosition = startByteOffset;
  const endByteOffset = options.endByteOffset ?? Number.MAX_SAFE_INTEGER;

  while (readPosition < endByteOffset) {
    const readBuffer = Buffer.allocUnsafe(Math.min(64 * 1024, endByteOffset - readPosition));
    const { bytesRead } = await handle.read(readBuffer, 0, readBuffer.length, readPosition);
    if (bytesRead === 0) {
      break;
    }
    const chunk = readBuffer.subarray(0, bytesRead);
    let segmentStart = 0;

    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) {
        continue;
      }
      const segment = chunk.subarray(segmentStart, index);
      if (segment.length > 0) {
        lineParts.push(segment);
        lineLength += segment.length;
      }
      const rawBytes = lineLength === 0 ? Buffer.alloc(0) : Buffer.concat(lineParts, lineLength);
      const { contentBytes, lineTerminator } = splitLineContent(rawBytes, true);
      const isBlank = contentBytes.length === 0 || isWhitespaceOnly(contentBytes);
      if (!isBlank) {
        recordOrdinal += 1;
      }
      const byteEnd = absoluteOffset + index + 1;
      yield {
        contentBytes,
        lineNumber,
        recordOrdinal,
        isBlank,
        byteStart: lineStart,
        byteEnd,
        lineTerminator,
      };
      lineNumber += 1;
      lineStart = byteEnd;
      lineLength = 0;
      lineParts = [];
      segmentStart = index + 1;
    }

    const tail = chunk.subarray(segmentStart);
    if (tail.length > 0) {
      lineParts.push(tail);
      lineLength += tail.length;
    }
    absoluteOffset += chunk.length;
    readPosition += bytesRead;
  }

  if (lineLength > 0) {
    const rawBytes = Buffer.concat(lineParts, lineLength);
    const { contentBytes, lineTerminator } = splitLineContent(rawBytes, false);
    const isBlank = contentBytes.length === 0 || isWhitespaceOnly(contentBytes);
    if (!isBlank) {
      recordOrdinal += 1;
    }
    yield {
      contentBytes,
      lineNumber,
      recordOrdinal,
      isBlank,
      byteStart: lineStart,
      byteEnd: absoluteOffset,
      lineTerminator,
    };
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const INTERNAL_REASONING_TYPES = new Set([
  "reasoning",
  "agent_reasoning",
  "agent_reasoning_raw_content",
  "assistant_reasoning",
]);

function isInternalReasoningType(value: string | null): boolean {
  return Boolean(value && INTERNAL_REASONING_TYPES.has(value.toLowerCase()));
}

function normalizeEventType(value: string | null): string {
  return value?.replace(/[^a-z0-9]/giu, "").toLowerCase() ?? "";
}

function normalizeContent(content: unknown): CanonicalContentPart[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const parts: CanonicalContentPart[] = [];
  for (const item of content) {
    const object = readObject(item);
    const itemType = readString(object?.type) ?? "unknown";
    const normalizedItemType = normalizeEventType(itemType);
    if (isInternalReasoningType(itemType)) {
      continue;
    }
    const text = readString(object?.text);
    if (normalizedItemType === "inputtext" || normalizedItemType === "outputtext" || normalizedItemType === "text") {
      parts.push(text === null ? { type: itemType } : { type: itemType, text });
      continue;
    }
    parts.push({ type: itemType });
  }
  return parts;
}

function makeSource(raw: RawPhysicalLine, sourcePath: string): CanonicalEventSource {
  return {
    path: sourcePath,
    lineNumber: raw.lineNumber,
    recordOrdinal: raw.recordOrdinal,
    byteStart: raw.byteStart,
    byteEnd: raw.byteEnd,
    lineTerminator: raw.lineTerminator,
    rawLineSha256: createHash("sha256").update(raw.contentBytes).digest("hex"),
  };
}

function canonicalizeRawLine(
  raw: RawPhysicalLine,
  options: StreamCanonicalSessionEventsOptions,
): { event: CanonicalSessionEvent | null; excludedReasoning: boolean } {
  const source = makeSource(raw, options.sourcePath);
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw.contentBytes.toString("utf8")) as unknown;
  } catch {
    return {
      excludedReasoning: false,
      event: {
        schemaVersion: CANONICAL_SESSION_EVENT_VERSION,
        eventType: "parse_error",
        sessionId: options.sessionId,
        timestamp: null,
        recordType: null,
        payloadType: null,
        source,
        error: { code: "invalid_json", message: "Line is not valid JSON." },
      },
    };
  }

  const record = readObject(parsed);
  const recordType = readString(record?.type);
  const payload = readObject(record?.payload);
  const payloadType = readString(payload?.type);
  const completedAtMs = Number(payload?.completed_at_ms);
  const timestamp = readString(record?.timestamp)
    ?? (Number.isFinite(completedAtMs) && completedAtMs > 0 ? new Date(completedAtMs).toISOString() : null);
  const base: CanonicalEventBase = {
    schemaVersion: CANONICAL_SESSION_EVENT_VERSION,
    sessionId: options.sessionId,
    timestamp,
    recordType,
    payloadType,
    source,
  };

  if (isInternalReasoningType(recordType) || isInternalReasoningType(payloadType)) {
    return { event: null, excludedReasoning: true };
  }

  if (recordType === "event_msg" && payload) {
    const role =
      payloadType === "user_message"
        ? "user"
        : payloadType === "agent_message"
          ? "assistant"
          : payloadType === "system_message"
            ? "system"
            : null;
    const message = readString(payload.message);
    if (role && message !== null) {
      return {
        excludedReasoning: false,
        event: { ...base, eventType: "message", role, content: [{ type: "text", text: message }] },
      };
    }
  }

  if (recordType === "event_msg" && payloadType === "item_completed" && payload) {
    const item = readObject(payload.item);
    const itemType = readString(item?.type);
    const normalizedItemType = normalizeEventType(itemType);
    if (normalizedItemType === "reasoning") {
      return { event: null, excludedReasoning: true };
    }
    const role = normalizedItemType === "usermessage"
      ? "user"
      : normalizedItemType === "agentmessage"
        ? "assistant"
        : null;
    if (role && item) {
      return {
        excludedReasoning: false,
        event: {
          ...base,
          eventType: "message",
          role,
          content: normalizeContent(item.content),
        },
      };
    }
  }

  if (recordType === "response_item" && payloadType === "message" && payload) {
    return {
      excludedReasoning: false,
      event: {
        ...base,
        eventType: "message",
        role: readString(payload.role),
        content: normalizeContent(payload.content),
      },
    };
  }

  if (recordType === "response_item" && payload) {
    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      return {
        excludedReasoning: false,
        event: {
          ...base,
          eventType: "tool_call",
          callId: readString(payload.call_id) ?? readString(payload.id),
          name: readString(payload.name),
          arguments: payload.arguments ?? payload.input ?? null,
        },
      };
    }
    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      return {
        excludedReasoning: false,
        event: {
          ...base,
          eventType: "tool_output",
          callId: readString(payload.call_id) ?? readString(payload.id),
          output: payload.output ?? payload.result ?? null,
        },
      };
    }
    if (payloadType === "web_search_call") {
      return {
        excludedReasoning: false,
        event: {
          ...base,
          eventType: "tool_call",
          callId: readString(payload.call_id) ?? readString(payload.id),
          name: "web_search",
          arguments: payload.action ?? null,
        },
      };
    }
    if (payloadType === "tool_search_call") {
      return {
        excludedReasoning: false,
        event: {
          ...base,
          eventType: "tool_call",
          callId: readString(payload.call_id) ?? readString(payload.id),
          name: "tool_search",
          arguments: payload.arguments ?? null,
        },
      };
    }
    if (payloadType === "tool_search_output") {
      return {
        excludedReasoning: false,
        event: {
          ...base,
          eventType: "tool_output",
          callId: readString(payload.call_id) ?? readString(payload.id),
          output: payload.tools ?? null,
        },
      };
    }
  }

  return { excludedReasoning: false, event: { ...base, eventType: "record" } };
}

export async function* streamCanonicalSessionEvents(
  options: StreamCanonicalSessionEventsOptions,
): AsyncGenerator<CanonicalSessionEvent> {
  const opened = await openVerifiedSource(options);
  try {
    for await (const raw of streamRawJsonLines(opened.handle, { endByteOffset: opened.fileSize })) {
      if (raw.isBlank) {
        continue;
      }
      const result = canonicalizeRawLine(raw, options);
      if (result.event) {
        yield result.event;
      }
    }
    await verifyOpenSourceUnchanged(options, opened);
  } finally {
    await opened.handle.close();
  }
}

function encodeCursor(payload: PageCursorPayload): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const mac = createHmac("sha256", CURSOR_HMAC_KEY).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${mac}`;
}

function decodeCursor(cursor: string): PageCursorPayload {
  if (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    throw new Error("Invalid canonical event cursor.");
  }
  const parts = cursor.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error("Invalid canonical event cursor.");
  }
  const expectedMac = createHmac("sha256", CURSOR_HMAC_KEY).update(parts[0]).digest();
  let providedMac: Buffer;
  try {
    providedMac = Buffer.from(parts[1], "base64url");
  } catch {
    throw new Error("Invalid canonical event cursor.");
  }
  if (providedMac.length !== expectedMac.length || !timingSafeEqual(providedMac, expectedMac)) {
    throw new Error("Invalid canonical event cursor authentication.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as unknown;
  } catch {
    throw new Error("Invalid canonical event cursor.");
  }
  const value = readObject(parsed);
  const identity = readObject(value?.fileIdentity);
  if (
    value?.version !== PAGE_CURSOR_VERSION ||
    typeof value.sessionId !== "string" ||
    typeof value.rootBindingSha256 !== "string" ||
    typeof value.fileBindingSha256 !== "string" ||
    typeof value.sourcePath !== "string" ||
    typeof value.contentVersion !== "string" ||
    !Number.isInteger(value.nextByteOffset) ||
    !Number.isInteger(value.nextLineNumber) ||
    !Number.isInteger(value.recordOrdinal) ||
    typeof value.boundarySha256 !== "string" ||
    typeof identity?.dev !== "string" ||
    typeof identity.ino !== "string" ||
    typeof identity.mode !== "string" ||
    typeof identity.nlink !== "string" ||
    typeof identity.size !== "string" ||
    typeof identity.mtimeNs !== "string" ||
    typeof identity.ctimeNs !== "string"
  ) {
    throw new Error("Invalid canonical event cursor.");
  }
  return value as unknown as PageCursorPayload;
}

function validatePageLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CANONICAL_EVENT_PAGE_SIZE) {
    throw new Error(`Canonical event page limit must be an integer from 1 to ${MAX_CANONICAL_EVENT_PAGE_SIZE}.`);
  }
  return limit;
}

async function readExactRange(handle: FileHandle, start: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let total = 0;
  while (total < length) {
    const result = await handle.read(buffer, total, length - total, start + total);
    if (result.bytesRead === 0) {
      break;
    }
    total += result.bytesRead;
  }
  return buffer.subarray(0, total);
}

async function assertRealLineBoundary(handle: FileHandle, offset: number, fileSize: number): Promise<void> {
  if (offset < 0 || offset > fileSize) {
    throw new Error("Invalid canonical event cursor position.");
  }
  if (offset === 0 || offset === fileSize) {
    return;
  }
  const previous = await readExactRange(handle, offset - 1, 1);
  if (previous.length !== 1 || previous[0] !== 0x0a) {
    throw new Error("Canonical event cursor offset is not a real JSONL line boundary.");
  }
}

async function buildBoundaryEvidence(handle: FileHandle, offset: number, fileSize: number): Promise<string> {
  await assertRealLineBoundary(handle, offset, fileSize);
  const start = Math.max(0, offset - CURSOR_BOUNDARY_WINDOW_BYTES);
  const end = Math.min(fileSize, offset + CURSOR_BOUNDARY_WINDOW_BYTES);
  const bytes = await readExactRange(handle, start, end - start);
  return createHash("sha256")
    .update(`${start}:${offset}:${end}:`)
    .update(bytes)
    .digest("hex");
}

function validateCursorBinding(
  cursor: PageCursorPayload,
  options: ReadCanonicalSessionEventPageOptions,
  opened: OpenVerifiedSource,
): void {
  if (
    cursor.sessionId !== options.sessionId ||
    cursor.rootBindingSha256 !== hashBinding(options.rootRealpath) ||
    cursor.fileBindingSha256 !== hashBinding(options.fileRealpath) ||
    cursor.sourcePath !== options.sourcePath
  ) {
    throw new Error("Canonical event cursor does not match the requested root, session, or source file.");
  }
  if (!sameIdentity(cursor.fileIdentity, opened.identity) || cursor.contentVersion !== opened.contentVersion) {
    throw new Error("Canonical event source identity or content version changed after the cursor was created.");
  }
  if (cursor.nextLineNumber < 1 || cursor.recordOrdinal < 0) {
    throw new Error("Invalid canonical event cursor position.");
  }
}

export async function readCanonicalSessionEventPage(
  options: ReadCanonicalSessionEventPageOptions,
): Promise<CanonicalSessionEventPage> {
  const limit = validatePageLimit(options.limit ?? 50);
  const opened = await openVerifiedSource(options);

  try {
    let nextByteOffset = 0;
    let nextLineNumber = 1;
    let recordOrdinal = 0;
    if (options.cursor !== undefined) {
      const cursor = decodeCursor(options.cursor);
      validateCursorBinding(cursor, options, opened);
      await assertRealLineBoundary(opened.handle, cursor.nextByteOffset, opened.fileSize);
      const boundary = await buildBoundaryEvidence(opened.handle, cursor.nextByteOffset, opened.fileSize);
      if (boundary !== cursor.boundarySha256) {
        throw new Error("Canonical event cursor boundary evidence no longer matches the source.");
      }
      nextByteOffset = cursor.nextByteOffset;
      nextLineNumber = cursor.nextLineNumber;
      recordOrdinal = cursor.recordOrdinal;
    }

    const events: CanonicalSessionEvent[] = [];
    let excludedReasoningCount = 0;
    let omittedOversizedEventCount = 0;
    let eventBytes = 2;
    let byteLimited = false;
    let processedByteOffset = nextByteOffset;
    let processedNextLineNumber = nextLineNumber;
    let processedRecordOrdinal = recordOrdinal;

    for await (const raw of streamRawJsonLines(opened.handle, {
      startByteOffset: nextByteOffset,
      startLineNumber: nextLineNumber,
      startRecordOrdinal: recordOrdinal,
      endByteOffset: opened.fileSize,
    })) {
      const markProcessed = () => {
        processedByteOffset = raw.byteEnd;
        processedNextLineNumber = raw.lineNumber + 1;
        processedRecordOrdinal = raw.recordOrdinal;
      };
      if (raw.isBlank) {
        markProcessed();
        continue;
      }
      const result = canonicalizeRawLine(raw, options);
      if (result.excludedReasoning) {
        excludedReasoningCount += 1;
        markProcessed();
        continue;
      }
      if (result.event) {
        const serializedBytes = Buffer.byteLength(JSON.stringify(result.event), "utf8") + (events.length > 0 ? 1 : 0);
        if (eventBytes + serializedBytes > MAX_CANONICAL_EVENT_PAGE_BYTES) {
          byteLimited = true;
          if (events.length > 0) {
            break;
          }
          omittedOversizedEventCount += 1;
          markProcessed();
          continue;
        }
        events.push(result.event);
        eventBytes += serializedBytes;
      }
      markProcessed();
      if (events.length >= limit) {
        break;
      }
    }

    const done = processedByteOffset >= opened.fileSize;
    if (!done && processedByteOffset <= nextByteOffset) {
      throw new Error("Canonical event pagination made no forward progress.");
    }
    const boundarySha256 = done
      ? null
      : await buildBoundaryEvidence(opened.handle, processedByteOffset, opened.fileSize);
    await verifyOpenSourceUnchanged(options, opened);
    const nextCursor = done
      ? null
      : encodeCursor({
          version: PAGE_CURSOR_VERSION,
          sessionId: options.sessionId,
          rootBindingSha256: hashBinding(options.rootRealpath),
          fileBindingSha256: hashBinding(options.fileRealpath),
          sourcePath: options.sourcePath,
          fileIdentity: opened.identity,
          contentVersion: opened.contentVersion,
          nextByteOffset: processedByteOffset,
          nextLineNumber: processedNextLineNumber,
          recordOrdinal: processedRecordOrdinal,
          boundarySha256: boundarySha256 as string,
        });

    const itemLimited = !done && events.length >= limit;
    const completeness = done && omittedOversizedEventCount === 0 ? "complete" : "truncated_limit";
    const omittedReason = omittedOversizedEventCount > 0
      ? `${omittedOversizedEventCount} event(s) exceeded the MCP byte limit; use CLI events or --output for complete tool data`
      : byteLimited
        ? `MCP event page byte limit (${MAX_CANONICAL_EVENT_PAGE_BYTES}); continue with nextCursor or use CLI events`
        : itemLimited
          ? `MCP event page item limit (${limit}); continue with nextCursor or use CLI events`
          : null;

    return {
      schemaVersion: CANONICAL_SESSION_EVENT_VERSION,
      sessionId: options.sessionId,
      sourcePath: options.sourcePath,
      events,
      nextCursor,
      done,
      excludedReasoningCount,
      omittedOversizedEventCount,
      completeness,
      omittedReason,
      responseByteLimit: MAX_CANONICAL_EVENT_PAGE_BYTES,
    };
  } finally {
    await opened.handle.close();
  }
}

async function writeChunk(output: ReturnType<typeof createWriteStream>, chunk: string): Promise<void> {
  if (!output.write(chunk, "utf8")) {
    await once(output, "drain");
  }
}

export async function writeCanonicalSessionEventsFile(
  options: StreamCanonicalSessionEventsOptions,
  outputPath: string,
): Promise<CanonicalSessionEventFileResult> {
  const resolvedOutputPath = path.resolve(outputPath);
  await mkdir(path.dirname(resolvedOutputPath), { recursive: true, mode: 0o700 });
  const output = createWriteStream(resolvedOutputPath, { flags: "wx", encoding: "utf8", mode: 0o600 });
  let opened = false;
  let eventCount = 0;

  try {
    await once(output, "open");
    opened = true;
    for await (const event of streamCanonicalSessionEvents(options)) {
      await writeChunk(output, `${JSON.stringify(event)}\n`);
      eventCount += 1;
    }
    output.end();
    await once(output, "finish");
  } catch (error) {
    output.destroy();
    if (opened) {
      await rm(resolvedOutputPath, { force: true });
    }
    throw error;
  }

  return {
    schemaVersion: CANONICAL_SESSION_EVENT_VERSION,
    sessionId: options.sessionId,
    sourcePath: options.sourcePath,
    outputPath: resolvedOutputPath,
    eventCount,
  };
}
