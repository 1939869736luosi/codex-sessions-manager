# codex-sessions

[简体中文](./README.zh-CN.md)

Local Codex session management toolkit with:

- a Node/TypeScript CLI
- a local stdio MCP server
- shared core logic for scanning, previewing, exporting, verifying, and deleting sessions

This project no longer ships a browser UI. The primary product is `CLI + MCP`.

## Install

```bash
npm install
npm run build
```

## CLI

Run via the built output:

```bash
node dist/cli/index.js list
node dist/cli/index.js show <session-id>
node dist/cli/index.js export <session-id>
node dist/cli/index.js delete <session-id...>
node dist/cli/index.js cleanup-index <session-id...>
node dist/cli/index.js cleanup-stale
node dist/cli/index.js verify <session-id...>
```

The default Codex root is `~/.codex`. Override with `--root /path/to/.codex`.

Examples:

```bash
node dist/cli/index.js list --status active --limit 20
node dist/cli/index.js show 019d5240
node dist/cli/index.js export 019d5240 --output ./backup.json
node dist/cli/index.js delete 019d5240 019d3de0 --yes
node dist/cli/index.js cleanup-stale
node dist/cli/index.js verify 019d5240 --json
```

Notes:

- `delete` without `--yes` only prints a preview.
- `cleanup-index` only rewrites `session_index.jsonl` and `history.jsonl`.
- `cleanup-stale` removes index rows for sessions that no longer exist in files or SQLite.

## MCP

Start the local stdio MCP server:

```bash
node dist/mcp/server.js
```

Exposed tools:

- `list_sessions`
- `get_session`
- `export_session_backup`
- `preview_delete_sessions`
- `delete_sessions`
- `cleanup_session_indexes`
- `cleanup_stale_indexes`
- `verify_sessions`

All MCP tools use the same Node core as the CLI.

## Development

```bash
npm install
npm run build
npm test
```

## License

Apache License 2.0. See [LICENSE](./LICENSE).
