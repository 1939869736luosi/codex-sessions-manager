import { buildDeletePreview } from "./delete.js";
import { buildSessionFamily } from "./family.js";
import { toExactKeyPreview } from "./global-state.js";
import { resolveSessions } from "./query.js";
import type {
  PlanDeleteAvailableInclude,
  PlanDeleteIncludedId,
  PlanDeleteIncludeReason,
  PlanDeleteOptions,
  PlanDeleteRejectedId,
  PlanDeleteResult,
  PlanDeleteSurfaceCounts,
  ScanResult,
  SessionEntry,
  SessionFamilyBrokenRelation,
  SessionFamilyMissingSurfaceGroups,
  SessionFamilyNode,
  ThreadSpawnEdgeRow,
} from "./types.js";

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function uniqueMessages(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function hasKnownSurface(session: SessionEntry | undefined): session is SessionEntry {
  return Boolean(session && (session.fileTargets.length > 0 || session.hasSessionIndex || session.hasHistory || session.hasThread));
}

function emptySurfaceCounts(): PlanDeleteSurfaceCounts {
  return {
    sessionFiles: 0,
    shellSnapshotFiles: 0,
    globalStateRefs: 0,
    exactKeyGlobalStateRefs: 0,
    possibleUnknownGlobalStateRefs: 0,
    sessionIndexRows: 0,
    historyRows: 0,
    sqliteRows: 0,
  };
}

function addIncluded(
  selectedIds: Set<string>,
  includedIds: PlanDeleteIncludedId[],
  rejectedIds: PlanDeleteRejectedId[],
  sessionsById: Map<string, SessionEntry>,
  sessionId: string,
  reason: PlanDeleteIncludeReason,
): void {
  const session = sessionsById.get(sessionId);
  if (session?.kind === "active") {
    if (!rejectedIds.some((item) => item.sessionId === sessionId)) {
      rejectedIds.push({ sessionId, reason: "active-session-refused-by-default" });
    }
    return;
  }

  if (selectedIds.has(sessionId)) {
    return;
  }
  selectedIds.add(sessionId);
  includedIds.push({ sessionId, reason });
}

function rejectIfActive(
  rejectedIds: PlanDeleteRejectedId[],
  sessionId: string,
  kind: SessionEntry["kind"],
): void {
  if (kind !== "active" || rejectedIds.some((item) => item.sessionId === sessionId)) {
    return;
  }
  rejectedIds.push({ sessionId, reason: "active-session-refused-by-default" });
}

function rejectActiveRelatedCandidates(
  rejectedIds: PlanDeleteRejectedId[],
  families: ReturnType<typeof buildSessionFamily>[],
): void {
  for (const family of families) {
    for (const node of [
      ...family.parents,
      ...family.directChildren,
      ...family.descendants,
      ...family.familyMembers,
    ]) {
      rejectIfActive(rejectedIds, node.sessionId, node.kind);
    }
  }
}

function toAvailableInclude(node: SessionFamilyNode, kind: PlanDeleteAvailableInclude["kind"]): PlanDeleteAvailableInclude {
  return {
    sessionId: node.sessionId,
    kind,
    relationship: node.relationship,
    sourceKind: node.sourceKind,
    childTypeLabels: node.childTypeLabels,
    reason: `${kind} 可通过显式 include flag 纳入；T7-P1 不会默认递归包含。`,
  };
}

function isSubagentNode(node: SessionFamilyNode): boolean {
  return node.sourceKind === "subagent" || Boolean(node.agentRole || node.agentNickname || node.agentPath);
}

function hasSideOrForkSignal(node: SessionFamilyNode): boolean {
  return node.childTypeLabels.includes("side/fork") ||
    [node.source, node.threadSource].some((value) => /side|fork/i.test(value ?? ""));
}

function edgesByParent(edges: ThreadSpawnEdgeRow[]): Map<string, ThreadSpawnEdgeRow[]> {
  const result = new Map<string, ThreadSpawnEdgeRow[]>();
  for (const edge of edges) {
    const existing = result.get(edge.parentThreadId) ?? [];
    existing.push(edge);
    result.set(edge.parentThreadId, existing);
  }
  return result;
}

function collectDescendantIds(scan: ScanResult, seedIds: string[]): string[] {
  const byParent = edgesByParent(scan.sqlite.threadSpawnEdges);
  const knownSessionsById = new Map(scan.sessions.map((session) => [session.id, session]));
  const descendants: string[] = [];
  const seen = new Set(seedIds);
  const queue = [...seedIds];

  while (queue.length > 0) {
    const parentId = queue.shift() as string;
    for (const edge of byParent.get(parentId) ?? []) {
      if (seen.has(edge.childThreadId) || !hasKnownSurface(knownSessionsById.get(edge.childThreadId))) {
        continue;
      }
      seen.add(edge.childThreadId);
      descendants.push(edge.childThreadId);
      queue.push(edge.childThreadId);
    }
  }

  return descendants;
}

function collectMissingSurfaces(
  families: ReturnType<typeof buildSessionFamily>[],
  brokenRelations: SessionFamilyBrokenRelation[],
): SessionFamilyMissingSurfaceGroups {
  return {
    missingFileSessionIds: uniqueSorted(families.flatMap((family) => family.missingSurfaces.missingFileSessionIds)),
    missingSessionIndexIds: uniqueSorted(families.flatMap((family) => family.missingSurfaces.missingSessionIndexIds)),
    missingThreadIds: uniqueSorted([
      ...families.flatMap((family) => family.missingSurfaces.missingThreadIds),
      ...brokenRelations.flatMap((relation) => [
        relation.missingParentSession ? relation.parentThreadId : null,
        relation.missingChildSession ? relation.childThreadId : null,
      ]).filter((value): value is string => Boolean(value)),
    ]),
  };
}

function dedupeBrokenRelations(relations: SessionFamilyBrokenRelation[]): SessionFamilyBrokenRelation[] {
  const byKey = new Map<string, SessionFamilyBrokenRelation>();
  for (const relation of relations) {
    const key = `${relation.parentThreadId}:${relation.childThreadId}:${relation.status ?? ""}`;
    if (!byKey.has(key)) {
      byKey.set(key, relation);
    }
  }
  return [...byKey.values()].sort((left, right) =>
    left.parentThreadId.localeCompare(right.parentThreadId) ||
    left.childThreadId.localeCompare(right.childThreadId) ||
    (left.status ?? "").localeCompare(right.status ?? ""),
  );
}

function collectSurfaceCounts(scan: ScanResult, selectedSessions: SessionEntry[]): PlanDeleteSurfaceCounts {
  if (selectedSessions.length === 0) {
    return emptySurfaceCounts();
  }
  return buildDeletePreview(scan, selectedSessions).totals;
}

function collectCandidateSessions(scan: ScanResult, options: NonNullable<PlanDeleteOptions["candidateSource"]>): SessionEntry[] {
  const statusSet = new Set(options.statuses);
  const sourceKindSet = new Set(options.sourceKinds);
  return scan.sessions
    .filter((session) => sourceKindSet.has(session.sourceKind))
    .filter((session) => statusSet.size === 0 || statusSet.has(session.kind))
    .slice(0, options.limit);
}

export function buildPlanDelete(
  scan: ScanResult,
  seedSessionIds: string[],
  options: PlanDeleteOptions = {},
): PlanDeleteResult {
  const seeds = resolveSessions(scan, seedSessionIds);
  const knownSessionsById = new Map(scan.sessions.map((session) => [session.id, session]));
  const seedSessionsById = new Map(seeds.map((session) => [session.id, session]));
  const candidateSessionsById = new Map([...knownSessionsById, ...seedSessionsById]);
  const selectedIds = new Set<string>();
  const candidateIds = new Set<string>();
  const includedIds: PlanDeleteIncludedId[] = [];
  const rejectedIds: PlanDeleteRejectedId[] = [];
  for (const seed of seeds) {
    addIncluded(selectedIds, includedIds, rejectedIds, candidateSessionsById, seed.id, "seed");
  }

  const sourceCandidates = options.candidateSource ? collectCandidateSessions(scan, options.candidateSource) : [];
  for (const candidate of sourceCandidates) {
    if (candidate.kind === "active") {
      rejectIfActive(rejectedIds, candidate.id, candidate.kind);
    } else {
      candidateIds.add(candidate.id);
    }
  }

  const seedFamilies = seeds.map((session) => buildSessionFamily(scan, session));

  if (options.includeChildren) {
    for (const family of seedFamilies) {
      for (const node of family.directChildren) {
        addIncluded(selectedIds, includedIds, rejectedIds, candidateSessionsById, node.sessionId, "include-children");
      }
    }
  }

  if (options.includeSubagents) {
    for (const family of seedFamilies) {
      for (const node of family.familyMembers.filter(isSubagentNode)) {
        addIncluded(selectedIds, includedIds, rejectedIds, candidateSessionsById, node.sessionId, "include-subagents");
      }
    }
  }

  if (options.includeDescendants) {
    for (const id of collectDescendantIds(scan, seeds.map((session) => session.id))) {
      addIncluded(selectedIds, includedIds, rejectedIds, candidateSessionsById, id, "include-descendants");
    }
  }

  if (options.includeFamily) {
    for (const family of seedFamilies) {
      for (const node of family.familyMembers.sort((left, right) => left.sessionId.localeCompare(right.sessionId))) {
        addIncluded(selectedIds, includedIds, rejectedIds, candidateSessionsById, node.sessionId, "include-family");
      }
    }
  }
  rejectActiveRelatedCandidates(rejectedIds, seedFamilies);

  const selectedSessions = [...selectedIds]
    .map((id) => seedSessionsById.get(id) ?? knownSessionsById.get(id))
    .filter((session): session is SessionEntry => Boolean(session));
  const selectedFamilies = selectedSessions.map((session) => buildSessionFamily(scan, session));
  const brokenRelations = dedupeBrokenRelations(selectedFamilies.flatMap((family) => family.brokenRelations));
  const warnings = uniqueMessages([
    ...scan.warnings,
    ...selectedSessions
      .filter((session) => session.kind === "active")
      .map((session) => `active session ${session.id} 已进入计划但需要显式人工复核；T7-P1 不执行删除。`),
    ...seedFamilies.flatMap((family) => family.brokenRelations.flatMap((relation) => relation.warnings)),
    ...selectedSessions
      .filter((session) => (scan.globalState.possibleUnknownRefsById.get(session.id)?.length ?? 0) > 0)
      .map((session) => `unknown global-state refs for ${session.id}: 只报警，不会自动修改。`),
    ...seedFamilies
      .filter((family) => family.familyMembers.length > 1)
      .map((family) => `family 不默认递归包含：${family.current.sessionId} 还有 related sessions 可在 availableIncludes 查看。`),
    options.includeFamily ? "高风险：--include-family 会纳入 connected family；T7-P1 仍然只读且不支持执行。" : null,
    options.candidateSource
      ? "sourceKind candidate plan 只列出 candidateIds，不写入 selectedIds，不是删除确认、不是授权、不是 preview token。"
      : null,
    options.candidateSource
      ? "sourceKind 是筛选维度，不是删除授权；mcp/vscode/exec 等分类只保留原始来源语义，不能推导为可安全批量删除。"
      : null,
  ].filter((value): value is string => Boolean(value)));

  return {
    readOnly: true,
    executionSupported: false,
    seedSessionIds: seeds.map((session) => session.id),
    selectedIds: uniqueSorted(selectedIds),
    ...(options.candidateSource ? {
      candidateIds: uniqueSorted(candidateIds),
      candidateSource: {
        type: "sourceKind" as const,
        sourceKinds: options.candidateSource.sourceKinds,
        statuses: options.candidateSource.statuses,
        limit: options.candidateSource.limit,
      },
    } : {}),
    includedIds,
    availableIncludes: {
      parents: seedFamilies.flatMap((family) => family.parents.filter((node) => !selectedIds.has(node.sessionId) && !rejectedIds.some((item) => item.sessionId === node.sessionId)).map((node) => toAvailableInclude(node, "parent"))),
      children: seedFamilies.flatMap((family) => family.directChildren.filter((node) => !selectedIds.has(node.sessionId) && !rejectedIds.some((item) => item.sessionId === node.sessionId)).map((node) => toAvailableInclude(node, "child"))),
      subagents: seedFamilies.flatMap((family) => family.familyMembers.filter((node) => isSubagentNode(node) && !selectedIds.has(node.sessionId) && !rejectedIds.some((item) => item.sessionId === node.sessionId)).map((node) => toAvailableInclude(node, "subagent"))),
      descendants: seedFamilies.flatMap((family) => family.descendants.filter((node) => !selectedIds.has(node.sessionId) && !rejectedIds.some((item) => item.sessionId === node.sessionId)).map((node) => toAvailableInclude(node, "descendant"))),
      family: seedFamilies.flatMap((family) => family.familyMembers
        .filter((node) => node.sessionId !== family.current.sessionId && !selectedIds.has(node.sessionId) && !rejectedIds.some((item) => item.sessionId === node.sessionId))
        .map((node) => toAvailableInclude(node, "family"))),
      sideOrFork: seedFamilies.flatMap((family) => family.familyMembers.filter((node) => hasSideOrForkSignal(node) && !selectedIds.has(node.sessionId) && !rejectedIds.some((item) => item.sessionId === node.sessionId)).map((node) => toAvailableInclude(node, "side/fork"))),
    },
    rejectedIds,
    warnings,
    brokenRelations,
    missingSurfaces: collectMissingSurfaces(selectedFamilies.length > 0 ? selectedFamilies : seedFamilies, brokenRelations),
    surfaceCounts: collectSurfaceCounts(scan, selectedSessions),
    globalStateExactKey: selectedSessions.flatMap((session) =>
      (scan.globalState.exactKeyRefsById.get(session.id) ?? []).map(toExactKeyPreview),
    ),
  };
}
