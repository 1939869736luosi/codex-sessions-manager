import path from "node:path";
import { lstat, readdir } from "node:fs/promises";

import { safeJsonParse, splitJsonLines } from "./jsonl.js";
import {
  collectExactKeyGlobalStateReferences,
  collectGlobalStateReferences,
  collectPossibleUnknownGlobalStateReferences,
} from "./global-state.js";
import { deriveProjectIdentity } from "./project.js";
import {
  captureManagedPath,
  createTrustedRootContext,
  getRegisteredTrustedRoots,
  isPathSafetyError,
  readManagedText,
  revalidateManagedPath,
  toManagedRelativePath,
  type TrustedRootContext,
} from "./path-safety.js";
import { resolveCodexRoot } from "./root.js";
import { scanShellSnapshots } from "./shell-snapshots.js";
import { deriveSourceInfo } from "./sources.js";
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
  ScanSafetyIssue,
  ScanSurface,
  SessionTitleCandidate,
  SessionTitleSource,
} from "./types.js";

function recordScanSafetyIssue(
  issues: ScanSafetyIssue[],
  surface: ScanSurface,
  error: unknown,
): void {
  if (!isPathSafetyError(error)) return;
  issues.push({
    surface,
    path: error.path,
    code: error.code,
    reason: error.reason,
  });
}

async function readOptionalText(
  filePath: string | null,
  context: TrustedRootContext,
  warnings: string[],
  unsafeSurfaces: ScanSafetyIssue[],
  surface: ScanSurface,
): Promise<string | null> {
  if (!filePath) {
    return null;
  }

  try {
    return await readManagedText(context, toManagedRelativePath(context, filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    if (!isPathSafetyError(error)) throw error;
    warnings.push(error.message);
    recordScanSafetyIssue(unsafeSurfaces, surface, error);
    return null;
  }
}

async function* walkDirectory(
  context: TrustedRootContext,
  relativeDirectoryPath: string,
  warnings: string[],
  unsafeSurfaces: ScanSafetyIssue[],
  surface: ScanSurface,
): AsyncGenerator<{ absolutePath: string; relativePath: string }> {
  let directorySnapshot;
  try {
    directorySnapshot = await captureManagedPath(context, relativeDirectoryPath, {
      expectedKind: "directory",
      allowMissing: false,
    });
  } catch (error) {
    if (!isPathSafetyError(error)) throw error;
    warnings.push(error.message);
    recordScanSafetyIssue(unsafeSurfaces, surface, error);
    return;
  }
  const entries = await readdir(directorySnapshot.absolutePath, { withFileTypes: true });
  await revalidateManagedPath(context, directorySnapshot);

  for (const entry of entries) {
    const relativePath = path.join(relativeDirectoryPath, entry.name);
    let snapshot;
    try {
      snapshot = await captureManagedPath(context, relativePath, { allowMissing: false });
    } catch (error) {
      if (!isPathSafetyError(error)) throw error;
      warnings.push(error.message);
      recordScanSafetyIssue(unsafeSurfaces, surface, error);
      continue;
    }
    if (snapshot.identity?.kind === "directory") {
      yield* walkDirectory(context, relativePath, warnings, unsafeSurfaces, surface);
    } else if (snapshot.identity?.kind === "file") {
      yield { absolutePath: snapshot.absolutePath, relativePath: snapshot.relativePath };
    }
  }
}

function extractSessionId(fileName: string): string | null {
  const match = fileName.match(/([0-9a-f]{8,}-[0-9a-f-]{20,})\.jsonl(?:\.zst)?$/i);
  return match?.[1] ?? null;
}

function getSessionFileFormat(filePath: string): Pick<SessionFileTarget, "format" | "compressed"> | null {
  if (filePath.endsWith(".jsonl.zst")) {
    return { format: "jsonl.zst", compressed: true };
  }

  if (filePath.endsWith(".jsonl")) {
    return { format: "jsonl", compressed: false };
  }

  return null;
}

async function scanSessionDirectory(
  directoryPath: string | null,
  bucket: "sessions" | "archived_sessions",
  context: TrustedRootContext,
  warnings: string[],
  unsafeSurfaces: ScanSafetyIssue[],
): Promise<Map<string, SessionFileTarget[]>> {
  const byId = new Map<string, SessionFileTarget[]>();

  if (!directoryPath) {
    return byId;
  }

  let relativeDirectoryPath: string;
  try {
    relativeDirectoryPath = toManagedRelativePath(context, directoryPath);
  } catch (error) {
    if (!isPathSafetyError(error)) throw error;
    warnings.push(error.message);
    recordScanSafetyIssue(unsafeSurfaces, bucket, error);
    return byId;
  }

  for await (const { absolutePath, relativePath } of walkDirectory(
    context,
    relativeDirectoryPath,
    warnings,
    unsafeSurfaces,
    bucket,
  )) {
    const fileFormat = getSessionFileFormat(absolutePath);
    if (!fileFormat) {
      continue;
    }

    const fileName = path.basename(absolutePath);
    const sessionId = extractSessionId(fileName);

    if (!sessionId) {
      continue;
    }

    const snapshot = await captureManagedPath(context, relativePath, {
      expectedKind: "file",
      allowMissing: false,
    });
    const fileStat = await lstat(snapshot.absolutePath);
    await revalidateManagedPath(context, snapshot);
    const target: SessionFileTarget = {
      id: sessionId,
      bucket,
      ...fileFormat,
      absolutePath: snapshot.absolutePath,
      relativePath: snapshot.relativePath,
      fileName,
      size: fileStat.size,
      lastModified: fileStat.mtimeMs,
      device: fileStat.dev,
      inode: fileStat.ino,
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

function formatIsoFromUnixMillis(milliseconds: number | null): string | null {
  if (!milliseconds) {
    return null;
  }

  return new Date(milliseconds).toISOString();
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
  const createdAt =
    formatIsoFromUnixMillis(thread?.createdAtMs ?? null) ||
    formatIsoFromUnix(thread?.createdAt ?? null);
  const updatedAt =
    formatIsoFromUnixMillis(thread?.updatedAtMs ?? null) ||
    formatIsoFromUnix(thread?.updatedAt ?? null) ||
    indexRecord?.updated_at ||
    (fileTargets[0]?.lastModified ? new Date(fileTargets[0].lastModified).toISOString() : null);
  const recencyAtMs = thread?.recencyAtMs ?? null;
  const recencyAt =
    formatIsoFromUnixMillis(recencyAtMs) ||
    formatIsoFromUnix(thread?.recencyAt ?? null);
  const hasFile = fileTargets.length > 0;
  const hasThread = Boolean(thread);
  const kind = chooseSessionKind(hasFile, archived, hasThread);
  const previewSummary = buildPreviewSummary(historyPreview, thread?.firstUserMessage ?? "", fileTargets);
  const project = deriveProjectIdentity({
    cwd: thread?.cwd ?? null,
    rolloutPath: thread?.rolloutPath ?? null,
    fileTargets,
  });
  const sourceInfo = thread?.sourceInfo ?? deriveSourceInfo({
    source: null,
    threadSource: null,
    agentRole: null,
    agentNickname: null,
    agentPath: null,
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
    recencyAt,
    recencyAtMs,
    historyMode: thread?.historyMode ?? "legacy",
    model: thread?.model ?? null,
    modelProvider: thread?.modelProvider ?? null,
    cwd: thread?.cwd ?? null,
    rolloutPath: thread?.rolloutPath ?? null,
    sourceKind: sourceInfo.sourceKind,
    sourceInfo,
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
  const warnings: string[] = [...root.warnings];
  const unsafeSurfaces: ScanSafetyIssue[] = [...root.unsafeSurfaces];
  const rootContext = getRegisteredTrustedRoots(root)?.root ?? await createTrustedRootContext(root.rootPath);

  const [activeFiles, archivedFiles, sessionIndexText, historyText, shellSnapshotFiles, globalStateText] = await Promise.all([
    scanSessionDirectory(root.sessionsDir, "sessions", rootContext, warnings, unsafeSurfaces),
    scanSessionDirectory(root.archivedDir, "archived_sessions", rootContext, warnings, unsafeSurfaces),
    readOptionalText(root.sessionIndexPath, rootContext, warnings, unsafeSurfaces, "session_index"),
    readOptionalText(root.historyPath, rootContext, warnings, unsafeSurfaces, "history"),
    scanShellSnapshots(root.shellSnapshotsDir, root.rootPath, rootContext, warnings, unsafeSurfaces),
    readOptionalText(root.globalStatePath, rootContext, warnings, unsafeSurfaces, "global_state"),
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
      const rightTime = right.recencyAtMs ?? new Date(right.recencyAt ?? right.updatedAt ?? 0).getTime();
      const leftTime = left.recencyAtMs ?? new Date(left.recencyAt ?? left.updatedAt ?? 0).getTime();
      if (rightTime !== leftTime) return rightTime - leftTime;
      return right.id.localeCompare(left.id);
    });

  return {
    root,
    sessions,
    sessionIndex,
    history,
    sqlite: {
      sqlitePath: root.sqlitePath,
      goalsSqlitePath: root.goalsSqlitePath,
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
    safety: {
      complete: unsafeSurfaces.length === 0,
      unsafeSurfaces,
    },
    warnings: [...new Set(warnings)],
  };
}
