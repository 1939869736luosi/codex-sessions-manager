# OpenAI Codex Adapter

Use codex-sessions-manager with OpenAI Codex CLI agent.

## Setup

1. Install the CLI globally:

```bash
npm install -g codex-sessions-manager
```

2. Add to your `AGENTS.md` or project instructions:

```markdown
## Session Management

When the user asks about local Codex sessions, use the `codex-sessions` CLI:

- `codex-sessions list --limit 10` to see recent sessions
- `codex-sessions audit <id>` to check what remains after deletion
- `codex-sessions family <id>` to inspect parent/child relationships
- `codex-sessions delete <id>` to preview deletion (add --yes to execute)
- `codex-sessions verify <id>` to confirm cleanup

Always preview before deleting. Never add --yes without explicit user confirmation.
```

## Optional: MCP Configuration

Add to your Codex MCP config:

```json
{
  "mcpServers": {
    "codex-sessions": {
      "command": "codex-sessions-mcp",
      "args": ["--profile", "read-only"]
    }
  }
}
```

## Notes

- Codex agents can run shell commands directly, making CLI the simplest integration path.
- MCP provides structured JSON responses if your workflow benefits from that.
- The AGENTS.md snippet above is a minimal starting point; adjust to your workflow.
