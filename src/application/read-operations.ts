import { buildRootDeletePreview, buildRootResidueAudit, buildSessionResidueAudit } from "../core/audit.js";
import { exportSessionBackup } from "../core/backup.js";
import { validateDeletion } from "../core/delete.js";
import { buildSessionFamilyQuery } from "../core/family.js";
import { listProjectSummaries } from "../core/project.js";
import { parseDeletePlanObject, previewDeletePlan, readDeletePlanFile, writeDeletePlanFile } from "../core/plan-file.js";
import { buildPlanDelete } from "../core/plan-delete.js";
import { resolveSessions } from "../core/query.js";
import { getRecoveryStatus } from "../core/recovery.js";
import { scanCodexRoot } from "../core/scan.js";
import { summarizeSources } from "../core/sources.js";
import { listTrashEntries, summarizeTrashDuplicateSessions } from "../core/trash.js";
import type { PlanDeleteOptions, SessionFamilyMode, SourceKind } from "../core/types.js";

export interface RootInput {
  root?: string;
}

export async function summarizeSourcesOperation(input: RootInput) {
  const scan = await scanCodexRoot(input.root);
  return {
    scan,
    data: { root: scan.root, warnings: scan.warnings, summary: summarizeSources(scan.sessions) },
  };
}

export async function listProjectsOperation(input: RootInput) {
  const scan = await scanCodexRoot(input.root);
  return {
    scan,
    data: { root: scan.root, warnings: scan.warnings, projects: listProjectSummaries(scan.sessions) },
  };
}

export async function getSessionFamilyOperation(input: RootInput & {
  sessionId: string;
  mode?: SessionFamilyMode;
  sourceKind?: SourceKind | SourceKind[] | string | string[];
}) {
  const scan = await scanCodexRoot(input.root);
  const query = buildSessionFamilyQuery(scan, input.sessionId, {
    mode: input.mode,
    sourceKind: input.sourceKind,
  });
  return { scan, data: { root: scan.root, warnings: scan.warnings, ...query } };
}

export async function auditSessionOperation(input: RootInput & { sessionId: string }) {
  const scan = await scanCodexRoot(input.root);
  return { scan, data: buildSessionResidueAudit(scan, input.sessionId) };
}

export async function auditRootOperation(input: RootInput & {
  limit?: number;
  includeAll?: boolean;
  statuses?: string[];
  sources?: string[];
}) {
  const scan = await scanCodexRoot(input.root);
  return { scan, data: buildRootResidueAudit(scan, input) };
}

export async function previewRootDeleteOperation(input: RootInput & {
  limit?: number;
  includeAll?: boolean;
  statuses?: string[];
  sources?: string[];
}) {
  const scan = await scanCodexRoot(input.root);
  return { scan, data: buildRootDeletePreview(scan, input) };
}

export async function exportSessionOperation(input: RootInput & { sessionId: string }) {
  const scan = await scanCodexRoot(input.root);
  const session = resolveSessions(scan, [input.sessionId])[0];
  const bundle = await exportSessionBackup(scan, session);
  return { scan, session, data: bundle };
}

export async function listTrashOperation(input: RootInput) {
  const scan = await scanCodexRoot(input.root);
  const entries = await listTrashEntries(scan.root.rootPath);
  return {
    scan,
    data: {
      root: scan.root,
      entries,
      duplicateSessionIds: summarizeTrashDuplicateSessions(entries),
    },
  };
}

export async function getRecoveryStatusOperation(input: RootInput) {
  const status = await getRecoveryStatus(input.root);
  return { data: status };
}

export async function verifySessionsOperation(input: RootInput & { sessionIds: string[] }) {
  const scan = await scanCodexRoot(input.root);
  const sessions = resolveSessions(scan, input.sessionIds);
  return { scan, sessions, data: await validateDeletion(scan, sessions) };
}

export async function planDeleteOperation(input: RootInput & {
  sessionIds: string[];
  options: PlanDeleteOptions;
}) {
  const scan = await scanCodexRoot(input.root);
  return { scan, data: buildPlanDelete(scan, input.sessionIds, input.options) };
}

export async function writeDeletePlanOperation(input: RootInput & {
  outputPath: string;
  sessionIds: string[];
  options: PlanDeleteOptions;
}) {
  const operation = await planDeleteOperation(input);
  const planFile = await writeDeletePlanFile(input.outputPath, operation.scan, operation.data);
  return { ...operation, data: planFile };
}

export async function previewDeletePlanOperation(input: RootInput & {
  planFile?: string;
  plan?: unknown;
}) {
  if ((input.planFile ? 1 : 0) + (input.plan ? 1 : 0) !== 1) {
    throw new Error("preview delete plan requires exactly one of planFile or plan");
  }
  const scan = await scanCodexRoot(input.root);
  const deletePlan = input.planFile
    ? await readDeletePlanFile(input.planFile)
    : parseDeletePlanObject(input.plan);
  return { scan, data: await previewDeletePlan(scan, deletePlan) };
}
