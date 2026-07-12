import { inspectCodexRoot } from "../core/doctor.js";
import { listProjectSummaries } from "../core/project.js";
import { filterSessions, resolveSessions, type ListSessionsOptions } from "../core/query.js";
import { scanCodexRoot } from "../core/scan.js";
import { inspectSessionMemoryLink } from "../core/sqlite.js";
import { readSessionTimelineResult } from "../core/timeline.js";
import type {
  DoctorReport,
  ProjectSummary,
  ScanResult,
  SessionEntry,
  SessionMemoryLink,
  TimelineReadLimits,
  SessionTimelineResult,
} from "../core/types.js";

export interface ListSessionsOperationInput {
  root?: string;
  filters?: ListSessionsOptions;
  groupBy?: "project";
}

export interface ListSessionsData {
  root: ScanResult["root"];
  warnings: string[];
  sessions: SessionEntry[];
  projectSummaries?: ProjectSummary[];
}

export interface ListSessionsOperationResult {
  data: ListSessionsData;
  scan: ScanResult;
}

export async function listSessionsOperation(
  input: ListSessionsOperationInput,
): Promise<ListSessionsOperationResult> {
  const scan = await scanCodexRoot(input.root);
  const sessions = filterSessions(scan, input.filters);
  return {
    scan,
    data: {
      root: scan.root,
      warnings: scan.warnings,
      sessions,
      projectSummaries: input.groupBy === "project" ? listProjectSummaries(sessions) : undefined,
    },
  };
}

export interface GetSessionOperationInput {
  root?: string;
  sessionId: string;
  timelineLimits?: TimelineReadLimits;
}

export type GetSessionData = {
  session: SessionEntry;
  timeline: SessionTimelineResult["items"];
  memoryLink: SessionMemoryLink;
} & Omit<SessionTimelineResult, "items">;

export interface GetSessionOperationResult {
  data: GetSessionData;
  scan: ScanResult;
}

export function interpretMemoryMode(memoryMode: string | null | undefined): boolean | "unknown" {
  if (memoryMode === "enabled") return true;
  if (memoryMode === "disabled") return false;
  return "unknown";
}

export async function getSessionOperation(
  input: GetSessionOperationInput,
): Promise<GetSessionOperationResult> {
  const scan = await scanCodexRoot(input.root);
  const session = resolveSessions(scan, [input.sessionId])[0];
  const timelineResult = await readSessionTimelineResult(session, undefined, input.timelineLimits);
  const { items: timeline, ...timelineMetadata } = timelineResult;
  const memoryEnabled = interpretMemoryMode(session.thread?.memoryMode);
  let memoryLink: SessionMemoryLink;
  try {
    memoryLink = inspectSessionMemoryLink(
      scan.root.memoriesSqlitePath,
      session.id,
      memoryEnabled,
    );
  } catch (error) {
    memoryLink = {
      enabled: memoryEnabled,
      stage1Present: false,
      rolloutSummaryPresent: false,
      phase2Influence: "unknown",
      retainedAfterSessionDelete: true,
      schemaStatus: "unrecognized",
      warnings: [error instanceof Error ? error.message : String(error)],
    };
  }
  return {
    scan,
    data: { session, timeline, memoryLink, ...timelineMetadata },
  };
}

export interface InspectRootOperationInput {
  root?: string;
  includeDetails?: boolean;
}

export interface DoctorView extends DoctorReport {
  detailsIncluded: boolean;
  sampleLimit: number | null;
  counts: {
    globalStateKnownRefs: number;
    globalStateExactKeyRefs: number;
    globalStatePossibleUnknownRefs: number;
    recoveryTargetIds: number;
    warnings: number;
  };
}

export interface InspectRootOperationResult {
  report: DoctorView;
  warnings: string[];
}

const DOCTOR_SAMPLE_LIMIT = 5;
const DOCTOR_WARNING_LIMIT = 20;

function buildDoctorView(report: DoctorReport, includeDetails: boolean): DoctorView {
  const sampleLimit = includeDetails ? Number.POSITIVE_INFINITY : DOCTOR_SAMPLE_LIMIT;
  const warningLimit = includeDetails ? Number.POSITIVE_INFINITY : DOCTOR_WARNING_LIMIT;
  return {
    ...report,
    detailsIncluded: includeDetails,
    sampleLimit: includeDetails ? null : DOCTOR_SAMPLE_LIMIT,
    counts: {
      globalStateKnownRefs: report.globalState.knownRefs.length,
      globalStateExactKeyRefs: report.globalState.exactKeyRefs.length,
      globalStatePossibleUnknownRefs: report.globalState.possibleUnknownRefs.length,
      recoveryTargetIds: report.recovery.targetIds.length,
      warnings: report.warnings.length,
    },
    recovery: {
      ...report.recovery,
      targetIds: report.recovery.targetIds.slice(0, sampleLimit),
    },
    sqlite: {
      ...report.sqlite,
      warnings: report.sqlite.warnings.slice(0, warningLimit),
    },
    globalState: {
      ...report.globalState,
      knownRefs: report.globalState.knownRefs.slice(0, sampleLimit),
      exactKeyRefs: report.globalState.exactKeyRefs.slice(0, sampleLimit),
      possibleUnknownRefs: report.globalState.possibleUnknownRefs.slice(0, sampleLimit),
      warnings: report.globalState.warnings.slice(0, warningLimit),
    },
    scan: {
      ...report.scan,
      warnings: report.scan.warnings.slice(0, warningLimit),
    },
    memory: {
      ...report.memory,
      warnings: report.memory.warnings.slice(0, warningLimit),
    },
    warnings: report.warnings.slice(0, warningLimit),
  };
}

export async function inspectRootOperation(
  input: InspectRootOperationInput,
): Promise<InspectRootOperationResult> {
  const fullReport = await inspectCodexRoot(input.root);
  const report = buildDoctorView(fullReport, input.includeDetails === true);
  return { report, warnings: report.warnings };
}
