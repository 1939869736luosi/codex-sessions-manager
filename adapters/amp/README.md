# Amp Adapter

Use codex-sessions-manager as an Amp Skill with deferred MCP loading.

## Setup

1. Install the CLI globally:

```bash
npm install -g codex-sessions-manager
```

2. Copy the skill directory into your Amp workspace:

```bash
mkdir -p .agents/skills/codex-sessions-manager
cp -r skills/codex-sessions-manager/* .agents/skills/codex-sessions-manager/
cp adapters/amp/mcp.json .agents/skills/codex-sessions-manager/mcp.json
```

3. The SKILL.md teaches Amp when and how to use the CLI. The `mcp.json` enables deferred MCP tool loading with the read-only profile (16 tools).

## Admin Access

To enable destructive tools (delete, restore, purge, cleanup), edit the copied `mcp.json`:

```json
{
  "codex-sessions": {
    "command": "codex-sessions-mcp",
    "args": ["--profile", "admin"]
  }
}
```

## Notes

- The CLI is always available as a fallback regardless of MCP configuration.
- MCP tools are loaded on demand by Amp, reducing context overhead.
- This adapter does not make CSM an Amp-specific tool. The same CLI works in any agent.
