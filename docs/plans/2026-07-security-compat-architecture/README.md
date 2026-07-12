# Security, compatibility, and architecture program

Status: **completed through v0.7.0**
Program window: 2026-07-10 to 2026-07-12
Latest release covered by this program: **v0.7.0**

This directory is the maintained repository copy of the security, compatibility, and architecture plan that guided the v0.6.1–v0.7.0 work. It replaces a single oversized chat plan with smaller documents that can be reviewed and updated independently.

The documents record both the original intent and what actually happened. They are not an instruction to rerun completed releases, move existing tags, republish old versions, or copy private session material into the repository.

## Program goals

The work began from six related requests:

1. Review and preserve recent local development before changing it.
2. Reconcile unfinished plans with the code that already existed, including reconsidering memory support.
3. Make the product CLI-first while retaining MCP where bounded structured access and host authorization are useful.
4. Correct incomplete session preview behavior without putting whole large sessions into one MCP response.
5. Re-run official Codex compatibility checks and replace the one-off prompt with a sustainable compatibility process.
6. Reduce unnecessary agent scaffolding and prevent Superpowers, Matt Pocock-style planning, native planning, and aggressive multi-agent modes from stacking by default.

The audit expanded those goals to include path containment, crash recovery, truthful partial-success reporting, package leak prevention, dependency security, CI, Trusted Publishing, release identity, doctor output bounds, and project governance.

## Documents

| Document | Purpose | Current status |
|---|---|---|
| [01 — Security and release safety](01-security-and-release.md) | Trusted roots, destructive operations, recovery, package safety, and the private security release | Completed in the v0.6.1/v0.6.2 security line |
| [02 — Compatibility and previews](02-compatibility-and-preview.md) | Codex 0.144.1 storage compatibility, bounded MCP previews, exact CLI output, adapters, and compatibility watch | Completed in v0.6.3 |
| [03 — Architecture and memory](03-architecture-and-memory.md) | Shared operations, CLI/MCP responsibilities, read-only memory links, doctor bounds, and Skill governance | Completed in v0.7.0 |
| [04 — Future projects](04-future-projects.md) | Work deliberately not included in v0.7.0 | Not implemented; separately gated |
| [05 — Verification and evidence](05-verification-and-evidence.md) | Release identities, public evidence, five-part review, deviations, and final verdict | Completed |

## Actual release sequence

The original plan expected three public versions: v0.6.1, v0.6.2, and v0.7.0. Registry verification exposed a release-process failure, so the final public sequence became:

| Version | Actual role |
|---|---|
| v0.6.1 | First security candidate; reached only the non-default npm verification tag and was not promoted to `latest` |
| v0.6.2 | Fully verified security release |
| v0.6.3 | Codex 0.144.1 compatibility, preview boundaries, packaging, and compatibility-watch release |
| v0.7.0 | Shared application operations, bounded MCP responses, read-only memory association, doctor/Skill context controls, and governance |

Published versions were never overwritten and existing tags were never moved.

## Completion boundary

“Completed through v0.7.0” means the security, compatibility, architecture, read-only memory, bounded-output, release, and governance commitments described in documents 01–03 passed their release gates.

It does **not** mean every future idea from the original discussion has been implemented. Memory mutation, logs analysis, Amp exploration, a real multi-host harness, stronger descriptor-relative TOCTOU protection, and MCP resource handoff remain separate projects in document 04 and in the repository [Roadmap](../../../ROADMAP.md).

## Private-material boundary

This program used private local session exports, local paths, dynamic exploit fixtures, advisory drafts, and internal review material. Those inputs are evidence sources, not project documentation. They remain outside the public repository, GitHub Actions artifacts, GitHub Releases, and npm packages.

Only sanitized conclusions, synthetic fixtures, public advisory text, and reproducible release evidence belong here.
