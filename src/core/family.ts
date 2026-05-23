import { resolveSessions } from "./query.js";
import type {
  DeleteFamilyWarning,
  ScanResult,
  SessionEntry,
  SessionFamily,
  SessionFamilyBrokenRelation,
  SessionFamilyNode,
  SessionFamilyRelationship,
  ThreadSpawnEdgeRow,
} from "./types.js";

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

function inferSourceLabel(session: SessionEntry): string {
  const rawSource = session.source?.trim() ?? "";
  const rawThreadSource = session.threadSource?.trim() ?? "";
  const sourceObject = parseJsonObject(rawSource);
  const sourceKeys = sourceObject ? Object.keys(sourceObject).join(" ") : "";
  const haystack = [
    rawSource,
    rawThreadSource,
    sourceKeys,
    session.agentRole ?? "",
    session.agentNickname ?? "",
    session.agentPath ?? "",
  ].join(" ").toLowerCase();

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
    parentEdgeStatus: (parentEdgesByChild.get(session.id) ?? [])[0]?.status ?? null,
    archived: session.archived,
    updatedAt: session.updatedAt,
    fileExists: session.fileTargets.length > 0,
    fileCount: session.fileTargets.length,
    source: session.source,
    sourceLabel: inferSourceLabel(session),
    threadSource: session.threadSource,
    agentRole: session.agentRole,
    agentNickname: session.agentNickname,
    agentPath: session.agentPath,
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
    familyMembers: nodes,
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
