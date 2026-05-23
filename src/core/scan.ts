import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";

import { safeJsonParse, splitJsonLines } from "./jsonl.js";
import {
  collectExactKeyGlobalStateReferences,
  collectGlobalStateReferences,
  collectPossibleUnknownGlobalStateReferences,
} from "./global-state.js";
import { deriveProjectIdentity } from "./project.js";
import { resolveCodexRoot } from "./root.js";
import { scanShellSnapshots } from "./shell-snapshots.js";
import { scanThreadSpawnEdges, scanThreads } from "./sqlite.js";
import type {
  GlobalStateReference,
  HistoryData,
  HistoryRecord,
  ScanResult,
  SessionEntry,
  SessionFileTarget,
  SessionIndexData,
  SessionIndexRecord,
  SessionTitleCandidate,
  SessionTitleSource,
} from "./types.js";

async function readOptionalText(filePath: string | null): Promise<string | null> {
  if (!filePath) {
    return null;
  }

  return readFile(filePath, "utf8");
}

async function* walkDirectory(directoryPath: string): AsyncGenerator<string> {
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const nextPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      yield* walkDirectory(nextPath);
      continue;
    }

    yield nextPath;
  }
}

function extractSessionId(fileName: string): string | null {
  const match = fileName.match(/([0-9a-f]{8,}-[0-9a-f-]{20,})\.jsonl$/i);
  return match?.[1] ?? null;
}

async function scanSessionDirectory(
  directoryPath: string | null,
  bucket: "sessions" | "archived_sessions",
  rootPath: string,
): Promise<Map<string, SessionFileTarget[]>> {
  const byId = new Map<string, SessionFileTarget[]>();

  if (!directoryPath) {
    return byId;
  }

  for await (const absolutePath of walkDirectory(directoryPath)) {
    if (!absolutePath.endsWith(".jsonl")) {
      continue;
    }

    const fileName = path.basename(absolutePath);
    const sessionId = extractSessionId(fileName);

    if (!sessionId) {
      continue;
    }

    const fileStat = await stat(absolutePath);
    const target: SessionFileTarget = {
      id: sessionId,
      bucket,
      absolutePath,
      relativePath: path.relative(rootPath, absolutePath),
      fileName,
      size: fileStat.size,
      lastModified: fileStat.mtimeMs,
    };

    const existing = byId.get(sessionId) ?? [];
    existing.push(target);
    byId.set(sessionId, existing);
  }

  return byId;
}

function parseSessionIndex(text: string | null): SessionIndexData {
  const latestById = new Map<string, SessionIndexRecord>();
  const lineCountById = new Map<string, number>();
  const matchingRecordsById = new Map<string, SessionIndexRecord[]>();

  if (!text) {
    return { text, latestById, lineCountById, matchingRecordsById };
  }

  for (const line of splitJsonLines(text)) {
    const record = safeJsonParse<SessionIndexRecord>(line);

    if (!record?.id) {
      continue;
    }

    lineCountById.set(record.id, (lineCountById.get(record.id) ?? 0) + 1);
    const matching = matchingRecordsById.get(record.id) ?? [];
    matching.push(record);
    matchingRecordsById.set(record.id, matching);

    const previous = latestById.get(record.id);
    const previousTime = previous?.updated_at ? new Date(previous.updated_at).getTime() : 0;
    const nextTime = record.updated_at ? new Date(record.updated_at).getTime() : 0;

    if (!previous || nextTime >= previousTime) {
      latestById.set(record.id, record);
    }
  }

  return { text, latestById, lineCountById, matchingRecordsById };
}

function parseHistory(text: string | null): HistoryData {
  const previewById = new Map<string, string[]>();
  const lineCountById = new Map<string, number>();
  const matchingRecordsById = new Map<string, HistoryRecord[]>();

  if (!text) {
    return { text, previewById, lineCountById, matchingRecordsById };
  }

  for (const line of splitJsonLines(text)) {
    const record = safeJsonParse<HistoryRecord>(line);

    if (!record?.session_id) {
      continue;
    }

    lineCountById.set(record.session_id, (lineCountById.get(record.session_id) ?? 0) + 1);
    const matching = matchingRecordsById.get(record.session_id) ?? [];
    matching.push(record);
    matchingRecordsById.set(record.session_id, matching);

    if (typeof record.text === "string" && record.text.trim()) {
      const preview = previewById.get(record.session_id) ?? [];

      if (preview.length < 3) {
        preview.push(record.text.trim());
        previewById.set(record.session_id, preview);
      }
    }
  }

  return { text, previewById, lineCountById, matchingRecordsById };
}

function formatIsoFromUnix(seconds: number | null): string | null {
  if (!seconds) {
    return null;
  }

  return new Date(seconds * 1000).toISOString();
}

function buildPreviewSummary(historyPreview: string[], firstUserMessage: string, fileTargets: SessionFileTarget[]): string {
  if (historyPreview.length > 0) {
    return historyPreview[0];
  }

  if (firstUserMessage.trim()) {
    return firstUserMessage.trim();
  }

  if (fileTargets.length > 0) {
    return fileTargets[0].relativePath;
  }

  return "无摘要";
}

function chooseSessionKind(hasFile: boolean, archived: boolean, hasThread: boolean): SessionEntry["kind"] {
  if (hasFile) {
    return archived ? "archived" : "active";
  }

  if (hasThread) {
    return "db-only";
  }

  return "stale";
}

function normalizeTitle(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function buildTitleMetadata(
  id: string,
  indexRecord: SessionIndexRecord | undefined,
  thread: ScanResult["sqlite"]["threadsById"] extends Map<string, infer T> ? T | undefined : never,
): Pick<
  SessionEntry,
  | "displayTitle"
  | "indexTitle"
  | "sqliteTitle"
  | "firstUserMessage"
  | "titleSource"
  | "titleMismatch"
  | "titleCandidates"
  | "title"
> {
  const indexTitle = normalizeTitle(indexRecord?.thread_name);
  const sqliteTitle = normalizeTitle(thread?.title);
  const firstUserMessage = normalizeTitle(thread?.firstUserMessage);
  const candidates: SessionTitleCandidate[] = [
    indexTitle ? { source: "session_index", title: indexTitle } : null,
    sqliteTitle ? { source: "sqlite", title: sqliteTitle } : null,
    firstUserMessage ? { source: "first_user_message", title: firstUserMessage } : null,
    { source: "id", title: id },
  ].filter((candidate): candidate is SessionTitleCandidate => Boolean(candidate));
  const preferred = candidates[0] ?? ({ source: "id", title: id } satisfies SessionTitleCandidate);
  const titleMismatch = Boolean(indexTitle && sqliteTitle && indexTitle !== sqliteTitle);

  return {
    displayTitle: preferred.title,
    indexTitle,
    sqliteTitle,
    firstUserMessage,
    titleSource: preferred.source as SessionTitleSource,
    titleMismatch,
    titleCandidates: candidates,
    title: preferred.title,
  };
}

function buildSession(
  id: string,
  fileTargets: SessionFileTarget[],
  sessionIndex: SessionIndexData,
  history: HistoryData,
  thread: ScanResult["sqlite"]["threadsById"] extends Map<string, infer T> ? T | undefined : never,
): SessionEntry {
  const indexRecord = sessionIndex.latestById.get(id);
  const historyPreview = history.previewById.get(id) ?? [];
  const totalFileSize = fileTargets.reduce((sum, target) => sum + target.size, 0);
  const archived = Boolean(
    thread?.archived ||
      (fileTargets.length > 0 && fileTargets.every((target) => target.bucket === "archived_sessions")) ||
      thread?.rolloutPath?.includes("/archived_sessions/"),
  );
  const titleMetadata = buildTitleMetadata(id, indexRecord, thread);
  const createdAt = formatIsoFromUnix(thread?.createdAt ?? null);
  const updatedAt =
    formatIsoFromUnix(thread?.updatedAt ?? null) ||
    indexRecord?.updated_at ||
    (fileTargets[0]?.lastModified ? new Date(fileTargets[0].lastModified).toISOString() : null);
  const hasFile = fileTargets.length > 0;
  const hasThread = Boolean(thread);
  const kind = chooseSessionKind(hasFile, archived, hasThread);
  const previewSummary = buildPreviewSummary(historyPreview, thread?.firstUserMessage ?? "", fileTargets);
  const project = deriveProjectIdentity({
    cwd: thread?.cwd ?? null,
    rolloutPath: thread?.rolloutPath ?? null,
    fileTargets,
  });

  return {
    id,
    ...titleMetadata,
    kind,
    archived,
    projectPath: project.projectPath,
    projectName: project.projectName,
    projectKey: project.projectKey,
    createdAt,
    updatedAt,
    model: thread?.model ?? null,
    modelProvider: thread?.modelProvider ?? null,
    cwd: thread?.cwd ?? null,
    rolloutPath: thread?.rolloutPath ?? null,
    sourceKind: thread?.sourceKind ?? "unknown",
    source: thread?.source ?? null,
    threadSource: thread?.threadSource ?? null,
    agentRole: thread?.agentRole ?? null,
    agentNickname: thread?.agentNickname ?? null,
    agentPath: thread?.agentPath ?? null,
    previewSummary,
    historyPreview,
    totalFileSize,
    fileTargets,
    hasThread,
    hasSessionIndex: sessionIndex.latestById.has(id),
    hasHistory: history.lineCountById.has(id),
    sessionIndexCount: sessionIndex.lineCountById.get(id) ?? 0,
    historyCount: history.lineCountById.get(id) ?? 0,
    thread: thread ?? null,
  };
}

export async function scanCodexRoot(rootArg?: string): Promise<ScanResult> {
  const root = await resolveCodexRoot(rootArg);
  const warnings: string[] = [];

  const [activeFiles, archivedFiles, sessionIndexText, historyText, shellSnapshotFiles, globalStateText] = await Promise.all([
    scanSessionDirectory(root.sessionsDir, "sessions", root.rootPath),
    scanSessionDirectory(root.archivedDir, "archived_sessions", root.rootPath),
    readOptionalText(root.sessionIndexPath),
    readOptionalText(root.historyPath),
    scanShellSnapshots(root.shellSnapshotsDir, root.rootPath),
    readOptionalText(root.globalStatePath),
  ]);

  const sessionIndex = parseSessionIndex(sessionIndexText);
  const history = parseHistory(historyText);
  let globalStateWarning: string | null = null;
  let globalStateRefsById = new Map<string, GlobalStateReference[]>();
  let exactKeyGlobalStateRefsById = new Map<string, GlobalStateReference[]>();
  let possibleUnknownGlobalStateRefsById = new Map<string, GlobalStateReference[]>();

  try {
    globalStateRefsById = collectGlobalStateReferences(globalStateText);
    exactKeyGlobalStateRefsById = collectExactKeyGlobalStateReferences(globalStateText);
    possibleUnknownGlobalStateRefsById = collectPossibleUnknownGlobalStateReferences(globalStateText);
  } catch (error) {
    const globalStateName = root.globalStatePath ? path.basename(root.globalStatePath) : ".codex-global-state.json";
    globalStateWarning = `读取 ${globalStateName} 失败：${error instanceof Error ? error.message : String(error)}`;
    warnings.push(globalStateWarning);
  }

  let sqliteWarning: string | null = null;
  let threadsById = new Map<string, ScanResult["sqlite"]["threadsById"] extends Map<string, infer T> ? T : never>();
  let threadSpawnEdges: ScanResult["sqlite"]["threadSpawnEdges"] = [];

  try {
    threadsById = scanThreads(root.sqlitePath) as typeof threadsById;
    threadSpawnEdges = scanThreadSpawnEdges(root.sqlitePath);
  } catch (error) {
    const sqliteName = root.sqlitePath ? path.basename(root.sqlitePath) : "SQLite 状态库";
    sqliteWarning = `读取 ${sqliteName} 失败：${error instanceof Error ? error.message : String(error)}`;
    warnings.push(sqliteWarning);
  }

  const ids = new Set<string>();
  for (const key of activeFiles.keys()) ids.add(key);
  for (const key of archivedFiles.keys()) ids.add(key);
  for (const key of sessionIndex.latestById.keys()) ids.add(key);
  for (const key of history.lineCountById.keys()) ids.add(key);
  for (const key of threadsById.keys()) ids.add(key);
  for (const edge of threadSpawnEdges) {
    ids.add(edge.parentThreadId);
    ids.add(edge.childThreadId);
  }

  const sessions = [...ids]
    .map((id) => {
      const fileTargets = [...(activeFiles.get(id) ?? []), ...(archivedFiles.get(id) ?? [])];
      return buildSession(id, fileTargets, sessionIndex, history, threadsById.get(id));
    })
    .sort((left, right) => {
      const rightTime = new Date(right.updatedAt ?? 0).getTime();
      const leftTime = new Date(left.updatedAt ?? 0).getTime();
      return rightTime - leftTime;
    });

  return {
    root,
    sessions,
    sessionIndex,
    history,
    sqlite: {
      sqlitePath: root.sqlitePath,
      threadsById: threadsById as ScanResult["sqlite"]["threadsById"],
      threadSpawnEdges,
      warning: sqliteWarning,
    },
    globalState: {
      path: root.globalStatePath,
      text: globalStateText,
      refsById: globalStateRefsById,
      exactKeyRefsById: exactKeyGlobalStateRefsById,
      possibleUnknownRefsById: possibleUnknownGlobalStateRefsById,
      warning: globalStateWarning,
    },
    shellSnapshots: {
      dir: root.shellSnapshotsDir,
      filesById: shellSnapshotFiles,
    },
    warnings,
  };
}
