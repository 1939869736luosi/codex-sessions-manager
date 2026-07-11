# Maintainer Compatibility Prompt

This is a **maintainer-only** prompt. Do not place it in the ordinary `codex-sessions-manager` user Skill or invoke it automatically.

Check the current official stable OpenAI Codex release against the tracked baseline. Use fixed official release, tag, commit, documentation, and source references. Review exactly these surfaces:

1. storage roots and SQLite migrations;
2. legacy and paginated rollout serialization;
3. active and archived `.jsonl.zst` behavior;
4. official MCP TOML and Skill packaging;
5. safety promises for cleanup, memory, logs, remote-control, and external agent imports.

Update only synthetic fixtures and public summaries. Keep real paths, session text, local counts, security details, and machine-specific evidence in `compat/runs/private/`. A detected upstream change is a finding, not permission to edit code or publish. Record finding, decision, fix, and post-fix verification separately.
