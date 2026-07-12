# Codex Compatibility Checks

This directory keeps the public, reproducible compatibility evidence used before a release. It contains only synthetic fixtures and fixed upstream references. Real Codex roots, local paths, session text, counts, and private reports must stay in ignored private runs.

The six check routes are:

1. **Storage structure** — SQLite columns, active/archived rollout locations, and compressed rollout discovery.
2. **Rollout parsing** — legacy `event_msg` / `response_item` records and paginated `event_msg.payload.type=item_completed` records.
3. **Codex integration** — official TOML MCP configuration, CLI-first guidance, and `.agents/skills` packaging with nested `agents/openai.yaml`.
4. **Safety promises** — compressed-only honesty, bounded MCP output, exact export boundaries, and no expansion of ordinary cleanup into memory, logs, remote-control, or external agent imports.
5. **Local read-only smoke** — a maintainer may inspect a real Codex root, but the public result records only a pass/fail summary with no paths, identifiers, text, or machine-specific counts.
6. **Capability replacement** — record which normal session-management, delete, memory, import, and pagination capabilities official Codex now provides; classify the project response as official-first, retained, verify-only, deferred, or removed.

## Files

- `upstream-baseline.json` pins the checked stable Codex release and commit.
- `upstream-capabilities.json` is the versioned official-overlap and project-disposition table. It must be reviewed with the storage baseline, not maintained as README prose alone.
- `fixtures/` contains synthetic old/new timeline, SQLite, origin metadata, and compressed rollout samples.
- `runs/` contains dated, immutable public summaries. A finding, its fix, and the post-fix verification are recorded separately.
- `MAINTAINER_PROMPT.md` is an explicit maintainer-only prompt. It is not part of the normal user Skill context.

Run the offline checks with:

```bash
npm run compat:check
```

Release jobs use `npm run compat:release-check`, which also rejects a baseline older than seven days. A release review is incomplete until both storage compatibility and capability replacement have been checked. The weekly workflow reports stable-version drift and whether a replacement review is required; it never edits code, opens a public issue, publishes a package, or touches a Codex root.

## Capability decisions

For each tracked official capability, answer all four questions:

1. Is it stable, experimental, unavailable, or still unknown in the pinned release?
2. Does it fully replace, partially overlap, or complement this project?
3. Should this project use the official path first, retain an independent function, verify official behavior, defer work, or stop expanding the duplicate area?
4. Which fixed official source or current documentation proves the decision?

Normal thread controls move to official-first as soon as the official contract is adequate. Existing compatibility commands may remain for offline, legacy, damaged, or cross-host evidence, but they must not be marketed as a competing normal task manager. A capability marked `removed` must keep both `removalReason` and `migrationNotes`; the watch workflow never removes code automatically.

Memory review must always check whether official Codex has added per-entry or per-session list/edit/delete controls, whether `thread/delete` schedules and completes reconsolidation, and whether full reset or task-level controls changed. Until a supported granular contract exists, this project stays read-only and must not recommend direct database or generated-file editing.
