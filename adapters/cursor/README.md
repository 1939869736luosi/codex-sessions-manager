# Cursor Adapter

Use codex-sessions-manager with Cursor via MCP.

## Setup

1. Install the CLI globally:

```bash
npm install -g codex-sessions-manager
```

2. Add to your `.cursor/mcp.json` (project-level) or Cursor global MCP settings:

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

See `mcp.json.example` in this directory for a ready-to-copy version.

## Admin Access

For destructive tools, change the args to `["--profile", "admin"]`.

## Notes

- Cursor supports MCP servers natively via `.cursor/mcp.json`.
- The read-only profile exposes 15 tools for safe session inspection.
- The CLI remains available as a fallback via Cursor's terminal.
