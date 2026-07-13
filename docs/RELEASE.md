# Release checklist

This checklist is intentionally stricter than a normal package publish. A release is allowed only from one reviewed commit and one immutable tag.

## Before creating a tag

- Confirm the working tree contains no session exports, local security reports, advisory drafts, encrypted archives, real session IDs, real home paths, or raw Codex data.
- Confirm package version, `src/version.ts`, the dated `## <version> (YYYY-MM-DD)` changelog heading, and intended `v<version>` tag match. The tag workflow rejects `Unreleased`, missing, duplicate, and invalid-date headings before publishing.
- Run `npm ci`, `npm run typecheck`, the supported-platform test suites, `npm run test:coverage`, `npm run build`, `npm run pack:check`, and `npm audit --omit=dev --audit-level=high`. Linux and macOS run the complete `npm test` suite. Windows runs the documented read-only/fail-closed release subset until destructive Windows support is enabled.
- Review both `compat/upstream-baseline.json` and `compat/upstream-capabilities.json`. The release is blocked if storage compatibility or official capability replacement was not checked within the release window.
- Create the tarball from the reviewed commit, record its file manifest and SHA-256, install that local tarball in an empty directory, and smoke both `--version` entrypoints.
- Complete the release-level first-principles, dependency-order, critical, adversarial, and independent review. Any unresolved High/P1 finding is a stop condition.
- For a security release, finish the private advisory text and affected-version evidence before making the tag public.

## npm publishing configuration

- Configure npm Trusted Publishing for this GitHub repository and the exact `release.yml` workflow. It requires GitHub OIDC and npm CLI 11.5.1 or newer; the workflow pins npm 11.16.0.
- Candidate publishing uses GitHub OIDC. Do not store an npm dist-tag token in GitHub Actions: npm may require a browser or Touch ID interaction even when a granular token is allowed to bypass 2FA, so a cloud runner cannot reliably complete `latest` promotion.
- Perform the final dist-tag change from a trusted maintainer machine. If npm requires a token, create the shortest-lived single-package read/write token possible, keep it out of the repository and shell history, and revoke it immediately after verification.
- Every local promotion read and write must use `https://registry.npmjs.org/`. The promotion script pins that address, removes registry/userconfig environment overrides, runs outside the repository so project `.npmrc` files are not loaded, and copies one explicitly supplied promotion-only user config into its private temporary directory.
- The promotion script also supplies an empty private global config, removes all inherited `npm_config_*` values and common npm token environment variables, and cleans its private credential copy on normal exit, `SIGINT`, `SIGTERM`, and `SIGHUP`. `SIGKILL`, power loss, and an operating-system crash cannot run application cleanup; before a later attempt, inspect and securely remove only stale `csm-npm-promotion-*` directories owned by the maintainer account.
- Prepare that promotion-only config immediately before the release window: `PROMOTION_USERCONFIG="$(mktemp)"`, then `npm login --auth-type=web --registry=https://registry.npmjs.org/ --userconfig "$PROMOTION_USERCONFIG"`. Do not pass a normal long-lived user config or a project `.npmrc`.

## Release window

The candidate and registry-verification workflows share one package-level concurrency queue. Do not bypass or replace that queue with per-version groups. npm does not provide an atomic compare-and-swap for dist-tags, so the maintainer must repeat the live `latest` and `security-verify` checks immediately before the local promotion.

1. Merge the reviewed commit to public `main` only after private review passes.
2. Wait for all required Linux, macOS, Windows, coverage, package, and production-audit checks on that exact commit.
3. Create the immutable `v<version>` tag. Do not move or replace an existing tag.
4. The tag workflow publishes the exact reviewed tarball with the non-default `security-verify` npm tag, installs the exact registry version, smokes CLI and MCP, downloads the registry tarball, and requires its SHA-256 to match.
5. Review the candidate workflow artifact. It may contain only the public tarball, package manifest, and SHA-256 file.
6. Run `Verify existing npm registry candidate` with the exact version, immutable tag, tag commit, candidate run ID, reviewed SHA-256, and current `latest` value. It is a read-only workflow that rebuilds the tag, downloads the registry tarball with fresh caches, verifies identity and provenance metadata, installs those exact bytes, and uploads public evidence.
7. On a trusted maintainer machine, confirm that the independent verification run succeeded, the immutable tag still identifies the reviewed commit, `security-verify` identifies the candidate, and `latest` still has the value recorded by verification. Stop if any value changed.
8. Run `node scripts/promote-npm.mjs --version <version> --expected-latest <previous-version> --expected-sha256 <sha256> --tag v<version> --expected-commit <commit> --expected-verification-commit <main-commit> --candidate-run-id <run> --verification-run-id <run> --npm-userconfig "$PROMOTION_USERCONFIG"`. The script first requires `npm config get registry` and `npm whoami` to succeed against the public npm registry, then downloads the independent verification artifact, requires the verifier to be the registered workflow on `main` at the reviewed verifier commit, and checks the tag-push candidate run, immutable tag, release commit, provenance/smoke evidence, and a fresh registry tarball hash before running the equivalent of `npm dist-tag add codex-sessions-manager@<version> latest` with explicit official-registry and isolated-userconfig flags. Complete the npm browser or Touch ID confirmation when prompted. Do not run this command in GitHub Actions and do not retry blindly after an ambiguous response; the script verifies registry state even when npm exits unsuccessfully.
9. Use the same isolated config and a fresh online lookup to run `npm view codex-sessions-manager dist-tags --json --registry=https://registry.npmjs.org/ --userconfig "$PROMOTION_USERCONFIG"`, then confirm both `latest` and `security-verify` identify the exact version. If the command response was ambiguous, this public-registry result decides whether promotion happened.
10. Revoke any temporary npm token, delete temporary npm configuration, clear the clipboard, and confirm that no promotion secret remains in GitHub. Keep only public release evidence.
11. Publish the prepared GitHub Release and, for a security release, the Security Advisory.
12. Confirm Git tag, GitHub Release, npm package, npm dist-tags, advisory patched version, and reviewed commit all identify the same release.

If publishing and exact-version registry smoke succeeded but the hash-comparison step stopped before downloading bytes because the exact candidate version returned `ETARGET` and `No matching version found`, keep `latest` unchanged and do not rerun the publish job. A separate read-only registry verification workflow may recover the release only when the candidate job log proves that exact failure reason, then rebuilds the immutable tag, proves source and registry hashes are identical, verifies the full manifest and package identity, confirms provenance metadata, installs and smokes the exact registry bytes, and uploads public evidence. A missing log, an unknown compare failure, or any actual hash, identity, manifest, provenance-metadata, or smoke mismatch still requires a new patch version.

## Stop conditions

- Before the tag: stop for any failed test, stale or incomplete platform result, package leak, unexplained dependency audit, mismatched version, manifest, or hash.
- If the source tag is public but npm publish fails: do not move the tag and do not publish the GitHub Release or advisory. Repair only the release process and retry from the same tag.
- If the candidate reaches npm but registry smoke or hash comparison fails: do not promote `latest`. Mark the version as not recommended and prepare a new patch version; never overwrite the published version.
- Never upload local Codex data, private advisory evidence, or encrypted backups as a GitHub Actions artifact.
