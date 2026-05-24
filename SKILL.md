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
- "Plan deleting these explicit session IDs without deleting anything"
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
- `plan_delete_sessions` (read-only delete planning; cannot execute deletion)
- `preview_delete_plan` (read-only plan-file / inline-plan stale check; cannot execute deletion)
- `delete_sessions` (without `confirm=true`, returns preview only; with `confirm=true`, executes after the caller has reviewed the intended scope; pass `trash=true` for recoverable deletion; P11 exact-key global-state refs follow the same preview/confirm safety model)
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

For family lookups, call `get_session_family` with optional `mode: full | children | parents | subagents | impact` and optional `sourceKind`. These modes are read-only. `impact` is a relationship risk view only; it is not deletion advice, not a delete preview, and must not execute or imply confirmation.

For read-only delete planning through MCP, use `plan_delete_sessions` for explicit-ID plans or sourceKind candidate plans, and `preview_delete_plan` for plan-file / inline-plan stale checks. These tools are read-only, do not create preview tokens, and cannot execute delete-by-plan.

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
codex-sessions family <session-id> --root <path-to-codex-root> --children
codex-sessions family <session-id> --root <path-to-codex-root> --parents
codex-sessions family <session-id> --root <path-to-codex-root> --subagents
codex-sessions family <session-id> --root <path-to-codex-root> --impact
codex-sessions family <session-id> --root <path-to-codex-root> --full
codex-sessions family <session-id> --root <path-to-codex-root> --json
codex-sessions audit <session-id> --root <path-to-codex-root>
codex-sessions audit <session-id> --root <path-to-codex-root> --json
codex-sessions audit-root --root <path-to-codex-root>
codex-sessions audit-root --root <path-to-codex-root> --json --limit 50
codex-sessions audit-root --root <path-to-codex-root> --status risky-global-state --limit 50
codex-sessions audit-root --root <path-to-codex-root> --status global-state-exact-key --limit 50
codex-sessions audit-root --root <path-to-codex-root> --source global-state-unknown --limit 50
codex-sessions audit-root --root <path-to-codex-root> --source global-state-exact-key --limit 50
codex-sessions preview-root --root <path-to-codex-root>
codex-sessions preview-root --root <path-to-codex-root> --json --limit 50
codex-sessions preview-root --root <path-to-codex-root> --status db-only --limit 20
codex-sessions preview-root --root <path-to-codex-root> --status global-state-exact-key --limit 20
codex-sessions preview-root --root <path-to-codex-root> --source global-state-unknown --limit 20
codex-sessions preview-root --root <path-to-codex-root> --source global-state-exact-key --limit 20
codex-sessions export <session-id> --root <path-to-codex-root> --output ./backup.json
codex-sessions plan-delete <session-id...> --root <path-to-codex-root>
codex-sessions plan-delete <session-id...> --root <path-to-codex-root> --include-children
codex-sessions plan-delete <session-id...> --root <path-to-codex-root> --include-subagents
codex-sessions plan-delete <session-id...> --root <path-to-codex-root> --include-descendants
codex-sessions plan-delete <session-id...> --root <path-to-codex-root> --include-family --json
codex-sessions plan-delete <session-id...> --root <path-to-codex-root> --write-plan /tmp/codex-delete-plan.json --json
codex-sessions plan-delete --root <path-to-codex-root> --source-kind subagent --limit 20 --json
codex-sessions plan-delete --root <path-to-codex-root> --source-kind mcp --status archived --limit 20 --json
codex-sessions preview-plan /tmp/codex-delete-plan.json --root <path-to-codex-root> --json
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

Use the `--yes` delete, restore, purge, and cleanup examples only after a separate preview or match listing has been inspected and the user has explicitly confirmed the write.

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
node dist/cli/index.js family <session-id> --root <path-to-codex-root> --children
node dist/cli/index.js family <session-id> --root <path-to-codex-root> --parents
node dist/cli/index.js family <session-id> --root <path-to-codex-root> --subagents
node dist/cli/index.js family <session-id> --root <path-to-codex-root> --impact
node dist/cli/index.js family <session-id> --root <path-to-codex-root> --full
node dist/cli/index.js family <session-id> --root <path-to-codex-root> --json
node dist/cli/index.js audit <session-id> --root <path-to-codex-root>
node dist/cli/index.js audit <session-id> --root <path-to-codex-root> --json
node dist/cli/index.js audit-root --root <path-to-codex-root>
node dist/cli/index.js audit-root --root <path-to-codex-root> --json --limit 50
node dist/cli/index.js audit-root --root <path-to-codex-root> --status risky-global-state --limit 50
node dist/cli/index.js audit-root --root <path-to-codex-root> --status global-state-exact-key --limit 50
node dist/cli/index.js audit-root --root <path-to-codex-root> --source global-state-unknown --limit 50
node dist/cli/index.js audit-root --root <path-to-codex-root> --source global-state-exact-key --limit 50
node dist/cli/index.js preview-root --root <path-to-codex-root>
node dist/cli/index.js preview-root --root <path-to-codex-root> --json --limit 50
node dist/cli/index.js preview-root --root <path-to-codex-root> --status db-only --limit 20
node dist/cli/index.js preview-root --root <path-to-codex-root> --status global-state-exact-key --limit 20
node dist/cli/index.js preview-root --root <path-to-codex-root> --source global-state-unknown --limit 20
node dist/cli/index.js preview-root --root <path-to-codex-root> --source global-state-exact-key --limit 20
node dist/cli/index.js export <session-id> --root <path-to-codex-root> --output ./backup.json
node dist/cli/index.js plan-delete <session-id...> --root <path-to-codex-root>
node dist/cli/index.js plan-delete <session-id...> --root <path-to-codex-root> --include-children
node dist/cli/index.js plan-delete <session-id...> --root <path-to-codex-root> --include-subagents
node dist/cli/index.js plan-delete <session-id...> --root <path-to-codex-root> --include-descendants
node dist/cli/index.js plan-delete <session-id...> --root <path-to-codex-root> --include-family --json
node dist/cli/index.js plan-delete <session-id...> --root <path-to-codex-root> --write-plan /tmp/codex-delete-plan.json --json
node dist/cli/index.js plan-delete --root <path-to-codex-root> --source-kind subagent --limit 20 --json
node dist/cli/index.js plan-delete --root <path-to-codex-root> --source-kind mcp --status archived --limit 20 --json
node dist/cli/index.js preview-plan /tmp/codex-delete-plan.json --root <path-to-codex-root> --json
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

The `--yes` examples above are execution examples, not first-step recommendations. Run the preview-only form first for delete and cleanup, and use explicit confirmation only after reviewing the result.

## Safety Rules

- Run MCP `inspect_root` or CLI `doctor` before delete, restore, purge, or cleanup when Codex storage may have changed.
- Treat delete, restore, purge, and cleanup as dangerous write paths.
- Always run a separate preview or match listing before destructive actions, then require explicit user confirmation for `--yes` or `confirm=true`.
- `summarize_sources`, source filters on `list_sessions`, CLI `sources`, and CLI source filters on `list` are read-only. They must not be treated as cleanup recommendations.
- `sourceKind` is an inferred category only: `subagent`, `mcp`, `vscode`, `cli`, `exec`, or `unknown`. Preserve and report raw `source` when source details matter.
- `source=vscode` is a raw Codex thread source label. Do not present it as proof that the session came from VS Code IDE.
- Do not infer Desktop by exclusion. Anything not classified as `cli`, `mcp`, `vscode`, or `exec` is `unknown`, not automatically Desktop.
- `source=mcp` is a thread source label, not a per-call MCP tool log.
- `model_provider` is display/filter metadata in this skill. Do not use this workflow to repair or rewrite provider identity.
- `get_session_family` and CLI `family` are read-only. They do not delete, export, restore, or select related sessions automatically.
- `get_session_family` modes `full`, `children`, `parents`, `subagents`, and `impact` are read-only. CLI `family --children`, `--parents`, `--subagents`, `--impact`, and `--full` are also read-only.
- `family --impact` and MCP `mode=impact` show relationship impact only. Do not present them as deletion advice or a delete preview, do not generate `--yes`, and do not change delete behavior.
- `thread_spawn_edges` is a generic parent/child edge table, not a subagent-only table. `/side`, `/fork`, subagent, MCP, exec, VS Code, CLI, and unknown sessions may all appear as child threads.
- Classify child type from the child session's own `sourceKind`, raw `source`, `thread_source`, `agent_role`, `agent_nickname`, and `agent_path`. A child can have multiple labels, such as both `subagent` and `side/fork`; use `childTypeLabels` and `relationshipLabels` when available instead of collapsing it to one identity.
- Parent deletion does not automatically process children. Child deletion does not automatically process parents. Real deletion should use a separate preview and explicit confirmation.
- `audit_session` and CLI `audit` are read-only. They report local residue after official UI delete/archive actions and must not rewrite files, SQLite, shell snapshots, or global state.
- `audit_root` and CLI `audit-root` are read-only. They scan for likely residue candidates across a Codex root and must not delete, rewrite, or select parent/child sessions automatically.
- `audit_root` / `audit-root` status and source filters only narrow displayed candidates. Multiple statuses or multiple sources use OR; combining status and source uses AND. A matching candidate is not a deletion list entry or deletion recommendation; it still needs per-session audit or read-only preview before any cleanup decision.
- `preview_root_delete` and CLI `preview-root` are read-only. They reuse `audit-root` filters to build a batch delete preview, but do not delete, do not rewrite JSONL, SQLite, shell snapshots, or global state, do not accept `--yes`, do not recommend deleting any session, and do not recursively select parent, child, or family sessions.
- A `preview-root` result is not a deletion recommendation. Actual deletion should use a separate explicit-ID delete preview for review and then user-confirmed `delete ... --yes`.
- CLI `plan-delete` and MCP `plan_delete_sessions` are read-only. Explicit session IDs can enter `selectedIds`; sourceKind root-level candidate mode can only enter `candidateIds`. They never execute deletion. JSON/structured output must include `readOnly: true` and `executionSupported: false`.
- `plan-delete` selects only seed IDs by default. `--include-children`, `--include-subagents`, `--include-descendants`, and `--include-family` only affect plan selection; `--include-family` is high risk and must be described as such. Side/fork sessions are ambiguous `availableIncludes`; do not invent side/fork include flags.
- `plan-delete --source-kind KIND --limit N` and MCP `plan_delete_sessions` with `sourceKind + limit` are read-only candidate plans only. `limit` is required and capped at 50. Repeated `sourceKind` and repeated `status` use OR. `sourceKind=unknown` root-level plans are rejected; unknown sessions require explicit session ID review. Active/current candidates must remain `rejectedIds`, never `selectedIds` or `candidateIds`. `--write-plan` / `writePlan` is intentionally unsupported for sourceKind candidate plans.
- `sourceKind` is only a filtering dimension and is not deletion authorization. `mcp` is the thread source, not per-tool-call provenance; `vscode` is the raw Codex thread source label, not proof of the VS Code IDE; `exec` does not imply execution logs are safe to batch-delete.
- `plan-delete --write-plan FILE` writes a `codex-sessions-delete-plan.v1` audit file only. It includes root fingerprint, `planHash`, `scanTimestamp`, selected surface counts, family edges, and exact-key paths. It must not include transcript bodies, prompt text, or full global-state values.
- `preview-plan <plan-file>` and MCP `preview_delete_plan` are read-only. They rescan the root and report stale when root realpath, session_index/history/global-state/sqlite mtime/size/parseability, selected surface counts, family edges, or exact-key paths differ. If stale, do not treat it as the current delete preview; `deletePreview` must be null or absent.
- MCP `preview_delete_plan` accepts either `planFile` or an inline plan object and must not accept `confirm`, `trash`, `yes`, `force`, or any write option.
- A `plan-delete` result or plan file is not deletion confirmation, not authorization, not a preview token, and not a substitute for a separate explicit-ID delete preview and explicit user confirmation.
- Delete previews warn when selected sessions have unselected parent, child, or family sessions, and when relationship edges point at missing sessions or missing file/index surfaces.
- CLI `delete` without `--yes` is preview-only.
- MCP `delete_sessions` without `confirm=true` is preview-only.
- Permanent delete remains available for compatibility.
- Prefer recoverable deletion with CLI `--trash --yes` or MCP `trash=true, confirm=true` only after preview review.
- `delete --trash` without `--yes` only previews moving sessions to trash.
- `restore` and `purge` require `--yes` in CLI mode.
- MCP `restore_sessions` and `purge_trash` require `confirm=true`.
- Restore refuses live session conflicts and SQLite key conflicts. There is no force overwrite mode.
- Restore does not remove the trash entry. If a restored session is moved to trash again, `trash-list` may contain multiple recoverable copies for the same session id. This is normal trash state, not live residue.
- A newer trash entry does not replace an older one. Treat old entries as backups until the user explicitly chooses otherwise.
- If one session id maps to multiple trash entries, confirmed `restore` or `purge` must use an exact `trashId`. Do not use the session id for writes in this state.
- Do not auto-purge duplicate trash entries. Report them and wait for explicit user confirmation.
- Before purging an old copy, confirm the live session is absent and at least one backup copy remains, unless the user explicitly accepts having no trash backup.
- `purge` removes only the trash entry and must not touch live sessions.
- `cleanup-index` and `cleanup-stale` rewrite `session_index.jsonl` and `history.jsonl`. They do not delete raw files or SQLite rows, but they still require `--yes`.
- MCP `cleanup_session_indexes` and `cleanup_stale_indexes` require `confirm=true` to rewrite JSONL indexes.
- Global-state cleanup is limited to known structured keys plus the two P11 exact-key paths: `$.electron-persisted-atom-state.prompt-history.<session-id>` and `$.electron-persisted-atom-state.heartbeat-thread-permissions-by-id.<session-id>`.
- P11 exact-key refs are removable only through explicit-ID delete with explicit confirmation (`--yes` or MCP `confirm=true`) after preview review. Preview must show path, rule id, shape, byte estimate, affected surfaces, family warnings, and confirmation requirement. Do not print prompt contents or full global-state values.
- `export_session_backup`, CLI `export`, and trash bundles are recovery data, not previews. They may include full exact-key global-state values, including prompt-history content, so do not print them back to the user unless explicitly requested for recovery.
- Unknown global-state references outside those exact-key rules are warnings only. Do not edit or delete unknown keys automatically. Refuse cleanup when an ID matches only ineligible unknown global-state refs.
- The current CLI/MCP does not use a preview token. The confirmed delete command rescans the root. If global-state changes again inside that confirmed command before the write, cannot be parsed, or lacks snapshot/rollback protection, refuse the write and tell the user to rerun preview.
- If `audit`, `audit-root`, `preview-root`, `verify`, `doctor`, or `inspect_root` reports warnings, tell the user. Do not claim the root is fully clean.
- Do not output chat content when reporting audit, doctor, verify, or global-state warnings.

## Side Conversations

Codex `/side` creates an ephemeral side conversation with a separate transcript. In local storage, it can appear as a separate child thread linked to a parent thread.

When a user asks about side conversations:

- Treat the parent thread and side child thread as separate sessions with separate transcripts.
- Use `get_session_family` or CLI `family` first to identify parent, child, `/side`, `/fork`, subagent, and unknown child relationships.
- Treat `thread_spawn_edges` as generic parent/child edges. Do not describe them as a subagent-only table.
- Determine child type from the child session's own `sourceKind`, raw `source`, `thread_source`, and agent metadata. Preserve mixed labels when a child is both side/fork-like and has subagent information.
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
- For family requests: distinguish current session, root, direct parents, direct children, ancestors, descendants, siblings, full family members, edge status, `sourceKind`, raw `source`, `thread_source`, agent metadata, child type labels, relationship labels, and file/index/thread presence. Human CLI output is compact by default and may shorten long text; `--full`, JSON, and MCP keep full raw fields. Report broken relationship groups and missing surface groups clearly. Say clearly that family views are read-only and cover only explicitly selected session IDs.
- For family children requests: use MCP `get_session_family mode=children` or CLI `family --children`. Show direct children only, grouped or labeled by child type when useful.
- For family parent requests: use MCP `get_session_family mode=parents` or CLI `family --parents`. Show direct parents only.
- For family subagent requests: use MCP `get_session_family mode=subagents` or CLI `family --subagents`. Include nickname and role when available.
- For family impact requests: use MCP `get_session_family mode=impact` or CLI `family --impact`. Report selected session, unselected parents, unselected children, unselected family members, missing relations, and missing file/index/thread surfaces. Say clearly that it is read-only, not deletion advice, and not a substitute for delete preview.
- For side-conversation requests: distinguish parent thread ID and child thread ID, and say whether the requested action covers one or both.
- For audit requests: report the overall status, each residue surface count, family summary, warnings, and the preview-only next command. Say clearly that audit does not delete anything and that parent/child sessions are not handled recursively.
- For root residue requests: use MCP `audit_root` or CLI `audit-root`. Report `filters`, `totalCandidatesBeforeFilter`, `totalCandidatesAfterFilter`, `returnedCandidates`, limit, `byStatus`, `bySource`, session IDs, status labels, residue source counts, family/broken-family state, and the recommended per-session audit command. Do not print chat content. Say clearly that root scans do not delete anything, candidates are not a deletion list, filtered candidates are not automatically safe to delete, and parent/child sessions are not handled recursively.
- For root delete preview requests: use MCP `preview_root_delete` or CLI `preview-root`. Report filters, candidate totals before and after filters, previewed and omitted counts, aggregate preview counts, family warning summary, each candidate ID, statuses, sources, preview counts, family warning state, and recommended single-session audit/preview commands. Say clearly that it is read-only, does not delete, does not recommend deleting any session, does not recurse through family, and does not prove the candidates should be deleted.
- For plan-delete requests: use CLI `plan-delete` or MCP `plan_delete_sessions` depending on caller context. Report seed IDs, selected IDs, candidate IDs when present, included IDs with reasons, available includes, rejected IDs, warnings, broken relations, missing surfaces, surface counts, and exact-key global-state metadata. If `--write-plan` is requested, say the plan file is audit material only and not authorization/preview token/delete confirmation. Say clearly that it is read-only, did not delete anything, family is not included by default, and execution is not supported.
- For preview-plan requests: use CLI `preview-plan` or MCP `preview_delete_plan` depending on caller context. Report `stale`, stale reasons, rejected IDs, and the read-only delete preview only when stale is false. Never add `--yes`, `--trash`, `--force`, `confirm`, or any delete execution step based on a plan file.
- For delete requests: explain whether this is preview-only, permanent delete, or recoverable trash delete. Do not run confirmed deletion unless a separate preview has been reviewed and the user explicitly confirmed execution.
- For trash requests: distinguish moved to trash, restored, and purged.
- For restore conflicts: explain that the live session already exists and identify conflicting surfaces when available.
- For verify requests: report whether files, JSONL rows, SQLite rows, shell snapshots, known global-state refs, exact-key global-state refs, unknown global-state refs, or warnings remain.
- For doctor / inspect requests: report OK, missing, and warning states without printing chat content.
- For exact-key global-state refs: report path, rule id, value shape, byte estimate, and confirmation requirement; do not print values.
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
