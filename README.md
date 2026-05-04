# Codex Sessions Manager

Local Codex session management toolkit with CLI, MCP server, and AI agent skill — all in one repo.

[简体中文](./README.zh-CN.md)

## What's Included

| Component | Description |
|-----------|-------------|
| **CLI** | List, show, export, delete, and verify local Codex sessions |
| **MCP Server** | stdio MCP server for AI agent integration |
| **Skill** | Codex / Claude Code skill for natural language session management |

## Quick Start

```bash
# 1. Clone everything
git clone https://github.com/1939869736luosi/codex-sessions-manager.git
cd codex-sessions-manager

# 2. Install dependencies
npm install

# 3. Build
npm run build

# 4. Use CLI
node dist/cli/index.js list --root ~/.codex --limit 20
node dist/cli/index.js show <session-id> --root ~/.codex
node dist/cli/index.js export <session-id> --root ~/.codex --output ./backup.json
```

## Install as Skill

### Via [skills.sh](https://skills.sh)

```bash
npx skills add 1939869736luosi/codex-sessions-manager -g
```

### Manual Install

**For Codex:**
```bash
cp -r . ~/.codex/skills/codex-sessions-manager
```

**For Claude Code:**
```bash
cp -r . ~/.claude/skills/codex-sessions-manager
```

## Project Structure

```
.
├── LICENSE              # Apache-2.0
├── README.md            # This file
├── README.zh-CN.md      # 简体中文
├── package.json         # Node dependencies
├── tsconfig.json        # TypeScript config
├── src/
│   ├── cli/             # CLI entry points
│   ├── core/            # Session scanning, query, delete, backup logic
│   └── mcp/             # MCP server implementation
├── tests/               # Test suite
├── SKILL.md             # Skill definition for AI agents
└── agents/
    └── openai.yaml      # Codex agent interface config
```

## CLI Commands

| Command | Description |
|---------|-------------|
| `list` | List sessions with optional filters |
| `show` | Show session details |
| `export` | Export session to JSON |
| `delete` | Delete sessions (preview without `--yes`) |
| `cleanup-index` | Remove stale JSONL index entries |
| `cleanup-stale` | Remove stale SQLite records |
| `verify` | Verify session integrity |

All commands accept `--root ~/.codex` to override the default Codex directory.

## MCP Server

Start the MCP server:

```bash
node dist/mcp/server.js
```

Exposed tools: `list_sessions`, `get_session`, `export_session_backup`, `preview_delete_sessions`, `delete_sessions`, `cleanup_session_indexes`, `cleanup_stale_indexes`, `verify_sessions`.

## Development

```bash
npm install
npm run build
npm test
```

## License

Apache License 2.0
