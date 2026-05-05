# codex-sessions

[简体中文](./README.zh-CN.md)

Local Codex session management toolkit with:

- a Node/TypeScript CLI
- a local stdio MCP server
- shared core logic for scanning, project grouping, time filtering, trash, restore, purge, verifying, and deleting sessions

This project no longer ships a browser UI. The primary product is `CLI + MCP`.
It does not include a UI, TUI, detail page, incremental project scanner, or automatic stale cleanup.

## Install

```bash
npm install
npm run build
```

## CLI

Run via the built output:

```bash
node dist/cli/index.js list
node dist/cli/index.js projects
node dist/cli/index.js doctor
node dist/cli/index.js show <session-id>
node dist/cli/index.js export <session-id>
node dist/cli/index.js delete <session-id...>
node dist/cli/index.js trash-list
node dist/cli/index.js restore <trash-id-or-session-id>
node dist/cli/index.js purge <trash-id-or-session-id>
node dist/cli/index.js cleanup-index <session-id...>
node dist/cli/index.js cleanup-index <session-id...> --yes
node dist/cli/index.js cleanup-stale
node dist/cli/index.js cleanup-stale --yes
node dist/cli/index.js verify <session-id...>
```

The default Codex root is `~/.codex`. Override with `--root /path/to/.codex`.

Examples:

```bash
node dist/cli/index.js list --status active --limit 20
node dist/cli/index.js list --project /path/or/name --group-by project
node dist/cli/index.js list --updated-after 2026-04-03 --updated-before 2026-04-03
node dist/cli/index.js projects
node dist/cli/index.js doctor --root ~/.codex --json
node dist/cli/index.js show 019d5240
node dist/cli/index.js export 019d5240 --output ./backup.json
node dist/cli/index.js delete 019d5240 --trash
node dist/cli/index.js delete 019d5240 --trash --yes
node dist/cli/index.js trash-list
node dist/cli/index.js restore 019d5240 --yes
node dist/cli/index.js purge 019d5240 --yes
node dist/cli/index.js delete 019d5240 019d3de0 --yes
node dist/cli/index.js cleanup-stale
node dist/cli/index.js cleanup-stale --yes
node dist/cli/index.js verify 019d5240 --json
```

Notes:

- `delete` without `--yes` only prints a preview.
- Permanent delete remains the default for compatibility.
- `delete --trash` without `--yes` only previews moving sessions to trash; `delete --trash --yes` writes a recoverable trash bundle before deleting live session surfaces.
- `restore` and `purge` require `--yes`.
- `restore` refuses to run when any live session surface already contains the same session id or a conflicting SQLite key. There is no force overwrite mode.
- `purge` only removes the trash entry; it does not touch live sessions.
- `doctor` is read-only diagnostics. It does not delete, restore, purge, or write any files.
- `cleanup-index` and `cleanup-stale` rewrite `session_index.jsonl` and `history.jsonl`; without `--yes`, they only print a preview.
- `cleanup-index --yes` removes JSONL traces for the selected sessions without deleting raw files or SQLite rows.
- `cleanup-stale --yes` removes index rows for sessions that no longer exist in files or SQLite.
- Date-only filters such as `2026-04-03` use the local calendar day, matching CLI display. ISO datetime filters must include an explicit timezone, such as `Z` or `+08:00`; timezone-less datetime strings are rejected.

## MCP

Start the local stdio MCP server:

```bash
node dist/mcp/server.js
```

Exposed tools:

- `inspect_root`
- `list_sessions`
- `list_projects`
- `get_session`
- `export_session_backup`
- `preview_delete_sessions`
- `delete_sessions`
- `list_trash`
- `restore_sessions`
- `purge_trash`
- `cleanup_session_indexes`
- `cleanup_stale_indexes`
- `verify_sessions`

All MCP tools use the same Node core as the CLI.

`inspect_root` is read-only diagnostics. It reports root structure, SQLite table availability, trash entries, and global-state warnings without deleting, restoring, purging, or writing anything.

Destructive MCP tools require explicit confirmation:

- `delete_sessions` does nothing unless `confirm=true`.
- `delete_sessions` supports `trash=true`; without `confirm=true`, this is still preview-only.
- `restore_sessions` and `purge_trash` do nothing unless `confirm=true`.
- `cleanup_session_indexes` and `cleanup_stale_indexes` rewrite JSONL indexes and do nothing unless `confirm=true`.

## Development

```bash
npm install
npm run build
npm test
```

## License

Apache License 2.0. See [LICENSE](./LICENSE).
