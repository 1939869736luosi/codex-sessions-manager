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

CLI is the preferred path for complete JSON, byte-exact exports, and shell pipelines. MCP is useful for bounded structured reads and explicitly approved management actions.

Register the read-only server with Codex:

```bash
codex mcp add codex-sessions -- codex-sessions-mcp --profile read-only
```

Or add the equivalent official TOML block to `~/.codex/config.toml`:

```toml
[mcp_servers.codex-sessions]
command = "codex-sessions-mcp"
args = ["--profile", "read-only"]
```

## Notes

- Codex agents can run shell commands directly, making CLI the simplest integration path.
- MCP `get_session` is intentionally bounded and reports completeness. Use `codex-sessions show <id> --json` or `export` when the whole local result is required.
- The AGENTS.md snippet above is a minimal starting point; adjust to your workflow.
