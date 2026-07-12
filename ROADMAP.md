# Roadmap

This file is the current project tracker. Historical plans remain evidence, not an active checklist.

## Completed with public evidence

- CLI-first product positioning, read-only/admin MCP profiles, ecosystem adapters, and packaged Skill: v0.6.0 history and tests.
- Path/root safety, full-ID confirmation, active-session protection, recoverable mutation journal, crash recovery, cross-platform build, CI, package allowlist, and coordinated pre-disclosure security handling: v0.6.1/v0.6.2 security line.
- Codex 0.144.1 timeline/history/recency compatibility, bounded MCP previews, TOML Codex adapter, official Skill packaging, and tracked compatibility fixtures: v0.6.3 release.
- Independent npm candidate verification and stale-promotion protection: recovery workflows on `main`.

## v0.7.0 completed

- CLI and MCP use shared application operations with normalized parity tests.
- CLI keeps all locally parseable semantic JSON, canonical event-stream, pipeline, and JSON recovery-bundle paths; embedded source files preserve their text or binary bytes. MCP keeps bounded structured reads.
- Session detail and doctor expose conservative read-only memory association without raw memory content.
- Doctor is summary-first and requires explicit details for complete reference arrays.
- Canonical session event streaming is available through CLI, while MCP event reads remain bounded.
- Architecture, roadmap, contribution, issue, PR, release, dependency-management, and agent-governance guidance are tracked.
- The installed MCP-first Skill was replaced after release by the repository CLI-first version and shared across local Skill entrypoints.
- Public evidence: [v0.7.0 release](https://github.com/1939869736luosi/codex-sessions-manager/releases/tag/v0.7.0) and [PR #3](https://github.com/1939869736luosi/codex-sessions-manager/pull/3).

The maintained implementation record is split under [`docs/plans/2026-07-security-compat-architecture/`](docs/plans/2026-07-security-compat-architecture/README.md).

## v0.7.1 corrective patch

- Preserve `passed`, `partial`, and `failed` verification truth when recovery only finalizes a stale committed journal; unknown or missing evidence becomes `not_run`.
- Persist restore and purge verification outcomes before releasing the mutation lock.
- Correct the published positioning now that official Codex 0.144.1 provides substantial permanent thread deletion.
- Make every compatibility review also classify capabilities that official Codex replaced, narrowed, or newly enabled.
- Align README, architecture, release guidance, package description, and historical implementation records with actual behavior.

## Next high-value work

- **Official-delete verifier:** on a temporary Codex home, create and officially delete synthetic threads, then report exactly which rollout, SQLite, logs, memory, snapshot, index, and global-state surfaces remain or cannot be confirmed.
- **Periodic residue review:** make the monthly workflow simple: official delete first, root audit, risk-sorted residual candidates, batch preview, recoverable cleanup, final verification receipt.
- **Warning aggregation:** keep real-root hard-link and unsafe-path warnings from flooding normal output; default to counts plus at most five samples and expand only on request.
- **Memory provenance and delete verification:** show the available per-thread extraction and rollout-summary evidence, label uncertain final-memory provenance as `unknown`, and verify only observable reconsolidation changes after official thread deletion. Do not directly edit generated memory or its database or promise paragraph-level attribution.
- **Small Codex behavior check:** for each pinned stable Codex version, generate its App Server schema and run create/read/archive/unarchive/delete against a temporary home. Expand to other hosts only after a real adapter failure justifies it.

## Conditional future ideas

- **Logs / Loop Lens:** a read-only report that finds repeated failed commands, tool retries, excessive subagents, repeated planning frameworks, and other token/context waste. It does not delete logs.
- **Amp inspection:** only investigate Amp storage when a real Amp audit or recovery need appears and official external-agent import is insufficient.
- **Multi-host behavior tests:** do not build a large platform. Add one real Claude/Amp/Factory smoke only when a supported adapter has a concrete contract to protect.
- **Stronger file-race protection:** only relevant if the project promises protection against another process deliberately swapping files during deletion. The current personal-tool threat model does not require it.
- **Large cross-host handoff:** do not add a custom cursor protocol. Prefer a private handoff file; reconsider only when a non-Codex host proves that bounded MCP plus files cannot work.
- **Direct memory mutation:** blocked until official per-entry or per-session management semantics exist or a separately reviewed provenance, backup, reconsolidation, and recovery design is approved.

## Explicitly rejected or deferred

- No generic MCP `run_command` tool.
- No MCP shell-out to CLI.
- No unbounded whole-session MCP response.
- No automatic delete authorization from `sourceKind`, family, audit, plan files, or preview output.
- No ordinary cleanup of logs, memories, remote-control state, or external-agent imports.
- No direct editing of `memories_N.sqlite`, `MEMORY.md`, `memory_summary.md`, `raw_memories.md`, or rollout summaries as the normal memory control surface.
- No automatic public issue or code modification from compatibility-watch workflows.

## Historical plans

- `docs/SPEC-v0.6.0-cli-first.md` is completed and archived.
- `docs/superpowers/plans/2026-05-25-t8-p2-sourcekind-compatibility-layer.md` is historical evidence. Its unchecked boxes do not override this roadmap or tested current behavior.
