# codex-sessions-manager

[![npm](https://img.shields.io/npm/v/codex-sessions-manager)](https://www.npmjs.com/package/codex-sessions-manager)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[简体中文](./README.zh-CN.md)

> Codex Desktop now includes a delete action for archived chats. Local testing shows that it removes the main session file and some thread rows, but may still leave session index rows, execution logs, and desktop state references behind.

**codex-sessions-manager** is a local Codex session audit and cleanup tool. It works as a **Skill** (Claude Code / Codex), a **CLI**, and an **MCP server** — all sharing the same core. Use it to inspect what remains under `~/.codex`, audit leftovers after the official UI delete/archive flow, clean hidden local residues by exact session ID, and verify the local surfaces this release understands.

It is built for safety-critical local history work: prompt/history privacy, exact-session deletion, rollback, restore conflict checks, SQLite/global-state consistency, and post-delete verification.

Security reports are welcome. See [SECURITY.md](./SECURITY.md) for the supported security model and reporting path.

## Why this one?

Codex Desktop's built-in delete is the right first stop for ordinary archived-chat cleanup. This tool is for the harder local cases: proving what remains after deletion, cleaning orphaned records, handling exact session IDs, and giving agents a safe way to manage local history.

| | codex-sessions-manager | Others |
|--|:---:|:---:|
| Cleans covered session layers (files + JSONL + known SQLite + known global state) | ✅ | ❌ partial |
| Durable journal, rollback, and explicit crash recovery | ✅ | ❌ |
| Recoverable trash with conflict-safe restore | ✅ | ❌ or basic backup |
| Post-delete verification (checks for orphans) | ✅ | ❌ |
| AI agents can call it (MCP server) | ✅ | ❌ |
| Detects `/side` and `/fork` child relationships | ✅ | ❌ |

Current compatibility limit: Codex can store SQLite files outside the Codex root via `sqlite_home` or `CODEX_SQLITE_HOME`. This tool resolves that split in this order: `config.toml sqlite_home`, then `CODEX_SQLITE_HOME`, then the Codex root. It warns when both locations contain SQLite databases. It also recognizes compressed rollout files (`.jsonl.zst`) and preserves them through trash/restore as binary data. If a session has only `.jsonl.zst`, `show` / timeline output does not decompress the transcript body; it uses index/history summaries instead. `memories_N.sqlite` is recognized by `doctor` as an official memory surface, but memory rows and Phase 2 memory outputs are read-only and are not mutated by session cleanup. `logs_N.sqlite` execution logs and remote-control state are also not ordinary session cleanup surfaces.

Confirmed mutations require canonical full session UUIDs; deleting an active session needs the additional `--allow-active` / `allowActive=true` override. Managed symlinks, junctions, hard-linked files, outside-root paths, and stale plans are rejected. Interrupted mutations keep a durable recovery record and block further writes until the exact recovery operation completes. See [Safety Guide](./docs/SAFETY.md) for exit statuses, verification scope, and the same-user filesystem-race boundary.

## Quick Start

```bash
# Install globally
npm install -g codex-sessions-manager

# Check the installed package version
codex-sessions --version
codex-sessions-mcp --version

# List recent sessions
codex-sessions list --limit 10

# Summarize session sources (safe, no changes)
codex-sessions sources

# Inspect parent and child sessions (safe, no changes)
codex-sessions family <session-id>
codex-sessions family <session-id> --children
codex-sessions family <session-id> --parents
codex-sessions family <session-id> --subagents
codex-sessions family <session-id> --impact

# Audit what still exists locally after official UI archive/delete (safe, no changes)
codex-sessions audit <session-id>

# Scan the whole root for likely residue candidates (safe, no changes)
codex-sessions audit-root --limit 50
codex-sessions audit-root --status risky-global-state --source global-state-unknown --limit 50

# Batch-preview deleting root residue candidates (safe, no changes)
codex-sessions preview-root --limit 50
codex-sessions preview-root --source global-state-unknown --limit 20

# Build an explicit-ID read-only delete plan (safe; optional audit plan file)
codex-sessions plan-delete <session-id...>
codex-sessions plan-delete <session-id...> --include-children
codex-sessions plan-delete <session-id...> --include-descendants --json
codex-sessions plan-delete --source-kind subagent --limit 20 --json
codex-sessions plan-delete --source-kind mcp --status archived --limit 20 --json
codex-sessions plan-delete <session-id...> --write-plan /tmp/codex-delete-plan.json --json
codex-sessions preview-plan /tmp/codex-delete-plan.json --json

# Preview what deletion would do (safe, no changes)
codex-sessions delete <session-id>

# Preview P11 exact-key global-state cleanup for one explicit session (safe, no changes)
codex-sessions delete <session-id> --root <path-to-codex-root>

# After preview, delete with the canonical full UUID (recommended)
codex-sessions delete <full-session-uuid> --trash --yes

# Changed your mind? Restore it
# Confirmed restore always uses the exact internal trashId.
codex-sessions restore <exact-trash-id> --yes

# Verify the live surfaces covered by this release
codex-sessions verify <session-id>
```

## How deletion actually works

Most tools: delete one file or one DB row → done → orphans everywhere.

This tool:

```
1. Snapshot all files (in case we need to roll back)
2. Rewrite session_index.jsonl (remove matching rows)
3. Rewrite history.jsonl (remove matching rows)
4. Clean known `.codex-global-state.json` references and the two P11 exact-key candidates only
5. Delete raw session files
6. Delete shell snapshot files
7. Delete known SQLite session rows (threads, spawn_edges, assigned agent jobs, dynamic tools, legacy state-owned `stage1_outputs`, thread goals; current Codex may store goals in `goals_N.sqlite`). Execution logs in `logs_N.sqlite` are retained by default.

If ANY step fails → everything rolls back to the original state.
```

After deletion, run `verify` to confirm no residue remains in the surfaces this release covers. `verify` may still report retained logs as `retained_sqlite=logs=N`; that is expected. Memory state in `memories_N.sqlite` remains read-only and needs a separate memory-delete safety design before this tool can claim full memory cleanup.

## Features

| Feature | What it does |
|---------|-------------|
| **List & filter** | By project, status, time range, source metadata, model provider, and model; group by project |
| **Source summary** | Read-only `sourceKind` summary while preserving raw `source`, `thread_source`, `model_provider`, `model`, and `agent_role` |
| **Split title sources** | Lists show the Codex UI-searchable title by default; detail output shows `session_index`, SQLite, and first-message title differences |
| **Export** | Backup any session to JSON before you touch it |
| **Delete** | Permanent or recoverable trash — your choice |
| **Residue audit** | Read-only report for raw rollout files, shell snapshots, session indexes, history, SQLite rows, global-state refs, thread edges, family status, and broken parent/child links |
| **Root residue scan** | Read-only root-level scan for likely leftover IDs, without requiring a session ID first |
| **Root delete preview** | Read-only batch delete preview for root residue candidates, without requiring you to list session IDs by hand |
| **Codex SQLite layout** | Resolves `config.toml sqlite_home` / `CODEX_SQLITE_HOME` / root fallback, in that order; detects `state_N.sqlite`, `logs_N.sqlite`, `goals_N.sqlite`, and read-only `memories_N.sqlite`; `doctor`, `audit`, `verify`, and previews count `goals_N.sqlite.thread_goals`, while `logs_N.sqlite` and `memories_N.sqlite` stay out of default deletion. |
| **Explicit delete plan** | Read-only `plan-delete` for explicit session IDs; include flags can add children, subagents, descendants, or connected family to the plan selection, but execution is not supported |
| **Trash & Restore** | Full snapshot saved; `.jsonl.zst` session files are stored as binary-safe data; restore checks for SQLite key conflicts before writing |
| **Verify** | Reports remaining files, index rows, and DB records for the surfaces this release supports |
| **Cleanup** | Remove stale index entries without touching raw data |
| **Health check** | `doctor` command for full root diagnostics |
| **MCP server** | AI agents (Claude Code, Codex, Kiro) manage sessions directly |
| **Session family** | Read-only parent, child, ancestor, descendant, sibling, subagent, `/fork`, `/side`, and impact views; human output uses short `source` labels unless `--full` is used |
| **Side conversations** | Parent and child sessions stay separate; delete/export/verify never recurses automatically |

## Use with AI Agents

### 1. CLI (Universal, All Ecosystems)

Any AI agent that can run shell commands can use codex-sessions-manager directly:

```bash
codex-sessions list --limit 10
codex-sessions audit <session-id>
codex-sessions delete <session-id>   # preview only without --yes
```

This works in Amp, Claude Code, Codex, Cursor, Factory Droid, and any other agent with shell access.

### 2. Skill (Claude Code, Amp)

Copy the self-contained skill directory for richer agent integration:

```bash
# Claude Code
mkdir -p ~/.claude/skills/codex-sessions-manager
cp -r skills/codex-sessions-manager/* ~/.claude/skills/codex-sessions-manager/

# Amp
mkdir -p .agents/skills/codex-sessions-manager
cp -r skills/codex-sessions-manager/* .agents/skills/codex-sessions-manager/
```

### 3. MCP (Optional, Advanced)

For agents that benefit from structured JSON responses:

```json
{
  "mcpServers": {
    "codex-sessions": {
      "command": "codex-sessions-mcp",
      "args": ["--profile", "read-only"]
    }
  }
}
```

Default profile is **read-only** (16 tools). For destructive operations, use `--profile admin` (22 tools).

**Windows security-patch releases in the 0.6 line are read-only.** Delete, trash, restore, purge, cleanup, and interrupted-operation recovery fail closed until the real Windows junction/reparse-point, case-handling, and abrupt-termination matrix is verified. On Windows, requesting the MCP `admin` profile still registers only the read-only tools.

### 4. Ecosystem Adapters

Platform-specific setup guides are in the `adapters/` directory:

| Platform | Adapter | Key Feature |
|----------|---------|-------------|
| Amp | [`adapters/amp/`](adapters/amp/) | Skill-bundled `mcp.json` for deferred loading |
| Claude Code | [`adapters/claude-code/`](adapters/claude-code/) | Skill directory + MCP config |
| OpenAI Codex | [`adapters/codex/`](adapters/codex/) | AGENTS.md snippet + CLI templates |
| Cursor | [`adapters/cursor/`](adapters/cursor/) | `.cursor/mcp.json` example |
| Factory Droid | [`adapters/factory-droid/`](adapters/factory-droid/) | `droid mcp add` one-liner |

### Migration Note (v0.5.x to v0.6.0)

MCP default changed from 20 tools to 15 tools in v0.6.0. v0.6.1 adds read-only recovery inspection and an admin-only confirmed recovery tool, bringing the profiles to 16 and 22 tools. If you need destructive tools, add `--profile admin`; explicit confirmation remains mandatory.

## CLI Reference

```bash
codex-sessions list [--status active|archived] [--limit N] [--project TEXT]
codex-sessions list --updated-after 2026-04-01 --updated-before 2026-04-30
codex-sessions list --group-by project
codex-sessions list --source-kind cli --model-provider openai
codex-sessions list --source mcp --thread-source mcp
codex-sessions list --agent-role subagent --agent-nickname helper
codex-sessions sources [--json]
codex-sessions projects
codex-sessions doctor [--json]
codex-sessions show <session-id>
codex-sessions family <session-id> [--json] [--children|--parents|--subagents|--impact] [--full] [--source-kind KIND]
codex-sessions audit <session-id> [--json]
codex-sessions audit-root [--json] [--limit 50] [--status STATUS...] [--source SOURCE...] [--all]
codex-sessions preview-root [--json] [--limit 50] [--status STATUS...] [--source SOURCE...] [--all]
codex-sessions export <session-id> [--output ./backup.json]
codex-sessions plan-delete <session-id...> [--json] [--write-plan FILE] [--include-children] [--include-subagents] [--include-descendants] [--include-family]
codex-sessions plan-delete --source-kind KIND [--source-kind KIND...] --limit N [--status STATUS...] [--json]
codex-sessions preview-plan <plan-file> [--json]
codex-sessions delete <full-session-uuid...> [--trash] [--yes] [--allow-active]
codex-sessions cleanup-index <full-session-uuid...> [--yes] [--allow-active]
codex-sessions recovery-status [--json]
codex-sessions recover <exact-operation-id> --yes
codex-sessions trash-list
codex-sessions restore <exact-trash-id> --yes
codex-sessions purge <exact-trash-id> --yes
codex-sessions cleanup-stale [--yes]
codex-sessions verify <session-id...> [--json]
```

**Safety first**: All destructive commands require `--yes`. Without it, you only get a preview. Run a separate preview for the exact session IDs first; `family`, `impact`, `audit-root`, `preview-root`, `plan-delete`, plan files, and `preview-plan` never count as permission to delete.

Read-only lookups may resolve a unique short prefix. Confirmed session mutations require lowercase full UUIDs; active-session deletion needs `--allow-active`. Confirmed restore and purge require an exact `trashId`. Exit status `2` means a mutation committed but verification was partial or failed; status `3` means recovery is required and further mutation is blocked.

`export` and trash bundles are recovery data, not previews. They may include full global-state exact-key values such as prompt-history content. Human delete previews show only path, rule, shape, and byte counts.

**Duplicate trash entries**: `restore` does not delete the trash entry. If a restored session is moved to trash again, `trash-list` can show multiple recoverable copies for the same session ID. This is normal trash state, not live residue. A newer copy does not replace an older one. When one session ID has multiple trash entries, confirmed `restore` and `purge` refuse the session ID and require the exact `trashId`. Do not auto-purge duplicates. `purge` permanently removes only the selected trash entry and never touches the live session.

Use `audit` after the official Codex UI delete/archive flow when you need a clear local residue report. It is read-only. It reports whether the raw rollout file, shell snapshot, `session_index`, `history`, SQLite records, known global-state refs, P11 exact-key global-state refs, unknown global-state refs, and `thread_spawn_edges` are still present. It also reports family membership and broken parent/child links. If anything remains, the suggested next command is a preview-only `delete` command; nothing is deleted unless you add `--yes`.

Use `audit-root` when you do not already have the session ID. It scans the whole Codex root and lists likely residue candidates by risk: broken parent/child edges, missing rollout files with unknown global-state refs, SQLite-only rows, shell snapshots, index-only rows, and other partial leftovers. It is read-only, defaults to `--limit 50`, does not print transcript content, and recommends a per-session `audit` command for each candidate. Add `--all` only when you intentionally want complete non-residue sessions included too.

`audit-root` supports display-only filters. Matching candidates are not a deletion list or a deletion recommendation; audit them one by one or inspect a read-only preview before choosing any cleanup:

- `--status risky-global-state`
- `--status global-state-exact-key`
- `--status db-only`
- `--status broken-family`
- `--status partial-residue`
- `--status global-state-unknown`
- `--source global-state-unknown`
- `--source global-state-exact-key`
- `--source global-state-known`
- `--source sqlite`
- `--source session-index`
- `--source history`
- `--source shell-snapshot`
- `--source thread-spawn-edges`

You can pass `--status` or `--source` more than once. Multiple values of the same kind use OR. Combining status and source uses AND. These filters only narrow what is shown. A matching candidate still needs per-session `audit` or delete preview before any cleanup decision, and it does not mean the candidate should be deleted.

Human and JSON output include a summary: `filters`, `totalCandidatesBeforeFilter`, `totalCandidatesAfterFilter`, `returnedCandidates`, `limit`, `byStatus`, and `bySource`. The `byStatus` and `bySource` counts are computed after status/source filters and before `limit`.

Use `sources` when you need a read-only overview of where sessions came from. It groups by inferred `sourceKind`, raw `source`, `thread_source`, `model_provider`, `model`, and `agent_role`. `sourceKind` can be `subagent`, `mcp`, `vscode`, `cli`, `exec`, or `unknown`. The raw `source` value is still kept in JSON output and shown in human output, because `sourceKind` is only this tool's inferred category.

`list` supports the same source-facing filters: `--source-kind`, `--source`, `--thread-source`, `--agent-role`, `--agent-nickname`, `--model-provider`, and `--model`. Filters combine with AND across different fields. Repeating the same field uses OR. MCP `list_sessions` accepts the same fields, and MCP `summarize_sources` returns the same summary shape as CLI `sources --json`.

Important source limits:

- `source=vscode` is a raw Codex thread source label. It should not be treated as proof that the chat came from the VS Code IDE.
- Do not infer "Desktop" by exclusion. Sessions not marked `cli`, `mcp`, `vscode`, or `exec` are `unknown`, not automatically Desktop.
- `source=mcp` means the thread was recorded with that source. It is not a log of every MCP tool call inside the conversation.
- `model_provider` is only displayed and filtered here. This tool does not repair provider identity or rewrite provider history.

Use `preview-root` when you want a read-only batch delete preview for the same candidates `audit-root` would select. It reuses the same status/source filters and conservative default `--limit 50`, then summarizes what a read-only preview would touch across rollout files, compressed `.jsonl.zst` rollout files, shell snapshots, `session_index`, `history`, SQLite (including `goals_N.sqlite.thread_goals` when present), known global-state refs, P11 exact-key global-state refs, unknown global-state refs, and `thread_spawn_edges`. `logs_N.sqlite` and `memories_N.sqlite` are not default deletion surfaces. It does not delete, does not rewrite JSONL, SQLite, shell snapshots, or global-state, does not accept `--yes`, does not recommend deleting any session, and does not recursively add parent, child, or family sessions. A `preview-root` result is not a deletion recommendation; it only shows what would be touched if you later choose explicit `delete` commands. Actual deletion should use a separate explicit-ID `delete` preview for review, followed by an explicitly confirmed `delete ... --yes` command.

Use `plan-delete` when you already have explicit session IDs and want a safer relationship-aware plan before any deletion preview or write. It is read-only, has `readOnly: true` and `executionSupported: false`, and is also available through the read-only MCP `plan_delete_sessions` tool. By default only the seed IDs are selected. Related parents, children, subagents, descendants, family members, and side/fork ambiguous sessions are reported in `availableIncludes` or warnings. `--include-children`, `--include-subagents`, `--include-descendants`, and `--include-family` only change `selectedIds`; they do not execute deletion. `--include-family` is highest risk and emits a strong warning. Exact-key global-state output shows only path, rule, shape, and byte metadata; unknown global-state remains warning-only.

T7-P3 also allows a conservative root-level source candidate form: `plan-delete --source-kind subagent --limit 20 [--status archived] [--json]`. Repeated `--source-kind` values use OR, and repeated `--status` values use OR. `--limit` is mandatory and must be at most 50. `sourceKind=unknown` is rejected at root level; review unknown sessions by explicit session ID instead. This mode writes matches to `candidateIds`, never `selectedIds`, and active/current matches stay in `rejectedIds`. It is a candidate list only: `sourceKind` is a filter dimension, not delete authorization. `mcp` means the thread source, not each MCP tool call; `vscode` is the raw Codex label, not proof of the VS Code IDE; `exec` does not mean execution logs are safe to batch-delete. `--write-plan` is intentionally not supported for sourceKind candidate plans in this release.

MCP `plan_delete_sessions` supports the same sourceKind candidate semantics: pass `sourceKind` plus mandatory `limit` and optional `status`; `selectedIds` remains empty, `candidateIds` carries the matches, root-level `unknown` is rejected, and active/current matches stay in `rejectedIds`. The MCP tool does not support `writePlan`, does not create preview tokens, and cannot execute deletion.

`plan-delete --write-plan FILE` writes a stable `codex-sessions-delete-plan.v1` JSON audit artifact. The file includes `scanTimestamp`, `planHash`, a root fingerprint, selected surface counts, family edges, and exact-key global-state paths. It must not contain transcript bodies, prompt text, or full global-state values; exact-key global-state entries are limited to path/rule/shape/byteEstimate metadata. A plan file is not authorization, not a preview token, not a deletion confirmation, and cannot be passed to any delete execution command.

Use `preview-plan <plan-file>` to re-scan the root read-only and compare the plan against current state. It checks root realpath, SQLite home realpath/source, `session_index`, `history`, `.codex-global-state.json`, state/log/goals/memories SQLite mtime/size/parseability, selected surface counts, family edges, and exact-key paths. Selected surface counts include compressed `.jsonl.zst` rollout files when a selected session has them. If anything differs inside the covered fingerprint, `stale=true` and no delete preview is produced, so an old plan cannot be treated as the current preview. `preview-plan` does not accept `--yes`, `--trash`, `--force`, or any delete execution mode.

MCP `preview_delete_plan` accepts either `planFile` or an inline `plan` object and uses the same stale detection. It is read-only, does not accept `confirm`, `trash`, `yes`, or `force`, and returns no current `deletePreview` when `stale=true`.

By design, this toolkit does not support delete-by-plan, preview tokens, `--force`, sourceKind-based delete execution, or advanced family/sourceKind automatic deletion orchestration. Actual deletion must return to a separate explicit-ID delete preview and explicit human confirmation.

### P11 exact-key global-state cleanup

Only two formerly unknown `.codex-global-state.json` paths can be removed by confirmed delete:

- `$.electron-persisted-atom-state.prompt-history.<session-id>`
- `$.electron-persisted-atom-state.heartbeat-thread-permissions-by-id.<session-id>`

They are removable only when the session id is the whole object key and the value shape matches the rule. Preview shows the exact path, rule id, value shape, byte estimate, affected surfaces, family warnings, and that confirmation is required. It never prints prompt text or full global-state values.

All other unknown global-state refs remain warnings. UUID-shaped string values, UUIDs inside arrays, partial path matches, unexpected heartbeat shapes, installation ids, and root-scan candidates are not deleted. Confirmed delete refuses an ID that matches only ineligible unknown global-state refs.

Use the existing explicit-session delete flow:

```bash
codex-sessions delete <session-id> --root <path-to-codex-root>
codex-sessions delete <session-id> --root <path-to-codex-root> --yes
codex-sessions delete <session-id> --root <path-to-codex-root> --trash --yes
```

MCP follows the same safety model: call `preview_delete_sessions` to inspect the exact paths, then call `delete_sessions` with `confirm=true` only when the preview matches your intended scope. There is no preview token binding the preview call to the confirmed call. The confirmed command rescans the root and refuses if the global-state file changes again inside that confirmed command before its write, cannot be parsed, or cannot be protected by rollback.

Use `family` before deleting a parent or child session. Parent and child sessions are independent sessions with their own IDs. Deleting a parent does not delete children, and deleting a child does not delete its parent. Delete previews and audits warn when relationship records point at missing sessions or missing file/index surfaces. To process multiple related sessions, put every intended session ID into the preview/delete command explicitly. The tool never recurses into parent or child sessions automatically.

`thread_spawn_edges` is a generic parent/child relationship edge table. It is not a subagent-only table. `/side`, `/fork`, subagent, MCP, exec, VS Code, CLI, and unknown child threads can all appear as child threads. Child type is inferred from the child session itself: inferred `sourceKind`, raw `source`, `thread_source`, `agent_role`, `agent_nickname`, and `agent_path`. A child can have more than one label, such as both `subagent` and `side/fork`; JSON/MCP expose `childTypeLabels` and `relationshipLabels` so the mixed identity is not collapsed into one label.

Family modes are all read-only:

- `family <id> --children` shows direct children only, including `sourceKind`, edge status, child type labels, title, updated time, agent metadata, and file/index/thread presence.
- `family <id> --parents` shows direct parents only with the same source and edge metadata.
- `family <id> --subagents` shows family members whose `sourceKind` is `subagent` or that have agent metadata.
- `family <id> --impact` shows what parent, child, family member, missing parent/child, and missing file/index/thread risks would remain if you later choose to process only this session. It groups `selected`, `unselected parents`, `unselected children`, `unselected family members`, `missing relations`, and `missing surfaces`. It does not delete anything, does not recommend deletion, and does not generate `--yes`.
- `family <id> --full` keeps full raw `source` and full titles in block output instead of a wide table. JSON output and MCP always keep complete fields.

Use `--source-kind subagent|mcp|vscode|cli|exec|unknown` with family modes when you only want matching family nodes. Default human output is compact and may shorten long text; use `--full`, `family --json`, or MCP `get_session_family` when exact raw fields matter. Actual deletion should still use a separate explicit-ID preview and explicit confirmation.

T8-P2/T9 adds a source metadata compatibility layer. The stable `sourceKind` field remains the coarse compatibility category (`subagent`, `mcp`, `vscode`, `cli`, `exec`, `unknown`). JSON output may also include `sourceInfo` with raw `source`, raw `thread_source`, official Codex v2 source-kind metadata when reliably derived, thread-source analytics metadata, and compact evidence. This is observability only: it does not change filters, delete previews, plan-delete selection, MCP planning, or delete authorization. In particular, internal raw `mcp`, raw `appServer`, and raw `app-server` are reported as stable `sourceKind=mcp` with official metadata `appServer`; they are not proof of individual MCP tool calls.

## Session Titles

A local Codex session can have multiple title sources:

- `displayTitle`: the default title shown in lists, preferred from `session_index.jsonl.thread_name`, and usually closest to what Codex UI search can find.
- `indexTitle`: the title from `session_index.jsonl`.
- `sqliteTitle`: the `threads.title` value from `state_N.sqlite`, which can be an older internal long title.
- `firstUserMessage`: the first user request.
- `titleSource`: where the current display title came from.
- `titleMismatch`: whether title sources disagree.
- `titleCandidates`: all candidate titles.

`list` and search results show `displayTitle` by default. Human-readable `show` prints shortened `sqliteTitle`, `firstUserMessage`, title candidates, and timeline preview so title drift is visible without dumping large transcript-like text. Use `show --json` when you need the full values and full timeline.

## What Codex stores (and what we clean)

When Codex Desktop deletes an archived chat, it may already remove some of these surfaces. `audit-root` can find likely leftover IDs first, `preview-root` can batch-preview the selected IDs, and `audit` gives a read-only report for one ID. `verify` remains useful after a cleanup action. `delete --yes` or `cleanup-index --yes` can remove remaining local records only when you intentionally choose to do so.

```
~/.codex/
├── sessions/            ← raw rollout .jsonl / .jsonl.zst files    ✅ cleaned
├── archived_sessions/   ← archived .jsonl / .jsonl.zst files       ✅ cleaned
├── shell_snapshots/     ← shell snapshot scripts         ✅ cleaned
├── session_index.jsonl  ← session metadata index         ✅ cleaned
├── history.jsonl        ← conversation history index     ✅ cleaned
├── state_N.sqlite       ← threads and related records     ✅ cleaned
├── goals_N.sqlite       ← thread goals, when split out    ✅ cleaned
├── logs_N.sqlite        ← execution logs                 👁 retained by default
├── memories_N.sqlite    ← official memory state           👁 doctor/schema watch only
└── .codex-global-state.json ← known active-session refs   ✅ cleaned
```

SQLite databases may live directly under `~/.codex` or under a separate SQLite home selected by `config.toml sqlite_home` / `CODEX_SQLITE_HOME`. `config.toml sqlite_home` wins when both are set. `doctor` reports the active SQLite home and warns when both locations contain candidate databases.

Compressed `.jsonl.zst` files are covered as session files for scan, preview, delete, trash, restore, and stale detection. They are not decompressed for transcript display; compressed-only sessions use index/history summaries in `show` and timeline output.

## Documentation

- [Security policy](./SECURITY.md) — report data-loss, incomplete-deletion, restore, rollback, path, and local-history exposure issues
- [Safety guide](./docs/SAFETY.md) — read before delete/trash/restore/purge
- [Changelog](./CHANGELOG.md) — release notes
- [SKILL.md](./SKILL.md) — AI skill instructions (slim routing file, ~90 lines)
- [Detailed tool reference](./skills/codex-sessions-manager/docs/SKILL_DETAIL.md) — full CLI/MCP parameter reference
- [Ecosystem adapters](./adapters/) — platform-specific setup for Amp, Claude Code, Codex, Cursor, Factory Droid

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
