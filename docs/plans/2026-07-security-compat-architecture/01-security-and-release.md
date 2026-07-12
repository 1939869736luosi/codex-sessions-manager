# 01 — Security and release safety

Status: **completed**
Release line: v0.6.1 candidate → v0.6.2 verified security release

## Problem statement

The pre-fix implementation trusted lexical paths and retained scan-time absolute paths. A malformed or unexpectedly linked local Codex layout could cause inspection or explicitly confirmed cleanup to reach outside the selected Codex root. Additional failure cases could report a completed mutation as if nothing happened, leave multi-file state partially updated, load very large SQLite files into memory for rollback, or silently hide invalid trash manifests.

The issue required local filesystem manipulation or malformed local state and an affected command invocation. It was treated as a release-blocking local High/P1 issue, not remote code execution.

## Baseline and local-work preservation

The opening audit compared local `HEAD`, `origin/main`, and tag `v0.6.0`. All three resolved to commit `3900270e74317f54d15fd779e89eadf756982ecb`, and the tracked worktree contained no unpushed code that needed a public backup branch or rewritten tag.

The only untracked inputs relevant to the audit were private session exports and an internal security report. They were deliberately kept outside Git, GitHub artifacts, and npm packages rather than being mistaken for publishable source changes. This established the rollback baseline while preserving the private evidence boundary.

## Trusted-root model

- Resolve the user-selected Codex root once to a canonical real path and bind operations to its filesystem identity.
- Treat configured `sqlite_home` as a separate trusted root because Codex may store SQLite outside the Codex root.
- Validate managed directories, files, parents, and SQLite sidecars from the appropriate trusted root.
- Skip unsafe paths with explicit warnings for read-only work.
- Fail closed for delete, trash, restore, purge, cleanup, rollback, and recovery when a managed path is a symlink, junction, reparse point, hard link, root escape, or unsupported special file.
- Reconstruct mutation targets from controlled relative paths and revalidate type and identity immediately before committing.
- Reject stale plans when relevant files, directories, active-session state, or identities change after scanning.

The Node implementation narrows filesystem races through rejection, repeated identity checks, safe-parent temporary files, and atomic replacement. It does not claim absolute protection against a malicious same-user process continuously racing filesystem entries.

## Confirmation and authorization

- Read-only list, show, and search may use a unique short ID prefix.
- Confirmed destructive session operations require a canonical full UUID.
- Trash restore and purge require an exact internal trash ID.
- Active-session deletion is refused unless the caller supplies the explicit active override in addition to a full ID and confirmation.
- MCP read-only mode does not register destructive tools.
- MCP admin mode still requires explicit confirmation and uses the same underlying safety rules as CLI.
- `--yes`, MCP confirmation, client tool filters, approval policy, and profile selection cannot bypass path or recovery failures.

## Recoverable mutations

Each mutation:

1. Acquires an exclusive mutation lock.
2. Freezes the exact target list.
3. Writes a durable operation journal.
4. Precomputes replacements before committing them.
5. Uses safe-parent temporary files, flush/fsync, and atomic replacement.
6. Uses row-scoped SQLite transactions and old row values instead of reading whole databases into memory.
7. Verifies the declared post-commit scope.
8. Records whether the operation committed, rolled back, or requires recovery.

Large execution-log databases remain read-only and are not copied into rollback data. Invalid trash manifests remain visible as invalid and cannot be restored or purged.

## Result semantics

Structured mutation results retain compatible success fields and add:

- `operationStatus`
- `verificationStatus`
- `verificationScope`
- `warnings`
- stable error codes for unsafe paths, stale plans, malformed IDs, active sessions, required recovery, and post-commit verification failures

A committed operation followed by partial or failed verification remains reported as committed. CLI exit status distinguishes pre-mutation refusal, committed-but-partially-verified work, and recovery-required state.

## Package and release safety

- Cross-platform Node build scripts replace shell-specific cleanup and permission commands.
- The package requires Node 20 or newer.
- npm uses an explicit `files` allowlist.
- CI checks type safety, tests, coverage, build, smoke, package contents, private-material leaks, and production dependency advisories.
- Linux tests Node 20/22/24; macOS and Windows test Node 24.
- Windows destructive operations remain disabled until real Windows mutation safety is verified.
- npm publishing uses GitHub OIDC Trusted Publishing.
- A short-lived single-package token is used only for the separately verified `latest` dist-tag promotion, then revoked.
- Candidate, verifier, and promotion workflows share one package-level queue and bind evidence to immutable tag, commit, run, hash, and previous `latest` state.

## Public disclosure

The security advisory is public at [GHSA-m675-9q85-c8w2](https://github.com/1939869736luosi/codex-sessions-manager/security/advisories/GHSA-m675-9q85-c8w2).

The first candidate, v0.6.1, was not promoted after registry verification did not finish. v0.6.2 reissued the fix through the full release process. No published version or tag was overwritten.

## Acceptance result

- External sentinel files remained unchanged across real temporary-filesystem regression tests.
- Symlink, hard-link, stale-plan, malformed-ID, active-session, crash, recovery, WAL, manifest, and permission combinations were covered.
- Production audit had no high or critical advisory at release time.
- Public package artifacts contained no session exports, private reports, local paths, real session IDs, or raw conversations.
- Final verdict: **GO for the verified security release**.
