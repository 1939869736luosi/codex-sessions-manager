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
- Public evidence: [v0.7.1 release](https://github.com/1939869736luosi/codex-sessions-manager/releases/tag/v0.7.1), reviewed/tag commit `844f6f9a117aad6a7972dbf6a2adeb25ff09d42c`, and npm `latest`/`security-verify` version `0.7.1`.

## v0.8.0 completed

- Permanent delete removes only exact `logs.thread_id` rows; trash retains them, restore leaves them unchanged, and final purge removes them unless the ID is live again.
- `monthly-review` combines bounded root audit and preview into one read-only periodic report.
- Root and doctor warnings default to at most five samples; full warning details require an explicit request.
- Session memory association reports source and Phase 2 selection metadata without raw memory, and post-delete validation confirms only the observable retained association.
- Active and archived rollout files with the same session ID are reported as `storage-conflict`, not normal archive inventory.
- Public evidence: [v0.8.0 release](https://github.com/1939869736luosi/codex-sessions-manager/releases/tag/v0.8.0), [merged PR #10](https://github.com/1939869736luosi/codex-sessions-manager/pull/10), reviewed/tag commit `f2615e1c95f2a03be98eadafa442610caaa5a359`, and npm `latest`/`security-verify` version `0.8.0`.

## Next high-value work

- **Official-delete verifier:** on a temporary Codex home, create and officially delete synthetic threads, then report exactly which rollout, SQLite, logs, memory, snapshot, index, and global-state surfaces remain or cannot be confirmed. Real session IDs may be used later as explicitly selected read-only calibration samples; supplying an ID never authorizes deletion.
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
- No memory, remote-control, external-agent-import, unowned log, WAL, free-page, or byte-forensic cleanup.
- No direct editing of `memories_N.sqlite`, `MEMORY.md`, `memory_summary.md`, `raw_memories.md`, or rollout summaries as the normal memory control surface.
- No automatic public issue or code modification from compatibility-watch workflows.

## Historical plans

- `docs/SPEC-v0.6.0-cli-first.md` is completed and archived.
- `docs/superpowers/plans/2026-05-25-t8-p2-sourcekind-compatibility-layer.md` is historical evidence. Its unchecked boxes do not override this roadmap or tested current behavior.
