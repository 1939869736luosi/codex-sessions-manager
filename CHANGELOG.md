# Changelog

## Unreleased

### Added

- Added separate title metadata fields: `displayTitle`, `indexTitle`, `sqliteTitle`, `firstUserMessage`, `titleSource`, `titleMismatch`, and `titleCandidates`.
- Updated list/search behavior to use the Codex UI-searchable `displayTitle` by default while keeping detail output explicit about mismatched title sources.
- Shortened long title metadata and timeline previews in human-readable `show` output; use `show --json` for full values.
- Added read-only session family inspection through CLI `family` and MCP `get_session_family`, including parent, child, `/side`, `/fork`, archive, file, status, and source metadata.
- Added delete preview family warnings when selected sessions have unselected parent, child, or related family sessions.
- Refined family output with compact `source` labels and broken relationship warnings for missing sessions or missing file/index surfaces.

### Changed

- Updated public positioning now that Codex Desktop includes archived-chat delete: the project is described as a local residue audit, verification, and cleanup tool rather than a replacement for a missing built-in delete button.
- Synchronized README, README.zh-CN, Skill, example Skill, and the installed local Skill with the new family inspection guidance.

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
