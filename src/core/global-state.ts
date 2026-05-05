import { readFile, writeFile } from "node:fs/promises";

import type { GlobalStateReference } from "./types.js";

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PINNED_THREAD_IDS_KEY = "pinned-thread-ids";
const QUEUED_FOLLOW_UPS_KEY = "queued-follow-ups";
const DIFF_VIEW_THREAD_SETTINGS_KEY = "diffViewThreadSettings";
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

function addReference(
  refsById: Map<string, GlobalStateReference[]>,
  sessionId: string,
  pathParts: Array<string | number>,
  kind: GlobalStateReference["kind"],
  value: unknown,
): void {
  const refs = refsById.get(sessionId) ?? [];
  refs.push({
    sessionId,
    path: formatPath(pathParts),
    kind,
    value,
  });
  refsById.set(sessionId, refs);
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
        addReference(refsById, item, [PINNED_THREAD_IDS_KEY, index], "array-value", item);
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
        addReference(refsById, sessionId, [key, sessionId], "object-key", childValue);
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
        addReference(refsById, value, pathParts, "object-string-value", value);
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === "string" && isSessionId(item)) {
          addReference(refsById, item, [...pathParts, index], "array-value", item);
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

      if (isSessionId(key)) {
        addReference(refsById, key, [...pathParts, key], "object-key", childValue);
      }

      walk(childValue, [...pathParts, key]);
    }
  }

  walk(parsed, []);
  return refsById;
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

export async function removeGlobalStateReferences(
  filePath: string,
  targetIds: Set<string>,
): Promise<{
  originalText: string;
  removedCount: number;
}> {
  const originalText = await readFile(filePath, "utf8");
  const parsed = JSON.parse(originalText) as unknown;
  const result = removeKnownGlobalStateReferences(parsed, targetIds);

  if (result.removed > 0) {
    await writeFile(filePath, `${JSON.stringify(result.value, null, 2)}\n`, "utf8");
  }

  return {
    originalText,
    removedCount: result.removed,
  };
}

export async function restoreGlobalStateReferences(
  filePath: string | null,
  refs: GlobalStateReference[],
): Promise<number> {
  if (!filePath || refs.length === 0) {
    return 0;
  }

  let parsed: unknown = {};
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }

  const nextObject: Record<string, unknown> = isPlainObject(parsed) ? { ...parsed } : {};
  let restored = 0;

  for (const ref of refs) {
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

  if (restored > 0) {
    await writeFile(filePath, `${JSON.stringify(nextObject, null, 2)}\n`, "utf8");
  }

  return restored;
}
