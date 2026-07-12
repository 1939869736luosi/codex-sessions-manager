# Contributing

Thank you for helping improve Codex Sessions Manager.

## Before opening a change

- Use a public issue for ordinary bugs and feature proposals.
- Do not publish exploit details, real session data, local paths, tokens, advisory drafts, or screenshots containing private transcripts. Follow `SECURITY.md` for vulnerabilities.
- Keep changes focused. Safety fixes, compatibility updates, and architecture work should be reviewable independently.

## Development

Requirements: Node.js 20 or newer and the locked npm dependencies.

```bash
npm ci
npm run typecheck
npm test
npm run compat:check
npm run build
npm run pack:check
npm run audit:prod
```

Behavior changes start with a failing test. Filesystem safety tests must use a real temporary filesystem rather than mocks alone. Never run destructive tests against a real `~/.codex`; use the synthetic fixtures.

When an operation is exposed through both CLI and MCP, both adapters must call the same application operation. Add a parity test for normalized JSON/structured results and separate tests for adapter-specific presentation or byte limits.

## Pull requests

- Explain the user-visible behavior, safety boundary, compatibility impact, and validation evidence.
- Preserve existing fields unless a documented breaking release intentionally changes them.
- Update English and Chinese README content together when public behavior changes.
- Keep root and packaged Skill copies byte-identical where the compatibility validator requires it.
- Confirm `npm pack` contains no local/private material.

Release preparation follows `docs/RELEASE.md`. A passing test suite is necessary but not sufficient for release.
