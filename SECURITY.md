# Security Policy

`codex-sessions-manager` works on local Codex session artifacts. Those files can
contain prompt history, project paths, shell logs, thread metadata, SQLite rows,
and desktop state references. Treat reports about incomplete deletion, unsafe
restore, data loss, or unexpected local history exposure as security-sensitive.

## Supported versions

The latest published npm version and the current `main` branch are supported for
security reports. Older versions may be affected by already fixed safety or
cleanup behavior.

## What to report

Please report issues that could cause:

- Local prompt, history, path, or project metadata to be exposed unexpectedly.
- A delete, cleanup, trash, restore, or purge command to affect the wrong
  session ID.
- Incomplete deletion where verification incorrectly reports success.
- Restore conflicts that can overwrite live session data.
- Rollback failures after a partial delete or cleanup operation.
- Path traversal, symlink, or root-selection behavior that can touch files
  outside the intended Codex root.
- SQLite, JSONL, or global-state inconsistency that can leave hidden residues.
- MCP tool behavior that bypasses preview or explicit confirmation boundaries.

## Reporting

Open a private security advisory on GitHub:

https://github.com/1939869736luosi/codex-sessions-manager/security/advisories/new

If GitHub advisories are unavailable, open a minimal public issue that says a
security report is available, but do not include private prompt content,
session IDs, local paths, or proof-of-concept details in the public issue.

## Handling sensitive artifacts

Do not upload raw `~/.codex` files, SQLite databases, shell snapshots, prompt
history, or trash bundles to public issues. When possible, share redacted command
output, the exact command used, the tool version, and a small synthetic fixture
that reproduces the issue.

## Safety boundaries

The intended safety model is:

- Read-only commands must not modify local Codex state.
- Destructive CLI commands require `--yes`.
- Destructive MCP tools require explicit confirmation.
- Confirmed destructive session operations require canonical full UUIDs, and
  active-session deletion requires an additional explicit override.
- MCP's read-only profile does not register destructive tools.
- Current Windows releases are read-only for destructive operations: core and CLI mutations fail closed, and MCP does not register destructive tools even when `--profile admin` is requested. Mutation support will remain disabled until the real Windows reparse-point and crash matrix is verified.
- Delete plans and previews are not authorization tokens.
- Confirmed mutation fixes a canonical trusted root, rejects unsafe managed
  links and path escapes, and repeats path and identity checks before writing.
- Unknown global-state references remain warnings unless an exact-key safety
  rule makes them eligible.
- Restore must check conflicts before writing live data.
- Mutations use an exclusive lock, a durable journal, atomic file replacement,
  and operation-specific recovery data. If the final state cannot be proven,
  further mutation is blocked until recovery completes.

The path checks substantially narrow filesystem races but do not promise
absolute protection against another malicious process running as the same user
and continuously replacing entries between checks. The project currently uses
fail-closed managed-path checks rather than native descriptor-relative
`openat`/`unlinkat` operations.

Reports that break any of these boundaries are in scope.
