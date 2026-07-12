# Roadmap

This file is the current project tracker. Historical plans remain evidence, not an active checklist.

## Completed with public evidence

- CLI-first product positioning, read-only/admin MCP profiles, ecosystem adapters, and packaged Skill: v0.6.0 history and tests.
- Path/root safety, full-ID confirmation, active-session protection, recoverable mutation journal, crash recovery, cross-platform build, CI, package allowlist, and private security release process: v0.6.1/v0.6.2 security line.
- Codex 0.144.1 timeline/history/recency compatibility, bounded MCP previews, TOML Codex adapter, official Skill packaging, and tracked compatibility fixtures: v0.6.3 candidate.
- Independent npm candidate verification and stale-promotion protection: recovery workflows on `main`.

## 0.7.0 in progress

- Migrate CLI and MCP to shared application operations with normalized parity tests.
- Keep CLI complete-output paths and MCP bounded structured reads.
- Add read-only session memory linkage and doctor memory statistics without raw memory content.
- Make doctor summary-first; require explicit details for full reference arrays.
- Preserve and harden canonical session event streaming from the local development branch.
- Add architecture, roadmap, contribution, issue, PR, release, and dependency-management guidance.
- Replace stale installed MCP-first Skill copies after release and verify canonical copies across supported hosts.

## Separate future designs

- **Memory mutation:** correction, deletion, restore, provenance, jobs, stage1, Phase 2 summaries, `MEMORY.md`, `memory_summary.md`, Skill propagation, backup, redaction, and recovery.
- **Logs / Loop Lens:** read-only analysis of `logs_N.sqlite`; not ordinary cleanup.
- **Amp Explorer:** Amp session format, provenance, and adapter capabilities.
- **Host harness:** real Codex, Claude, Amp, Factory, and other host behavior tests.
- **Stronger TOCTOU protection:** descriptor-relative native filesystem operations if the threat model expands to malicious same-user continuous races.
- **MCP resource handoff:** only if bounded MCP plus CLI/file workflows prove insufficient.

## Explicitly rejected or deferred

- No generic MCP `run_command` tool.
- No MCP shell-out to CLI.
- No unbounded whole-session MCP response.
- No automatic delete authorization from `sourceKind`, family, audit, plan files, or preview output.
- No ordinary cleanup of logs, memories, remote-control state, or external-agent imports.
- No automatic public issue or code modification from compatibility-watch workflows.

## Historical plans

- `docs/SPEC-v0.6.0-cli-first.md` is completed and archived.
- `docs/superpowers/plans/2026-05-25-t8-p2-sourcekind-compatibility-layer.md` is historical evidence. Its unchecked boxes do not override this roadmap or tested current behavior.
