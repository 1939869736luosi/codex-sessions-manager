# Safety Guide

`codex-sessions` is a local Codex session management toolkit. It provides a CLI and a stdio MCP server for inspecting, listing, exporting, verifying, deleting, moving to trash, restoring, purging, and diagnosing local Codex sessions.

Codex Desktop has its own delete action for archived chats. Use that for ordinary UI-driven deletion. Use this toolkit when you need to verify local leftovers, clean exact session IDs, inspect hidden storage, or perform recoverable/batch cleanup.

It is not a UI product and does not include a TUI, detail page, incremental project scanner, automatic stale cleanup, or automatic trash purge.

## Root Selection

The default Codex root is:

```text
~/.codex
```

Use `--root` to point the CLI at another Codex root:

```bash
node dist/cli/index.js doctor --root <path-to-codex-root>
```

MCP tools also accept an optional `root` argument.

Codex SQLite may live outside the Codex root. The resolver honors `sqlite_home` in `config.toml` first, then `CODEX_SQLITE_HOME`, then the Codex root itself. `doctor` / `inspect_root` report the active SQLite home and warn when both the root and the SQLite home contain candidate databases.

## Read-Only Operations

These operations are intended to inspect or report information without modifying the Codex root:

| CLI | MCP | Purpose |
|---|---|---|
| `list` | `list_sessions` | List matching sessions |
| `projects` | `list_projects` | Summarize sessions by project |
| `show` | `get_session` | Read one session timeline |
| `export` | `export_session_backup` | Export a backup bundle |
| `doctor` | `inspect_root` | Diagnose root structure and compatibility |
| `verify` | `verify_sessions` | Report remaining files, indexes, SQLite rows, and warnings |
| `trash-list` | `list_trash` | List trash entries |
| `plan-delete` / `preview-plan` | `plan_delete_sessions` / `preview_delete_plan` | Build and re-preview read-only explicit-ID delete plans; sourceKind candidate mode lists `candidateIds` only; MCP never writes plan files and never executes delete-by-plan |

`doctor` and `inspect_root` are read-only diagnostics. They are intended to detect Codex storage changes, missing files, SQLite table availability, SQLite home splits, memory DB presence, trash state, and global-state warnings.

## Write Operations

These operations modify files or indexes and require explicit confirmation:

| CLI | MCP | Writes |
|---|---|---|
| `delete --yes` | `delete_sessions` with `confirm=true` | Permanently removes live session surfaces |
| `delete --trash --yes` | `delete_sessions` with `trash=true` and `confirm=true` | Writes a trash entry, then removes live session surfaces |
| `restore --yes` | `restore_sessions` with `confirm=true` | Restores a trash entry into live session surfaces |
| `purge --yes` | `purge_trash` with `confirm=true` | Permanently removes a trash entry |
| `cleanup-index --yes` | `cleanup_session_indexes` with `confirm=true` | Rewrites JSONL indexes for selected sessions |
| `cleanup-stale --yes` | `cleanup_stale_indexes` with `confirm=true` | Rewrites JSONL indexes to remove stale rows |

Without `--yes` or `confirm=true`, destructive operations return a preview and do not perform the write.

## Delete, Trash, Restore, and Purge

Permanent delete remains the default delete mode for compatibility. However, `delete` without `--yes` only prints a preview.

`plan-delete` is stricter than a delete preview: it is read-only, never executes deletion, and reports `executionSupported=false`. Explicit session IDs can enter `selectedIds`; by default only seed IDs are selected. The include flags (`--include-children`, `--include-subagents`, `--include-descendants`, `--include-family`) only change the planned `selectedIds`; they do not authorize or execute a write. `--include-family` is high risk and side/fork sessions remain ambiguous available includes.

`plan-delete --source-kind KIND --limit N` is a read-only candidate plan, not a deletion plan. `--limit` is mandatory and capped at 50. Repeated `--source-kind` and repeated `--status` use OR. Root-level `sourceKind=unknown` is rejected because unknown source sessions must be reviewed by explicit session ID. Candidate matches are reported as `candidateIds`, never `selectedIds`; active/current matches remain `rejectedIds`. This output is not authorization, not a preview token, not a delete confirmation, and not accepted by any delete execution command. `--write-plan` is intentionally unsupported for sourceKind candidate plans in this release.

`sourceKind` is only a filter dimension. `mcp` means thread source, not a record of each MCP tool call; `vscode` is the raw Codex thread source label, not proof of the VS Code IDE; `exec` does not imply execution logs are safe to batch-delete. Root-level sourceKind candidate plans must not inherit candidates from `audit-root` or `preview-root` as deletion recommendations.

T8-P2/T9 adds a source metadata compatibility layer. The stable `sourceKind` field remains the coarse compatibility category (`subagent`, `mcp`, `vscode`, `cli`, `exec`, `unknown`). JSON output may also include `sourceInfo` with raw `source`, raw `thread_source`, official Codex v2 source-kind metadata when reliably derived, thread-source analytics metadata, and compact evidence. This is observability only: it does not change filters, delete previews, plan-delete selection, MCP planning, or delete authorization. In particular, internal raw `mcp`, raw `appServer`, and raw `app-server` are reported as stable `sourceKind=mcp` with official metadata `appServer`; they are not proof of individual MCP tool calls.

`plan-delete --write-plan FILE` may write a stable `codex-sessions-delete-plan.v1` audit file. That file is not authorization, not a preview token, not a delete confirmation, and not accepted by any delete execution command. It must contain only metadata: selected IDs, included/rejected IDs, available includes, warnings, broken relations, missing surfaces, surface counts, root fingerprint, plan hash, scan timestamp, and exact-key global-state path/rule/shape/byteEstimate. It must not contain transcript bodies, prompt text, or full global-state values.

`preview-plan <plan-file>` is read-only. It rescans the root, compares root realpath, SQLite home realpath/source, `session_index`, `history`, global-state, state SQLite, logs SQLite, goals SQLite, memories SQLite mtime/size/parseability, selected surface counts, family edges, and exact-key paths. Selected surface counts include compressed `.jsonl.zst` rollout files when selected sessions have them. If any comparison differs, it returns `stale=true` and refuses to produce a current delete preview from the old plan.

Newer Codex roots may store `thread_goals` in `goals_N.sqlite` instead of `state_N.sqlite`. `doctor` / `inspect_root`, `audit`, delete previews, trash/restore, and `verify` report those rows as part of the SQLite cleanup surface. This compatibility change does not add delete-by-plan, preview tokens, sourceKind delete execution, side/fork automatic deletion, or release/cleanup automation.

Codex roots may also contain `logs_N.sqlite`, `memories_N.sqlite`, remote-control state, and compressed rollout files (`.jsonl.zst`). Execution logs are retained by default; `verify` may show them as retained SQLite rows, not as failed cleanup. Compressed rollout files are treated as session files and are stored in trash/backup bundles as binary-safe data. Compressed-only sessions are not decompressed for transcript display; `show` / timeline output should use index/history summaries instead. Treat memory DB rows as official derived state, not disposable residue: `memories_N.sqlite.stage1_outputs.thread_id` can link back to `state_N.sqlite.threads.id`, and Phase 2 can update `MEMORY.md`, `memory_summary.md`, `raw_memories.md`, `rollout_summaries`, and `skills`. Current session cleanup must not mutate `logs_N.sqlite`, `memories_N.sqlite`, memory job rows, Phase 2 memory outputs, or remote-control state. Future cleanup support for those surfaces requires a separate development plan and safety design.

When reporting `verify` results, say that the result applies to the cleanup surfaces this release supports. Do not claim unconditional zero-orphan or all-SQLite coverage while memory DB mutation is deliberately unsupported and execution logs are retained by default.

MCP `plan_delete_sessions` is the read-only MCP equivalent for plan generation. Explicit `sessionIds` reuse the same include flag semantics as CLI `plan-delete`. SourceKind candidate mode requires `sourceKind` plus `limit`, rejects root-level `unknown`, returns `candidateIds` only, keeps `selectedIds` empty, and rejects active/current matches into `rejectedIds`. It does not support `writePlan`, does not create preview tokens, and does not execute deletion.

MCP `preview_delete_plan` accepts either `planFile` or an inline plan object and reuses the same stale detection as CLI `preview-plan`. It does not accept `confirm`, `trash`, `yes`, `force`, or any write option. When `stale=true`, `deletePreview` is null and the old plan must not be treated as the current preview.

For routine cleanup, prefer recoverable trash deletion:

```bash
node dist/cli/index.js delete <session-id> --trash
node dist/cli/index.js delete <session-id> --trash --yes
```

`delete --trash --yes` writes a recoverable trash bundle before removing live session surfaces.

`restore --yes` performs conflict checks before writing. It refuses to restore when a live session surface already contains the same session id or when a SQLite primary-key or unique-key conflict is detected. There is no force overwrite mode.

Restoring a trash entry does not remove that trash entry. If you restore a session and then move it to trash again, `trash-list` may show more than one recoverable copy for the same session id. This is normal trash state, not live residue. Treat old trash entries as backups until the user explicitly chooses to purge them.

Duplicate trash rules:

- Duplicate trash entries are allowed. A newer trash entry does not replace an older one.
- `restore` never deletes the restored trash entry.
- If one session id maps to multiple trash entries, confirmed `restore` / `purge` must use an exact `trashId`; using the session id is refused as ambiguous.
- Agents must not auto-purge duplicate trash entries. Report the duplicate entries and wait for explicit user confirmation.
- Before purging an old copy, confirm the live session is absent and at least one backup copy remains, unless the user explicitly accepts having no trash backup.
- `purge --yes` permanently removes only the selected trash entry. It does not touch live sessions.

## Low-Risk Trash Drill

Use this narrow workflow for residue that has all of these properties:

- exactly one raw session file
- the raw file is empty or otherwise intentionally disposable
- exactly one `history.jsonl` row
- no `session_index.jsonl` row
- no shell snapshots
- no SQLite cleanup rows, ignoring retained `logs_N.sqlite` execution logs
- no known, P11 exact-key, or unknown global-state references
- no parent, child, subagent, side/fork, or broken family relation warnings

Preview first:

```bash
node dist/cli/index.js audit <session-id> --root <path-to-codex-root> --json
node dist/cli/index.js family <session-id> --root <path-to-codex-root> --impact --json
node dist/cli/index.js delete <session-id> --root <path-to-codex-root> --trash --json
```

Execute only after the preview still matches the narrow scope:

```bash
node dist/cli/index.js delete <session-id> --root <path-to-codex-root> --trash --yes --json
```

After deletion, confirm that the live root is clean and the trash entry exists:

```bash
node dist/cli/index.js audit <session-id> --root <path-to-codex-root> --json
node dist/cli/index.js trash-list --root <path-to-codex-root> --json
```

To test recoverability, preview and restore the trash entry, audit the restored surfaces, then move the same explicit session id back to trash if cleanup is still desired. Do not run `purge --yes` during this drill. For residual-only sessions that no longer resolve through `verify`, use `audit` plus `trash-list` as the post-delete proof.

## Side Conversations

Codex `/side` conversations are separate transcripts. They may appear in local storage as child threads linked to a parent thread.

This matters for safety:

- A parent thread and a side child thread have separate session IDs.
- Showing or exporting a parent thread does not guarantee that side child transcript content is included.
- Deleting a parent thread does not mean the child thread's full transcript is also deleted.
- If you want to handle both, preview both session IDs together before running any confirmed write operation.
- The current CLI/MCP tools do not automatically recurse from a parent thread to its side child threads.

Recommended workflow:

1. Identify the parent thread ID and any side child thread IDs.
2. Preview delete, trash, export, or verify with all IDs that should be covered.
3. Confirm only after the preview matches the intended scope.

## Cleanup Commands

`cleanup-index` and `cleanup-stale` do not delete raw session files or SQLite rows. They rewrite `session_index.jsonl` and `history.jsonl`, so they still require explicit confirmation.

Use preview first:

```bash
node dist/cli/index.js cleanup-stale
```

Execute only after reviewing the preview:

```bash
node dist/cli/index.js cleanup-stale --yes
```

## Global State Warnings

Known global-state cleanup is limited to structured keys that the tool understands.

P11 exact-key cleanup is limited to these promoted paths:

- `$.electron-persisted-atom-state.prompt-history.<session-id>`
- `$.electron-persisted-atom-state.heartbeat-thread-permissions-by-id.<session-id>`

They are allowed only when the session id is the complete object key and the value shape matches the P11 rule. Preview must show the exact path, rule id, value shape, byte estimate, affected surfaces, family warnings, and that confirmation is required. It must not print prompt contents or full global-state values.

Use the normal explicit-session delete preview. There is no separate broad cleanup command:

```bash
codex-sessions delete <session-id> --root <path-to-codex-root>
codex-sessions delete <session-id> --root <path-to-codex-root> --yes
```

For MCP, use `preview_delete_sessions` to inspect exact paths, then use `delete_sessions` with `confirm=true` only after reviewing the intended scope. There is no preview token binding a prior preview call to the confirmed call. Use `trash=true` when recoverability is needed.

Before any confirmed write, the tool must have a snapshot or equivalent rollback path. The confirmed command rescans the root and refuses if `.codex-global-state.json` changes again before the write, cannot be parsed, cannot be read, or cannot be rolled back.

Unknown global-state references outside those exact-key rules are warnings only. The tool reports them but does not modify unknown keys automatically. `audit-root` and `preview-root` remain read-only and are not deletion approval.

## Testing Safety

Do not experiment with dangerous write operations against a real Codex root.

Use a temporary root for smoke tests:

```bash
tmp="$(mktemp -d)"
node dist/cli/index.js doctor --root "$tmp" --json
node dist/cli/index.js cleanup-stale --root "$tmp"
```

Dangerous tests should always use temporary fixtures or disposable roots.

## Explicit Non-Goals

This project does not provide:

- UI
- TUI
- detail pages
- incremental project scanning
- automatic stale cleanup
- automatic trash purge
- force overwrite restore
- automatic editing of unknown global-state keys
- delete-by-plan execution
- preview tokens
- sourceKind-based delete execution
