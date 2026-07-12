# T8-P2 SourceKind Compatibility Layer Implementation Plan

> **Archived:** completed or superseded by tested current behavior. Unchecked boxes below are historical notes, not active project tasks. See `ROADMAP.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the stable coarse `sourceKind` API while exposing raw/official source evidence so future Codex source labels can be understood without changing delete semantics.

**Architecture:** Add a small source metadata compatibility layer in `src/core/sources.ts`. Existing `sourceKind` remains `subagent | mcp | vscode | cli | exec | unknown`; new metadata explains raw SQLite/JSONL source values, official Codex v2 source-kind mapping where reliable, thread-source analytics values, evidence, and local inference confidence. Filters and delete planning continue to use the existing coarse `sourceKind` only.

**Tech Stack:** TypeScript, Vitest, existing CLI/MCP architecture, better-sqlite3 fixtures.

---

## Non-goals and safety boundary

- Do not implement npm publish.
- Do not clean real `~/.codex` sessions.
- Do not implement P5-P9: no delete-by-plan, no preview token, no sourceKind delete execution, no side/fork automatic deletion, no release/cleanup automation.
- Do not rename or change the meaning of existing `sourceKind`.
- Do not allow `unknown` to become a root-level bulk delete candidate.
- Do not add `officialSourceKind` as an always-null placeholder. Either map it from official Codex source values or omit/null it because no reliable mapping exists.
- Do not add new source filters in T8-P2. `officialSourceKind` and `threadSourceKind` are output-only metadata in this stage.
- Do not change `delete`, `delete --trash`, `plan-delete`, or MCP delete execution behavior.

## Official Codex source model to align with

T8-P2 must align with the current official/open-source Codex model rather than inventing a new taxonomy:

1. `source` is the primary persisted origin field in SQLite/JSONL.
   - Simple values include `cli`, `vscode`, `exec`, `mcp`, and `unknown`.
   - Subagent origins can be represented as structured JSON such as `{"sub_agent":{"thread_spawn":{...}}}`.
   - Official v2 API maps internal `mcp` origin to `appServer`; this is not proof of individual MCP tool-call provenance.
2. `thread_source` is an optional analytics/intent field.
   - Known values are `user`, `subagent`, and `memory_consolidation`.
   - It is not the same field as `source` and must not replace the stable coarse `sourceKind`.
3. `agent_nickname`, `agent_role`, and `agent_path` are subagent evidence fields.
   - They support local coarse classification as `sourceKind="subagent"` when present.
4. Official v2 `ThreadSourceKind` is a filter/API taxonomy, not a separate stored DB column.
   - Known values are `cli`, `vscode`, `exec`, `appServer`, `subAgent`, `subAgentReview`, `subAgentCompact`, `subAgentThreadSpawn`, `subAgentOther`, and `unknown`.
   - T8-P2 may expose this as metadata only when it can be derived from raw `source` without guessing.

Mapping rule for this repository:

| Raw / official evidence | Stable coarse `sourceKind` | Metadata note |
| --- | --- | --- |
| `source="cli"` | `cli` | official kind `cli` |
| `source="vscode"` | `vscode` | official kind `vscode`; not proof of a particular IDE runtime beyond Codex label |
| `source="exec"` | `exec` | official kind `exec`; not delete authorization |
| `source="mcp"` | `mcp` | official v2 equivalent `appServer`; not per-tool-call provenance |
| structured `sub_agent.review` | `subagent` | official kind `subAgentReview` |
| structured `sub_agent.compact` | `subagent` | official kind `subAgentCompact` |
| structured `sub_agent.thread_spawn` | `subagent` | official kind `subAgentThreadSpawn` |
| other structured `sub_agent.*` | `subagent` | official kind `subAgentOther` or `subAgent` depending available evidence |
| `thread_source="subagent"` only | `subagent` only if supported by existing local inference rules | record as analytics evidence |
| `thread_source="memory_consolidation"` only | `unknown` | record analytics value; do not create new coarse kind |
| unknown/custom raw source | `unknown` unless current local rules already classify it | preserve raw evidence |

## File structure

- Modify: `src/core/types.ts`
  - Add `OfficialCodexSourceKind`, `ThreadSourceKind`, `SourceEvidenceField`, `SourceEvidence`, and `SourceInfo` interfaces.
  - Add `sourceInfo: SourceInfo` to `ThreadRow` and `SessionEntry`.
  - Do not add nested evidence to source summary rows in T8-P2; source summaries already group by raw `source` and `thread_source`.
- Modify: `src/core/sources.ts`
  - Keep `deriveSourceKind()` as a compatibility wrapper.
  - Add `deriveSourceInfo(metadata)` as the new source of truth.
  - Ensure `sourceKind` is still the same coarse value for existing fixtures.
- Modify: `src/core/sqlite.ts`
  - Build `sourceInfo` once while mapping thread rows.
- Modify: `src/core/scan.ts`
  - Propagate `thread.sourceInfo` into `SessionEntry`; use an unknown fallback for db-less/stale sessions.
- Modify: `src/cli/format.ts`
  - Keep human output compact; do not add evidence to default list output.
- Modify: `src/mcp/server.ts`
  - No schema changes are needed unless tests require explicit schema documentation; structured output can carry the new fields through existing objects.
- Modify: `tests/core.test.ts`, `tests/cli.test.ts`, `tests/mcp.test.ts`
  - Add regression coverage proving old `sourceKind` filters still work and new source metadata is present.
- Modify: `README.md`, `README.zh-CN.md`, `SKILL.md`, `docs/SAFETY.md`, `CHANGELOG.md`
  - Document that T8-P2 is an observability/compatibility layer, not deletion authorization.
- Modify ignored local docs: `docs/local/INDEX.md`, `docs/local/TIMELINE.md`, `docs/local/DECISIONS.md`
  - Record why sourceKind official fine-grained alignment is handled as compatibility metadata rather than a replacement.

---

### Task 1: Add failing core tests for sourceInfo while preserving sourceKind

**Files:**
- Modify: `tests/core.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests near the existing source tests:

```ts
  it("derives sourceInfo without changing stable sourceKind", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const active = resolveSessions(scan, [FIXTURE_IDS.ACTIVE_ID])[0];
    const archived = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID])[0];

    expect(active.sourceKind).toBe("cli");
    expect(active.sourceInfo).toMatchObject({
      sourceKind: "cli",
      rawSource: "cli",
      rawThreadSource: "cli",
      officialSourceKind: "cli",
      threadSourceKind: null,
      inferenceConfidence: "exact",
    });
    expect(active.sourceInfo.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "source", value: "cli", coarseSourceKind: "cli", officialSourceKind: "cli" }),
      ]),
    );

    expect(archived.sourceKind).toBe("subagent");
    expect(archived.sourceInfo.sourceKind).toBe("subagent");
    expect(archived.sourceInfo.evidence.some((item) => item.coarseSourceKind === "subagent")).toBe(true);
  });

  it("maps official subagent source variants as metadata without changing coarse sourceKind", async () => {
    const db = new Database(fixture.paths.sqlite);
    db.prepare("update threads set source = ?, thread_source = ?, agent_role = null, agent_nickname = null, agent_path = null where id = ?").run(
      JSON.stringify({ sub_agent: { thread_spawn: { parent_thread_id: FIXTURE_IDS.ACTIVE_ID, depth: 1 } } }),
      "subagent",
      FIXTURE_IDS.ARCHIVED_ID,
    );
    db.close();

    const scan = await scanCodexRoot(fixture.rootDir);
    const archived = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID])[0];

    expect(archived.sourceKind).toBe("subagent");
    expect(archived.sourceInfo).toMatchObject({
      sourceKind: "subagent",
      officialSourceKind: "subAgentThreadSpawn",
      threadSourceKind: "subagent",
    });
  });

  it("maps internal mcp source to official appServer metadata without changing coarse sourceKind", async () => {
    const db = new Database(fixture.paths.sqlite);
    db.prepare("update threads set source = ?, thread_source = null, agent_role = null, agent_nickname = null, agent_path = null where id = ?").run(
      "mcp",
      FIXTURE_IDS.ARCHIVED_ID,
    );
    db.close();

    const scan = await scanCodexRoot(fixture.rootDir);
    const archived = resolveSessions(scan, [FIXTURE_IDS.ARCHIVED_ID])[0];

    expect(archived.sourceKind).toBe("mcp");
    expect(archived.sourceInfo).toMatchObject({
      sourceKind: "mcp",
      rawSource: "mcp",
      officialSourceKind: "appServer",
      threadSourceKind: null,
    });
  });

  it("keeps unknown sourceInfo explicit for sessions without source evidence", async () => {
    const scan = await scanCodexRoot(fixture.rootDir);
    const stale = resolveSessions(scan, [FIXTURE_IDS.STALE_ID])[0];

    expect(stale.sourceKind).toBe("unknown");
    expect(stale.sourceInfo).toMatchObject({
      sourceKind: "unknown",
      rawSource: null,
      rawThreadSource: null,
      officialSourceKind: null,
      threadSourceKind: null,
      inferenceConfidence: "unknown",
      evidence: [],
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx vitest run tests/core.test.ts --testNamePattern "sourceInfo|sourceKind"
```

Expected: FAIL because `sourceInfo` does not exist yet.

---

### Task 2: Implement the minimal sourceInfo compatibility type and derivation

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/sources.ts`

- [ ] **Step 1: Add types**

Add near the existing `SourceKind` type:

```ts
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
```

Add `sourceInfo: SourceInfo;` to `ThreadRow` and `SessionEntry`.

- [ ] **Step 2: Add the derivation helper**

In `src/core/sources.ts`, replace the body of `deriveSourceKind()` with a wrapper around a new `deriveSourceInfo()`:

```ts
import type {
  OfficialCodexSourceKind,
  SessionEntry,
  SourceEvidence,
  SourceInfo,
  SourceKind,
  SourceSummary,
  SourceSummaryRow,
  ThreadSourceKind,
} from "./types.js";

function evidence(
  field: SourceEvidence["field"],
  value: string | null,
  coarseSourceKind: SourceKind,
  officialSourceKind: OfficialCodexSourceKind | null,
  reason: string,
): SourceEvidence | null {
  const trimmed = value?.trim();
  return trimmed ? { field, value: trimmed, coarseSourceKind, officialSourceKind, reason } : null;
}

function parseThreadSourceKind(value: string | null): ThreadSourceKind | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "user" || normalized === "subagent" || normalized === "memory_consolidation") {
    return normalized;
  }
  return null;
}

function officialKindFromRawSource(value: string | null): OfficialCodexSourceKind | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  if (lower === "cli") return "cli";
  if (lower === "vscode") return "vscode";
  if (lower === "exec") return "exec";
  if (lower === "mcp") return "appServer";
  if (lower === "unknown") return "unknown";
  return null;
}

function officialKindFromSourceJson(sourceObject: Record<string, unknown> | null): OfficialCodexSourceKind | null {
  const subAgent = sourceObject?.sub_agent ?? sourceObject?.subagent;
  if (!subAgent || typeof subAgent !== "object" || Array.isArray(subAgent)) {
    return null;
  }
  const keys = Object.keys(subAgent as Record<string, unknown>).map((key) => key.toLowerCase());
  if (keys.includes("review")) return "subAgentReview";
  if (keys.includes("compact")) return "subAgentCompact";
  if (keys.includes("thread_spawn")) return "subAgentThreadSpawn";
  if (keys.length > 0) return "subAgentOther";
  return "subAgent";
}

export function deriveSourceInfo(metadata: SourceMetadata): SourceInfo {
  const sourceObject = parseJsonObject(metadata.source);
  const officialFromJson = officialKindFromSourceJson(sourceObject);
  const officialFromRaw = officialKindFromRawSource(metadata.source);
  const officialSourceKind = officialFromJson ?? officialFromRaw;
  const threadSourceKind = parseThreadSourceKind(metadata.threadSource);
  const knownSource = normalizeKnownKind(metadata.source);
  const knownThreadSource = normalizeKnownKind(metadata.threadSource);
  const evidenceItems: SourceEvidence[] = [];

  if (hasSubagentSignal(sourceObject)) {
    evidenceItems.push({
      field: "source_json",
      value: metadata.source ?? "",
      coarseSourceKind: "subagent",
      officialSourceKind: officialFromJson ?? "subAgent",
      reason: "source JSON contains official sub_agent evidence",
    });
  }

  if (knownSource) {
    const item = evidence("source", metadata.source, knownSource, officialFromRaw, "raw source matches a stable sourceKind");
    if (item) evidenceItems.push(item);
  }

  if (knownThreadSource) {
    const item = evidence("thread_source", metadata.threadSource, knownThreadSource, null, "thread_source matches a local stable sourceKind");
    if (item) evidenceItems.push(item);
  } else if (threadSourceKind) {
    const item = evidence("thread_source", metadata.threadSource, threadSourceKind === "subagent" ? "subagent" : "unknown", null, "thread_source is official analytics metadata, not the primary source field");
    if (item) evidenceItems.push(item);
  }

  for (const [field, value] of [
    ["agent_role", metadata.agentRole],
    ["agent_nickname", metadata.agentNickname],
    ["agent_path", metadata.agentPath],
  ] as const) {
    const item = evidence(field, value, "subagent", officialSourceKind, `${field} is present as subagent evidence`);
    if (item) evidenceItems.push(item);
  }

  const hasSubagent = evidenceItems.some((item) => item.coarseSourceKind === "subagent");
  const sourceKind = hasSubagent ? "subagent" : knownSource ?? knownThreadSource ?? "unknown";

  return {
    sourceKind,
    rawSource: metadata.source,
    rawThreadSource: metadata.threadSource,
    officialSourceKind,
    threadSourceKind,
    inferenceConfidence: sourceKind === "unknown" ? "unknown" : officialSourceKind || knownSource ? "exact" : "derived",
    evidence: evidenceItems,
  };
}

export function deriveSourceKind(metadata: SourceMetadata): SourceKind {
  return deriveSourceInfo(metadata).sourceKind;
}
```

- [ ] **Step 3: Run typecheck for expected compile failures**

Run:

```bash
npx tsc --noEmit
```

Expected: FAIL because `ThreadRow` and `SessionEntry` construction sites do not yet provide `sourceInfo`.

---

### Task 3: Wire sourceInfo through SQLite scan and SessionEntry construction

**Files:**
- Modify: `src/core/sqlite.ts`
- Modify: `src/core/scan.ts`

- [ ] **Step 1: Build sourceInfo in SQLite thread rows**

In `src/core/sqlite.ts`, import `deriveSourceInfo` and compute once:

```ts
import { deriveSourceInfo } from "./sources.js";

// inside mapThreadRow after source/threadSource/agent fields:
const sourceInfo = deriveSourceInfo({ source, threadSource, agentRole, agentNickname, agentPath });
```

Then set:

```ts
sourceKind: sourceInfo.sourceKind,
sourceInfo,
```

- [ ] **Step 2: Add unknown fallback in scan**

In `src/core/scan.ts`, import `deriveSourceInfo` and set `sourceInfo` in `buildSession()`:

```ts
const sourceInfo = thread?.sourceInfo ?? deriveSourceInfo({
  source: null,
  threadSource: null,
  agentRole: null,
  agentNickname: null,
  agentPath: null,
});
```

Then set:

```ts
sourceKind: sourceInfo.sourceKind,
sourceInfo,
```

- [ ] **Step 3: Run the focused core tests**

Run:

```bash
npx vitest run tests/core.test.ts --testNamePattern "sourceInfo|source fields|sourceKind"
```

Expected: PASS for the new sourceInfo tests and existing sourceKind behavior.

---

### Task 4: Expose sourceInfo safely in CLI/MCP JSON without cluttering defaults

**Files:**
- Modify: `tests/cli.test.ts`
- Modify: `tests/mcp.test.ts`
- Modify: `src/cli/format.ts` only if a failing test proves human output should mention the field

- [ ] **Step 1: Add CLI JSON regression test**

Add to the existing source/family JSON tests:

```ts
    expect(result.items[0].sourceInfo).toMatchObject({
      sourceKind: result.items[0].sourceKind,
      rawSource: result.items[0].source,
      rawThreadSource: result.items[0].threadSource,
    });
```

If the existing `list --json` test names differ, apply the same assertion to the JSON object that contains a session item.

- [ ] **Step 2: Add MCP structured output regression test**

In the MCP `list_sessions` or `get_session_family` structured output test, assert:

```ts
expect(content.items[0].sourceInfo).toMatchObject({
  sourceKind: content.items[0].sourceKind,
});
```

- [ ] **Step 3: Run focused CLI/MCP tests**

Run:

```bash
npx vitest run tests/cli.test.ts tests/mcp.test.ts --testNamePattern "source|family|list_sessions"
```

Expected: PASS. If JSON output already serializes `sourceInfo` through `SessionEntry`, no CLI/MCP implementation change is required.

---

### Task 5: Update docs and local memory with the compatibility-layer boundary

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `SKILL.md`
- Modify: `docs/SAFETY.md`
- Modify: `CHANGELOG.md`
- Modify ignored: `docs/local/INDEX.md`, `docs/local/TIMELINE.md`, `docs/local/DECISIONS.md`

- [ ] **Step 1: Update public docs with one consistent paragraph**

Use this wording, adapted for English/Chinese documents:

```md
T8-P2 adds a source metadata compatibility layer. The stable `sourceKind` field remains the coarse compatibility category (`subagent`, `mcp`, `vscode`, `cli`, `exec`, `unknown`). JSON output may also include `sourceInfo` with raw `source`, raw `thread_source`, official Codex v2 source-kind metadata when reliably derived, thread-source analytics metadata, and compact evidence. This is observability only: it does not change filters, delete previews, plan-delete selection, MCP planning, or delete authorization. In particular, internal raw `mcp` is reported as stable `sourceKind=mcp` and official metadata `appServer`; it is not proof of individual MCP tool calls.
```

- [ ] **Step 2: Update CHANGELOG Unreleased section**

Add:

```md
- Add a source metadata compatibility layer (`sourceInfo`) while preserving the stable coarse `sourceKind` API and delete safety semantics. Official Codex source-kind metadata is output-only and is not a new filter or delete authorization path.
```

- [ ] **Step 3: Update docs/local**

Record:

```md
T8-P2 sourceKind official alignment is handled as compatibility metadata, not as a replacement for stable `sourceKind`. The official model distinguishes primary `source`, optional analytics `thread_source`, subagent evidence fields, and v2 filter-only `ThreadSourceKind`. P5-P9 remain unsupported by design. npm publish and real Codex session cleanup are outside this agent's scope unless the user explicitly reassigns them.
```

---

### Task 6: Full verification and commit

**Files:**
- All modified files

- [ ] **Step 1: Run whitespace check**

```bash
git diff --check
```

Expected: no output, exit 0.

- [ ] **Step 2: Run full test suite**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Run build and typecheck**

```bash
npm run build
npx tsc --noEmit
```

Expected: both pass.

- [ ] **Step 4: Smoke check read-only behavior**

Use fixture/temp roots for smoke checks. Do not use default real `~/.codex` unless the user explicitly asks.

```bash
npm test -- tests/cli.test.ts tests/core.test.ts tests/mcp.test.ts
```

Expected: all fixture-backed source metadata and sourceKind safety tests pass. SourceKind candidate mode remains `readOnly: true`, `executionSupported: false`, and uses `candidateIds`, not `selectedIds`.

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/sources.ts src/core/sqlite.ts src/core/scan.ts tests/core.test.ts tests/cli.test.ts tests/mcp.test.ts README.md README.zh-CN.md SKILL.md docs/SAFETY.md CHANGELOG.md
git commit -m "feat: add sourceKind compatibility metadata"
```

Do not add `docs/local/*` unless the user explicitly changes the repo policy for ignored local memory.

---

## Plan self-review

- Spec coverage: The plan preserves stable `sourceKind`, adds official-aligned source metadata evidence, avoids P5-P9, and keeps delete semantics unchanged.
- Placeholder scan: No placeholder steps remain; each task includes exact files, commands, and expected outcomes.
- Type consistency: The plan uses `OfficialCodexSourceKind`, `ThreadSourceKind`, `SourceInfo`, `SourceEvidence`, `sourceInfo`, `rawSource`, `rawThreadSource`, `officialSourceKind`, `threadSourceKind`, `inferenceConfidence`, and `evidence` consistently.
- Scope check: This is a single compatibility-layer change. It does not include release prep, npm publish, or real session cleanup.
