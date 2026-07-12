# Architecture

Codex Sessions Manager is a local history audit, residue-verification, recovery, and exceptional-cleanup project. Official Codex owns normal thread management and normal permanent deletion. This project independently checks deletion outcomes, handles legacy or damaged storage, and provides previewable recoverable cleanup when official workflows are not enough.

## Official-first boundary

| Workflow | Owner |
|---|---|
| Normal list, search, read, rename, archive, resume, fork, messaging, goals, and permanent delete | Official Codex |
| Post-delete residue verification, old-format inspection, damaged/orphaned state, recoverable trash/restore, mutation journal, and failure recovery | This project |
| Official capability replacement and storage-format drift review | Shared compatibility process under `compat/` |

The tracked decision record is `compat/upstream-capabilities.json`. A new official capability is not copied automatically. It is classified as official-first, retained, verify-only, deferred, or removed before code or documentation changes.

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

The CLI is the preferred public interface for automation, pipes, all locally parseable semantic JSON, canonical event streams, and JSON recovery bundles whose embedded source files preserve reconstructable text or binary bytes. Human output may be compact, but JSON and file output must state their completeness.

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
| `logs_N.sqlite` | Read-only observation in this project; official delete behavior is version-tracked separately |
| `memories_N.sqlite`, `MEMORY.md`, summaries, memory skills | Read-only association and compatibility watch; precise final-memory deletion verification is future work; no direct mutation |
| remote-control and external-agent imports | Observation only; retained |

## Result contract

Mutations report `operationStatus`, `verificationStatus`, actual `verificationScope`, warnings, and stable error codes. A committed mutation with partial or failed verification remains reported as committed. Recovery-required state blocks later mutations.

Read results report completeness. `show --json` returns all locally parseable semantic items; `export` is a JSON recovery bundle with reconstructable embedded source bytes; `events` is a complete canonical local stream. MCP list, session detail, doctor, and event pages are deliberately bounded and disclose omissions.
