# 02 — Compatibility and previews

Status: **completed**
Release: v0.6.3

## Official baseline

The implementation baseline for this program was Codex CLI 0.144.1, pinned by version, release URL, tag URL, and source commit in [`compat/upstream-baseline.json`](../../../compat/upstream-baseline.json).

Release checks reject a compatibility baseline older than seven days. The weekly and manually dispatched compatibility workflow reports upstream version drift without changing code, opening public issues, modifying real Codex data, or publishing a release.

## Storage and timeline compatibility

- Parse legacy `event_msg` and `response_item` records.
- Parse paginated canonical `item_completed` records.
- Produce consistent user, assistant, command, tool, and supported system timeline items across old and new formats.
- Count and disclose unknown items instead of silently dropping them.
- Expose `historyMode`, `recencyAt`, and `recencyAtMs`.
- Sort by `recency_at_ms`, then `recency_at`, then `updated_at`.
- Treat active and archived `.jsonl.zst` files as session files for scan, trash, restore, and export.
- Mark compressed-only transcript reads as `compressed_unread`; never present index/history summaries as complete transcript content.
- Observe Work originator, remote control, external-agent imports, logs, and memory without adding them to ordinary cleanup.

## Preview and export contract

### Human CLI

Human `show` remains compact. It states how many semantic items were returned, how many are known when that number can be established, why content was omitted, and how to request complete local output.

### CLI JSON and export

- `show --json` returns all semantic items that the local reader can parse; it has no total semantic-item cap.
- Per-item tool output may still be truncated and is labelled accordingly.
- Unknown records and parse errors remain visible in completeness metadata.
- `export` writes a JSON recovery bundle containing metadata, matching index/history records, selected global-state references, snapshots, SQLite rows, and session files.
- UTF-8 session files are embedded as text. Binary compressed files are embedded as base64, allowing their original bytes to be reconstructed without claiming that the outer export file is the raw rollout itself.

### MCP

MCP session detail supports two bounded modes:

| Mode | Item limit | Serialized response limit | Source-read limit |
|---|---:|---:|---:|
| `compact` | 20 | 64 KiB | 1 MiB |
| `full` | 200 | 256 KiB | 8 MiB |

List operations are bounded as well. Limit hits stop serialization and return explicit completeness and omission metadata. `itemsKnown=null` means the reader stopped before EOF and cannot claim a complete total.

The cross-session handoff rule is therefore:

- Use MCP for bounded structured context.
- Use CLI JSON for complete locally parseable semantic context.
- Use the CLI JSON recovery bundle or a private file handoff when source bytes must be reconstructed exactly.
- Do not place an entire large session into one MCP response.

## Integration corrections

- The Codex adapter uses official TOML or `codex mcp add`, not a Claude-style JSON configuration.
- Skill documentation includes project `.agents/skills` and user `$HOME/.agents/skills` locations.
- The packaged Skill includes nested `agents/openai.yaml`.
- Tests prevent the root Skill and packaged Skill from drifting.
- MCP server instructions state that complete, large, export, and pipeline work belongs in CLI; MCP is for bounded structured reads and explicitly approved management actions.

## Compatibility system

The tracked [`compat/`](../../../compat) directory contains:

- a pinned upstream baseline;
- synthetic legacy and paginated timeline fixtures;
- synthetic SQLite schema and source-metadata fixtures;
- active and archived compressed-session fixtures;
- sanitized immutable run summaries;
- an offline validator;
- a maintainer-only compatibility prompt.

Public fixtures contain no local paths, real session IDs, or real conversations. Real Codex roots are used only for local read-only smoke tests and private ignored reports.

## Acceptance result

- Legacy, paginated, compressed, unknown-item, parse-error, recency, history-mode, and bounded-preview fixtures passed.
- The Codex adapter and nested Skill packaging passed release checks.
- CLI semantic JSON and recovery-bundle boundaries remained distinct.
- Candidate and registry package bytes matched.
- Final verdict: **GO for v0.6.3 compatibility release**.
