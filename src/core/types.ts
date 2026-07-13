export type SessionKind = "active" | "archived" | "db-only" | "stale";
export type ThreadHistoryMode = "legacy" | "paginated" | "unknown";
export type TimelineCompleteness =
  | "complete"
  | "compressed_unread"
  | "unsupported_items"
  | "parse_error"
  | "truncated_limit";
export type SourceKind = "subagent" | "mcp" | "vscode" | "cli" | "exec" | "unknown";
export type OfficialCodexSourceKind =
  | "cli"
  | "vscode"
  | "exec"
  | "appServer"
  | "subAgent"
  | "subAgentReview"
  | "subAgentCompact"
  | "subAgentThreadSpawn"
  | "subAgentOther"
  | "unknown";
export type ThreadSourceKind = "user" | "subagent" | "memory_consolidation";
export type SourceEvidenceField = "source" | "thread_source" | "agent_role" | "agent_nickname" | "agent_path" | "source_json";
export type SourceInferenceConfidence = "exact" | "derived" | "unknown";

export interface SourceEvidence {
  field: SourceEvidenceField;
  value: string;
  coarseSourceKind: SourceKind;
  officialSourceKind: OfficialCodexSourceKind | null;
  reason: string;
}

export interface SourceInfo {
  sourceKind: SourceKind;
  rawSource: string | null;
  rawThreadSource: string | null;
  officialSourceKind: OfficialCodexSourceKind | null;
  threadSourceKind: ThreadSourceKind | null;
  inferenceConfidence: SourceInferenceConfidence;
  evidence: SourceEvidence[];
}

export interface CodexRootPaths {
  rootPath: string;
  sqliteHomePath: string;
  sqliteHomeSource: "CODEX_SQLITE_HOME" | "config.toml" | "root";
  sqliteHomeTrusted: boolean;
  sqliteHomeConfigPath: string | null;
  sessionsDir: string;
  archivedDir: string | null;
  sessionIndexPath: string | null;
  historyPath: string | null;
  sqlitePath: string | null;
  logsSqlitePath: string | null;
  goalsSqlitePath: string | null;
  memoriesSqlitePath: string | null;
  globalStatePath: string | null;
  shellSnapshotsDir: string | null;
  unsafeSurfaces: ScanSafetyIssue[];
  warnings: string[];
}

export type ScanSurface =
  | "trusted-root"
  | "sessions"
  | "archived_sessions"
  | "shell_snapshots"
  | "session_index"
  | "history"
  | "global_state"
  | "sqlite_home"
  | "sqlite_state"
  | "sqlite_logs"
  | "sqlite_goals"
  | "sqlite_memories";

export interface ScanSafetyIssue {
  surface: ScanSurface;
  path: string;
  code: "UNSAFE_PATH" | "STALE_PLAN";
  reason: string;
}

export interface ScanSafetyState {
  complete: boolean;
  unsafeSurfaces: ScanSafetyIssue[];
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
  createdAtMs: number | null;
  updatedAtMs: number | null;
  recencyAt: number | null;
  recencyAtMs: number | null;
  historyMode: ThreadHistoryMode;
  memoryMode: string | null;
  archived: boolean;
  rolloutPath: string | null;
  model: string | null;
  modelProvider: string | null;
  cwd: string | null;
  sourceKind: SourceKind;
  sourceInfo: SourceInfo;
  source: string | null;
  threadSource: string | null;
  agentRole: string | null;
  agentNickname: string | null;
  agentPath: string | null;
}

export type MemoryPhase2Influence = "known" | "none" | "unknown";
export type MemorySchemaStatus = "absent" | "recognized" | "unrecognized";

export interface SessionMemoryLink {
  enabled: boolean | "unknown";
  stage1Present: boolean;
  rolloutSummaryPresent: boolean;
  phase2Influence: MemoryPhase2Influence;
  sourceUpdatedAt: number | null;
  selectedForPhase2: boolean | "unknown";
  selectedForPhase2SourceUpdatedAt: number | null;
  selectionMatchesCurrentSource: boolean | "unknown";
  retainedAfterSessionDelete: true;
  schemaStatus: MemorySchemaStatus;
  warnings: string[];
}

export interface MemoryDoctorStats {
  enabled: boolean | "unknown";
  databaseExists: boolean;
  schemaStatus: MemorySchemaStatus;
  stage1: {
    total: number;
    withRolloutSummary: number;
    selectedForPhase2: number;
  };
  jobs: {
    total: number;
    byStatus: Record<string, number>;
  };
  warnings: string[];
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
  format: "jsonl" | "jsonl.zst";
  compressed: boolean;
  absolutePath: string;
  relativePath: string;
  fileName: string;
  size: number;
  lastModified: number | null;
  device?: number;
  inode?: number;
}

export interface ShellSnapshotFile {
  id: string;
  absolutePath: string;
  relativePath: string;
  fileName: string;
  size: number;
  lastModified: number | null;
  device?: number;
  inode?: number;
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
  recencyAt: string | null;
  recencyAtMs: number | null;
  historyMode: ThreadHistoryMode;
  model: string | null;
  modelProvider: string | null;
  cwd: string | null;
  rolloutPath: string | null;
  sourceKind: SourceKind;
  sourceInfo: SourceInfo;
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
  ruleId?: GlobalStateExactKeyRuleId;
  safetyClass?: "known" | "promoted-exact-key" | "unknown";
  valueShape?: string;
  byteEstimate?: number;
  reason?: string;
}

export type GlobalStateExactKeyRuleId = "electronPromptHistoryByThreadId" | "heartbeatThreadPermissionsById";

export interface GlobalStateExactKeyPreview {
  sessionId: string;
  path: string;
  ruleId: GlobalStateExactKeyRuleId;
  valueShape: string;
  byteEstimate: number;
  reason: string;
  requiresConfirmation: true;
}

export interface GlobalStateScanData {
  path: string | null;
  text: string | null;
  refsById: Map<string, GlobalStateReference[]>;
  exactKeyRefsById: Map<string, GlobalStateReference[]>;
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
  goalsSqlitePath: string | null;
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
  safety: ScanSafetyState;
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
  source?: "event_msg" | "response_item" | "history" | "diagnostic";
  sourceType?: string | null;
  lineNumber?: number | null;
  truncated?: boolean;
  unsupported?: boolean;
  parseError?: boolean;
}

export interface SessionTimelineResult {
  historyMode: ThreadHistoryMode;
  items: TimelineItem[];
  completeness: TimelineCompleteness;
  itemsReturned: number;
  itemsKnown: number | null;
  omittedReason: string | null;
  exactExportAvailable: boolean;
  unsupportedItemCount: number;
  parseErrorCount: number;
  toolOutputTruncatedCount: number;
  collectionLimitReason?: "items" | "bytes" | "read_bytes";
  sourceBytesRead?: number;
  sourceBytesKnown?: number;
}

export interface TimelineReadLimits {
  maxItems?: number;
  maxTimelineBytes?: number;
  maxReadBytes?: number;
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
  | "storage-conflict"
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
    globalStateExactKey: SessionResiduePathSurface & { refs: GlobalStateExactKeyPreview[] };
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
    exactKeyGlobalStateRefs: number;
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
  | "global-state-exact-key"
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
  | "global_state_exact_key"
  | "global_state_unknown"
  | "thread_spawn_edges";

export interface RootResidueSurfaceSummary {
  rolloutFiles: number;
  shellSnapshots: number;
  sessionIndexRows: number;
  historyRows: number;
  sqliteRows: number;
  dedicatedLogRows: number;
  knownGlobalStateRefs: number;
  exactKeyGlobalStateRefs: number;
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
  warningSummary: WarningSummary;
  warnings: string[];
  recommendedAuditCommand: string;
}

export interface RootResidueFilters {
  statuses: RootResidueCandidateStatus[];
  sources: RootResidueCandidateSource[];
  includeAll: boolean;
}

export interface WarningSummary {
  total: number;
  returned: number;
  omitted: number;
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
  warningSummary: WarningSummary;
  warnings: string[];
}

export interface RootDeletePreviewCounts {
  rolloutFiles: number;
  shellSnapshots: number;
  sessionIndexRows: number;
  historyRows: number;
  sqliteRows: number;
  dedicatedLogRows: number;
  knownGlobalStateRefs: number;
  exactKeyGlobalStateRefs: number;
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
  deleteSupported: boolean;
  deleteUnsupportedReason: string | null;
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
  warningSummary: WarningSummary;
  warnings: string[];
}

export interface MonthlyResidueReview {
  readOnly: true;
  officialDeleteFirst: true;
  memoryRetained: true;
  audit: RootResidueAudit;
  preview: RootDeletePreview;
  nextSteps: string[];
}

export interface DeletePreviewItem {
  sessionId: string;
  title: string;
  archived: boolean;
  storageConflict: boolean;
  warnings: string[];
  filePaths: string[];
  shellSnapshotFiles: string[];
  globalStateRefs: number;
  exactKeyGlobalStateRefs: number;
  possibleUnknownGlobalStateRefs: number;
  possibleUnknownGlobalStateRefPaths: string[];
  exactKeyGlobalStateRefPaths: string[];
  exactKeyGlobalStateRefsDetail: GlobalStateExactKeyPreview[];
  sessionIndexRows: number;
  historyRows: number;
  sqlite: SqliteDeletionCounts;
}

export interface DeletePreview {
  memoryRetained: true;
  dedicatedLogsRetained: boolean;
  retainedSurfaces: string[];
  items: DeletePreviewItem[];
  familyWarnings: DeleteFamilyWarning[];
  totals: {
    sessionFiles: number;
    shellSnapshotFiles: number;
    globalStateRefs: number;
    exactKeyGlobalStateRefs: number;
    possibleUnknownGlobalStateRefs: number;
    sessionIndexRows: number;
    historyRows: number;
    sqliteRows: number;
  };
}

export type PlanDeleteIncludeReason =
  | "seed"
  | "include-children"
  | "include-subagents"
  | "include-descendants"
  | "include-family";

export type PlanDeleteAvailableIncludeKind =
  | "parent"
  | "child"
  | "subagent"
  | "descendant"
  | "family"
  | "side/fork";

export interface PlanDeleteIncludedId {
  sessionId: string;
  reason: PlanDeleteIncludeReason;
}

export interface PlanDeleteAvailableInclude {
  sessionId: string;
  kind: PlanDeleteAvailableIncludeKind;
  relationship: SessionFamilyRelationship;
  sourceKind: SourceKind;
  childTypeLabels: SessionFamilyChildCategory[];
  reason: string;
}

export interface PlanDeleteRejectedId {
  sessionId: string;
  reason: string;
}

export interface PlanDeleteOptions {
  includeChildren?: boolean;
  includeSubagents?: boolean;
  includeDescendants?: boolean;
  includeFamily?: boolean;
  candidateSource?: PlanDeleteCandidateSource;
}

export interface PlanDeleteCandidateSource {
  sourceKinds: SourceKind[];
  statuses: SessionKind[];
  limit: number;
}

export interface PlanDeleteSurfaceCounts {
  sessionFiles: number;
  shellSnapshotFiles: number;
  globalStateRefs: number;
  exactKeyGlobalStateRefs: number;
  possibleUnknownGlobalStateRefs: number;
  sessionIndexRows: number;
  historyRows: number;
  sqliteRows: number;
}

export interface PlanDeleteResult {
  schemaVersion?: "codex-sessions-delete-plan.v1";
  scanTimestamp?: string;
  rootFingerprint?: DeletePlanRootFingerprint;
  selectedSnapshot?: DeletePlanSelectedSnapshot;
  planHash?: string;
  readOnly: true;
  executionSupported: false;
  seedSessionIds: string[];
  selectedIds: string[];
  candidateIds?: string[];
  candidateSource?: {
    type: "sourceKind";
    sourceKinds: SourceKind[];
    statuses: SessionKind[];
    limit: number;
  };
  includedIds: PlanDeleteIncludedId[];
  availableIncludes: {
    parents: PlanDeleteAvailableInclude[];
    children: PlanDeleteAvailableInclude[];
    subagents: PlanDeleteAvailableInclude[];
    descendants: PlanDeleteAvailableInclude[];
    family: PlanDeleteAvailableInclude[];
    sideOrFork: PlanDeleteAvailableInclude[];
  };
  rejectedIds: PlanDeleteRejectedId[];
  warnings: string[];
  brokenRelations: SessionFamilyBrokenRelation[];
  missingSurfaces: SessionFamilyMissingSurfaceGroups;
  surfaceCounts: PlanDeleteSurfaceCounts;
  globalStateExactKey: GlobalStateExactKeyPreview[];
}

export interface DeletePlanSurfaceFingerprint {
  path: string | null;
  availability: "available" | "missing" | "unsafe";
  unsafeReason: string | null;
  exists: boolean;
  size: number | null;
  mtimeMs: number | null;
  sha256: string | null;
  parseable: boolean;
}

export interface DeletePlanRootFingerprint {
  rootRealpath: string | null;
  sqliteHomeRealpath: string | null;
  sqliteHomeSource: CodexRootPaths["sqliteHomeSource"];
  sessionIndex: DeletePlanSurfaceFingerprint;
  history: DeletePlanSurfaceFingerprint;
  globalState: DeletePlanSurfaceFingerprint;
  sqlite: DeletePlanSurfaceFingerprint;
  logsSqlite: DeletePlanSurfaceFingerprint;
  goalsSqlite: DeletePlanSurfaceFingerprint;
  memoriesSqlite: DeletePlanSurfaceFingerprint;
}

export interface DeletePlanSelectedSnapshot {
  surfaceCounts: PlanDeleteSurfaceCounts;
  familyEdges: Array<{ parentThreadId: string; childThreadId: string; status: string | null }>;
  exactKeyGlobalStatePaths: string[];
}

export interface DeletePlanFile extends PlanDeleteResult {
  schemaVersion: "codex-sessions-delete-plan.v1";
  scanTimestamp: string;
  rootFingerprint: DeletePlanRootFingerprint;
  selectedSnapshot: DeletePlanSelectedSnapshot;
  planHash: string;
}

export interface PreviewPlanResult {
  readOnly: true;
  executionSupported: false;
  planSchemaVersion: string;
  planHash: string | null;
  scanTimestamp: string;
  stale: boolean;
  staleReasons: string[];
  rejectedIds: PlanDeleteRejectedId[];
  selectedIds: string[];
  deletableSelectedIds: string[];
  deletePreview: DeletePreview | null;
}

export interface DeleteValidationItem {
  sessionId: string;
  title: string;
  filePathsRemaining: string[];
  shellSnapshotFilesRemaining: string[];
  globalStateRefsRemaining: number;
  exactKeyGlobalStateRefsRemaining: number;
  exactKeyGlobalStateRefPaths: string[];
  possibleUnknownGlobalStateRefsRemaining: number;
  possibleUnknownGlobalStateRefPaths: string[];
  globalStateWarning: string | null;
  warnings: string[];
  sessionIndexRowsRemaining: number;
  historyRowsRemaining: number;
  sqlite: SqliteDeletionCounts;
  memoryLink: SessionMemoryLink;
}

export type OperationStatus = "not_started" | "committed" | "rolled_back" | "recovery_required";
export type VerificationStatus = "passed" | "partial" | "failed" | "not_run";
export type MutationErrorCode =
  | "UNSAFE_PATH"
  | "STALE_PLAN"
  | "MALFORMED_ID"
  | "ACTIVE_SESSION"
  | "RECOVERY_REQUIRED"
  | "POST_COMMIT_VERIFY_FAILED";

/** Shared machine-readable failure contract for destructive operations. */
export class OperationError extends Error {
  readonly code: MutationErrorCode;
  readonly operationStatus: OperationStatus;
  readonly verificationStatus: VerificationStatus;

  constructor(
    code: MutationErrorCode,
    message: string,
    options: {
      operationStatus?: OperationStatus;
      verificationStatus?: VerificationStatus;
      cause?: unknown;
    } = {},
  ) {
    super(`${code}: ${message}`);
    this.name = "OperationError";
    this.code = code;
    this.operationStatus = options.operationStatus ?? "not_started";
    this.verificationStatus = options.verificationStatus ?? "not_run";
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function isOperationError(error: unknown): error is OperationError {
  return error instanceof OperationError;
}

export interface VerificationScope {
  sessionFiles: boolean;
  shellSnapshots: boolean;
  sessionIndex: boolean;
  history: boolean;
  globalState: boolean;
  sqlite: boolean;
  trashEntry?: boolean;
  operationJournal?: boolean;
  retainedSurfaces: string[];
}

export interface MutationResultMetadata {
  operationStatus: OperationStatus;
  verificationStatus: VerificationStatus;
  verificationScope: VerificationScope;
  warnings: string[];
  errorCode: MutationErrorCode | null;
}

export interface DeleteExecutionResult {
  preview: DeletePreview;
  validation: DeleteValidationItem[];
  confirmed: true;
  operationStatus: OperationStatus;
  verificationStatus: VerificationStatus;
  verificationScope: VerificationScope;
  warnings: string[];
  errorCode: MutationErrorCode | null;
}

export class DeleteSessionsError extends OperationError {
  readonly liveDeleteStarted: boolean;
  readonly liveDeleteRolledBack: boolean;

  constructor(message: string, options: {
    code: MutationErrorCode;
    liveDeleteStarted: boolean;
    liveDeleteRolledBack: boolean;
    cause?: unknown;
  }) {
    super(options.code, message, {
      operationStatus: options.liveDeleteStarted
        ? (options.liveDeleteRolledBack ? "rolled_back" : "recovery_required")
        : "not_started",
      verificationStatus: "not_run",
      cause: options.cause,
    });
    this.name = "DeleteSessionsError";
    this.liveDeleteStarted = options.liveDeleteStarted;
    this.liveDeleteRolledBack = options.liveDeleteRolledBack;
  }
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
    encoding?: "utf8" | "base64";
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
    encoding?: "utf8" | "base64";
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
  status: "valid" | "invalid";
  invalidReason?: string;
}

export interface TrashDuplicateSessionSummary {
  sessionId: string;
  count: number;
  trashIds: string[];
}

export interface TrashDeleteResult extends MutationResultMetadata {
  trashEntry: TrashEntrySummary;
  deletion: DeleteExecutionResult;
}

export interface TrashRestoreResult extends MutationResultMetadata {
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
}

export interface TrashPurgeResult extends MutationResultMetadata {
  trashEntry: TrashEntrySummary;
  purged: boolean;
}

export interface CleanupResult {
  staleSessionIds: string[];
  removedSessionIndexRows: number;
  removedHistoryRows: number;
}

export interface CleanupExecutionResult extends CleanupResult, MutationResultMetadata {}

export interface SessionIndexCleanupResult {
  sessionIds: string[];
  removedSessionIndexRows: number;
  removedHistoryRows: number;
}

export interface SessionIndexCleanupExecutionResult extends SessionIndexCleanupResult, MutationResultMetadata {}

export interface SqliteTableInspection {
  table: string;
  exists: boolean;
  columns: string[];
  associationColumns: string[];
}

export interface DoctorReport {
  rootPath: string;
  recovery: {
    pending: boolean;
    operationId: string | null;
    kind: string | null;
    stage: string | null;
    targetIds: string[];
    hasRecoveryPayload: boolean;
    invalidReason: string | null;
  };
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
    sqliteHomePath: string;
    sqliteHomeSource: CodexRootPaths["sqliteHomeSource"];
    sqliteHomeTrusted: boolean;
    sqliteHomeConfigPath: string | null;
    stateCandidates: string[];
    activeStatePath: string | null;
    logsCandidates: string[];
    activeLogsPath: string | null;
    goalsCandidates: string[];
    activeGoalsPath: string | null;
    memoriesCandidates: string[];
    activeMemoriesPath: string | null;
    rootStateCandidates: string[];
    rootLogsCandidates: string[];
    rootGoalsCandidates: string[];
    rootMemoriesCandidates: string[];
    stateTables: SqliteTableInspection[];
    logsTables: SqliteTableInspection[];
    goalsTables: SqliteTableInspection[];
    memoriesTables: SqliteTableInspection[];
    warnings: string[];
  };
  globalState: {
    knownRefs: Array<{ sessionId: string; path: string; kind: GlobalStateReference["kind"] }>;
    exactKeyRefs: Array<{
      sessionId: string;
      path: string;
      kind: GlobalStateReference["kind"];
      ruleId: GlobalStateExactKeyRuleId;
      valueShape: string;
      byteEstimate: number;
    }>;
    possibleUnknownRefs: Array<{ sessionId: string; path: string; kind: GlobalStateReference["kind"] }>;
    warnings: string[];
  };
  scan: {
    sessionCount: number | null;
    warnings: string[];
  };
  memory: MemoryDoctorStats;
  warnings: string[];
}
