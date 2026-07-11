---
name: codex-sessions-manager
description: Use this skill when the user wants to inspect, search, export, verify,
  clean up, delete, restore, or purge local Codex sessions stored under ~/.codex.
metadata:
  source: https://github.com/1939869736luosi/codex-sessions-manager
---

# Codex Sessions Manager

## Overview

CLI-first local Codex session audit and cleanup tool. Inspect what remains under `~/.codex`, audit leftovers after the official UI delete/archive flow, clean hidden local residues by exact session ID, and verify the local surfaces this release understands.

This is not a UI product, TUI, detail page, incremental scanner, or automatic cleanup service.

## Setup

```bash
npm install -g codex-sessions-manager
codex-sessions --version
```

The default Codex root is `~/.codex`. Use `--root <path>` for a different root.

## When To Use

- List/filter/search sessions (by project, time, status, source)
- Show session detail or timeline
- Inspect session family (parent/child/subagent/side/fork)
- Audit what remains locally after official UI delete
- Scan root for likely residue candidates
- Preview batch delete scope without executing
- Build explicit-ID delete plans
- Export session backup
- Delete sessions (permanent or recoverable trash)
- Restore or purge trash entries
- Verify post-delete cleanliness
- Clean stale JSONL indexes

## CLI Quick Reference

```bash
codex-sessions doctor [--json] [--details]
codex-sessions list [--limit N] [--project TEXT] [--status S] [--source-kind K]
codex-sessions sources [--json]
codex-sessions projects
codex-sessions show <id>
codex-sessions events <exact-id> [--output FILE]
codex-sessions family <id> [--children|--parents|--subagents|--impact|--full]
codex-sessions audit <id> [--json]
codex-sessions audit-root [--limit 50] [--status S...] [--source S...]
codex-sessions preview-root [--limit 50] [--status S...] [--source S...]
codex-sessions export <id> [--output ./backup.json]
codex-sessions plan-delete <id...> [--include-children] [--include-family] [--json]
codex-sessions plan-delete --source-kind K --limit N [--json]
codex-sessions preview-plan <file> [--json]
codex-sessions delete <id...> [--trash] [--yes]
codex-sessions trash-list
codex-sessions restore <id> --yes
codex-sessions purge <id> --yes
codex-sessions cleanup-index <id...> [--yes]
codex-sessions cleanup-stale [--yes]
codex-sessions verify <id...>
```

## Safety Rules

- All destructive commands require `--yes` (CLI) or `confirm=true` (MCP); without it you get preview only.
- Always run a separate preview before any destructive action, then require explicit user confirmation.
- `preview`, `plan-delete`, `family`, `impact`, `audit-root`, `preview-root` are read-only. They are never deletion authorization.
- Delete never recursively adds parent, child, or family sessions. List every intended ID explicitly.
- P11 exact-key global-state refs are removable only through explicit-ID confirmed delete.
- Unknown global-state refs are warnings only; do not delete them automatically.
- Rollback is best-effort, not crash-safe transaction.

## MCP (Optional, Advanced)

```bash
codex-sessions-mcp                       # default: read-only profile (17 tools)
codex-sessions-mcp --profile admin       # all 23 tools including destructive ops
```

Invalid `--profile` values exit with code 1. Default is read-only for safety.

## Detailed References

For full CLI/MCP parameter reference, safety model, and advanced rules:

- [Detailed tool reference](../skills/codex-sessions-manager/docs/SKILL_DETAIL.md)
- [Safety guide](../skills/codex-sessions-manager/docs/SAFETY.md)
