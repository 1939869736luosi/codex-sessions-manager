---
name: codex-sessions-manager
description: Use this skill when the user wants to inspect, search, export, verify, clean up, or delete local Codex sessions stored in ~/.codex. Trigger for requests about Codex conversation history, archived sessions, session IDs, deleting chats, exporting a session, previewing deletion impact, cleaning stale indexes, or verifying whether a session still has raw files, JSONL index entries, or SQLite records.
metadata:
  source: https://github.com/1939869736luosi/codex-sessions-manager
---

# Codex Sessions Manager

## Overview

This skill manages local Codex sessions through the `codex-sessions` toolkit.

Use it when the user wants to work with local Codex conversation history instead of the current live chat thread.

## Prerequisites

This skill requires the CLI to be built from this repository:

```bash
cd /path/to/codex-sessions-manager
npm install
npm run build
```

The built CLI is available at `dist/cli/index.js` within this directory.

## When To Use

Use this skill for requests like:

- "列出我最近的 Codex 对话"
- "看一下这条 session 的详情"
- "导出这个会话"
- "删除这几个会话"
- "先预览删除会影响什么"
- "清理失效索引"
- "验证这条会话还有没有残留"

Do not use this skill for:

- generic ChatGPT history questions
- Claude Code session management
- editing the current conversation

## Execution Order

### 1. Prefer MCP first

If the `codex-sessions` MCP server is available in the current Codex session, use these tools:

- `list_sessions`
- `get_session`
- `export_session_backup`
- `preview_delete_sessions`
- `delete_sessions` (requires `confirm=true` to execute; without it, returns a preview)
- `cleanup_session_indexes`
- `cleanup_stale_indexes`
- `verify_sessions`

### 2. Fall back to CLI when MCP is unavailable

Run the CLI from this repository:

Commands:

```bash
node dist/cli/index.js list --root ~/.codex --limit 20
node dist/cli/index.js show <session-id> --root ~/.codex
node dist/cli/index.js export <session-id> --root ~/.codex --output ./backup.json
node dist/cli/index.js delete <session-id...> --root ~/.codex
node dist/cli/index.js delete <session-id...> --root ~/.codex --yes
node dist/cli/index.js cleanup-index <session-id...> --root ~/.codex
node dist/cli/index.js cleanup-stale --root ~/.codex
node dist/cli/index.js verify <session-id...> --root ~/.codex
```

## Safety Rules

- Treat `delete` as destructive. Always preview first unless the user has already explicitly confirmed deletion.
- `delete` without `--yes` is the preferred safe preview path in CLI mode.
- `cleanup-index` only removes JSONL traces; it does not delete raw files or SQLite rows.
- `cleanup-stale` only removes stale index records.
- When the user asks to delete sessions, echo back the session IDs you are about to delete before executing if there is any ambiguity.

## Response Style

- For list requests: show session ID, updated time, size, and a readable title.
- For show requests: summarize the session and include the key metadata.
- For delete requests: explain whether this is preview-only or actual deletion.
- For verify requests: report whether files, JSONL rows, and SQLite rows still remain.

## Quick Examples

### List recent archived sessions

Use MCP `list_sessions` with `status=archived` and `limit=5`.

CLI fallback:

```bash
node dist/cli/index.js list --root ~/.codex --status archived --limit 5
```

### Preview deleting a session

Use MCP `preview_delete_sessions`.

CLI fallback:

```bash
node dist/cli/index.js delete 019d5240 --root ~/.codex
```

### Actually delete confirmed sessions

Use MCP `delete_sessions` only after clear user confirmation, and pass `confirm=true`.

CLI fallback:

```bash
node dist/cli/index.js delete 019d5240 019d3de0 --root ~/.codex --yes
```
