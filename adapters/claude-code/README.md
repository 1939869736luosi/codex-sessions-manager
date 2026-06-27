# Claude Code Adapter

Use codex-sessions-manager as a Claude Code Skill with optional MCP.

## Setup (Skill)

1. Install the CLI globally:

```bash
npm install -g codex-sessions-manager
```

2. Copy the skill directory:

```bash
mkdir -p ~/.claude/skills/codex-sessions-manager
cp -r skills/codex-sessions-manager/* ~/.claude/skills/codex-sessions-manager/
```

Claude Code will pick up the SKILL.md and teach the agent to use the CLI.

## Optional: MCP Configuration

Add to your project or user `.claude/mcp.json`:

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

For admin access (destructive tools), change to `["--profile", "admin"]`.

## Plugin Support

v0.6.0 does not provide a full Claude Code Plugin package. Plugin support requires a `.claude-plugin/plugin.json` manifest which is heavyweight for this use case. The Skill + optional MCP config approach provides equivalent functionality with less setup overhead.

## Notes

- The CLI is the primary interface; MCP is optional.
- Claude Code Skills do not natively support bundled MCP. Use the separate `.claude/mcp.json` config.
- The same SKILL.md works for both Claude Code and Amp (with different installation paths).
