# Changelog

## 0.5.2

### Added

- SQLite home resolver: supports `config.toml sqlite_home`, `CODEX_SQLITE_HOME` environment variable, and Codex root fallback, with config taking priority.
- Dual-home warning when SQLite databases exist in both the configured SQLite home and the Codex root.
- Compressed rollout file (`.jsonl.zst`) support: scan, delete, trash, and restore handle compressed archives as binary data without decompression. Compressed-only sessions use index/history summaries instead of transcript body.
- `memories_N.sqlite` recognition in `doctor` as an official memory surface; memory rows are read-only and not mutated by session cleanup.
- `SECURITY.md` with reporting guidance for local Codex session artifacts, data loss, incomplete deletion, restore conflicts, rollback failures, path handling, and local-history exposure.
- Linked the security policy from both English and Chinese README documentation sections.

### Changed

- `logs_N.sqlite` execution logs are now preserved by default and excluded from ordinary session delete scope. They remain accessible to `doctor` and audit but are not cleanup targets.
- README and SAFETY documentation updated to reflect that `verify` covers logical live-surface verification only, not byte-forensic cleanup. Documentation no longer claims unconditional coverage of all SQLite surfaces or zero orphans.

### Safety

- Logs-only residue does not belong to ordinary `delete <session-id>` semantics.
- Memory rows and Phase 2 memory outputs are read-only observability; session cleanup does not mutate them.
- Rollback remains best-effort, not crash-safe transaction.
- `remote_control_enrollments` and related pairing state are not session cleanup surfaces.

## 0.5.1

### Added

- Added a source metadata compatibility layer (`sourceInfo`) while preserving the stable coarse `sourceKind` API and delete safety semantics. Official Codex source-kind metadata is output-only and is not a new filter or delete authorization path.

## 0.5.0

### Added

- Added Codex `goals_N.sqlite` detection, doctor reporting, and `thread_goals` counting alongside `state_N.sqlite` and `logs_N.sqlite`.
- Included `goals_N.sqlite.thread_goals` in read-only session audit, root audit, explicit delete preview, root preview, verify, backup export, recoverable trash restore conflict handling, and delete-plan root fingerprint / stale detection.
- Added `codex-sessions --version` and `codex-sessions-mcp --version` for package-version verification without scanning a Codex root or starting the MCP stdio server.
- Added read-only `plan-delete --source-kind ... --limit ...` candidate plans that list `candidateIds` without turning them into delete-selected IDs.
- Added read-only MCP `plan_delete_sessions` for explicit-ID delete plans and sourceKind candidate plans.
- Added read-only MCP `preview_delete_plan` for plan files or inline plan objects, reusing CLI `preview-plan` stale detection.

### Changed

- Moved current test fixtures to the newer Codex layout where `state_5.sqlite` no longer owns `thread_goals` and `goals_1.sqlite` does.

### Safety

- SourceKind candidate plans require an explicit limit capped at 50, reject root-level `sourceKind=unknown`, reject active/current candidates into `rejectedIds`, and intentionally do not support `--write-plan` or any delete execution path.
- MCP plan tools are read-only, return `executionSupported=false`, create no preview token, do not implement `delete_sessions_by_plan`, and do not support sourceKind delete execution.
- `preview_delete_plan` returns no current `deletePreview` when `stale=true` and accepts no `confirm`, `trash`, `yes`, or `force` write semantics.
- This release does not include delete-by-plan, preview tokens, sourceKind delete execution, side/fork automatic deletion, side/fork-specific include flags, or release/cleanup automation. These remain intentionally unsupported design boundaries, not pending bugs.

## 0.4.0

### Added

- Added read-only `plan-delete` for explicit session IDs, producing a relationship-aware delete plan without executing deletion.
- Added `plan-delete --write-plan FILE` to write `codex-sessions-delete-plan.v1` audit files for later review.
- Added `preview-plan <plan-file>` to re-scan the current Codex root and report whether a saved plan is stale before showing any current delete preview.
- Added plan metadata including `planHash`, root fingerprint, selected session snapshot, selected surface counts, family edges, and exact-key global-state path metadata.
- Added stale detection for plan previews across root identity, key surface mtime/size/parseability, selected surface counts, family edges, and exact-key paths.

### Safety

- `plan-delete` and `preview-plan` are read-only. They do not delete, restore, purge, clean up, rewrite indexes, or modify global state.
- Plan files are audit materials only. They are not authorization, not preview tokens, not delete confirmations, and not accepted by any delete execution command.
- Active sessions are rejected from delete plans, and include flags only change read-only plan selection.
- This release does not add delete-by-plan, MCP plan tools, preview tokens, `--force`, sourceKind-based delete execution, side/fork-specific include flags, or release/cleanup automation.
- This release does not complete advanced family/sourceKind deletion orchestration; actual deletion remains a separate explicit-ID preview plus explicit confirmation flow.

## 0.3.3

### Added

- Added packaged safety rules for P11/P12 exact-key global-state cleanup in `docs/UNKNOWN_GLOBAL_STATE_RULES.md`.
- Added separate title metadata fields: `displayTitle`, `indexTitle`, `sqliteTitle`, `firstUserMessage`, `titleSource`, `titleMismatch`, and `titleCandidates`.
- Updated list/search behavior to use the Codex UI-searchable `displayTitle` by default while keeping detail output explicit about mismatched title sources.
- Shortened long title metadata and timeline previews in human-readable `show` output; use `show --json` for full values.
- Added read-only session family inspection through CLI `family` and MCP `get_session_family`, including parent, child, `/side`, `/fork`, archive, file, status, and source metadata.
- Added read-only family query modes for CLI `family` and MCP `get_session_family`: children, parents, subagents, full, sourceKind filtering, and impact views.
- Added child classification for generic `thread_spawn_edges` parent/child edges, derived from each child session's `sourceKind`, raw source fields, and agent metadata.
- Added compatibility fields for mixed child identities: `childType`, `childTypeLabels`, `relationshipLabels`, `missingRelations`, and `missingSurfaces`.
- Added delete preview family warnings when selected sessions have unselected parent, child, or related family sessions.
- Refined family output with compact `source` labels and broken relationship warnings for missing sessions or missing file/index surfaces.
- Added read-only residue audit through CLI `audit` and MCP `audit_session`, covering raw rollout files, shell snapshots, session indexes, history, SQLite rows, global-state refs, thread edges, family membership, and broken parent/child relations.
- Added structured audit status labels for `clean`, `present`, `partial`, `db-only`, `index-only`, `risky-global-state`, and `broken-family`.
- Added read-only root residue scanning through CLI `audit-root` and MCP `audit_root`, including default risk filtering, `--json`, `--limit`, and per-candidate audit commands.
- Added `audit-root` status/source filters plus structured summary fields: `filters`, `totalCandidatesBeforeFilter`, `totalCandidatesAfterFilter`, `byStatus`, and `bySource`.
- Added read-only root delete preview through CLI `preview-root` and MCP `preview_root_delete`, reusing `audit-root` filters to batch-preview candidate delete impact without deleting, rewriting local data, or recursively selecting family sessions.

### Changed

- Synchronized package and trash manifest tool versions.
- Synchronized MCP server metadata version.
- Ensured built CLI and MCP bin files are executable after local builds.
- Clarified preview/confirmation wording: confirmed deletes rescan and protect the current write, but no preview token binds a prior preview to a later confirmation.
- Generalized the unknown global-state rules document so it no longer contains local machine paths, dates, or live local counts.
- Updated public positioning now that Codex Desktop includes archived-chat delete: the project is described as a local residue audit, verification, and cleanup tool rather than a replacement for ordinary Desktop deletion.
- Synchronized README, README.zh-CN, Skill, example Skill, CLI help, and MCP descriptions with the new family inspection, session audit, root residue scan, root preview, and explicit preview-before-confirmation guidance.
- Changed human-readable family output from wide table rows to compact blocks; default output shortens long text and points to `--full`, `--json`, or MCP for full fields, while `--full` expands complete titles and raw source values as blocks.
- Changed `family --impact` output to explicit read-only delete-precheck groups: selected session, unselected parents, unselected children, unselected family members, missing relations, and missing surfaces.

### Fixed

- Ensured the P11/P12 safety rules document is included in npm package contents.
- Clarified audit output for valid session IDs that have no local record or residue, reporting them as `absent` instead of `clean`.
- Avoided truncating large CLI output by letting stdout flush before process exit.

## 0.3.2

### Fixed

- Corrected README wording for `/side` and `/fork`: the tool detects child relationships and can operate on explicit session IDs, but it does not recursively delete child threads automatically.
- Corrected storage names in README from `logs.sqlite` and `global_state.json` to `logs_N.sqlite` and `.codex-global-state.json`.
- Updated npm package contents so linked public docs, Skill entrypoint, and Skill template are included in package builds.
- Synchronized `package-lock.json` with the published package name.
- Updated public Skill instructions to prefer the installed `codex-sessions` CLI, with repository commands kept as the development path.
- Removed stale ClawHub package contents from the clean Skill publish surface.

### Notes

- This version is a post-release cleanup for the npm, GitHub, and ClawHub publish surfaces.
- Memory-related cleanup remains intentionally unchanged.

## 0.3.1

### Added

- Added read-only root diagnostics through CLI `doctor` and MCP `inspect_root`.
- Added project grouping, date filters, and status filters.
- Added recoverable trash deletion, restore, and purge flows.
- Added cleanup preview and explicit confirmation for JSONL index rewrites.
- Added warnings for unknown global-state references.
- Added public Skill packaging through `SKILL.md` and `agents/openai.yaml`.
- Added a public Skill template under `examples/`.

### Changed

- Updated compatibility with current Codex SQLite storage, including `state_N.sqlite` and `logs_N.sqlite`.
- Synchronized README, README.zh-CN, MCP behavior, and Skill guidance.
- Hardened delete and restore coverage across JSONL indexes, raw session files, SQLite rows, global state, and shell snapshots.

### Safety

- Destructive writes require `--yes` in the CLI or `confirm=true` in MCP.
- Restore performs conflict checks before writing and has no force overwrite mode.
- Unknown global-state references are reported as warnings only.
- The project continues to avoid UI, TUI, automatic cleanup, and automatic purge behavior.
