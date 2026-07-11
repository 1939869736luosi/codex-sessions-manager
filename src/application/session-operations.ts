import { inspectCodexRoot } from "../core/doctor.js";
import { listProjectSummaries } from "../core/project.js";
import { filterSessions, resolveSessions, type ListSessionsOptions } from "../core/query.js";
import { scanCodexRoot } from "../core/scan.js";
import { readSessionTimelineResult } from "../core/timeline.js";
import type {
  DoctorReport,
  ProjectSummary,
  ScanResult,
  SessionEntry,
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
} & Omit<SessionTimelineResult, "items">;

export interface GetSessionOperationResult {
  data: GetSessionData;
  scan: ScanResult;
}

export async function getSessionOperation(
  input: GetSessionOperationInput,
): Promise<GetSessionOperationResult> {
  const scan = await scanCodexRoot(input.root);
  const session = resolveSessions(scan, [input.sessionId])[0];
  const timelineResult = await readSessionTimelineResult(session, undefined, input.timelineLimits);
  const { items: timeline, ...timelineMetadata } = timelineResult;
  return {
    scan,
    data: { session, timeline, ...timelineMetadata },
  };
}

export interface InspectRootOperationInput {
  root?: string;
}

export interface InspectRootOperationResult {
  report: DoctorReport;
  warnings: string[];
}

export async function inspectRootOperation(
  input: InspectRootOperationInput,
): Promise<InspectRootOperationResult> {
  const report = await inspectCodexRoot(input.root);
  return { report, warnings: report.warnings };
}
