export type SessionKind = "active" | "archived" | "db-only" | "stale";
export type SourceKind = "subagent" | "mcp" | "vscode" | "cli" | "exec" | "unknown";

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
  modelProvider: string | null;
  cwd: string | null;
  sourceKind: SourceKind;
  source: string | null;
  threadSource: string | null;
  agentRole: string | null;
  agentNickname: string | null;
  agentPath: string | null;
}

export interface ThreadSpawnEdgeRow {
  parentThreadId: string;
  childThreadId: string;
  status: string | null;
  metadata: Record<string, unknown>;
}

export type SessionTitleSource = "session_index" | "sqlite" | "first_user_message" | "id";

export interface SessionTitleCandidate {
  source: SessionTitleSource;
  title: string;
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
  displayTitle: string;
  indexTitle: string | null;
  sqliteTitle: string | null;
  firstUserMessage: string | null;
  titleSource: SessionTitleSource;
  titleMismatch: boolean;
  titleCandidates: SessionTitleCandidate[];
  title: string;
  kind: SessionKind;
  archived: boolean;
  projectPath: string | null;
  projectName: string;
  projectKey: string;
  createdAt: string | null;
  updatedAt: string | null;
  model: string | null;
  modelProvider: string | null;
  cwd: string | null;
  rolloutPath: string | null;
  sourceKind: SourceKind;
  source: string | null;
  threadSource: string | null;
  agentRole: string | null;
  agentNickname: string | null;
  agentPath: string | null;
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
  threadSpawnEdges: ThreadSpawnEdgeRow[];
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

export interface SourceSummaryRow {
  sourceKind: SourceKind;
  source: string | null;
  threadSource: string | null;
  modelProvider: string | null;
  model: string | null;
  agentRole: string | null;
  count: number;
  latestUpdatedAt: string | null;
}

export interface SourceSummary {
  totalSessions: number;
  bySourceKind: Record<SourceKind, number>;
  rows: SourceSummaryRow[];
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

export type SessionFamilyRelationship =
  | "self"
  | "root"
  | "parent"
  | "child"
  | "ancestor"
  | "descendant"
  | "sibling"
  | "related";

export type SessionFamilyEdgeStatus = "open" | "closed" | "other" | "none";

export type SessionFamilyChildCategory = "subagent" | "side/fork" | "mcp" | "exec" | "vscode" | "cli" | "unknown";

export type SessionFamilyMode = "full" | "children" | "parents" | "subagents" | "impact";

export interface SessionFamilyMissingRelationGroups {
  missingParents: SessionFamilyBrokenRelation[];
  missingChildren: SessionFamilyBrokenRelation[];
}

export interface SessionFamilyMissingSurfaceGroups {
  missingFileSessionIds: string[];
  missingSessionIndexIds: string[];
  missingThreadIds: string[];
}

export interface SessionFamilyNode {
  sessionId: string;
  displayTitle: string;
  kind: SessionKind;
  relationship: SessionFamilyRelationship;
  relationshipStatus: string | null;
  edgeStatus: SessionFamilyEdgeStatus;
  parentEdgeStatus: string | null;
  archived: boolean;
  updatedAt: string | null;
  fileExists: boolean;
  fileCount: number;
  hasSessionIndex: boolean;
  sessionIndexCount: number;
  hasHistory: boolean;
  historyCount: number;
  hasThread: boolean;
  sourceKind: SourceKind;
  source: string | null;
  sourceLabel: string;
  threadSource: string | null;
  agentRole: string | null;
  agentNickname: string | null;
  agentPath: string | null;
  childCategory: SessionFamilyChildCategory;
  childType: SessionFamilyChildCategory;
  childTypeLabels: SessionFamilyChildCategory[];
  relationshipLabels: string[];
  parentIds: string[];
  childIds: string[];
  edge: ThreadSpawnEdgeRow | null;
}

export interface SessionFamilyBrokenRelation {
  parentThreadId: string;
  childThreadId: string;
  status: string | null;
  missingParentSession: boolean;
  missingChildSession: boolean;
  parentMissingSurfaces: string[];
  childMissingSurfaces: string[];
  warnings: string[];
}

export interface SessionFamily {
  current: SessionFamilyNode;
  root: SessionFamilyNode;
  parent: SessionFamilyNode | null;
  parents: SessionFamilyNode[];
  directChildren: SessionFamilyNode[];
  ancestors: SessionFamilyNode[];
  descendants: SessionFamilyNode[];
  siblings: SessionFamilyNode[];
  familyMembers: SessionFamilyNode[];
  childrenByCategory: Record<SessionFamilyChildCategory, SessionFamilyNode[]>;
  edges: ThreadSpawnEdgeRow[];
  brokenRelations: SessionFamilyBrokenRelation[];
  missingRelations: SessionFamilyMissingRelationGroups;
  missingSurfaces: SessionFamilyMissingSurfaceGroups;
  warnings: string[];
}

export interface DeleteFamilyWarning {
  sessionId: string;
  unselectedParentIds: string[];
  unselectedChildIds: string[];
  unselectedFamilyMemberIds: string[];
  unselectedRelatedSessionIds: string[];
  missingParentIds: string[];
  missingChildIds: string[];
  brokenRelations: SessionFamilyBrokenRelation[];
  warnings: string[];
}

export interface SessionFamilyMissingSurfaceWarning {
  sessionId: string;
  role: "parent" | "child" | "family";
  missingSurfaces: string[];
  edgeStatus: string | null;
}

export interface SessionFamilyImpact {
  readOnly: true;
  targetSessionId: string;
  selectedSessionIds: string[];
  unselectedParentIds: string[];
  unselectedChildIds: string[];
  unselectedFamilyMemberIds: string[];
  unselectedRelatedSessionIds: string[];
  missingParentIds: string[];
  missingChildIds: string[];
  missingFileSessionIds: string[];
  missingSessionIndexIds: string[];
  missingThreadIds: string[];
  missingSurfaceWarnings: SessionFamilyMissingSurfaceWarning[];
  missingRelations: SessionFamilyMissingRelationGroups;
  missingSurfaces: SessionFamilyMissingSurfaceGroups;
  brokenRelations: SessionFamilyBrokenRelation[];
  warnings: string[];
}

export interface SessionFamilyQuery {
  mode: SessionFamilyMode;
  sourceKinds: SourceKind[];
  family: SessionFamily;
  nodes: SessionFamilyNode[];
  childrenByCategory: Record<SessionFamilyChildCategory, SessionFamilyNode[]>;
  impact: SessionFamilyImpact | null;
  readOnly: true;
}

export type SessionResidueAuditStatus =
  | "absent"
  | "clean"
  | "present"
  | "partial"
  | "broken-family"
  | "risky-global-state"
  | "db-only"
  | "index-only";

export interface SessionResidueSurface {
  present: boolean;
  count: number;
}

export interface SessionResiduePathSurface extends SessionResidueSurface {
  paths: string[];
}

export interface SessionResidueSqliteSurface extends SessionResidueSurface {
  rows: number;
  counts: SqliteDeletionCounts;
  hasThread: boolean;
  archived: boolean;
}

export interface SessionResidueThreadSpawnSurface extends SessionResidueSurface {
  asParent: number;
  asChild: number;
  edges: Array<{
    parentThreadId: string;
    childThreadId: string;
    status: string | null;
  }>;
}

export interface SessionResidueAudit {
  sessionId: string;
  title: string;
  displayTitle: string;
  knownLocally: boolean;
  rootPath: string;
  overallStatus: SessionResidueAuditStatus[];
  currentState: {
    kind: SessionKind | "clean" | "absent";
    archived: boolean;
    hasOriginalRollout: boolean;
    message: string;
  };
  surfaces: {
    rolloutFiles: SessionResiduePathSurface & { buckets: SessionFileTarget["bucket"][] };
    shellSnapshots: SessionResiduePathSurface;
    sessionIndex: SessionResidueSurface;
    history: SessionResidueSurface;
    sqlite: SessionResidueSqliteSurface;
    globalStateKnown: SessionResiduePathSurface;
    globalStateUnknown: SessionResiduePathSurface;
    threadSpawnEdges: SessionResidueThreadSpawnSurface;
  };
  counts: {
    rawSessionFiles: number;
    shellSnapshotFiles: number;
    sessionIndexRows: number;
    historyRows: number;
    sqliteRows: number;
    knownGlobalStateRefs: number;
    possibleUnknownGlobalStateRefs: number;
    threadSpawnEdges: number;
    familyMembers: number;
    brokenRelations: number;
  };
  familySummary: {
    isFamilyMember: boolean;
    rootId: string;
    parentIds: string[];
    childIds: string[];
    familyMemberIds: string[];
    edgeCount: number;
    brokenRelationCount: number;
  };
  brokenRelations: SessionFamilyBrokenRelation[];
  warnings: string[];
  recommendedNextCommand: string | null;
  recommendedNextCommandNote: string | null;
}

export type RootResidueCandidateStatus =
  | SessionResidueAuditStatus
  | "partial-residue"
  | "global-state-unknown"
  | "shell-snapshot-residue"
  | "index-residue"
  | "sqlite-residue"
  | "missing-parent-edge"
  | "missing-child-edge";

export type RootResidueCandidateSource =
  | "rollout_files"
  | "shell_snapshots"
  | "session_index"
  | "history"
  | "sqlite"
  | "global_state_known"
  | "global_state_unknown"
  | "thread_spawn_edges";

export interface RootResidueSurfaceSummary {
  rolloutFiles: number;
  shellSnapshots: number;
  sessionIndexRows: number;
  historyRows: number;
  sqliteRows: number;
  knownGlobalStateRefs: number;
  possibleUnknownGlobalStateRefs: number;
  threadSpawnEdges: number;
}

export interface RootResidueFamilySummary {
  isFamilyMember: boolean;
  brokenFamily: boolean;
  rootId: string;
  parentIds: string[];
  childIds: string[];
  familyMemberCount: number;
  brokenRelationCount: number;
}

export interface RootResidueCandidate {
  sessionId: string;
  statuses: RootResidueCandidateStatus[];
  sources: RootResidueCandidateSource[];
  surfaces: RootResidueSurfaceSummary;
  family: RootResidueFamilySummary;
  warnings: string[];
  recommendedAuditCommand: string;
}

export interface RootResidueFilters {
  statuses: RootResidueCandidateStatus[];
  sources: RootResidueCandidateSource[];
  includeAll: boolean;
}

export interface RootResidueAudit {
  rootPath: string;
  safetyNotice: string;
  filters: RootResidueFilters;
  totalCandidatesBeforeFilter: number;
  totalCandidatesAfterFilter: number;
  totalCandidates: number;
  returnedCandidates: number;
  limit: number;
  byStatus: Record<string, number>;
  bySource: Record<string, number>;
  candidates: RootResidueCandidate[];
  warnings: string[];
}

export interface RootDeletePreviewCounts {
  rolloutFiles: number;
  shellSnapshots: number;
  sessionIndexRows: number;
  historyRows: number;
  sqliteRows: number;
  knownGlobalStateRefs: number;
  possibleUnknownGlobalStateRefs: number;
  threadSpawnEdges: number;
}

export interface RootDeletePreviewFamilyWarningSummary {
  candidatesWithFamilyWarnings: number;
  unselectedParentIds: string[];
  unselectedChildIds: string[];
  unselectedFamilyMemberIds: string[];
  missingParentIds: string[];
  missingChildIds: string[];
  brokenRelationCount: number;
  warningCount: number;
  warnings: string[];
}

export interface RootDeletePreviewCandidate {
  sessionId: string;
  statuses: RootResidueCandidateStatus[];
  sources: RootResidueCandidateSource[];
  previewCounts: RootDeletePreviewCounts;
  familyWarnings: DeleteFamilyWarning[];
  recommendedAuditCommand: string;
  previewOnlyCommand: string;
  recommendedPreviewCommand: string;
}

export interface RootDeletePreview {
  rootPath: string;
  safetyNotice: string;
  filters: RootResidueFilters;
  totalCandidatesBeforeFilter: number;
  totalCandidatesAfterFilter: number;
  previewedCandidates: number;
  omittedCandidates: number;
  limit: number;
  aggregatePreview: RootDeletePreviewCounts;
  familyWarningSummary: RootDeletePreviewFamilyWarningSummary;
  candidates: RootDeletePreviewCandidate[];
  warnings: string[];
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
  familyWarnings: DeleteFamilyWarning[];
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

export interface TrashDuplicateSessionSummary {
  sessionId: string;
  count: number;
  trashIds: string[];
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
