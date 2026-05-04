# Codex Sessions Manager

本地 Codex 会话管理工具集，包含 CLI、MCP 服务器和 AI Agent Skill，全部集成在一个仓库中。

## 包含内容

| 组件 | 说明 |
|------|------|
| **CLI** | 列出、查看、导出、删除和验证本地 Codex 会话 |
| **MCP 服务器** | 供 AI Agent 集成的 stdio MCP 服务器 |
| **Skill** | 供 Codex / Claude Code 使用的自然语言会话管理 Skill |

## 快速开始

```bash
# 1. 克隆完整仓库
git clone https://github.com/1939869736luosi/codex-sessions-manager.git
cd codex-sessions-manager

# 2. 安装依赖
npm install

# 3. 构建
npm run build

# 4. 使用 CLI
node dist/cli/index.js list --root ~/.codex --limit 20
node dist/cli/index.js show <session-id> --root ~/.codex
node dist/cli/index.js export <session-id> --root ~/.codex --output ./backup.json
```

## 安装为 Skill

### 通过 skills.sh

```bash
npx skills add 1939869736luosi/codex-sessions-manager -g
```

### 手动安装

**Codex:**
```bash
cp -r . ~/.codex/skills/codex-sessions-manager
```

**Claude Code:**
```bash
cp -r . ~/.claude/skills/codex-sessions-manager
```

## 项目结构

```
.
├── LICENSE              # Apache-2.0
├── README.md            # 英文说明
├── README.zh-CN.md      # 本文档
├── package.json         # Node 依赖
├── tsconfig.json        # TypeScript 配置
├── src/
│   ├── cli/             # CLI 入口
│   ├── core/            # 会话扫描、查询、删除、备份逻辑
│   └── mcp/             # MCP 服务器实现
├── tests/               # 测试套件
├── SKILL.md             # AI Agent Skill 定义
└── agents/
    └── openai.yaml      # Codex Agent 接口配置
```

## CLI 命令

| 命令 | 说明 |
|------|------|
| `list` | 列出会话，支持筛选 |
| `show` | 查看会话详情 |
| `export` | 导出会话为 JSON |
| `delete` | 删除会话（不加 `--yes` 只预览） |
| `cleanup-index` | 清理失效的 JSONL 索引条目 |
| `cleanup-stale` | 清理失效的 SQLite 记录 |
| `verify` | 验证会话完整性 |

所有命令都支持 `--root ~/.codex` 覆盖默认目录。

## MCP 服务器

启动 MCP 服务器：

```bash
node dist/mcp/server.js
```

暴露的工具：`list_sessions`、`get_session`、`export_session_backup`、`preview_delete_sessions`、`delete_sessions`、`cleanup_session_indexes`、`cleanup_stale_indexes`、`verify_sessions`。

## 开发

```bash
npm install
npm run build
npm test
```

## 许可证

Apache License 2.0
