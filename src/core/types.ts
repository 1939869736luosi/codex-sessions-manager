export type SessionKind = "active" | "archived" | "db-only" | "stale";

export interface CodexRootPaths {
  rootPath: string;
  sessionsDir: string;
  archivedDir: string | null;
  sessionIndexPath: string | null;
  historyPath: string | null;
  sqlitePath: string | null;
  logsSqlitePath: string | null;
  globalStatePath: string | null;
  shellSnapshotsDir: string | null;
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

export interface ShellSnapshotFile {
  id: string;
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
  projectPath: string | null;
  projectName: string;
  projectKey: string;
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

export interface GlobalStateReference {
  sessionId: string;
  path: string;
  kind: "array-value" | "object-key" | "object-string-value";
  value: unknown;
}

export interface GlobalStateScanData {
  path: string | null;
  text: string | null;
  refsById: Map<string, GlobalStateReference[]>;
  possibleUnknownRefsById: Map<string, GlobalStateReference[]>;
  warning: string | null;
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

export interface ShellSnapshotsScanData {
  dir: string | null;
  filesById: Map<string, ShellSnapshotFile[]>;
}

export interface ScanResult {
  root: CodexRootPaths;
  sessions: SessionEntry[];
  sessionIndex: SessionIndexData;
  history: HistoryData;
  sqlite: SqliteScanData;
  globalState: GlobalStateScanData;
  shellSnapshots: ShellSnapshotsScanData;
  warnings: string[];
}

export interface ProjectSummary {
  projectKey: string;
  projectName: string;
  projectPath: string | null;
  sessionCount: number;
  activeCount: number;
  archivedCount: number;
  dbOnlyCount: number;
  staleCount: number;
  latestUpdatedAt: string | null;
  totalFileSize: number;
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
  shellSnapshotFiles: string[];
  globalStateRefs: number;
  possibleUnknownGlobalStateRefs: number;
  possibleUnknownGlobalStateRefPaths: string[];
  sessionIndexRows: number;
  historyRows: number;
  sqlite: SqliteDeletionCounts;
}

export interface DeletePreview {
  items: DeletePreviewItem[];
  totals: {
    sessionFiles: number;
    shellSnapshotFiles: number;
    globalStateRefs: number;
    possibleUnknownGlobalStateRefs: number;
    sessionIndexRows: number;
    historyRows: number;
    sqliteRows: number;
  };
}

export interface DeleteValidationItem {
  sessionId: string;
  title: string;
  filePathsRemaining: string[];
  shellSnapshotFilesRemaining: string[];
  globalStateRefsRemaining: number;
  possibleUnknownGlobalStateRefsRemaining: number;
  possibleUnknownGlobalStateRefPaths: string[];
  globalStateWarning: string | null;
  warnings: string[];
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
  globalStateRefs: GlobalStateReference[];
  shellSnapshots: Array<{
    path: string;
    text: string;
  }>;
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

export interface TrashSessionManifest {
  sessionId: string;
  title: string;
  cwd: string | null;
  model: string | null;
  rolloutPath: string | null;
  projectPath: string | null;
  projectName: string;
  projectKey: string;
  originalRelativePaths: string[];
  shellSnapshotRelativePaths: string[];
}

export interface TrashManifest {
  trashId: string;
  createdAt: string;
  rootPath: string;
  toolVersion: string;
  sessionIds: string[];
  sessions: TrashSessionManifest[];
  preview: DeletePreview;
}

export interface TrashBundle {
  manifest: TrashManifest;
  sessionFiles: Array<{
    sessionId: string;
    path: string;
    text: string;
  }>;
  shellSnapshots: Array<{
    sessionId: string;
    path: string;
    text: string;
  }>;
  sessionIndexRecords: SessionIndexRecord[];
  historyRecords: HistoryRecord[];
  globalStateRefs: GlobalStateReference[];
  sqlite: {
    state: {
      threads: Record<string, unknown>[];
      logs: Record<string, unknown>[];
      threadSpawnEdges: Record<string, unknown>[];
      agentJobItems: Record<string, unknown>[];
      threadDynamicTools: Record<string, unknown>[];
      stage1Outputs: Record<string, unknown>[];
      threadGoals: Record<string, unknown>[];
    };
    dedicatedLogs: Record<string, unknown>[];
  };
}

export interface TrashEntrySummary {
  trashId: string;
  createdAt: string;
  rootPath: string;
  sessionIds: string[];
  sessions: TrashSessionManifest[];
}

export interface TrashDeleteResult {
  trashEntry: TrashEntrySummary;
  deletion: DeleteExecutionResult;
}

export interface TrashRestoreResult {
  trashEntry: TrashEntrySummary;
  restoredSessionIds: string[];
  restoredSessionFiles: number;
  restoredShellSnapshots: number;
  restoredSessionIndexRecords: number;
  restoredHistoryRecords: number;
  restoredGlobalStateRefs: number;
  restoredSqliteRows: {
    total: number;
    threads: number;
    logs: number;
    threadSpawnEdges: number;
    agentJobItems: number;
    threadDynamicTools: number;
    stage1Outputs: number;
    threadGoals: number;
    dedicatedLogs: number;
  };
  skippedSqliteRows: {
    total: number;
    threads: number;
    logs: number;
    threadSpawnEdges: number;
    agentJobItems: number;
    threadDynamicTools: number;
    stage1Outputs: number;
    threadGoals: number;
    dedicatedLogs: number;
  };
  skippedSqliteTables: string[];
  warnings: string[];
}

export interface TrashPurgeResult {
  trashEntry: TrashEntrySummary;
  purged: boolean;
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

export interface SqliteTableInspection {
  table: string;
  exists: boolean;
  columns: string[];
  associationColumns: string[];
}

export interface DoctorReport {
  rootPath: string;
  paths: {
    sessionsDir: { path: string; exists: boolean; readable: boolean };
    archivedSessionsDir: { path: string; exists: boolean; readable: boolean };
    sessionIndex: { path: string; exists: boolean; readable: boolean };
    history: { path: string; exists: boolean; readable: boolean };
    globalState: { path: string; exists: boolean; readable: boolean; parseable: boolean | null };
    shellSnapshotsDir: { path: string; exists: boolean; readable: boolean };
    trashDir: { path: string; exists: boolean; readable: boolean; entryCount: number };
  };
  sqlite: {
    stateCandidates: string[];
    activeStatePath: string | null;
    logsCandidates: string[];
    activeLogsPath: string | null;
    stateTables: SqliteTableInspection[];
    logsTables: SqliteTableInspection[];
    warnings: string[];
  };
  globalState: {
    knownRefs: Array<{ sessionId: string; path: string; kind: GlobalStateReference["kind"] }>;
    possibleUnknownRefs: Array<{ sessionId: string; path: string; kind: GlobalStateReference["kind"] }>;
    warnings: string[];
  };
  scan: {
    sessionCount: number | null;
    warnings: string[];
  };
  warnings: string[];
}
