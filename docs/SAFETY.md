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

`doctor` and `inspect_root` are read-only diagnostics. They are intended to detect Codex storage changes, missing files, SQLite table availability, trash state, and global-state warnings.

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
- no SQLite rows
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
