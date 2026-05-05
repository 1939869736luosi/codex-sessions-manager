import path from "node:path";

import type { ProjectSummary, SessionEntry, SessionFileTarget, SessionKind } from "./types.js";

const UNKNOWN_PROJECT_KEY = "unknown";

export interface ProjectIdentity {
  projectPath: string | null;
  projectName: string;
  projectKey: string;
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\/+$/, "");
}

function identityFromPath(projectPath: string | null): ProjectIdentity {
  if (!projectPath) {
    return {
      projectPath: null,
      projectName: "unknown",
      projectKey: UNKNOWN_PROJECT_KEY,
    };
  }

  const normalized = normalizePath(projectPath);
  return {
    projectPath: normalized,
    projectName: path.basename(normalized) || normalized,
    projectKey: normalized.toLowerCase(),
  };
}

function fallbackDirectory(value: string | null): string | null {
  if (!value?.trim()) {
    return null;
  }

  const normalized = normalizePath(value);
  return path.extname(normalized) ? path.dirname(normalized) : normalized;
}

export function deriveProjectIdentity(input: {
  cwd?: string | null;
  rolloutPath?: string | null;
  fileTargets?: SessionFileTarget[];
}): ProjectIdentity {
  if (input.cwd?.trim()) {
    return identityFromPath(input.cwd);
  }

  const rolloutFallback = fallbackDirectory(input.rolloutPath ?? null);
  if (rolloutFallback) {
    return identityFromPath(rolloutFallback);
  }

  const fileFallback = fallbackDirectory(input.fileTargets?.[0]?.absolutePath ?? null);
  if (fileFallback) {
    return identityFromPath(fileFallback);
  }

  return identityFromPath(null);
}

function createEmptySummary(identity: ProjectIdentity): ProjectSummary {
  return {
    ...identity,
    sessionCount: 0,
    activeCount: 0,
    archivedCount: 0,
    dbOnlyCount: 0,
    staleCount: 0,
    latestUpdatedAt: null,
    totalFileSize: 0,
  };
}

function incrementKind(summary: ProjectSummary, kind: SessionKind): void {
  if (kind === "active") summary.activeCount += 1;
  if (kind === "archived") summary.archivedCount += 1;
  if (kind === "db-only") summary.dbOnlyCount += 1;
  if (kind === "stale") summary.staleCount += 1;
}

export function listProjectSummaries(sessions: SessionEntry[]): ProjectSummary[] {
  const summaries = new Map<string, ProjectSummary>();

  for (const session of sessions) {
    const summary =
      summaries.get(session.projectKey) ??
      createEmptySummary({
        projectPath: session.projectPath,
        projectName: session.projectName,
        projectKey: session.projectKey,
      });

    summary.sessionCount += 1;
    summary.totalFileSize += session.totalFileSize;
    incrementKind(summary, session.kind);

    const currentTime = summary.latestUpdatedAt ? new Date(summary.latestUpdatedAt).getTime() : 0;
    const nextTime = session.updatedAt ? new Date(session.updatedAt).getTime() : 0;
    if (nextTime >= currentTime && session.updatedAt) {
      summary.latestUpdatedAt = session.updatedAt;
    }

    summaries.set(session.projectKey, summary);
  }

  return [...summaries.values()].sort((left, right) => {
    const rightTime = right.latestUpdatedAt ? new Date(right.latestUpdatedAt).getTime() : 0;
    const leftTime = left.latestUpdatedAt ? new Date(left.latestUpdatedAt).getTime() : 0;
    return rightTime - leftTime || left.projectName.localeCompare(right.projectName);
  });
}

export function groupSessionsByProject(sessions: SessionEntry[]): Array<{
  project: ProjectSummary;
  sessions: SessionEntry[];
}> {
  const summaries = listProjectSummaries(sessions);
  return summaries.map((project) => ({
    project,
    sessions: sessions.filter((session) => session.projectKey === project.projectKey),
  }));
}

export function matchesProject(session: SessionEntry, projectText: string): boolean {
  const query = projectText.trim().toLowerCase();
  if (!query) {
    return true;
  }

  return [session.projectKey, session.projectPath ?? "", session.projectName, session.cwd ?? "", session.rolloutPath ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(query);
}
