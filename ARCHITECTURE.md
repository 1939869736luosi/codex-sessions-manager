# Architecture

Codex Sessions Manager is a local audit, residue-verification, controlled-cleanup, and cross-host tooling project. Official Codex remains the normal thread-management UI. This project focuses on local storage evidence and carefully scoped operations that the official UI does not expose.

## Layers

```text
CLI arguments / human output / JSON        MCP schemas / bounded responses / profiles
                  \                         /
                   shared application operations
          validation -> scan -> plan -> execute -> verify
                              |
             filesystem, JSONL, SQLite, global state
```

### CLI

The CLI is the preferred public interface for automation, pipes, complete locally parseable JSON, canonical event streams, and byte-exact exports. Human output may be compact, but JSON and file output must state their completeness.

### MCP

MCP is retained where structured results, host authorization, server instructions, and bounded reads are useful. The default profile is read-only. The admin profile registers only explicit management tools and still requires confirmation. MCP responses have item and byte limits; complete large data stays in CLI or files.

### Application operations

Application operations own input validation, root selection, authorization, planning, journaling, execution, verification, and stable result semantics. CLI and MCP adapters call these operations directly. They do not reinterpret safety errors, and MCP does not invoke the CLI through a shell.

### Core storage layer

The core understands the canonical Codex root and the separately trusted SQLite home. Managed descendants reject symlinks, junctions, hard-linked files, path escapes, stale identities, and unsupported special files. The current implementation narrows filesystem races through repeated identity checks and fail-closed behavior; it does not claim descriptor-relative protection against a malicious same-user process continuously racing paths.

## Storage ownership

| Surface | Ordinary session operation |
|---|---|
| `sessions/`, `archived_sessions/`, `.jsonl.zst` | Read, export, trash, restore, or delete when explicitly selected |
| `session_index.jsonl`, `history.jsonl` | Read and controlled atomic rewrite |
| state/goals SQLite session rows | Read and row-scoped mutation with recovery |
| `logs_N.sqlite` | Read-only observation; retained |
| `memories_N.sqlite`, `MEMORY.md`, summaries, memory skills | Read-only association; retained |
| remote-control and external-agent imports | Observation only; retained |

## Result contract

Mutations report `operationStatus`, `verificationStatus`, actual `verificationScope`, warnings, and stable error codes. A committed mutation with partial or failed verification remains reported as committed. Recovery-required state blocks later mutations.

Read results report completeness. `show --json` returns all locally parseable semantic items; `export` is byte-exact; `events` is a complete canonical local stream. MCP list, session detail, doctor, and event pages are deliberately bounded and disclose omissions.
