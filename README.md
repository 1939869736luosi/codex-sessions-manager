# codex-sessions-manager

[简体中文](./README.zh-CN.md)

> Codex has no built-in way to delete sessions. Archive ≠ delete. Your `~/.codex` grows forever.

**codex-sessions-manager** gives you full lifecycle control over local Codex sessions — list, filter, export, delete, trash, restore, verify, and cleanup — via CLI or MCP server.

## Why this exists

- Codex only offers "archive", not delete ([openai/codex#8784](https://github.com/openai/codex/issues/8784))
- Manually deleting files leaves orphaned JSONL index entries, SQLite rows, and global state references
- This tool handles **all four storage layers** properly: raw files, JSONL indexes, SQLite records, and global state

## Quick Start

```bash
# Install globally
npm install -g codex-sessions-manager

# List recent sessions
codex-sessions list --limit 10

# Preview what deletion would do (safe, no changes)
codex-sessions delete <session-id>

# Actually delete (with recoverable trash)
codex-sessions delete <session-id> --trash --yes

# Restore from trash if you change your mind
codex-sessions restore <session-id> --yes
```

## Features

| Feature | Description |
|---------|-------------|
| **List & filter** | By project, status, time range; group by project |
| **Export** | Backup any session to JSON |
| **Delete** | Permanent or recoverable trash — your choice |
| **Restore** | Undo trash deletion with conflict detection |
| **Verify** | Check if a session has orphaned files/indexes/DB rows |
| **Cleanup** | Remove stale index entries without touching raw data |
| **Health check** | `doctor` command for full diagnostics |
| **MCP server** | AI agents (Claude Code, Codex, Kiro) can manage sessions directly |
| **Side conversations** | Properly handles `/fork` and `/side` child threads |

## Use with AI Agents (MCP)

Add to your MCP config:

```json
{
  "mcpServers": {
    "codex-sessions": {
      "command": "codex-sessions-mcp",
      "args": []
    }
  }
}
```

Your AI agent gets 13 tools: `inspect_root`, `list_sessions`, `list_projects`, `get_session`, `export_session_backup`, `preview_delete_sessions`, `delete_sessions`, `list_trash`, `restore_sessions`, `purge_trash`, `cleanup_session_indexes`, `cleanup_stale_indexes`, `verify_sessions`.

## CLI Reference

```bash
codex-sessions list [--status active|archived] [--limit N] [--project TEXT]
codex-sessions list --updated-after 2026-04-01 --updated-before 2026-04-30
codex-sessions list --group-by project
codex-sessions projects
codex-sessions doctor [--json]
codex-sessions show <session-id>
codex-sessions export <session-id> [--output ./backup.json]
codex-sessions delete <session-id...> [--trash] [--yes]
codex-sessions trash-list
codex-sessions restore <session-id> --yes
codex-sessions purge <session-id> --yes
codex-sessions cleanup-stale [--yes]
codex-sessions cleanup-index <session-id...> [--yes]
codex-sessions verify <session-id...> [--json]
```

**Safety**: All destructive commands require `--yes` to execute. Without it, you get a preview only.

## How it works

Codex stores sessions across multiple layers:

```
~/.codex/
├── sessions/          ← raw rollout JSONL files
├── session_index.jsonl ← session metadata index
├── history.jsonl      ← conversation history index
├── state_5.sqlite     ← threads, messages, todos, env vars
└── global_state.json  ← references to active sessions
```

Most tools only delete the SQLite row. This tool cleans **all layers** and verifies nothing is left behind.

## Documentation

- [Safety guide](./docs/SAFETY.md) — read before delete/trash/restore/purge
- [Changelog](./CHANGELOG.md) — release notes
- [SKILL.md](./SKILL.md) — AI skill instructions

## Development

```bash
git clone https://github.com/1939869736luosi/codex-sessions-manager.git
cd codex-sessions-manager
npm install
npm run build
npm test
```

## License

Apache-2.0
