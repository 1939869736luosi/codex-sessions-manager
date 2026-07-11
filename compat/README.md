# Codex Compatibility Checks

This directory keeps the public, reproducible compatibility evidence used before a release. It contains only synthetic fixtures and fixed upstream references. Real Codex roots, local paths, session text, counts, and private reports must stay in ignored private runs.

The five check routes are:

1. **Storage structure** — SQLite columns, active/archived rollout locations, and compressed rollout discovery.
2. **Rollout parsing** — legacy `event_msg` / `response_item` records and paginated `event_msg.payload.type=item_completed` records.
3. **Codex integration** — official TOML MCP configuration, CLI-first guidance, and `.agents/skills` packaging with nested `agents/openai.yaml`.
4. **Safety promises** — compressed-only honesty, bounded MCP output, exact export boundaries, and no expansion of ordinary cleanup into memory, logs, remote-control, or external agent imports.
5. **Local read-only smoke** — a maintainer may inspect a real Codex root, but the public result records only a pass/fail summary with no paths, identifiers, text, or machine-specific counts.

## Files

- `upstream-baseline.json` pins the checked stable Codex release and commit.
- `fixtures/` contains synthetic old/new timeline, SQLite, origin metadata, and compressed rollout samples.
- `runs/` contains dated, immutable public summaries. A finding, its fix, and the post-fix verification are recorded separately.
- `MAINTAINER_PROMPT.md` is an explicit maintainer-only prompt. It is not part of the normal user Skill context.

Run the offline checks with:

```bash
npm run compat:check
```

Release jobs use `npm run compat:release-check`, which also rejects a baseline older than seven days. The weekly workflow only reports whether the official stable release changed. It never edits code, opens a public issue, publishes a package, or touches a Codex root.
