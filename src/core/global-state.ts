import { atomicWriteManagedTextIfUnchanged, MutationSafetyError } from "./mutation-safety.js";
import {
  captureManagedPath,
  readManagedText,
  toManagedRelativePath,
  type TrustedRootContext,
} from "./path-safety.js";
import type { GlobalStateExactKeyPreview, GlobalStateExactKeyRuleId, GlobalStateReference } from "./types.js";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PINNED_THREAD_IDS_KEY = "pinned-thread-ids";
const QUEUED_FOLLOW_UPS_KEY = "queued-follow-ups";
const DIFF_VIEW_THREAD_SETTINGS_KEY = "diffViewThreadSettings";
const ELECTRON_PERSISTED_ATOM_STATE_KEY = "electron-persisted-atom-state";
const PROMPT_HISTORY_KEY = "prompt-history";
const HEARTBEAT_THREAD_PERMISSIONS_BY_ID_KEY = "heartbeat-thread-permissions-by-id";
const PROMPT_HISTORY_RULE_ID = "electronPromptHistoryByThreadId" satisfies GlobalStateExactKeyRuleId;
const HEARTBEAT_PERMISSIONS_RULE_ID = "heartbeatThreadPermissionsById" satisfies GlobalStateExactKeyRuleId;
const HEARTBEAT_PERMISSION_KEYS = new Set(["approvalPolicy", "approvalsReviewer", "sandboxPolicy"]);
const KNOWN_GLOBAL_STATE_KEYS = new Set([
  PINNED_THREAD_IDS_KEY,
  QUEUED_FOLLOW_UPS_KEY,
  DIFF_VIEW_THREAD_SETTINGS_KEY,
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}

function formatPath(pathParts: Array<string | number>): string {
  if (pathParts.length === 0) {
    return "$";
  }

  return pathParts.reduce<string>((pathText, part) => {
    if (typeof part === "number") {
      return `${pathText}[${part}]`;
    }

    return `${pathText}.${part}`;
  }, "$");
}

function estimateBytes(value: unknown): number {
  const text = JSON.stringify(value);
  return text ? Buffer.byteLength(text, "utf8") : 0;
}

function describeValueShape(value: unknown): string {
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }

  if (isPlainObject(value)) {
    return `object(${Object.keys(value).length})`;
  }

  if (value === null) {
    return "null";
  }

  return typeof value;
}

function exactPathForRule(ruleId: GlobalStateExactKeyRuleId, sessionId: string): string {
  switch (ruleId) {
    case PROMPT_HISTORY_RULE_ID:
      return formatPath([ELECTRON_PERSISTED_ATOM_STATE_KEY, PROMPT_HISTORY_KEY, sessionId]);
    case HEARTBEAT_PERMISSIONS_RULE_ID:
      return formatPath([ELECTRON_PERSISTED_ATOM_STATE_KEY, HEARTBEAT_THREAD_PERMISSIONS_BY_ID_KEY, sessionId]);
  }
}

function isHeartbeatPermissionShape(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    return false;
  }

  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => HEARTBEAT_PERMISSION_KEYS.has(key));
}

function exactKeyReason(ruleId: GlobalStateExactKeyRuleId): string {
  switch (ruleId) {
    case PROMPT_HISTORY_RULE_ID:
      return "session id 是 prompt-history 的完整对象键，P11 允许只删除这个 exact key；不会读取或打印 prompt 内容。";
    case HEARTBEAT_PERMISSIONS_RULE_ID:
      return "session id 是 heartbeat permissions 的完整对象键，且 value 只包含已知权限字段。";
  }
}

function buildExactKeyReference(
  sessionId: string,
  ruleId: GlobalStateExactKeyRuleId,
  value: unknown,
): GlobalStateReference {
  return {
    sessionId,
    path: exactPathForRule(ruleId, sessionId),
    kind: "object-key",
    value,
    ruleId,
    safetyClass: "promoted-exact-key",
    valueShape: describeValueShape(value),
    byteEstimate: estimateBytes(value),
    reason: exactKeyReason(ruleId),
  };
}

function classifyExactKeyReference(
  pathParts: Array<string | number>,
  sessionId: string,
  value: unknown,
): GlobalStateReference | null {
  if (
    pathParts.length === 3 &&
    pathParts[0] === ELECTRON_PERSISTED_ATOM_STATE_KEY &&
    pathParts[1] === PROMPT_HISTORY_KEY &&
    pathParts[2] === sessionId &&
    Array.isArray(value)
  ) {
    return buildExactKeyReference(sessionId, PROMPT_HISTORY_RULE_ID, value);
  }

  if (
    pathParts.length === 3 &&
    pathParts[0] === ELECTRON_PERSISTED_ATOM_STATE_KEY &&
    pathParts[1] === HEARTBEAT_THREAD_PERMISSIONS_BY_ID_KEY &&
    pathParts[2] === sessionId &&
    isHeartbeatPermissionShape(value)
  ) {
    return buildExactKeyReference(sessionId, HEARTBEAT_PERMISSIONS_RULE_ID, value);
  }

  return null;
}

export function toExactKeyPreview(ref: GlobalStateReference): GlobalStateExactKeyPreview {
  if (!ref.ruleId || ref.safetyClass !== "promoted-exact-key") {
    throw new Error(`不是 P11 认可的 exact-key global-state 引用：${ref.path}`);
  }

  return {
    sessionId: ref.sessionId,
    path: ref.path,
    ruleId: ref.ruleId,
    valueShape: ref.valueShape ?? describeValueShape(ref.value),
    byteEstimate: ref.byteEstimate ?? estimateBytes(ref.value),
    reason: ref.reason ?? exactKeyReason(ref.ruleId),
    requiresConfirmation: true,
  };
}

function addReference(
  refsById: Map<string, GlobalStateReference[]>,
  sessionId: string,
  pathParts: Array<string | number>,
  kind: GlobalStateReference["kind"],
  value: unknown,
  safetyClass: GlobalStateReference["safetyClass"],
): void {
  const refs = refsById.get(sessionId) ?? [];
  refs.push({
    sessionId,
    path: formatPath(pathParts),
    kind,
    value,
    safetyClass,
  });
  refsById.set(sessionId, refs);
}

function addExactReference(
  refsById: Map<string, GlobalStateReference[]>,
  ref: GlobalStateReference,
): void {
  const refs = refsById.get(ref.sessionId) ?? [];
  refs.push(ref);
  refsById.set(ref.sessionId, refs);
}

export function collectGlobalStateReferences(text: string | null): Map<string, GlobalStateReference[]> {
  const refsById = new Map<string, GlobalStateReference[]>();

  if (!text) {
    return refsById;
  }

  const parsed = JSON.parse(text) as unknown;

  if (!isPlainObject(parsed)) {
    return refsById;
  }

  const pinnedThreadIds = parsed[PINNED_THREAD_IDS_KEY];
  if (Array.isArray(pinnedThreadIds)) {
    pinnedThreadIds.forEach((item, index) => {
      if (typeof item === "string" && isSessionId(item)) {
        addReference(refsById, item, [PINNED_THREAD_IDS_KEY, index], "array-value", item, "known");
      }
    });
  }

  for (const key of [QUEUED_FOLLOW_UPS_KEY, DIFF_VIEW_THREAD_SETTINGS_KEY]) {
    const value = parsed[key];
    if (!isPlainObject(value)) {
      continue;
    }

    for (const [sessionId, childValue] of Object.entries(value)) {
      if (isSessionId(sessionId)) {
        addReference(refsById, sessionId, [key, sessionId], "object-key", childValue, "known");
      }
    }
  }

  return refsById;
}

export function collectExactKeyGlobalStateReferences(text: string | null): Map<string, GlobalStateReference[]> {
  const refsById = new Map<string, GlobalStateReference[]>();

  if (!text) {
    return refsById;
  }

  const parsed = JSON.parse(text) as unknown;

  if (!isPlainObject(parsed)) {
    return refsById;
  }

  const atomState = parsed[ELECTRON_PERSISTED_ATOM_STATE_KEY];
  if (!isPlainObject(atomState)) {
    return refsById;
  }

  const promptHistory = atomState[PROMPT_HISTORY_KEY];
  if (isPlainObject(promptHistory)) {
    for (const [sessionId, value] of Object.entries(promptHistory)) {
      if (isSessionId(sessionId) && Array.isArray(value)) {
        addExactReference(refsById, buildExactKeyReference(sessionId, PROMPT_HISTORY_RULE_ID, value));
      }
    }
  }

  const heartbeatPermissions = atomState[HEARTBEAT_THREAD_PERMISSIONS_BY_ID_KEY];
  if (isPlainObject(heartbeatPermissions)) {
    for (const [sessionId, value] of Object.entries(heartbeatPermissions)) {
      if (isSessionId(sessionId) && isHeartbeatPermissionShape(value)) {
        addExactReference(refsById, buildExactKeyReference(sessionId, HEARTBEAT_PERMISSIONS_RULE_ID, value));
      }
    }
  }

  return refsById;
}

export function collectPossibleUnknownGlobalStateReferences(text: string | null): Map<string, GlobalStateReference[]> {
  const refsById = new Map<string, GlobalStateReference[]>();

  if (!text) {
    return refsById;
  }

  const parsed = JSON.parse(text) as unknown;

  function walk(value: unknown, pathParts: Array<string | number>): void {
    if (typeof value === "string") {
      if (isSessionId(value)) {
        addReference(refsById, value, pathParts, "object-string-value", value, "unknown");
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === "string" && isSessionId(item)) {
          addReference(refsById, item, [...pathParts, index], "array-value", item, "unknown");
          return;
        }

        walk(item, [...pathParts, index]);
      });
      return;
    }

    if (!isPlainObject(value)) {
      return;
    }

    for (const [key, childValue] of Object.entries(value)) {
      if (pathParts.length === 0 && KNOWN_GLOBAL_STATE_KEYS.has(key)) {
        continue;
      }

      const nextPath = [...pathParts, key];
      const exactRef = isSessionId(key) ? classifyExactKeyReference(nextPath, key, childValue) : null;
      if (isSessionId(key) && !exactRef) {
        addReference(refsById, key, nextPath, "object-key", childValue, "unknown");
      }

      walk(childValue, nextPath);
    }
  }

  walk(parsed, []);
  return refsById;
}

export function findExistingExactKeyGlobalStatePaths(text: string | null, refs: GlobalStateReference[]): GlobalStateReference[] {
  if (!text || refs.length === 0) {
    return [];
  }

  const parsed = JSON.parse(text) as unknown;
  if (!isPlainObject(parsed)) {
    return [];
  }

  const atomState = parsed[ELECTRON_PERSISTED_ATOM_STATE_KEY];
  if (!isPlainObject(atomState)) {
    return [];
  }

  const conflicts: GlobalStateReference[] = [];
  for (const ref of refs) {
    if (!ref.ruleId || ref.safetyClass !== "promoted-exact-key") {
      continue;
    }

    const expectedPath = exactPathForRule(ref.ruleId, ref.sessionId);
    if (ref.path !== expectedPath) {
      throw new Error(`global state exact-key restore 路径不匹配：${ref.path}`);
    }

    const containerKey = ref.ruleId === PROMPT_HISTORY_RULE_ID ? PROMPT_HISTORY_KEY : HEARTBEAT_THREAD_PERMISSIONS_BY_ID_KEY;
    const container = atomState[containerKey];
    if (container !== undefined && !isPlainObject(container)) {
      throw new Error(`global state exact-key restore 需要对象容器：${ELECTRON_PERSISTED_ATOM_STATE_KEY}.${containerKey}`);
    }

    if (isPlainObject(container) && Object.prototype.hasOwnProperty.call(container, ref.sessionId)) {
      conflicts.push(ref);
    }
  }

  return conflicts;
}

function removeKnownGlobalStateReferences(parsed: unknown, targetIds: Set<string>): { value: unknown; removed: number } {
  if (!isPlainObject(parsed)) {
    return { value: parsed, removed: 0 };
  }

  const nextObject: Record<string, unknown> = { ...parsed };
  let removed = 0;

  const pinnedThreadIds = nextObject[PINNED_THREAD_IDS_KEY];
  if (Array.isArray(pinnedThreadIds)) {
    const nextPinnedThreadIds = pinnedThreadIds.filter((item) => {
      const shouldRemove = typeof item === "string" && targetIds.has(item);
      if (shouldRemove) {
        removed += 1;
      }
      return !shouldRemove;
    });
    nextObject[PINNED_THREAD_IDS_KEY] = nextPinnedThreadIds;
  }

  for (const key of [QUEUED_FOLLOW_UPS_KEY, DIFF_VIEW_THREAD_SETTINGS_KEY]) {
    const value = nextObject[key];
    if (!isPlainObject(value)) {
      continue;
    }

    const nextValue: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      if (targetIds.has(entryKey)) {
        removed += 1;
        continue;
      }
      nextValue[entryKey] = entryValue;
    }
    nextObject[key] = nextValue;
  }

  return { value: nextObject, removed };
}

function removeExactKeyGlobalStateReferences(parsed: unknown, targetIds: Set<string>): { value: unknown; removed: number } {
  if (!isPlainObject(parsed)) {
    return { value: parsed, removed: 0 };
  }

  const nextObject: Record<string, unknown> = { ...parsed };
  const atomState = nextObject[ELECTRON_PERSISTED_ATOM_STATE_KEY];
  if (!isPlainObject(atomState)) {
    return { value: nextObject, removed: 0 };
  }

  const nextAtomState: Record<string, unknown> = { ...atomState };
  let removed = 0;

  const promptHistory = nextAtomState[PROMPT_HISTORY_KEY];
  if (isPlainObject(promptHistory)) {
    const nextPromptHistory: Record<string, unknown> = { ...promptHistory };
    for (const sessionId of targetIds) {
      if (Object.prototype.hasOwnProperty.call(nextPromptHistory, sessionId) && Array.isArray(nextPromptHistory[sessionId])) {
        delete nextPromptHistory[sessionId];
        removed += 1;
      }
    }
    nextAtomState[PROMPT_HISTORY_KEY] = nextPromptHistory;
  }

  const heartbeatPermissions = nextAtomState[HEARTBEAT_THREAD_PERMISSIONS_BY_ID_KEY];
  if (isPlainObject(heartbeatPermissions)) {
    const nextHeartbeatPermissions: Record<string, unknown> = { ...heartbeatPermissions };
    for (const sessionId of targetIds) {
      if (
        Object.prototype.hasOwnProperty.call(nextHeartbeatPermissions, sessionId) &&
        isHeartbeatPermissionShape(nextHeartbeatPermissions[sessionId])
      ) {
        delete nextHeartbeatPermissions[sessionId];
        removed += 1;
      }
    }
    nextAtomState[HEARTBEAT_THREAD_PERMISSIONS_BY_ID_KEY] = nextHeartbeatPermissions;
  }

  nextObject[ELECTRON_PERSISTED_ATOM_STATE_KEY] = nextAtomState;
  return { value: nextObject, removed };
}

function removeKnownAndExactGlobalStateReferences(
  parsed: unknown,
  targetIds: Set<string>,
): { value: unknown; removed: number } {
  const known = removeKnownGlobalStateReferences(parsed, targetIds);
  const exact = removeExactKeyGlobalStateReferences(known.value, targetIds);
  return {
    value: exact.value,
    removed: known.removed + exact.removed,
  };
}

export function buildGlobalStateRemoval(
  originalText: string,
  targetIds: Set<string>,
): {
  nextText: string;
  removedCount: number;
  removedRefs: GlobalStateReference[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(originalText) as unknown;
  } catch (error) {
    throw new Error(`global state 无法解析，拒绝写入；请先运行 doctor 或 audit 查看原因：${error instanceof Error ? error.message : String(error)}`);
  }
  const removedRefs = [...targetIds.values()].flatMap((sessionId) => [
    ...(collectGlobalStateReferences(originalText).get(sessionId) ?? []),
    ...(collectExactKeyGlobalStateReferences(originalText).get(sessionId) ?? []),
  ]);
  const result = removeKnownAndExactGlobalStateReferences(parsed, targetIds);
  return {
    nextText: `${JSON.stringify(result.value, null, 2)}\n`,
    removedCount: result.removed,
    removedRefs,
  };
}

export async function removeGlobalStateReferences(
  filePath: string,
  targetIds: Set<string>,
  options: { expectedText?: string | null; trustedRoot: TrustedRootContext; relativePath?: string },
): Promise<{
  originalText: string;
  removedCount: number;
  removedRefs: GlobalStateReference[];
}> {
  const relativePath = options.relativePath ?? toManagedRelativePath(options.trustedRoot, filePath);
  const originalText = await readManagedText(options.trustedRoot, relativePath);
  if (options.expectedText !== undefined && options.expectedText !== originalText) {
    throw new MutationSafetyError(
      "STALE_PLAN",
      "global state 在预览后发生变化，拒绝写入；请重新运行 delete 预览，确认 exact key/path 后再加 --yes。",
    );
  }

  const result = buildGlobalStateRemoval(originalText, targetIds);

  if (result.removedCount > 0) {
    try {
      await atomicWriteManagedTextIfUnchanged(options.trustedRoot, relativePath, originalText, result.nextText);
    } catch (error) {
      try {
        await atomicWriteManagedTextIfUnchanged(options.trustedRoot, relativePath, result.nextText, originalText);
      } catch (rollbackError) {
        throw new Error(
          `global state 写入失败，回滚也失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}。原始错误：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  }

  return {
    originalText,
    removedCount: result.removedCount,
    removedRefs: result.removedRefs,
  };
}

function ensureObjectContainer(parent: Record<string, unknown>, key: string, label: string): Record<string, unknown> {
  const current = parent[key];
  if (current === undefined) {
    const next: Record<string, unknown> = {};
    parent[key] = next;
    return next;
  }

  if (!isPlainObject(current)) {
    throw new Error(`global state exact-key restore 需要对象容器：${label}`);
  }

  const next = { ...current };
  parent[key] = next;
  return next;
}

function restoreExactKeyReference(nextObject: Record<string, unknown>, ref: GlobalStateReference): boolean {
  if (!ref.ruleId || ref.safetyClass !== "promoted-exact-key") {
    return false;
  }

  const expectedPath = exactPathForRule(ref.ruleId, ref.sessionId);
  if (ref.path !== expectedPath) {
    throw new Error(`global state exact-key restore 路径不匹配：${ref.path}`);
  }

  const atomState = ensureObjectContainer(nextObject, ELECTRON_PERSISTED_ATOM_STATE_KEY, ELECTRON_PERSISTED_ATOM_STATE_KEY);
  const containerKey = ref.ruleId === PROMPT_HISTORY_RULE_ID ? PROMPT_HISTORY_KEY : HEARTBEAT_THREAD_PERMISSIONS_BY_ID_KEY;
  const container = ensureObjectContainer(atomState, containerKey, `${ELECTRON_PERSISTED_ATOM_STATE_KEY}.${containerKey}`);

  if (Object.prototype.hasOwnProperty.call(container, ref.sessionId)) {
    throw new Error(`global state exact-key restore 冲突，目标已存在：${ref.path}`);
  }

  container[ref.sessionId] = ref.value;
  return true;
}

export async function restoreGlobalStateReferences(
  filePath: string | null,
  refs: GlobalStateReference[],
  options: { trustedRoot: TrustedRootContext; relativePath?: string },
): Promise<number> {
  if (!filePath || refs.length === 0) {
    return 0;
  }

  const relativePath = options.relativePath ?? toManagedRelativePath(options.trustedRoot, filePath);
  const snapshot = await captureManagedPath(options.trustedRoot, relativePath, {
    expectedKind: "file",
    allowMissing: true,
    rejectHardlinks: true,
  });
  const originalText = snapshot.exists
    ? await readManagedText(options.trustedRoot, relativePath)
    : null;
  const built = buildGlobalStateRestoration(originalText, refs);

  if (built.restoredCount > 0) {
    await atomicWriteManagedTextIfUnchanged(options.trustedRoot, relativePath, originalText, built.nextText);
  }

  return built.restoredCount;
}

export function buildGlobalStateRestoration(
  originalText: string | null,
  refs: GlobalStateReference[],
): { nextText: string; restoredCount: number } {
  let parsed: unknown = {};
  if (originalText?.trim()) {
    parsed = JSON.parse(originalText) as unknown;
  }
  const nextObject: Record<string, unknown> = isPlainObject(parsed) ? { ...parsed } : {};
  let restored = 0;

  for (const ref of refs) {
    if (restoreExactKeyReference(nextObject, ref)) {
      restored += 1;
      continue;
    }

    if (ref.path.startsWith(`$.${PINNED_THREAD_IDS_KEY}`)) {
      const current = Array.isArray(nextObject[PINNED_THREAD_IDS_KEY])
        ? [...nextObject[PINNED_THREAD_IDS_KEY]]
        : [];
      if (!current.includes(ref.sessionId)) {
        current.push(ref.sessionId);
        restored += 1;
      }
      nextObject[PINNED_THREAD_IDS_KEY] = current;
      continue;
    }

    for (const key of [QUEUED_FOLLOW_UPS_KEY, DIFF_VIEW_THREAD_SETTINGS_KEY]) {
      if (!ref.path.startsWith(`$.${key}.`)) {
        continue;
      }

      const current = isPlainObject(nextObject[key]) ? { ...nextObject[key] } : {};
      if (!Object.prototype.hasOwnProperty.call(current, ref.sessionId)) {
        current[ref.sessionId] = ref.value;
        restored += 1;
      }
      nextObject[key] = current;
    }
  }

  return {
    nextText: `${JSON.stringify(nextObject, null, 2)}\n`,
    restoredCount: restored,
  };
}
