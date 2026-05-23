import { resolveSessions } from "./query.js";
import { parseSourceKind } from "./sources.js";
import type {
  DeleteFamilyWarning,
  ScanResult,
  SessionEntry,
  SessionFamily,
  SessionFamilyBrokenRelation,
  SessionFamilyChildCategory,
  SessionFamilyEdgeStatus,
  SessionFamilyImpact,
  SessionFamilyMissingSurfaceWarning,
  SessionFamilyMode,
  SessionFamilyNode,
  SessionFamilyQuery,
  SessionFamilyRelationship,
  SourceKind,
  ThreadSpawnEdgeRow,
} from "./types.js";

export const FAMILY_MODES = ["full", "children", "parents", "subagents", "impact"] as const satisfies readonly SessionFamilyMode[];

const OPEN_EDGE_STATUSES = new Set(["active", "created", "in_progress", "open", "pending", "queued", "running", "started"]);
const CLOSED_EDGE_STATUSES = new Set(["cancelled", "canceled", "closed", "complete", "completed", "done", "error", "failed", "finished", "success"]);

function sortByUpdatedAtThenId(left: SessionEntry, right: SessionEntry): number {
  const rightTime = new Date(right.updatedAt ?? 0).getTime();
  const leftTime = new Date(left.updatedAt ?? 0).getTime();

  if (rightTime !== leftTime) {
    return rightTime - leftTime;
  }

  return left.id.localeCompare(right.id);
}

function uniqueSortedIds(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function uniqueSortedMessages(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function entriesById(scan: ScanResult): Map<string, SessionEntry> {
  return new Map(scan.sessions.map((session) => [session.id, session]));
}

function edgesByChild(edges: ThreadSpawnEdgeRow[]): Map<string, ThreadSpawnEdgeRow[]> {
  const result = new Map<string, ThreadSpawnEdgeRow[]>();
  for (const edge of edges) {
    const existing = result.get(edge.childThreadId) ?? [];
    existing.push(edge);
    result.set(edge.childThreadId, existing);
  }
  return result;
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

function collectAncestors(parentEdgesByChild: Map<string, ThreadSpawnEdgeRow[]>, sessionId: string): Set<string> {
  const ancestors = new Set<string>();
  const queue = [sessionId];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const edge of parentEdgesByChild.get(id) ?? []) {
      if (ancestors.has(edge.parentThreadId)) {
        continue;
      }
      ancestors.add(edge.parentThreadId);
      queue.push(edge.parentThreadId);
    }
  }

  return ancestors;
}

function collectDescendants(childEdgesByParent: Map<string, ThreadSpawnEdgeRow[]>, sessionId: string): Set<string> {
  const descendants = new Set<string>();
  const queue = [sessionId];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    for (const edge of childEdgesByParent.get(id) ?? []) {
      if (descendants.has(edge.childThreadId)) {
        continue;
      }
      descendants.add(edge.childThreadId);
      queue.push(edge.childThreadId);
    }
  }

  return descendants;
}

function collectConnectedFamily(
  parentEdgesByChild: Map<string, ThreadSpawnEdgeRow[]>,
  childEdgesByParent: Map<string, ThreadSpawnEdgeRow[]>,
  sessionId: string,
): Set<string> {
  const family = new Set<string>([sessionId]);
  const queue = [sessionId];

  while (queue.length > 0) {
    const id = queue.shift() as string;
    const relatedIds = [
      ...(parentEdgesByChild.get(id) ?? []).map((edge) => edge.parentThreadId),
      ...(childEdgesByParent.get(id) ?? []).map((edge) => edge.childThreadId),
    ];

    for (const relatedId of relatedIds) {
      if (family.has(relatedId)) {
        continue;
      }
      family.add(relatedId);
      queue.push(relatedId);
    }
  }

  return family;
}

function chooseRootId(
  parentEdgesByChild: Map<string, ThreadSpawnEdgeRow[]>,
  sessionId: string,
): string {
  const visited = new Set<string>();
  let currentId = sessionId;

  while (!visited.has(currentId)) {
    visited.add(currentId);
    const parentEdges = parentEdgesByChild.get(currentId) ?? [];
    if (parentEdges.length === 0) {
      return currentId;
    }
    currentId = parentEdges.map((edge) => edge.parentThreadId).sort()[0];
  }

  return [...visited].sort()[0] ?? sessionId;
}

function inferRelationship(
  sessionId: string,
  targetId: string,
  rootId: string,
  directParentIds: Set<string>,
  directChildIds: Set<string>,
  ancestors: Set<string>,
  descendants: Set<string>,
  siblingIds: Set<string>,
): SessionFamilyRelationship {
  if (targetId === sessionId) return "self";
  if (directParentIds.has(targetId)) return "parent";
  if (directChildIds.has(targetId)) return "child";
  if (targetId === rootId) return "root";
  if (ancestors.has(targetId)) return "ancestor";
  if (descendants.has(targetId)) return "descendant";
  if (siblingIds.has(targetId)) return "sibling";
  return "related";
}

function compactText(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 32 ? `${normalized.slice(0, 29)}...` : normalized;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value?.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function sourceHaystack(session: SessionEntry): string {
  const rawSource = session.source?.trim() ?? "";
  const rawThreadSource = session.threadSource?.trim() ?? "";
  const sourceObject = parseJsonObject(rawSource);
  const sourceKeys = sourceObject ? Object.keys(sourceObject).join(" ") : "";
  return [
    rawSource,
    rawThreadSource,
    sourceKeys,
    session.agentRole ?? "",
    session.agentNickname ?? "",
    session.agentPath ?? "",
  ].join(" ").toLowerCase();
}

function inferSourceLabel(session: SessionEntry): string {
  const rawSource = session.source?.trim() ?? "";
  const rawThreadSource = session.threadSource?.trim() ?? "";
  const sourceObject = parseJsonObject(rawSource);
  const haystack = sourceHaystack(session);

  if (haystack.includes("subagent") || Boolean(session.agentRole || session.agentNickname || session.agentPath)) {
    return "subagent";
  }

  if (haystack.includes("side") || haystack.includes("fork")) {
    return "side-thread";
  }

  if (haystack.includes("mcp")) {
    return "mcp";
  }

  if (haystack.includes("exec")) {
    return "exec";
  }

  if (rawThreadSource) {
    return compactText(rawThreadSource);
  }

  if (sourceObject) {
    return "json";
  }

  if (rawSource) {
    return compactText(rawSource);
  }

  return "unknown";
}

function inferChildCategory(session: SessionEntry): SessionFamilyChildCategory {
  const haystack = sourceHaystack(session);

  if (session.sourceKind === "subagent" || haystack.includes("subagent") || Boolean(session.agentRole || session.agentNickname || session.agentPath)) {
    return "subagent";
  }

  if (haystack.includes("side") || haystack.includes("fork")) {
    return "side/fork";
  }

  if (session.sourceKind === "mcp" || haystack.includes("mcp")) {
    return "mcp";
  }

  if (session.sourceKind === "exec" || haystack.includes("exec")) {
    return "exec";
  }

  if (session.sourceKind === "vscode" || haystack.includes("vscode")) {
    return "vscode";
  }

  if (session.sourceKind === "cli" || haystack.includes("cli")) {
    return "cli";
  }

  return "unknown";
}

function inferEdgeStatus(status: string | null): SessionFamilyEdgeStatus {
  const normalized = status?.trim().toLowerCase();
  if (!normalized) {
    return "none";
  }

  if (OPEN_EDGE_STATUSES.has(normalized)) {
    return "open";
  }

  if (CLOSED_EDGE_STATUSES.has(normalized)) {
    return "closed";
  }

  return "other";
}

function findRelationshipEdge(
  sessionId: string,
  targetId: string,
  parentEdgesByChild: Map<string, ThreadSpawnEdgeRow[]>,
  childEdgesByParent: Map<string, ThreadSpawnEdgeRow[]>,
): ThreadSpawnEdgeRow | null {
  if (targetId === sessionId) {
    return null;
  }

  return (
    (childEdgesByParent.get(sessionId) ?? []).find((edge) => edge.childThreadId === targetId) ??
    (parentEdgesByChild.get(sessionId) ?? []).find((edge) => edge.parentThreadId === targetId) ??
    (parentEdgesByChild.get(targetId) ?? [])[0] ??
    null
  );
}

function createNode(
  session: SessionEntry,
  relationship: SessionFamilyRelationship,
  edge: ThreadSpawnEdgeRow | null,
  parentEdgesByChild: Map<string, ThreadSpawnEdgeRow[]>,
  childEdgesByParent: Map<string, ThreadSpawnEdgeRow[]>,
): SessionFamilyNode {
  return {
    sessionId: session.id,
    displayTitle: session.displayTitle,
    kind: session.kind,
    relationship,
    relationshipStatus: edge?.status ?? null,
    edgeStatus: inferEdgeStatus(edge?.status ?? null),
    parentEdgeStatus: (parentEdgesByChild.get(session.id) ?? [])[0]?.status ?? null,
    archived: session.archived,
    updatedAt: session.updatedAt,
    fileExists: session.fileTargets.length > 0,
    fileCount: session.fileTargets.length,
    hasSessionIndex: session.hasSessionIndex,
    sessionIndexCount: session.sessionIndexCount,
    hasHistory: session.hasHistory,
    historyCount: session.historyCount,
    hasThread: session.hasThread,
    sourceKind: session.sourceKind,
    source: session.source,
    sourceLabel: inferSourceLabel(session),
    threadSource: session.threadSource,
    agentRole: session.agentRole,
    agentNickname: session.agentNickname,
    agentPath: session.agentPath,
    childCategory: inferChildCategory(session),
    parentIds: uniqueSortedIds((parentEdgesByChild.get(session.id) ?? []).map((item) => item.parentThreadId)),
    childIds: uniqueSortedIds((childEdgesByParent.get(session.id) ?? []).map((item) => item.childThreadId)),
    edge,
  };
}

function hasKnownSessionSurface(session: SessionEntry | undefined): boolean {
  if (!session) {
    return false;
  }

  return session.fileTargets.length > 0 || session.hasSessionIndex || session.hasHistory || session.hasThread;
}

function missingSurfaces(session: SessionEntry | undefined): string[] {
  if (!session || !hasKnownSessionSurface(session)) {
    return ["session"];
  }

  const missing: string[] = [];
  if (session.fileTargets.length === 0) {
    missing.push("file");
  }
  if (!session.hasSessionIndex) {
    missing.push("session_index");
  }
  return missing;
}

function buildBrokenRelation(
  edge: ThreadSpawnEdgeRow,
  sessionById: Map<string, SessionEntry>,
): SessionFamilyBrokenRelation | null {
  const parent = sessionById.get(edge.parentThreadId);
  const child = sessionById.get(edge.childThreadId);
  const missingParentSession = !hasKnownSessionSurface(parent);
  const missingChildSession = !hasKnownSessionSurface(child);
  const parentMissingSurfaces = missingSurfaces(parent);
  const childMissingSurfaces = missingSurfaces(child);
  const warnings = [
    missingParentSession ? `missing parent session: ${edge.parentThreadId}` : null,
    missingChildSession ? `missing child session: ${edge.childThreadId}` : null,
    !missingParentSession && parentMissingSurfaces.length > 0
      ? `edge exists but parent session file/index row is missing: ${edge.parentThreadId} (${parentMissingSurfaces.join(", ")})`
      : null,
    !missingChildSession && childMissingSurfaces.length > 0
      ? `edge exists but child session file/index row is missing: ${edge.childThreadId} (${childMissingSurfaces.join(", ")})`
      : null,
  ].filter((warning): warning is string => Boolean(warning));

  if (warnings.length === 0) {
    return null;
  }

  return {
    parentThreadId: edge.parentThreadId,
    childThreadId: edge.childThreadId,
    status: edge.status,
    missingParentSession,
    missingChildSession,
    parentMissingSurfaces,
    childMissingSurfaces,
    warnings,
  };
}

function emptyChildrenByCategory(): Record<SessionFamilyChildCategory, SessionFamilyNode[]> {
  return {
    subagent: [],
    "side/fork": [],
    mcp: [],
    exec: [],
    vscode: [],
    cli: [],
    unknown: [],
  };
}

function groupChildrenByCategory(children: SessionFamilyNode[]): Record<SessionFamilyChildCategory, SessionFamilyNode[]> {
  const result = emptyChildrenByCategory();
  for (const child of children) {
    result[child.childCategory].push(child);
  }
  return result;
}

export function buildSessionFamily(scan: ScanResult, session: SessionEntry): SessionFamily {
  const sessionById = entriesById(scan);
  const parentEdgesByChild = edgesByChild(scan.sqlite.threadSpawnEdges);
  const childEdgesByParent = edgesByParent(scan.sqlite.threadSpawnEdges);
  const ancestors = collectAncestors(parentEdgesByChild, session.id);
  const descendants = collectDescendants(childEdgesByParent, session.id);
  const directParentEdges = parentEdgesByChild.get(session.id) ?? [];
  const directChildEdges = childEdgesByParent.get(session.id) ?? [];
  const directParentIds = new Set(directParentEdges.map((edge) => edge.parentThreadId));
  const directChildIds = new Set(directChildEdges.map((edge) => edge.childThreadId));
  const siblingIds = new Set<string>();

  for (const parentId of directParentIds) {
    for (const edge of childEdgesByParent.get(parentId) ?? []) {
      if (edge.childThreadId !== session.id) {
        siblingIds.add(edge.childThreadId);
      }
    }
  }

  const rootId = chooseRootId(parentEdgesByChild, session.id);
  const familyIds = collectConnectedFamily(parentEdgesByChild, childEdgesByParent, session.id);
  familyIds.add(rootId);
  for (const id of ancestors) familyIds.add(id);
  for (const id of descendants) familyIds.add(id);
  for (const id of siblingIds) familyIds.add(id);

  const nodes = [...familyIds]
    .map((id) => sessionById.get(id))
    .filter((item): item is SessionEntry => Boolean(item))
    .sort(sortByUpdatedAtThenId)
    .map((entry) => {
      const relationship = inferRelationship(
        session.id,
        entry.id,
        rootId,
        directParentIds,
        directChildIds,
        ancestors,
        descendants,
        siblingIds,
      );
      const edge = findRelationshipEdge(session.id, entry.id, parentEdgesByChild, childEdgesByParent);
      return createNode(entry, relationship, edge, parentEdgesByChild, childEdgesByParent);
    });

  const current = nodes.find((node) => node.sessionId === session.id) ?? createNode(
    session,
    "self",
    null,
    parentEdgesByChild,
    childEdgesByParent,
  );
  const rootSession = sessionById.get(rootId) ?? session;
  const root =
    nodes.find((node) => node.sessionId === rootId) ??
    createNode(rootSession, rootId === session.id ? "self" : "root", null, parentEdgesByChild, childEdgesByParent);
  const parents = nodes.filter((node) => directParentIds.has(node.sessionId));
  const directChildren = nodes.filter((node) => directChildIds.has(node.sessionId));
  const ancestorNodes = nodes.filter((node) => ancestors.has(node.sessionId));
  const descendantNodes = nodes.filter((node) => descendants.has(node.sessionId));
  const siblingNodes = nodes.filter((node) => siblingIds.has(node.sessionId));
  const familyEdges = scan.sqlite.threadSpawnEdges.filter(
    (edge) => familyIds.has(edge.parentThreadId) && familyIds.has(edge.childThreadId),
  );
  const brokenRelations = familyEdges
    .map((edge) => buildBrokenRelation(edge, sessionById))
    .filter((relation): relation is SessionFamilyBrokenRelation => Boolean(relation));

  return {
    current,
    root,
    parent: parents[0] ?? null,
    parents,
    directChildren,
    ancestors: ancestorNodes,
    descendants: descendantNodes,
    siblings: siblingNodes,
    familyMembers: nodes,
    childrenByCategory: groupChildrenByCategory(directChildren),
    edges: familyEdges,
    brokenRelations,
    warnings: uniqueSortedMessages([
      ...scan.warnings,
      ...brokenRelations.flatMap((relation) => relation.warnings),
    ]),
  };
}

export function resolveSessionFamily(scan: ScanResult, sessionId: string): SessionFamily {
  const session = resolveSessions(scan, [sessionId])[0];
  return buildSessionFamily(scan, session);
}

function normalizeSourceKindFilters(value: SourceKind | SourceKind[] | string | string[] | undefined): SourceKind[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map((item) => parseSourceKind(item));
}

function isSubagentNode(node: SessionFamilyNode): boolean {
  return node.sourceKind === "subagent" || Boolean(node.agentRole || node.agentNickname || node.agentPath);
}

function nodesForMode(family: SessionFamily, mode: SessionFamilyMode): SessionFamilyNode[] {
  switch (mode) {
    case "children":
      return family.directChildren;
    case "parents":
      return family.parents;
    case "subagents":
      return family.familyMembers.filter(isSubagentNode);
    case "impact":
      return [];
    case "full":
      return family.familyMembers;
  }
}

function filterNodesBySourceKind(nodes: SessionFamilyNode[], sourceKinds: SourceKind[]): SessionFamilyNode[] {
  if (sourceKinds.length === 0) {
    return nodes;
  }
  return nodes.filter((node) => sourceKinds.includes(node.sourceKind));
}

function missingSurfaceRole(node: SessionFamilyNode): SessionFamilyMissingSurfaceWarning["role"] {
  if (node.relationship === "parent" || node.relationship === "ancestor" || node.relationship === "root") {
    return "parent";
  }
  if (node.relationship === "child" || node.relationship === "descendant") {
    return "child";
  }
  return "family";
}

function addMissingSurfaceWarning(
  warningsByKey: Map<string, SessionFamilyMissingSurfaceWarning>,
  warning: SessionFamilyMissingSurfaceWarning,
): void {
  const key = `${warning.sessionId}:${warning.role}:${warning.edgeStatus ?? ""}`;
  const existing = warningsByKey.get(key);
  if (!existing) {
    warningsByKey.set(key, { ...warning, missingSurfaces: uniqueSortedMessages(warning.missingSurfaces) });
    return;
  }

  existing.missingSurfaces = uniqueSortedMessages([...existing.missingSurfaces, ...warning.missingSurfaces]);
}

export function buildFamilyImpact(family: SessionFamily): SessionFamilyImpact {
  const selectedIds = new Set([family.current.sessionId]);
  const unselectedParentIds = family.parents
    .map((node) => node.sessionId)
    .filter((id) => !selectedIds.has(id));
  const unselectedChildIds = family.directChildren
    .map((node) => node.sessionId)
    .filter((id) => !selectedIds.has(id));
  const unselectedFamilyMemberIds = family.familyMembers
    .map((node) => node.sessionId)
    .filter((id) =>
      id !== family.current.sessionId &&
      !selectedIds.has(id) &&
      !unselectedParentIds.includes(id) &&
      !unselectedChildIds.includes(id),
    );
  const unselectedRelatedSessionIds = uniqueSortedIds([
    ...unselectedParentIds,
    ...unselectedChildIds,
    ...unselectedFamilyMemberIds,
  ]);
  const missingParentIds = uniqueSortedIds(family.brokenRelations
    .filter((relation) => relation.missingParentSession)
    .map((relation) => relation.parentThreadId));
  const missingChildIds = uniqueSortedIds(family.brokenRelations
    .filter((relation) => relation.missingChildSession)
    .map((relation) => relation.childThreadId));
  const missingFileSessionIds = uniqueSortedIds(family.familyMembers
    .filter((node) => !node.fileExists)
    .map((node) => node.sessionId));
  const missingSessionIndexIds = uniqueSortedIds(family.familyMembers
    .filter((node) => !node.hasSessionIndex)
    .map((node) => node.sessionId));
  const missingThreadIds = uniqueSortedIds(family.familyMembers
    .filter((node) => !node.hasThread)
    .map((node) => node.sessionId));
  const warningsByKey = new Map<string, SessionFamilyMissingSurfaceWarning>();

  for (const node of family.familyMembers) {
    const missingSurfaces = [
      !node.fileExists ? "file" : null,
      !node.hasSessionIndex ? "session_index" : null,
      !node.hasThread ? "thread" : null,
    ].filter((surface): surface is string => Boolean(surface));

    if (missingSurfaces.length > 0) {
      addMissingSurfaceWarning(warningsByKey, {
        sessionId: node.sessionId,
        role: missingSurfaceRole(node),
        missingSurfaces,
        edgeStatus: node.relationshipStatus,
      });
    }
  }

  for (const relation of family.brokenRelations) {
    if (relation.parentMissingSurfaces.length > 0) {
      addMissingSurfaceWarning(warningsByKey, {
        sessionId: relation.parentThreadId,
        role: "parent",
        missingSurfaces: relation.parentMissingSurfaces,
        edgeStatus: relation.status,
      });
    }
    if (relation.childMissingSurfaces.length > 0) {
      addMissingSurfaceWarning(warningsByKey, {
        sessionId: relation.childThreadId,
        role: "child",
        missingSurfaces: relation.childMissingSurfaces,
        edgeStatus: relation.status,
      });
    }
  }

  return {
    readOnly: true,
    targetSessionId: family.current.sessionId,
    selectedSessionIds: [family.current.sessionId],
    unselectedParentIds: uniqueSortedIds(unselectedParentIds),
    unselectedChildIds: uniqueSortedIds(unselectedChildIds),
    unselectedFamilyMemberIds: uniqueSortedIds(unselectedFamilyMemberIds),
    unselectedRelatedSessionIds,
    missingParentIds,
    missingChildIds,
    missingFileSessionIds,
    missingSessionIndexIds,
    missingThreadIds,
    missingSurfaceWarnings: [...warningsByKey.values()].sort((left, right) =>
      left.sessionId.localeCompare(right.sessionId) ||
      left.role.localeCompare(right.role) ||
      (left.edgeStatus ?? "").localeCompare(right.edgeStatus ?? ""),
    ),
    brokenRelations: family.brokenRelations,
    warnings: uniqueSortedMessages(family.brokenRelations.flatMap((relation) => relation.warnings)),
  };
}

export function buildSessionFamilyQuery(
  scan: ScanResult,
  sessionId: string,
  options: {
    mode?: SessionFamilyMode;
    sourceKind?: SourceKind | SourceKind[] | string | string[];
  } = {},
): SessionFamilyQuery {
  const mode = options.mode ?? "full";
  const family = resolveSessionFamily(scan, sessionId);
  const sourceKinds = normalizeSourceKindFilters(options.sourceKind);
  const nodes = filterNodesBySourceKind(nodesForMode(family, mode), sourceKinds);
  const directChildren = filterNodesBySourceKind(family.directChildren, sourceKinds);

  return {
    mode,
    sourceKinds,
    family,
    nodes,
    childrenByCategory: groupChildrenByCategory(directChildren),
    impact: mode === "impact" ? buildFamilyImpact(family) : null,
    readOnly: true,
  };
}

export function buildDeleteFamilyWarnings(scan: ScanResult, sessions: SessionEntry[]): DeleteFamilyWarning[] {
  const selectedIds = new Set(sessions.map((session) => session.id));

  return sessions.flatMap((session) => {
    const family = buildSessionFamily(scan, session);
    const unselectedParentIds = family.parents
      .map((node) => node.sessionId)
      .filter((id) => !selectedIds.has(id));
    const unselectedChildIds = family.directChildren
      .map((node) => node.sessionId)
      .filter((id) => !selectedIds.has(id));
    const unselectedFamilyMemberIds = family.familyMembers
      .map((node) => node.sessionId)
      .filter((id) =>
        id !== session.id &&
        !selectedIds.has(id) &&
        !unselectedParentIds.includes(id) &&
        !unselectedChildIds.includes(id),
      );
    const unselectedRelatedSessionIds = uniqueSortedIds([
      ...unselectedParentIds,
      ...unselectedChildIds,
      ...unselectedFamilyMemberIds,
    ]);
    const missingParentIds = uniqueSortedIds(family.brokenRelations
      .filter((relation) => relation.missingParentSession)
      .map((relation) => relation.parentThreadId));
    const missingChildIds = uniqueSortedIds(family.brokenRelations
      .filter((relation) => relation.missingChildSession)
      .map((relation) => relation.childThreadId));
    const warnings = uniqueSortedMessages(family.brokenRelations.flatMap((relation) => relation.warnings));

    if (unselectedRelatedSessionIds.length === 0 && warnings.length === 0) {
      return [];
    }

    return [
      {
        sessionId: session.id,
        unselectedParentIds: uniqueSortedIds(unselectedParentIds),
        unselectedChildIds: uniqueSortedIds(unselectedChildIds),
        unselectedFamilyMemberIds: uniqueSortedIds(unselectedFamilyMemberIds),
        unselectedRelatedSessionIds,
        missingParentIds,
        missingChildIds,
        brokenRelations: family.brokenRelations,
        warnings,
      },
    ];
  });
}
