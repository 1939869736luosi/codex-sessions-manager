# Codex Sessions Manager

A [Codex](https://github.com/openai/codex) / [Claude Code](https://claude.ai/code) skill for managing local Codex sessions stored in ~/.codex.

## What it does

- **Inspect** — List and view details of local Codex conversation history
- **Export** — Backup sessions to JSON
- **Verify** — Check if sessions still have raw files, JSONL entries, or SQLite records
- **Clean up** — Remove stale indexes or safely delete sessions with preview

## Install

### Via skills.sh

```bash
npx skills add 1939869736luosi/codex-sessions-manager -g
```

### Manual install

**For Codex:**
```bash
cp -r . ~/.codex/skills/codex-sessions-manager
```

**For Claude Code:**
```bash
cp -r . ~/.claude/skills/codex-sessions-manager
```

## Important Note

The SKILL.md references a local CLI path. You need to update this path to match your own local codex-sessions installation before using.

Edit SKILL.md and replace the path with wherever you have the CLI built.

## Files

```
.
├── LICENSE            # MIT License
├── README.md          # This file
├── SKILL.md           # Skill instructions
└── agents/
    └── openai.yaml    # Codex agent interface definition
```

## License

MIT
