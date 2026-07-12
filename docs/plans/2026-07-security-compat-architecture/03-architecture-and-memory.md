# 03 — Architecture and memory

Status: **completed**
Release: v0.7.0

## CLI-first, not CLI-only

CLI is the preferred public interface for:

- all locally parseable semantic JSON, with completeness diagnostics for unsupported, malformed, compressed-only, or per-item-truncated content;
- scripts and shell pipelines;
- canonical JSONL event streams;
- JSON recovery bundles that preserve UTF-8 content and base64-encoded binary bytes;
- large local results that should not be placed in model context.

MCP remains useful for:

- bounded structured reads;
- host-native tool discovery and authorization;
- read-only/admin profiles;
- explicitly approved management operations;
- concise server instructions and resources.

MCP does not shell out to CLI, and the project does not expose a general `run_command` tool.

## Shared application operations

The shared application layer contains operations for list, session detail, doctor, audit, planning, export, verification, recovery, delete, trash, restore, purge, index cleanup, and canonical events. Each adapter exposes only the operations appropriate to its boundary: export is CLI-only, and MCP exposes canonical events only through bounded event pages.

The shared layer owns validation, trusted-root selection, permissions, planning, journaling, execution, verification, warnings, and stable error semantics. Adapters own only argument/schema handling and human, JSON, or structured presentation.

Characterization and parity tests prevent either adapter from:

- changing mutation semantics;
- bypassing full-ID or active-session rules;
- interpreting unsafe paths differently;
- converting committed-but-partially-verified work into a pre-mutation failure;
- returning an unbounded structured result.

## Final MCP boundary

Every MCP structured result has a final 256 KiB envelope limit and a 200-items-per-collection limit. Explicit multi-session operations accept at most 50 IDs. Trash listing defaults to 50 entries.

The unbounded MCP backup response was removed. Exact backups remain available through CLI export.

## Canonical event reads

`events <full-session-id>` provides a complete local JSONL stream or a private `0600` output file. It rejects prefixes, duplicate sources, symlinks, hard links, root escapes, and compressed-only sources that cannot be semantically read.

MCP event reads remain authenticated, item-bounded, and byte-bounded, and report oversized omission rather than returning a partial event as complete.

## Read-only memory phase

v0.7.0 deliberately implements observation and association only.

Codex memory processing has two relevant stages for this document: Stage 1 stores per-session candidate observations, while Phase 2 may consolidate selected observations into durable summaries and generated memory files. Doctor reports:

- whether memory enablement is known;
- whether a memory database exists;
- whether its schema is recognized;
- bounded stage1 and job statistics.

Session detail reports a conservative `memoryLink`:

- `enabled`;
- `stage1Present`;
- `rolloutSummaryPresent`;
- `phase2Influence` as `known`, `none`, or `unknown`;
- `retainedAfterSessionDelete: true`.

Database presence does not prove enablement. Unknown or future `memory_mode` values remain unknown. Stage 1 selection does not prove final Phase 2 influence. Raw memory and rollout-summary text are never returned through this feature.

Ordinary delete previews, plans, results, and verification state that memory is retained. Session cleanup does not mutate memory databases, jobs, `MEMORY.md`, `memory_summary.md`, raw-memory files, rollout summaries, or memory-generated Skills.

## Doctor and Skill context controls

- Doctor defaults to counts, risks, bounded warnings, and at most five samples per reference class.
- Complete diagnostic arrays require `--details` or MCP `includeDetails=true`.
- The user-facing Skill remains a short router plus safety rules.
- Long reference material stays in packaged docs and is read only when needed.
- Compatibility maintenance prompts do not live in the ordinary user Skill context.
- Repository agent guidance defaults to one agent, treats three-way concurrency as a ceiling, and forbids stacking native Plan, Superpowers, Matt Pocock-style planning, and Ultra-style orchestration.
- Release-level independent review runs once per release instead of once per small commit.

## Governance

v0.7.0 adds or restores:

- [`ARCHITECTURE.md`](../../../ARCHITECTURE.md);
- [`ROADMAP.md`](../../../ROADMAP.md);
- [`CONTRIBUTING.md`](../../../CONTRIBUTING.md);
- issue and pull-request templates;
- release and security guidance;
- Dependabot and compatibility reporting;
- an explicit statement that official Codex owns normal thread management and normal permanent deletion, while this project handles independent verification, recovery, and exceptional local cleanup.

## Acceptance result

- CLI JSON and MCP structured results passed normalized parity tests.
- Unsafe-path, stale-plan, partial-verification, and recovery-required outcomes match across adapters.
- Large doctor and MCP fixtures remain bounded.
- Memory tests cover absent DBs, unrecognized schemas, enablement uncertainty, stage1 evidence, and unknown Phase 2 provenance.
- Ordinary deletion tests do not modify memory surfaces.
- Final reviewed package contained 125 files and matched registry bytes exactly.
- Final verdict: **GO for v0.7.0**.
