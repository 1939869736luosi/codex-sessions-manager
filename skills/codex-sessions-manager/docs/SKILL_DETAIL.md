# Codex Sessions Manager — Detailed Tool Reference

This document provides the full CLI and MCP parameter reference for `codex-sessions-manager`. It is intended for agents that need precise parameter names, safety semantics, and edge-case rules.

## CLI Full Parameter Reference

### list

```bash
codex-sessions list [--root PATH] [--limit N] [--project TEXT] [--query TEXT]
  [--status all|active|archived|db-only|stale]
  [--group-by project]
  [--updated-after DATE] [--updated-before DATE]
  [--created-after DATE] [--created-before DATE]
  [--source-kind subagent|mcp|vscode|cli|exec|unknown]
  [--source VALUE] [--thread-source VALUE]
  [--agent-role VALUE] [--agent-nickname VALUE]
  [--model-provider VALUE] [--model VALUE]
  [--json]
```

Date-only filters use the local calendar day. Timezone-less datetime strings must be rejected. Repeated same-field values use OR. Different fields combine with AND.

### show

```bash
codex-sessions show <session-id> [--root PATH] [--json]
```

Human output shows at most 20 timeline items and reports returned/known counts. Use `--json` for every locally parseable semantic item; JSON has no total item-count limit and marks unknown items, parse errors, and truncated tool output. `export` is the byte-exact raw-content path. A compressed-only `.jsonl.zst` session reports `compressed_unread` instead of presenting an index/history summary as transcript text.

### family

```bash
codex-sessions family <session-id> [--root PATH] [--json]
  [--children|--parents|--subagents|--impact|--full]
  [--source-kind KIND]
```

All modes are read-only. `--impact` shows relationship risk only, not deletion advice.

`thread_spawn_edges` is a generic parent/child edge table. `/side`, `/fork`, subagent, MCP, exec, VS Code, CLI, and unknown child threads can all appear. Child type is inferred from the child session's own `sourceKind`, raw `source`, `thread_source`, `agent_role`, `agent_nickname`, and `agent_path`. A child can have multiple labels (e.g., both `subagent` and `side/fork`); use `childTypeLabels` and `relationshipLabels`.

### audit / audit-root

```bash
codex-sessions audit <session-id> [--root PATH] [--json]
codex-sessions audit-root [--root PATH] [--json] [--limit 50] [--all]
  [--status risky-global-state|global-state-exact-key|db-only|broken-family|partial-residue|global-state-unknown]
  [--source global-state-unknown|global-state-exact-key|global-state-known|sqlite|session-index|history|shell-snapshot|thread-spawn-edges]
```

Both are read-only. `audit-root` candidates are not a deletion list. Multiple `--status` use OR, multiple `--source` use OR, combining status and source uses AND.

### preview-root

```bash
codex-sessions preview-root [--root PATH] [--json] [--limit 50] [--all]
  [--status STATUS...] [--source SOURCE...]
```

Read-only batch delete preview. Does not delete, does not accept `--yes`, does not recommend deletion.

### plan-delete

```bash
codex-sessions plan-delete <session-id...> [--root PATH] [--json]
  [--include-children] [--include-subagents] [--include-descendants] [--include-family]
  [--write-plan FILE]

codex-sessions plan-delete --source-kind KIND [--source-kind KIND...] --limit N
  [--status STATUS...] [--root PATH] [--json]
```

Read-only. `executionSupported: false`. Explicit IDs enter `selectedIds`; sourceKind candidate mode enters `candidateIds` only. `--limit` required for sourceKind mode, max 50. `sourceKind=unknown` rejected at root level. Active/current stay in `rejectedIds`. `--write-plan` unsupported for sourceKind candidate plans.

`--include-family` is highest risk. Side/fork are `availableIncludes`, not forced includes.

Plan files are `codex-sessions-delete-plan.v1` audit artifacts containing root fingerprint, `planHash`, `scanTimestamp`, selected surface counts, family edges, and exact-key paths. No transcript bodies or full global-state values.

### preview-plan

```bash
codex-sessions preview-plan <plan-file> [--root PATH] [--json]
```

Read-only stale check. If stale, no current delete preview is produced.

### delete

```bash
codex-sessions delete <full-session-uuid...> [--root PATH] [--trash] [--yes] [--allow-active]
```

Without `--yes`: preview only. With `--yes`: executes after internal rescan. `--trash --yes` for recoverable deletion. Does not recurse to family.

### trash-list / restore / purge

```bash
codex-sessions trash-list [--root PATH]
codex-sessions restore <exact-trash-id> [--root PATH] --yes
codex-sessions purge <exact-trash-id> [--root PATH] --yes
```

When one session ID maps to multiple trash entries, use the exact `trashId`. Restore refuses live conflicts. Purge removes only the trash entry.

### cleanup-index / cleanup-stale

```bash
codex-sessions cleanup-index <full-session-uuid...> [--root PATH] [--yes] [--allow-active]
codex-sessions cleanup-stale [--root PATH] [--yes]
```

Rewrites `session_index.jsonl` and `history.jsonl`. Does not delete raw files or SQLite rows.

### verify

```bash
codex-sessions verify <session-id...> [--root PATH] [--json]
```

Reports remaining files, JSONL rows, SQLite rows (including goals DB), shell snapshots, known global-state refs, exact-key refs, unknown refs, and warnings. `verify` is logical live-surface verification, not byte-forensic cleanup. It does not check: SQLite WAL, SQLite free pages, app/terminal logs, backups, exports, trash bundles, or filesystem slack.

## MCP Tools Reference

### Read-only profile (16 tools, default)

| Tool | Purpose |
|------|---------|
| `inspect_root` | Inspect Codex root structure |
| `list_sessions` | List/filter sessions |
| `summarize_sources` | Read-only source summary |
| `list_projects` | Project summaries |
| `get_session` | Session detail + timeline |
| `get_session_family` | Family relationships (mode: full/children/parents/subagents/impact) |
| `audit_session` | Session residue audit |
| `audit_root` | Root residue scan |
| `preview_root_delete` | Batch delete preview |
| `export_session_backup` | Export backup |
| `preview_delete_sessions` | Explicit-ID delete preview |
| `plan_delete_sessions` | Read-only delete planning |
| `preview_delete_plan` | Plan-file stale check |
| `list_trash` | List trash entries |
| `verify_sessions` | Post-delete verification |
| `get_recovery_status` | Inspect an interrupted mutation without changing it |

### Admin-only (6 additional tools, requires `--profile admin`)

| Tool | Purpose |
|------|---------|
| `delete_sessions` | Delete with confirm/trash support |
| `restore_sessions` | Restore trash entry |
| `purge_trash` | Permanently remove trash entry |
| `cleanup_session_indexes` | Rewrite JSONL indexes for specific sessions |
| `cleanup_stale_indexes` | Remove stale JSONL entries |
| `recover_operation` | Recover the exact interrupted operation after explicit confirmation |

All admin tools require `confirm=true` to execute; without it they return preview only.

`get_session` accepts `detail=compact|full`. `compact` is limited to 20 timeline items and 64 KiB; `full` is limited to 200 items and 256 KiB. Responses include `completeness`, underlying `sourceCompleteness`, `itemsReturned`, `itemsKnown`, `omittedReason`, and `exactExportAvailable`. These limits are intentional; use CLI JSON or export for complete local handoff.

## Source Metadata Rules

- `sourceKind` is an inferred category: `subagent`, `mcp`, `vscode`, `cli`, `exec`, or `unknown`.
- `source=vscode` is a raw Codex thread source label, not proof of VS Code IDE.
- `source=mcp` is a thread source label, not a per-call MCP tool log.
- Do not infer "Desktop" by exclusion; unclassified is `unknown`.
- `model_provider` is display/filter metadata only.

## P11 Exact-Key Global-State Rules

Only two `.codex-global-state.json` paths are removable by confirmed delete:

- `$.electron-persisted-atom-state.prompt-history.<session-id>`
- `$.electron-persisted-atom-state.heartbeat-thread-permissions-by-id.<session-id>`

Removable only when the session ID is the whole object key and value shape matches the rule. Preview shows path, rule, shape, byte estimate. Never prints prompt contents or full values. All other unknown global-state refs are warnings only.

## Safety Model Summary

- Confirmed session mutations require canonical full UUIDs; active-session deletion needs an additional explicit override.
- Mutations use an exclusive lock, durable journal, atomic file replacement, and operation-specific recovery data.
- A committed operation with partial or failed verification is reported as committed, with the verification status and scope attached.
- No preview token binding between preview and confirmed calls; confirmed delete rescans.
- If global-state changes during confirmed delete or cannot be parsed, the write is refused.
- `logs_N.sqlite` execution logs are retained by default.
- `memories_N.sqlite` is read-only and not mutated by session cleanup.
- Compressed `.jsonl.zst` files are handled as binary-safe data through trash/restore.
- Export and trash bundles may include prompt-history content; do not print unless explicitly requested.
