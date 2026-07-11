# Release checklist

This checklist is intentionally stricter than a normal package publish. A release is allowed only from one reviewed commit and one immutable tag.

## Before creating a tag

- Confirm the working tree contains no session exports, local security reports, advisory drafts, encrypted archives, real session IDs, real home paths, or raw Codex data.
- Confirm package version, `src/version.ts`, changelog heading, and intended `v<version>` tag match.
- Run `npm ci`, `npm run typecheck`, `npm test`, `npm run test:coverage`, `npm run build`, `npm run pack:check`, and `npm audit --omit=dev --audit-level=high`.
- Create the tarball from the reviewed commit, record its file manifest and SHA-256, install that local tarball in an empty directory, and smoke both `--version` entrypoints.
- Complete the release-level first-principles, dependency-order, critical, adversarial, and independent review. Any unresolved High/P1 finding is a stop condition.
- For a security release, finish the private advisory text and affected-version evidence before making the tag public.

## npm publishing configuration

- Configure npm Trusted Publishing for this GitHub repository and the exact `release.yml` workflow. It requires GitHub OIDC and npm CLI 11.5.1 or newer; the workflow pins npm 11.16.0.
- Configure the protected GitHub environment `npm-production` with required reviewer approval.
- Store a narrowly scoped npm token for dist-tag changes as the `NPM_DIST_TAG_TOKEN` secret in that environment. The publish job itself uses OIDC and does not use this token.

## Release window

The candidate and promotion workflows share one package-level concurrency queue. Do not bypass or replace that queue with per-version groups: overlapping versions must never race while changing `security-verify` or `latest`.

1. Merge the reviewed commit to public `main` only after private review passes.
2. Wait for all required Linux, macOS, Windows, coverage, package, and production-audit checks on that exact commit.
3. Create the immutable `v<version>` tag. Do not move or replace an existing tag.
4. The tag workflow publishes the exact reviewed tarball with the non-default `security-verify` npm tag, installs the exact registry version, smokes CLI and MCP, downloads the registry tarball, and requires its SHA-256 to match.
5. Review the candidate workflow artifact. It may contain only the public tarball, package manifest, and SHA-256 file.
6. Run `Verify existing npm registry candidate` with the exact version, immutable tag, tag commit, candidate run ID, reviewed SHA-256, and current `latest` value. It is a read-only workflow that rebuilds the tag, downloads the registry tarball with fresh caches, verifies identity/provenance, installs those exact bytes, and uploads public evidence.
7. Run `Promote verified npm release` with the exact version, candidate SHA-256, tag, commit, candidate run ID, and successful verification run ID. Promotion must consume and validate the verification artifact, repeat its own exact-byte check, confirm that `security-verify` points to the same version, and only then move `latest`.
8. Confirm both `latest` and `security-verify` point to the exact version.
9. Publish the prepared GitHub Release and, for a security release, the Security Advisory.
10. Confirm Git tag, GitHub Release, npm package, npm dist-tags, advisory patched version, and reviewed commit all identify the same release.

If publishing and exact-version registry smoke succeeded but the hash-comparison step stopped before downloading bytes because of `ETARGET` or equivalent registry propagation lag, keep `latest` unchanged and do not rerun the publish job. A separate read-only registry verification workflow may recover the release only when it rebuilds the immutable tag, proves source and registry hashes are identical, verifies the full manifest and package identity, confirms provenance, installs and smokes the exact registry bytes, and uploads public evidence. Any actual hash, identity, manifest, provenance, or smoke mismatch still requires a new patch version.

## Stop conditions

- Before the tag: stop for any failed test, stale or incomplete platform result, package leak, unexplained dependency audit, mismatched version, manifest, or hash.
- If the source tag is public but npm publish fails: do not move the tag and do not publish the GitHub Release or advisory. Repair only the release process and retry from the same tag.
- If the candidate reaches npm but registry smoke or hash comparison fails: do not promote `latest`. Mark the version as not recommended and prepare a new patch version; never overwrite the published version.
- Never upload local Codex data, private advisory evidence, or encrypted backups as a GitHub Actions artifact.
