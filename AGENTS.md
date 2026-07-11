# Agent guidance

## Default execution model

- Use one agent for ordinary changes.
- Three concurrent agents is a hard ceiling, not a target. Use more than one only for independent work that can be reviewed separately.
- Use one primary planning or review framework per phase. Do not stack native Plan, Superpowers, Matt Pocock workflows, and Ultra-style orchestration.
- Small fixes should use direct model reasoning and focused tests. Use a diagnosing workflow only for a difficult reproduction.
- Run one independent release review on the fixed release commit and tarball. Do not repeat heavyweight review scaffolding for every small commit.

## Repository boundaries

- Prefer CLI for scripts, pipes, complete JSON, canonical event streams, and byte-exact exports.
- Keep MCP for bounded structured reads, resources/instructions, host permissions, and explicitly confirmed admin actions.
- CLI and MCP must call the same application operation. MCP must never shell out to the CLI, and no generic `run_command` tool may be added.
- Read-only operations must skip unsafe paths with an explicit warning. Mutations must fail closed.
- Never add local sessions, real home paths, security advisory drafts, encrypted backups, tokens, or raw memory text to Git, Actions artifacts, fixtures, docs, or npm packages.

## Required verification

- Add a failing test before changing behavior.
- For migrated operations, compare normalized CLI JSON and MCP structured results.
- Run typecheck, relevant tests, the full suite, compatibility checks, build, package-manifest checks, and production dependency audit in proportion to the change.
- A release requires first-principles, dependency-order, critical, adversarial, and independent GO/NO-GO review.
