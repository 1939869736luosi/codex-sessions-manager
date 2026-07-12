# Maintainer Compatibility Prompt

This is a **maintainer-only** prompt. Do not place it in the ordinary `codex-sessions-manager` user Skill or invoke it automatically.

Check the current official stable OpenAI Codex release against both tracked baselines: storage compatibility and official capability replacement. Use fixed official release, tag, commit, documentation, and source references. Review exactly these surfaces:

1. storage roots and SQLite migrations;
2. legacy and paginated rollout serialization;
3. active and archived `.jsonl.zst` behavior;
4. official MCP TOML and Skill packaging;
5. safety promises for cleanup, memory, logs, remote-control, and external agent imports.
6. official overlap for list/read/search, normal thread controls, permanent delete, recoverable delete, post-delete verification, memory controls, external-agent import, and turn/item pagination.

For every capability in `upstream-capabilities.json`, decide whether the evidence still supports its official status, overlap, and project disposition. Add newly relevant official capabilities and remove obsolete rows only with an explicit reason. Specifically verify:

- what official `thread/delete` removes in this fixed release and what still requires dynamic testing;
- whether official Codex now offers per-entry or per-session memory list/edit/delete;
- whether thread deletion removes Stage 1 memory state and whether derived memory reconsolidation is synchronous, delayed, failed, or still ambiguous;
- whether an official read, pagination, handoff, import, or management API makes a planned project tool redundant.

Update only synthetic fixtures, the two public baselines, and public summaries. Keep real paths, session text, local counts, security details, and machine-specific evidence in `compat/runs/private/`. A detected upstream change is a finding, not permission to edit or remove code, mutate real Codex data, or publish. Record finding, replacement decision, fix, and post-fix verification separately.
