# Codex Sessions Manager

Codex Sessions Manager is a local session management toolkit for Codex.

It packages three pieces together:

- **Skill**: agent-facing instructions for safe local session work
- **CLI**: terminal commands for listing, inspecting, exporting, verifying, deleting, trashing, restoring, purging, and diagnosing sessions
- **MCP server**: local tools for agents that support MCP

## What It Does

- Lists sessions by status, project, and time range
- Shows and exports individual sessions
- Previews deletes before writing anything
- Supports recoverable trash deletion
- Restores and purges trash entries with explicit confirmation
- Verifies whether session files, JSONL indexes, SQLite rows, shell snapshots, and global-state references remain
- Diagnoses Codex root structure through `doctor` and `inspect_root`
- Warns on unknown global-state references without editing unknown keys
- Requires explicit confirmation for destructive writes

## What It Does Not Do

- No UI
- No TUI
- No detail pages
- No incremental project scanner
- No automatic stale cleanup
- No automatic trash purge
- No force overwrite restore

## Safety Model

Read operations are separate from write operations.

CLI write operations require `--yes`. MCP write operations require `confirm=true`.

`cleanup-index` and `cleanup-stale` do not delete raw session files or SQLite rows, but they rewrite JSONL indexes, so they still require explicit confirmation.

## Quick Start

```bash
npm install
npm run build

node dist/cli/index.js doctor --root ~/.codex
node dist/cli/index.js list --root ~/.codex --limit 20
node dist/cli/index.js delete <session-id> --root ~/.codex --trash
node dist/cli/index.js delete <session-id> --root ~/.codex --trash --yes
node dist/cli/index.js verify <session-id> --root ~/.codex
```

See [README.md](./README.md), [docs/SAFETY.md](./docs/SAFETY.md), and [SKILL.md](./SKILL.md) for the public usage and safety rules.

