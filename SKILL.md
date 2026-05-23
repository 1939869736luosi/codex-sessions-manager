---
name: codex-sessions-manager
description: Use this skill when the user wants to inspect, search, export, verify, clean up, delete, restore, or purge local Codex sessions stored under a Codex root such as ~/.codex, including auditing leftovers after Codex Desktop's built-in delete.
metadata:
  source: https://github.com/1939869736luosi/codex-sessions-manager
---

# Codex Sessions Manager

## Overview

This skill manages local Codex sessions through the `codex-sessions` toolkit.

Use it when the user wants to work with local Codex conversation history instead of the current live conversation.

Codex Desktop has a built-in delete action for archived chats. Use this toolkit when the user needs local proof of what remains, exact ID-based cleanup, batch handling, recoverable trash, restore, or post-delete verification.

This repository provides:

- a Node / TypeScript CLI
- a local stdio MCP server
- this Skill entrypoint

The project is not a UI product, TUI, detail page, incremental scanner, or automatic cleanup service.

## Setup

Install the CLI before using fallback commands:

```bash
npm install -g codex-sessions-manager
```

This provides:

```text
codex-sessions
codex-sessions-mcp
```

For local development, build the repository first:

```bash
cd <path-to-codex-sessions-repo>
npm install
npm run build
```

The default Codex root is:

```text
~/.codex
```

Use `--root <path-to-codex-root>` when working with another Codex root.

## When To Use

Use this skill for requests like:

- "List my recent Codex sessions"
- "Find sessions for this project"
- "Show this session"
- "Find the session family for this session"
- "Show parent and side/fork child sessions"
- "Find side conversations for this session"
- "Audit what remains locally after the official Codex UI delete/archive action"
- "Find likely local residue without knowing the session ID"
- "Preview deleting likely root residue candidates"
- "Export this session"
- "Preview deleting these sessions"
- "Check what Codex Desktop left behind after deleting a chat"
- "Move these sessions to trash"
- "Restore this trash entry"
- "Purge this trash entry"
- "Verify whether this session is fully removed"
- "Inspect the Codex root before deleting or restoring"
- "Clean stale JSONL indexes"

Do not use this skill for:

- generic ChatGPT history questions
- replacing the ordinary Codex Desktop delete UI for simple archived-chat deletion
- non-Codex chat clients
- editing the current live conversation
- automatic cleanup schedules
- provider or model repair

## Preferred Order

### 1. Prefer MCP first

If the `codex-sessions` MCP server is available in the current agent session, use these tools:

- `inspect_root`
- `list_sessions`
- `summarize_sources` (read-only source summary)
- `list_projects`
- `get_session`
- `get_session_family` (read-only session family inspection)
- `audit_session` (read-only residue audit)
- `audit_root` (read-only root residue scan; candidates are not deletion recommendations)
- `preview_root_delete` (read-only root delete preview; never deletes and never recommends deletion)
- `export_session_backup`
- `preview_delete_sessions`
- `delete_sessions` (requires `confirm=true` to execute; pass `trash=true` for recoverable deletion)
- `list_trash`
- `restore_sessions` (requires `confirm=true`)
- `purge_trash` (requires `confirm=true`)
- `cleanup_session_indexes` (requires `confirm=true` to rewrite JSONL indexes)
- `cleanup_stale_indexes` (requires `confirm=true` to rewrite JSONL indexes)
- `verify_sessions`

Use MCP tools first. CLI is the fallback when MCP is unavailable or blocked.

For session lookup, narrow in this order:

1. project
2. status
3. updated / created time
4. preview or `get_session`

For project-aware listing, pass `project` to `list_sessions` or use `groupBy="project"`.

For time filters, pass `updatedAfter`, `updatedBefore`, `createdAfter`, or `createdBefore`. Date-only filters use the local calendar day. Timezone-less datetime strings must be rejected.

For source-aware listing, pass `sourceKind`, `source`, `threadSource`, `agentRole`, `agentNickname`, `modelProvider`, or `model` to `list_sessions`. Use `summarize_sources` for a read-only count by `sourceKind`, raw `source`, `thread_source`, `model_provider`, `model`, and `agent_role`.

### 2. Fall back to CLI

Prefer the installed CLI:

```bash
codex-sessions doctor --root <path-to-codex-root>
codex-sessions doctor --root <path-to-codex-root> --json
codex-sessions list --root <path-to-codex-root> --limit 20
codex-sessions list --root <path-to-codex-root> --project TEXT
codex-sessions list --root <path-to-codex-root> --group-by project
codex-sessions list --root <path-to-codex-root> --updated-after 2026-04-01 --updated-before 2026-04-30
codex-sessions list --root <path-to-codex-root> --source-kind cli --model-provider openai
codex-sessions list --root <path-to-codex-root> --source mcp --thread-source mcp
codex-sessions list --root <path-to-codex-root> --agent-role subagent --agent-nickname helper
codex-sessions sources --root <path-to-codex-root>
codex-sessions sources --root <path-to-codex-root> --json
codex-sessions projects --root <path-to-codex-root>
codex-sessions show <session-id> --root <path-to-codex-root>
codex-sessions family <session-id> --root <path-to-codex-root>
codex-sessions family <session-id> --root <path-to-codex-root> --json
codex-sessions audit <session-id> --root <path-to-codex-root>
codex-sessions audit <session-id> --root <path-to-codex-root> --json
codex-sessions audit-root --root <path-to-codex-root>
codex-sessions audit-root --root <path-to-codex-root> --json --limit 50
codex-sessions audit-root --root <path-to-codex-root> --status risky-global-state --limit 50
codex-sessions audit-root --root <path-to-codex-root> --source global-state-unknown --limit 50
codex-sessions preview-root --root <path-to-codex-root>
codex-sessions preview-root --root <path-to-codex-root> --json --limit 50
codex-sessions preview-root --root <path-to-codex-root> --status db-only --limit 20
codex-sessions preview-root --root <path-to-codex-root> --source global-state-unknown --limit 20
codex-sessions export <session-id> --root <path-to-codex-root> --output ./backup.json
codex-sessions delete <session-id...> --root <path-to-codex-root>
codex-sessions delete <session-id...> --root <path-to-codex-root> --yes
codex-sessions delete <session-id...> --root <path-to-codex-root> --trash
codex-sessions delete <session-id...> --root <path-to-codex-root> --trash --yes
codex-sessions trash-list --root <path-to-codex-root>
codex-sessions restore <trash-id-or-session-id> --root <path-to-codex-root>
codex-sessions restore <trash-id-or-session-id> --root <path-to-codex-root> --yes
codex-sessions purge <trash-id-or-session-id> --root <path-to-codex-root>
codex-sessions purge <trash-id-or-session-id> --root <path-to-codex-root> --yes
codex-sessions cleanup-index <session-id...> --root <path-to-codex-root>
codex-sessions cleanup-index <session-id...> --root <path-to-codex-root> --yes
codex-sessions cleanup-stale --root <path-to-codex-root>
codex-sessions cleanup-stale --root <path-to-codex-root> --yes
codex-sessions verify <session-id...> --root <path-to-codex-root>
```

When working from a cloned repository instead, run commands from the built repository:

```bash
cd <path-to-codex-sessions-repo>
```

Commands:

```bash
node dist/cli/index.js doctor --root <path-to-codex-root>
node dist/cli/index.js doctor --root <path-to-codex-root> --json
node dist/cli/index.js list --root <path-to-codex-root> --limit 20
node dist/cli/index.js list --root <path-to-codex-root> --project TEXT
node dist/cli/index.js list --root <path-to-codex-root> --group-by project
node dist/cli/index.js list --root <path-to-codex-root> --updated-after 2026-04-01 --updated-before 2026-04-30
node dist/cli/index.js list --root <path-to-codex-root> --source-kind cli --model-provider openai
node dist/cli/index.js list --root <path-to-codex-root> --source mcp --thread-source mcp
node dist/cli/index.js list --root <path-to-codex-root> --agent-role subagent --agent-nickname helper
node dist/cli/index.js sources --root <path-to-codex-root>
node dist/cli/index.js sources --root <path-to-codex-root> --json
node dist/cli/index.js projects --root <path-to-codex-root>
node dist/cli/index.js show <session-id> --root <path-to-codex-root>
node dist/cli/index.js family <session-id> --root <path-to-codex-root>
node dist/cli/index.js family <session-id> --root <path-to-codex-root> --json
node dist/cli/index.js audit <session-id> --root <path-to-codex-root>
node dist/cli/index.js audit <session-id> --root <path-to-codex-root> --json
node dist/cli/index.js audit-root --root <path-to-codex-root>
node dist/cli/index.js audit-root --root <path-to-codex-root> --json --limit 50
node dist/cli/index.js audit-root --root <path-to-codex-root> --status risky-global-state --limit 50
node dist/cli/index.js audit-root --root <path-to-codex-root> --source global-state-unknown --limit 50
node dist/cli/index.js preview-root --root <path-to-codex-root>
node dist/cli/index.js preview-root --root <path-to-codex-root> --json --limit 50
node dist/cli/index.js preview-root --root <path-to-codex-root> --status db-only --limit 20
node dist/cli/index.js preview-root --root <path-to-codex-root> --source global-state-unknown --limit 20
node dist/cli/index.js export <session-id> --root <path-to-codex-root> --output ./backup.json
node dist/cli/index.js delete <session-id...> --root <path-to-codex-root>
node dist/cli/index.js delete <session-id...> --root <path-to-codex-root> --yes
node dist/cli/index.js delete <session-id...> --root <path-to-codex-root> --trash
node dist/cli/index.js delete <session-id...> --root <path-to-codex-root> --trash --yes
node dist/cli/index.js trash-list --root <path-to-codex-root>
node dist/cli/index.js restore <trash-id-or-session-id> --root <path-to-codex-root>
node dist/cli/index.js restore <trash-id-or-session-id> --root <path-to-codex-root> --yes
node dist/cli/index.js purge <trash-id-or-session-id> --root <path-to-codex-root>
node dist/cli/index.js purge <trash-id-or-session-id> --root <path-to-codex-root> --yes
node dist/cli/index.js cleanup-index <session-id...> --root <path-to-codex-root>
node dist/cli/index.js cleanup-index <session-id...> --root <path-to-codex-root> --yes
node dist/cli/index.js cleanup-stale --root <path-to-codex-root>
node dist/cli/index.js cleanup-stale --root <path-to-codex-root> --yes
node dist/cli/index.js verify <session-id...> --root <path-to-codex-root>
```

## Safety Rules

- Run MCP `inspect_root` or CLI `doctor` before delete, restore, purge, or cleanup when Codex storage may have changed.
- Treat delete, restore, purge, and cleanup as dangerous write paths.
- Always preview before destructive actions unless the user has already clearly confirmed execution.
- `summarize_sources`, source filters on `list_sessions`, CLI `sources`, and CLI source filters on `list` are read-only. They must not be treated as cleanup recommendations.
- `sourceKind` is an inferred category only: `subagent`, `mcp`, `vscode`, `cli`, `exec`, or `unknown`. Preserve and report raw `source` when source details matter.
- `source=vscode` is a raw Codex thread source label. Do not present it as proof that the session came from VS Code IDE.
- Do not infer Desktop by exclusion. Anything not classified as `cli`, `mcp`, `vscode`, or `exec` is `unknown`, not automatically Desktop.
- `source=mcp` is a thread source label, not a per-call MCP tool log.
- `model_provider` is display/filter metadata in this skill. Do not use this workflow to repair or rewrite provider identity.
- `get_session_family` and CLI `family` are read-only. They do not delete, export, restore, or select related sessions automatically.
- `audit_session` and CLI `audit` are read-only. They report local residue after official UI delete/archive actions and must not rewrite files, SQLite, shell snapshots, or global state.
- `audit_root` and CLI `audit-root` are read-only. They scan for likely residue candidates across a Codex root and must not delete, rewrite, or select parent/child sessions automatically.
- `audit_root` / `audit-root` status and source filters only narrow displayed candidates. Multiple statuses or multiple sources use OR; combining status and source uses AND. A matching candidate is not a deletion list entry or deletion recommendation; it still needs per-session audit or read-only preview before any cleanup decision.
- `preview_root_delete` and CLI `preview-root` are read-only. They reuse `audit-root` filters to build a batch delete preview, but do not delete, do not rewrite JSONL, SQLite, shell snapshots, or global state, do not accept `--yes`, do not recommend deleting any session, and do not recursively select parent, child, or family sessions.
- A `preview-root` result is not a deletion recommendation. Actual deletion requires the user to run `delete ... --yes` explicitly.
- Delete previews warn when selected sessions have unselected parent, child, or family sessions, and when relationship edges point at missing sessions or missing file/index surfaces.
- CLI `delete` without `--yes` is preview-only.
- MCP `delete_sessions` without `confirm=true` is preview-only.
- Permanent delete remains available for compatibility.
- Prefer recoverable deletion with CLI `--trash --yes` or MCP `trash=true, confirm=true`.
- `delete --trash` without `--yes` only previews moving sessions to trash.
- `restore` and `purge` require `--yes` in CLI mode.
- MCP `restore_sessions` and `purge_trash` require `confirm=true`.
- Restore refuses live session conflicts and SQLite key conflicts. There is no force overwrite mode.
- `purge` removes only the trash entry and must not touch live sessions.
- `cleanup-index` and `cleanup-stale` rewrite `session_index.jsonl` and `history.jsonl`. They do not delete raw files or SQLite rows, but they still require `--yes`.
- MCP `cleanup_session_indexes` and `cleanup_stale_indexes` require `confirm=true` to rewrite JSONL indexes.
- Global-state cleanup is limited to known structured keys.
- Unknown global-state references are warnings only. Do not edit or delete unknown keys automatically.
- If `audit`, `audit-root`, `preview-root`, `verify`, `doctor`, or `inspect_root` reports warnings, tell the user. Do not claim the root is fully clean.
- Do not output chat content when reporting audit, doctor, verify, or global-state warnings.

## Side Conversations

Codex `/side` creates an ephemeral side conversation with a separate transcript. In local storage, it can appear as a separate child thread linked to a parent thread.

When a user asks about side conversations:

- Treat the parent thread and side child thread as separate sessions with separate transcripts.
- Use `get_session_family` or CLI `family` first to identify parent, child, `/side`, and `/fork` relationships.
- If family output reports broken relationship warnings, tell the user the relationship record exists but the related session may be missing files, index rows, or full session records.
- Search, show, export, delete, trash, restore, or verify the child thread by its own session ID.
- Do not assume deleting, exporting, or summarizing a parent thread also handles its side child threads.
- If the user wants a parent thread and its side conversations handled together, identify the child thread IDs first, preview all selected IDs together, and only then run any confirmed write operation.
- Current CLI/MCP behavior does not automatically recurse from parent to side child threads.

## Response Style

- For list requests: show session ID, updated time, size, project, status, and `displayTitle`.
- For source requests: use MCP `summarize_sources` or CLI `sources`. Report counts by `sourceKind` and include raw `source`, `thread_source`, `model_provider`, `model`, and `agent_role` when useful. Say clearly that source queries are read-only and do not prove Desktop, VS Code IDE, or individual MCP tool calls.
- For source-filtered list requests: use `list_sessions` or CLI `list` with `sourceKind`, `source`, `threadSource`, `agentRole`, `agentNickname`, `modelProvider`, and `model` filters. Different fields combine; repeated values inside one field are alternatives.
- For project requests: show project name/path, session count, status counts, latest updated time, and total size.
- For show requests: summarize the session and include key metadata. Include `displayTitle`, `indexTitle`, `sqliteTitle`, `firstUserMessage`, `titleSource`, `titleMismatch`, and `titleCandidates` when available. Human-readable CLI output may shorten long title fields and timeline previews; use JSON/MCP output for full values.
- Treat `displayTitle` as the default user-facing title. It prefers `session_index.jsonl.thread_name`, which is usually the title searchable in Codex UI. Do not present `sqliteTitle` as the only title when sources disagree.
- For family requests: distinguish current session, root, parent IDs, child IDs, relationship status, archived state, file existence, short `source` label, and source metadata. Human CLI output shows compact `source` labels; JSON/MCP output keeps the full raw `source` field. Report broken relationship warnings clearly. Say clearly that the action covers only explicitly selected session IDs.
- For side-conversation requests: distinguish parent thread ID and child thread ID, and say whether the requested action covers one or both.
- For audit requests: report the overall status, each residue surface count, family summary, warnings, and the preview-only next command. Say clearly that audit does not delete anything and that parent/child sessions are not handled recursively.
- For root residue requests: use MCP `audit_root` or CLI `audit-root`. Report `filters`, `totalCandidatesBeforeFilter`, `totalCandidatesAfterFilter`, `returnedCandidates`, limit, `byStatus`, `bySource`, session IDs, status labels, residue source counts, family/broken-family state, and the recommended per-session audit command. Do not print chat content. Say clearly that root scans do not delete anything, candidates are not a deletion list, filtered candidates are not automatically safe to delete, and parent/child sessions are not handled recursively.
- For root delete preview requests: use MCP `preview_root_delete` or CLI `preview-root`. Report filters, candidate totals before and after filters, previewed and omitted counts, aggregate preview counts, family warning summary, each candidate ID, statuses, sources, preview counts, family warning state, and recommended single-session audit/preview commands. Say clearly that it is read-only, does not delete, does not recommend deleting any session, does not recurse through family, and does not prove the candidates should be deleted.
- For delete requests: explain whether this is preview-only, permanent delete, or recoverable trash delete.
- For trash requests: distinguish moved to trash, restored, and purged.
- For restore conflicts: explain that the live session already exists and identify conflicting surfaces when available.
- For verify requests: report whether files, JSONL rows, SQLite rows, shell snapshots, global-state refs, or warnings remain.
- For doctor / inspect requests: report OK, missing, and warning states without printing chat content.
- For unknown global-state refs: report key path and count, not full global state content.

## Non-Goals

Do not build or imply support for:

- UI
- TUI
- detail pages
- incremental project scanning
- automatic stale cleanup
- automatic trash purge
- force overwrite restore
- automatic editing of unknown global-state keys
- non-Codex chat cleanup
