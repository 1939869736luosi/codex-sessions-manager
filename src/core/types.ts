export type SessionKind = "active" | "archived" | "db-only" | "stale";

export interface CodexRootPaths {
  rootPath: string;
  sessionsDir: string;
  archivedDir: string | null;
  sessionIndexPath: string | null;
  historyPath: string | null;
  sqlitePath: string | null;
  logsSqlitePath: string | null;
}

export interface SessionIndexRecord {
  id: string;
  thread_name?: string;
  updated_at?: string;
}

export interface HistoryRecord {
  session_id: string;
  ts?: number;
  text?: string;
}

export interface ThreadRow {
  id: string;
  title: string;
  firstUserMessage: string;
  createdAt: number | null;
  updatedAt: number | null;
  archived: boolean;
  rolloutPath: string | null;
  model: string | null;
  cwd: string | null;
}

export interface SessionFileTarget {
  id: string;
  bucket: "sessions" | "archived_sessions";
  absolutePath: string;
  relativePath: string;
  fileName: string;
  size: number;
  lastModified: number | null;
}

export interface SessionEntry {
  id: string;
  title: string;
  kind: SessionKind;
  archived: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  model: string | null;
  cwd: string | null;
  rolloutPath: string | null;
  previewSummary: string;
  historyPreview: string[];
  totalFileSize: number;
  fileTargets: SessionFileTarget[];
  hasThread: boolean;
  hasSessionIndex: boolean;
  hasHistory: boolean;
  sessionIndexCount: number;
  historyCount: number;
  thread: ThreadRow | null;
}

export interface SessionIndexData {
  text: string | null;
  latestById: Map<string, SessionIndexRecord>;
  lineCountById: Map<string, number>;
  matchingRecordsById: Map<string, SessionIndexRecord[]>;
}

export interface HistoryData {
  text: string | null;
  previewById: Map<string, string[]>;
  lineCountById: Map<string, number>;
  matchingRecordsById: Map<string, HistoryRecord[]>;
}

export interface SqliteScanData {
  sqlitePath: string | null;
  threadsById: Map<string, ThreadRow>;
  warning: string | null;
}

export interface ScanResult {
  root: CodexRootPaths;
  sessions: SessionEntry[];
  sessionIndex: SessionIndexData;
  history: HistoryData;
  sqlite: SqliteScanData;
  warnings: string[];
}

export interface TimelineItem {
  kind: "user" | "assistant" | "system";
  roleLabel: string;
  timestamp: string | null;
  body: string;
}

export interface SqliteDeletionCounts {
  threadRows: number;
  logRows: number;
  spawnEdgeRows: number;
  assignedAgentJobs: number;
  dynamicToolRows: number;
  stage1Rows: number;
  threadGoalRows: number;
}

export interface DeletePreviewItem {
  sessionId: string;
  title: string;
  archived: boolean;
  filePaths: string[];
  sessionIndexRows: number;
  historyRows: number;
  sqlite: SqliteDeletionCounts;
}

export interface DeletePreview {
  items: DeletePreviewItem[];
  totals: {
    sessionFiles: number;
    sessionIndexRows: number;
    historyRows: number;
    sqliteRows: number;
  };
}

export interface DeleteValidationItem {
  sessionId: string;
  title: string;
  filePathsRemaining: string[];
  sessionIndexRowsRemaining: number;
  historyRowsRemaining: number;
  sqlite: SqliteDeletionCounts;
}

export interface DeleteExecutionResult {
  preview: DeletePreview;
  validation: DeleteValidationItem[];
}

export interface BackupManifest {
  exportedAt: string;
  sessionId: string;
  title: string;
  archived: boolean;
  rolloutPath: string | null;
  cwd: string | null;
  model: string | null;
}

export interface BackupBundle {
  manifest: BackupManifest;
  sessionFiles: Array<{
    path: string;
    text: string;
  }>;
  sessionIndexRecords: SessionIndexRecord[];
  historyRecords: HistoryRecord[];
  sqlite: {
    threads: Record<string, unknown>[];
    logs: Record<string, unknown>[];
    threadSpawnEdges: Record<string, unknown>[];
    agentJobItems: Record<string, unknown>[];
    threadDynamicTools: Record<string, unknown>[];
    stage1Outputs: Record<string, unknown>[];
    threadGoals: Record<string, unknown>[];
  };
}

export interface CleanupResult {
  staleSessionIds: string[];
  removedSessionIndexRows: number;
  removedHistoryRows: number;
}

export interface SessionIndexCleanupResult {
  sessionIds: string[];
  removedSessionIndexRows: number;
  removedHistoryRows: number;
}
