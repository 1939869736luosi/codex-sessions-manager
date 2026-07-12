# 05 — Verification and evidence

Status: **completed**

## Public release identities

| Release | Reviewed/tag commit | Public evidence |
|---|---|---|
| v0.6.2 | `f3d8c1d4744431af961f989e5bd1858b64df4c74` | [GitHub Release](https://github.com/1939869736luosi/codex-sessions-manager/releases/tag/v0.6.2), [Security Advisory](https://github.com/1939869736luosi/codex-sessions-manager/security/advisories/GHSA-m675-9q85-c8w2) |
| v0.6.3 | `d4f553dc0be35e0faee20d896b1b667b13c87a42` | [GitHub Release](https://github.com/1939869736luosi/codex-sessions-manager/releases/tag/v0.6.3) |
| v0.7.0 | `e57c1934c20d62da8d6ece0a602d569de4565082` | [GitHub Release](https://github.com/1939869736luosi/codex-sessions-manager/releases/tag/v0.7.0), [merged PR #3](https://github.com/1939869736luosi/codex-sessions-manager/pull/3) |
| v0.7.1 | `844f6f9a117aad6a7972dbf6a2adeb25ff09d42c` | [GitHub Release](https://github.com/1939869736luosi/codex-sessions-manager/releases/tag/v0.7.1), npm `latest` and `security-verify` both `0.7.1` |

The v0.7.0 reviewed and registry tarball SHA-256 is:

```text
4bb0a7b347be9042d9f3b7a28bc169e30e95b8a7df1e99dec4fa966ed9f86895
```

It contains 125 package files. The local reviewed tarball, candidate artifact, independently downloaded registry tarball, and promotion verification all matched.

## v0.7.0 workflow evidence

| Check | Run | Result |
|---|---|---|
| Main branch CI after merge | [29174883368](https://github.com/1939869736luosi/codex-sessions-manager/actions/runs/29174883368) | Success |
| Immutable-tag candidate publish | [29175001731](https://github.com/1939869736luosi/codex-sessions-manager/actions/runs/29175001731) | Success |
| Independent registry verification | [29175091454](https://github.com/1939869736luosi/codex-sessions-manager/actions/runs/29175091454) | Success |
| Verified `latest` promotion | [29175623567](https://github.com/1939869736luosi/codex-sessions-manager/actions/runs/29175623567) | Success |

The release matrix covered Linux Node 20/22/24, macOS Node 24, Windows Node 24 read-only safety, type checking, tests, coverage, build, CLI/MCP smoke, package contents, and production dependency audit.

## Release deviations and incident handling

### v0.6.1 candidate

The first security candidate reached the non-default npm tag but immediate registry verification did not complete. It was not promoted to `latest`. The immutable version was not overwritten; v0.6.2 was published as the fully verified security release.

### v0.6.3 registry lag

The v0.6.3 candidate publish succeeded, but the original workflow stopped after the registry temporarily returned an exact-version `ETARGET`. A separate read-only verifier was added and restricted to the documented incident evidence. It rebuilt the immutable tag, downloaded the registry bytes with fresh caches, verified hash, manifest, metadata, provenance, installation, and smoke, then produced run-bound public evidence. Promotion consumed that evidence and did not rerun publish.

### v0.7.0 promotion token

The first short-lived token lacked effective 2FA bypass and npm rejected the dist-tag change before `latest` moved. A replacement token was verified on its npm detail page as single-package read/write, no organization access, seven-day expiry, and 2FA bypass. Promotion then succeeded. Both tokens and the GitHub environment secret were removed after use.

### v0.7.1 corrective release and interactive promotion

The fixed v0.7.1 commit passed main CI in [run 29181350443](https://github.com/1939869736luosi/codex-sessions-manager/actions/runs/29181350443). The immutable-tag candidate publish passed in [run 29181350450](https://github.com/1939869736luosi/codex-sessions-manager/actions/runs/29181350450), and independent registry verification passed in [run 29181462995](https://github.com/1939869736luosi/codex-sessions-manager/actions/runs/29181462995).

The cloud promotion attempt [run 29181489159](https://github.com/1939869736luosi/codex-sessions-manager/actions/runs/29181489159) stopped when npm required interactive verification. It did not establish that the candidate was defective. The maintainer repeated the live checks on a trusted local machine, ran the dist-tag change, completed npm's browser/Touch ID confirmation, and verified from the registry that both `latest` and `security-verify` identify v0.7.1. The temporary single-package token was revoked, the GitHub secret was deleted, temporary npm configuration was removed, and the clipboard was cleared.

The repository no longer contains a cloud dist-tag promotion workflow. Candidate publication and independent verification remain automated; changing `latest` is now an explicit local maintainer action followed by registry verification and immediate credential cleanup.

## Five-part release review

### 1. First principles

Reviewed product promises, trusted roots, separate SQLite ownership, attacker capability, confirmation boundaries, retained surfaces, and which data the tool may read or modify.

### 2. Dependency order

Verified the sequence baseline → failing fixture → fix → crash recovery → compatibility → artifact identity → candidate → independent registry verification → promotion → public release.

### 3. Critical review

Reviewed normal failure, partial success, truthful messages, API compatibility, cross-platform differences, performance, memory use, context size, privacy, dependency risk, and rollback limits.

### 4. Adversarial review

Attacked traversal, managed links, stale identity, prefix collisions, malformed IDs, active sessions, partial writes, abrupt termination, permission combinations, manifest destinations, MCP output size, and package leakage.

### 5. Independent verdict

The release-time review recorded no unresolved P0/P1/P2 finding for v0.7.0. A later post-release review found one truthfulness defect in stale-lock recovery: a committed journal with `partial` or `failed` verification could be finalized as `passed`. That later finding supersedes the earlier completion claim for current-code approval. The public commit, hashes, PR, and workflow runs remain valid evidence for the immutable v0.7.0 artifact, but they do not erase a subsequently discovered defect.

## Post-release correction

The corrective v0.7.1 release completed these requirements:

- preserve trusted `passed`, `partial`, and `failed` journal verification states;
- use `not_run` when no trusted verification result exists;
- keep the prior journal details while finalizing a stale lock;
- report only the scope actually checked during stale-lock finalization;
- preserve partial restore verification in the journal;
- correct the official-overlap, export, rollback, doctor, Windows release, and roadmap documentation.

The fixed commit passed the release gates and was published as v0.7.1. The earlier NO-GO applied before that corrective release and is retained here only as historical context.

## Final verdict

- Security release line: **GO**.
- Codex 0.144.1 compatibility release: **GO**.
- Historical v0.7.0 release identity and artifact evidence: **valid, but superseded for current approval by the post-release recovery finding**.
- v0.7.1 corrective release: **GO**, published from the reviewed commit and verified in the registry.
- Future projects in document 04: **not reviewed for implementation and not implicitly approved**.

Private session exports, local paths, exploit transcripts, internal reports, encrypted backups, and credential material are deliberately excluded from this evidence document.
