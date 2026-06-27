# Factory Droid Adapter

Use codex-sessions-manager with Factory Droid.

## Setup

1. Install the CLI globally:

```bash
npm install -g codex-sessions-manager
```

2. Add the MCP server:

```bash
droid mcp add codex-sessions codex-sessions-mcp -- --profile read-only
```

For admin access:

```bash
droid mcp add codex-sessions codex-sessions-mcp -- --profile admin
```

## AGENTS.md Integration

Add to your project's `AGENTS.md`:

```markdown
## Session Management

Use `codex-sessions` CLI for local Codex session audit and cleanup.
See `codex-sessions --help` for available commands.
Always preview before destructive operations.
```

## Skills Integration

Copy the skill directory to make it available as a Factory Droid skill:

```bash
cp -r skills/codex-sessions-manager/ .factory/skills/codex-sessions-manager/
```

## Notes

- Factory Droid supports MCP via `droid mcp add`, making setup a one-liner.
- The Deferred Context Engine means MCP tools are only loaded when needed.
- The CLI is always available as a direct shell fallback.
