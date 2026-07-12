# 04 — Future projects

Status: **not implemented by the v0.7.0 program**

These items were intentionally separated from the completed releases. They are not unchecked tasks inside v0.7.0 and should not be started by quietly adding a flag to ordinary session cleanup.

## Memory mutation

Plain meaning: change, correct, or delete what Codex remembers across tasks.

Potential scope:

- correction, deletion, restore, and provenance;
- jobs and stage1 rows;
- rollout summaries and Phase 2 outputs;
- `MEMORY.md`, `memory_summary.md`, raw-memory files, and generated Skills;
- multi-session provenance;
- backup, redaction, verification, and crash recovery.

Current decision: do not implement direct mutation. Official Codex can control memory use/generation per task, reset all memories, and remove one deleted thread's extraction input before background reconsolidation. It does not provide a supported per-entry final-memory editor. Generated files may combine several sessions and may be rebuilt, so manual file or SQLite editing is not a reliable deletion method.

Re-entry requirement: the compatibility and replacement review finds a stable official granular contract, or a separate design proves provenance, reconsolidation, backup, verification, and recovery without guessing.

## Logs / Loop Lens

Plain meaning: explain why a task wasted time or tokens by finding repeated failed commands, tool retries, excessive subagents, duplicated planning/review frameworks, and recurring failure points.

Potential scope: read-only analysis of `logs_N.sqlite` for execution patterns and debugging.

Boundary: logs are retained observation data, not ordinary cleanup residue. No delete support should be inferred from the analysis project.

## Amp Explorer

Plain meaning: inspect, search, and export Amp conversations that are available on the local machine, then measure what local data cannot cover.

Potential scope: Amp session formats, provenance, adapter behavior, Skill discovery, and optional deferred MCP loading.

Status: **corrected initial plan, not yet refined or approved for implementation**.

Corrected conclusion: Amp's native cloud-backed thread discovery and reading tools are host capabilities, not a public dependency that this project should try to call or reproduce. That does not block an open-source Amp explorer. Threads already persisted under the user's local Amp data root can be discovered, parsed, indexed, searched, and exported through a local read-only adapter. This may be less native and may not cover server-only threads, but it is the smallest evidence-based starting point. Official Codex external-session import does not replace this Amp-specific audit need.

Initial scope:

- detect the installed Amp version and candidate local data roots without reading credentials;
- inventory local thread files, history files, and candidate metadata surfaces;
- determine which surfaces contain complete transcripts versus prompts, indexes, caches, or active-session state;
- parse locally available thread metadata and message blocks conservatively, warning on unknown variants instead of guessing;
- normalize only fields whose semantics are proven by host evidence;
- provide read-only list, inspect, search, doctor, and export operations for locally discoverable Amp threads;
- report provenance and completeness explicitly, including whether local coverage is complete, partial, or unknown;
- compare representative local results with Amp's native thread search/read behavior to measure the real coverage gap.

Initial sequence:

1. **Local evidence audit:** use an isolated profile or protected read-only snapshot to count surfaces, sample schemas, identify format variants, and compare recent and older local threads with Amp's feed/native search.
2. **Fixture and contract design:** create synthetic or irreversibly redacted fixtures for each proven variant; define capability and completeness reporting before implementation.
3. **Read-only adapter:** implement detection, parsing, normalization, list, inspect, search, doctor, and export without mutation or credential access.
4. **Coverage evaluation:** run the same representative IDs and queries through the adapter and Amp's native behavior. Record missing server-only threads and semantic mismatches instead of hiding them.
5. **Conditional completion design:** only if the measured gap matters, separately evaluate an official Amp plugin or SDK-based capture path for known or newly observed thread IDs.
6. **Packaging:** after the provider contract is stable, expose it through the existing CLI-first Skill. Add a bounded MCP surface only if a real host workflow requires it.

Out of initial scope: a standalone web UI and archive/delete/edit/restore or any other mutation of Amp-owned data.

Boundaries:

- Do not infer Amp semantics from Codex data, generic `.agents` conventions, filenames alone, or another project's reverse-engineered schema.
- Do not assume the local data root is a complete cloud mirror. Missing local data means coverage is partial or unknown, not that a thread does not exist.
- Do not depend on Amp's internal `find_thread`/`read_thread` implementation, undocumented `/api/internal` endpoints, or tokens extracted from Amp credential files.
- Do not directly rewrite Amp-owned thread JSON. The initial project is read-only even when a local file appears editable.
- Do not publish real private threads, prompts, tool results, home paths, repository secrets, or credential material as fixtures or test artifacts.
- Keep provider parsing behind an Amp adapter and keep manager-owned indexes or metadata separate from Amp-owned state.

Initial acceptance evidence:

- synthetic or irreversibly redacted fixtures represent every local Amp schema variant that the audit claims to support;
- the adapter never reads Amp credential files and performs no writes to Amp-owned paths;
- unknown message blocks produce bounded warnings rather than silent loss or invented semantics;
- search and export identify their source and completeness status;
- a documented comparison states what local discovery can and cannot find relative to Amp's native behavior.

## Real host harness

Plain meaning: let a temporary test account create, read, archive, restore, and delete a fake conversation, then check what the real application changed. It is an automated compatibility check, not a new user-facing session manager.

Current decision: build only a small Codex check using a temporary home and the pinned stable App Server schema. Add Claude, Amp, or Factory only after one of their supported adapters has a concrete failure to reproduce.

Entry requirement: isolated profiles or temporary homes, explicit read/write boundaries, version capture, deterministic fixtures, and no use of private real sessions as public artifacts.

## Stronger TOCTOU protection

TOCTOU means “time of check to time of use”: a filesystem entry changes after validation but before the operation uses it. Descriptor-relative operations resolve and modify descendants through already opened directory handles rather than reconstructing ordinary path strings.

Plain meaning: protect against another local process deliberately replacing a file in the tiny gap between “this path is safe” and “delete this file.” The stronger implementation would keep an operating-system handle to the already checked directory instead of looking the path up again.

Current decision: defer. This does not help normal monthly cleanup enough to justify native cross-platform code. Reconsider only if the product promises protection against a malicious same-user process actively racing deletion.

Boundary: the current Node safety model must remain documented accurately. Native work must not be used to retroactively claim the existing implementation was unsafe for its stated threat model, nor should it be added without cross-platform ownership and packaging plans.

## MCP resource or cursor handoff

Plain meaning: when a conversation is too large to return at once, return the first part plus a continuation marker, then ask for the next part later. A cursor is only that continuation marker; it is not a new kind of session or memory.

Current decision: keep the existing small `get_session_events_page` interface, which returns one bounded block plus a `nextCursor` bookmark for the following block. Do not expand it into a second resource server or a new cross-host handoff protocol. Official Codex already reads other threads and App Server has experimental turn/item pagination. For non-Codex hosts, prefer a private handoff file. Reconsider a larger design only after a real host proves that the existing bounded page plus files is insufficient.

Entry requirement: evidence that bounded MCP plus CLI JSON/export/file workflows are insufficient in real use. Avoid adding a complex paging protocol only because complete sessions can be large.

## Suggested order

1. Official-delete verifier and small Codex behavior check.
2. Warning aggregation and periodic residue-review workflow.
3. Memory provenance and official-delete reconsolidation verification, still read-only.
4. Logs / Loop Lens read-only analysis.
5. Amp local-evidence audit and read-only Explorer adapter when Amp work becomes the selected project; add plugin/SDK completion only if measured local coverage is insufficient.
6. Broader multi-host checks, a larger custom handoff system, native file-race protection, and direct memory mutation only when their entry conditions are met.

Each project should have its own design, fixtures, failure model, acceptance criteria, and release-level review. None inherits deletion authorization from the completed session-cleanup work.
