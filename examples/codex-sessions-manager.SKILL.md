---
name: codex-sessions-manager
description: Use this skill when the user wants to inspect, search, export, verify, clean up, delete, restore, or purge local Codex sessions, including auditing leftovers after Codex Desktop's built-in delete.
---

# Codex Sessions Manager

This is a template Skill for using the `codex-sessions` toolkit from an agent workflow. Replace placeholders with paths for the target machine.

## Scope

Use this Skill for local Codex session history stored under a Codex root such as:

```text
<path-to-codex-root>
```

Use the installed CLI:

```bash
npm install -g codex-sessions-manager
```

This provides:

```text
codex-sessions
codex-sessions-mcp
```

For local development, use the repository from:

```text
<path-to-codex-sessions-repo>
```

This Skill is for Codex session inspection and safety operations. Codex Desktop has a built-in delete action for ordinary archived-chat deletion; this Skill is for local verification, exact ID cleanup, batch cleanup, trash/restore, and residue audits. It is not for generic chat history, non-Codex clients, or editing the current live conversation.

## Preferred Order

Prefer MCP tools when the `codex-sessions` MCP server is available:

- `inspect_root`
- `list_sessions`
- `list_projects`
- `get_session`
- `get_session_family` (read-only session family inspection)
- `audit_session` (read-only residue audit)
- `audit_root` (read-only root residue scan; candidates are not deletion recommendations)
- `preview_root_delete` (read-only root delete preview; never deletes and never recommends deletion)
- `export_session_backup`
- `preview_delete_sessions`
- `delete_sessions`
- `list_trash`
- `restore_sessions`
- `purge_trash`
- `cleanup_session_indexes`
- `cleanup_stale_indexes`
- `verify_sessions`

Use CLI only when MCP is unavailable or blocked.

For Codex `/side` conversations, treat the parent thread and side child thread as separate sessions. Do not assume parent operations include side child transcripts. If the user wants both handled, identify the child session IDs first and include them in the preview or confirmed operation. If family output reports a broken relationship warning, tell the user the relationship record exists but the related session may be missing files, index rows, or full session records.

Use `get_session_family` first when the request mentions parent, child, `/side`, or `/fork` relationships. It is read-only and does not select related sessions for write operations. Human CLI output uses short `source` labels; use JSON/MCP output when the full raw `source` field is needed.

For session titles, treat `displayTitle` as the default user-facing title. It prefers `session_index.jsonl.thread_name`, which is usually closest to Codex UI search. When showing one session in detail, include `indexTitle`, `sqliteTitle`, `firstUserMessage`, `titleSource`, `titleMismatch`, and `titleCandidates` if the tool returns them. Human-readable CLI output may shorten long title fields and timeline previews; use JSON/MCP output for full values.

## CLI Fallback

Prefer the installed CLI:

```bash
codex-sessions doctor --root <path-to-codex-root>
codex-sessions list --root <path-to-codex-root> --limit 20
codex-sessions projects --root <path-to-codex-root>
codex-sessions show <session-id> --root <path-to-codex-root>
codex-sessions family <session-id> --root <path-to-codex-root>
codex-sessions family <session-id> --root <path-to-codex-root> --json
codex-sessions audit <session-id> --root <path-to-codex-root>
codex-sessions audit <session-id> --root <path-to-codex-root> --json
codex-sessions audit-root --root <path-to-codex-root>
codex-sessions audit-root --root <path-to-codex-root> --json --limit 50
codex-sessions audit-root --root <path-to-codex-root> --status risky-global-state --limit 50
codex-sessions audit-root --root <path-to-codex-root> --source global-state-unknown --limit 50
codex-sessions preview-root --root <path-to-codex-root>
codex-sessions preview-root --root <path-to-codex-root> --json --limit 50
codex-sessions preview-root --root <path-to-codex-root> --status db-only --limit 20
codex-sessions preview-root --root <path-to-codex-root> --source global-state-unknown --limit 20
codex-sessions export <session-id> --root <path-to-codex-root> --output ./backup.json
codex-sessions delete <session-id> --root <path-to-codex-root>
codex-sessions delete <session-id> --root <path-to-codex-root> --trash
codex-sessions delete <session-id> --root <path-to-codex-root> --trash --yes
codex-sessions trash-list --root <path-to-codex-root>
codex-sessions restore <trash-id-or-session-id> --root <path-to-codex-root> --yes
codex-sessions purge <trash-id-or-session-id> --root <path-to-codex-root> --yes
codex-sessions cleanup-index <session-id> --root <path-to-codex-root>
codex-sessions cleanup-index <session-id> --root <path-to-codex-root> --yes
codex-sessions cleanup-stale --root <path-to-codex-root>
codex-sessions cleanup-stale --root <path-to-codex-root> --yes
codex-sessions verify <session-id> --root <path-to-codex-root>
```

When working from a cloned repository instead, run commands from:

```bash
cd <path-to-codex-sessions-repo>
```

Examples:

```bash
node dist/cli/index.js doctor --root <path-to-codex-root>
node dist/cli/index.js list --root <path-to-codex-root> --limit 20
node dist/cli/index.js projects --root <path-to-codex-root>
node dist/cli/index.js show <session-id> --root <path-to-codex-root>
node dist/cli/index.js family <session-id> --root <path-to-codex-root>
node dist/cli/index.js family <session-id> --root <path-to-codex-root> --json
node dist/cli/index.js audit <session-id> --root <path-to-codex-root>
node dist/cli/index.js audit <session-id> --root <path-to-codex-root> --json
node dist/cli/index.js audit-root --root <path-to-codex-root>
node dist/cli/index.js audit-root --root <path-to-codex-root> --json --limit 50
node dist/cli/index.js audit-root --root <path-to-codex-root> --status risky-global-state --limit 50
node dist/cli/index.js audit-root --root <path-to-codex-root> --source global-state-unknown --limit 50
node dist/cli/index.js preview-root --root <path-to-codex-root>
node dist/cli/index.js preview-root --root <path-to-codex-root> --json --limit 50
node dist/cli/index.js preview-root --root <path-to-codex-root> --status db-only --limit 20
node dist/cli/index.js preview-root --root <path-to-codex-root> --source global-state-unknown --limit 20
node dist/cli/index.js export <session-id> --root <path-to-codex-root> --output ./backup.json
node dist/cli/index.js delete <session-id> --root <path-to-codex-root>
node dist/cli/index.js delete <session-id> --root <path-to-codex-root> --trash
node dist/cli/index.js delete <session-id> --root <path-to-codex-root> --trash --yes
node dist/cli/index.js trash-list --root <path-to-codex-root>
node dist/cli/index.js restore <trash-id-or-session-id> --root <path-to-codex-root> --yes
node dist/cli/index.js purge <trash-id-or-session-id> --root <path-to-codex-root> --yes
node dist/cli/index.js cleanup-index <session-id> --root <path-to-codex-root>
node dist/cli/index.js cleanup-index <session-id> --root <path-to-codex-root> --yes
node dist/cli/index.js cleanup-stale --root <path-to-codex-root>
node dist/cli/index.js cleanup-stale --root <path-to-codex-root> --yes
node dist/cli/index.js verify <session-id> --root <path-to-codex-root>
```

## Safety Rules

- Run `inspect_root` or CLI `doctor` before delete, restore, purge, or cleanup when Codex storage may have changed.
- `get_session_family` and CLI `family` are read-only. They do not delete, export, restore, or select related sessions automatically.
- `audit_session` and CLI `audit` are read-only. They report local residue after official UI delete/archive actions and must not rewrite files, SQLite, shell snapshots, or global state.
- `audit_root` and CLI `audit-root` are read-only. They scan for likely residue candidates across a Codex root and must not delete, rewrite, or select parent/child sessions automatically.
- `audit_root` / `audit-root` status and source filters only narrow displayed candidates. Multiple statuses or multiple sources use OR; combining status and source uses AND. A matching candidate is not a deletion list entry or deletion recommendation; it still needs per-session audit or read-only preview before any cleanup decision.
- `preview_root_delete` and CLI `preview-root` are read-only. They reuse `audit-root` filters to build a batch delete preview, but do not delete, do not rewrite JSONL, SQLite, shell snapshots, or global state, do not accept `--yes`, do not recommend deleting any session, and do not recursively select parent, child, or family sessions.
- A `preview-root` result is not a deletion recommendation. Actual deletion requires the user to run `delete ... --yes` explicitly.
- Delete previews warn when selected sessions have unselected parent, child, or family sessions, and when relationship edges point at missing sessions or missing file/index surfaces.
- `delete` without `--yes` is preview-only.
- Permanent delete remains available, but prefer recoverable deletion with `--trash --yes`.
- MCP `delete_sessions` requires `confirm=true` to execute. Use `trash=true` for recoverable deletion.
- `restore` and `purge` require `--yes` in CLI mode.
- MCP `restore_sessions` and `purge_trash` require `confirm=true`.
- Restore refuses live session conflicts and SQLite key conflicts. There is no force overwrite mode.
- `purge` removes only the trash entry and must not touch live sessions.
- `cleanup-index` and `cleanup-stale` rewrite JSONL indexes. They do not delete raw files or SQLite rows, but they still require `--yes`.
- MCP `cleanup_session_indexes` and `cleanup_stale_indexes` require `confirm=true` to rewrite indexes.
- Unknown global-state references are warnings only. Do not edit unknown global-state keys automatically.
- If `audit`, `audit-root`, `preview-root`, `verify`, `doctor`, or `inspect_root` reports warnings, tell the user. Do not claim the root is fully clean.
- Do not output chat content when reporting audit, doctor, verify, or global-state warnings.
- `/side` conversations may be stored as separate child threads. Current CLI/MCP behavior does not automatically recurse from parent to side child threads.

## Non-Goals

Do not build or imply support for:

- UI
- TUI
- detail pages
- incremental project scanning
- automatic stale cleanup
- automatic trash purge
- force overwrite restore
