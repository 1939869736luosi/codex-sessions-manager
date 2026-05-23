# codex-sessions-manager

[![npm](https://img.shields.io/npm/v/codex-sessions-manager)](https://www.npmjs.com/package/codex-sessions-manager)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[English](./README.md)

> Codex Desktop 现在已经有归档聊天删除入口。实测中，它会删除主会话文件和部分 thread 记录，但仍可能留下索引、执行日志和桌面状态引用。

**codex-sessions-manager** 是本地 Codex 会话审计和清理工具。它同时是 **Skill**（Claude Code / Codex 可直接调用）、**CLI** 和 **MCP Server**——三种形态共享同一套核心逻辑。它用来检查 `~/.codex` 里还剩什么、审计官方 UI 删除/归档后留下的本地残留、按精确 session ID 处理隐藏记录，并验证删除后是否真的没有本机孤儿记录。

## 为什么选这个？

普通归档聊天优先用 Codex Desktop 官方删除入口。这个工具面向更难的本机场景：官方删完后验残留、清理孤儿记录、按精确 session ID 处理，以及让 AI Agent 安全管理本地历史。

| | codex-sessions-manager | 其他工具 |
|--|:---:|:---:|
| 清理全部 4 层（文件 + JSONL + SQLite + 全局状态） | ✅ | ❌ 只清部分 |
| 删除中途出错自动回滚 | ✅ | ❌ |
| 可恢复的回收站 + 冲突检测 | ✅ | ❌ 或简单备份 |
| 删完验证有没有残留 | ✅ | ❌ |
| AI Agent 可直接调用（MCP） | ✅ | ❌ |
| 识别 `/side` 和 `/fork` 父子关系 | ✅ | ❌ |

## 快速开始

```bash
# 全局安装
npm install -g codex-sessions-manager

# 列出最近的会话
codex-sessions list --limit 10

# 汇总会话来源（安全，不做任何修改）
codex-sessions sources

# 查看父子关系（安全，不做任何修改）
codex-sessions family <session-id>

# 审计官方 UI 删除/归档后本机还剩什么（安全，不做任何修改）
codex-sessions audit <session-id>

# 扫描整个 root 里的疑似残留 ID（安全，不做任何修改）
codex-sessions audit-root --limit 50
codex-sessions audit-root --status risky-global-state --source global-state-unknown --limit 50

# 批量预览 root 残留候选的删除影响（安全，不做任何修改）
codex-sessions preview-root --limit 50
codex-sessions preview-root --source global-state-unknown --limit 20

# 预览删除（安全，不做任何修改）
codex-sessions delete <session-id>

# 删除到回收站（推荐）
codex-sessions delete <session-id> --trash --yes

# 后悔了？恢复
codex-sessions restore <session-id> --yes

# 验证是否清理干净
codex-sessions verify <session-id>
```

## 删除到底做了什么

其他工具：删一个文件或一行数据库记录 → 完事 → 到处是孤儿文件。

这个工具：

```
1. 快照所有文件（万一要回滚）
2. 改写 session_index.jsonl（移除匹配行）
3. 改写 history.jsonl（移除匹配行）
4. 清理 `.codex-global-state.json` 引用
5. 删除原始 session 文件
6. 删除 shell snapshot 文件
7. 删除 SQLite 记录（threads、logs、spawn edges、agent jobs、dynamic tools、stage1、thread goals）

如果任何一步失败 → 全部回滚到原始状态。
```

删完之后跑 `verify`，确认零残留。

## 功能一览

| 功能 | 说明 |
|------|------|
| **列出 & 筛选** | 按项目、状态、时间范围、来源信息、model provider 和 model 筛选；按项目分组 |
| **来源汇总** | 只读汇总 `sourceKind`，同时保留 raw `source`、`thread_source`、`model_provider`、`model` 和 `agent_role` |
| **标题来源拆分** | 列表默认显示 Codex UI 可搜标题；详情显示 `session_index`、SQLite 和首条请求的标题差异 |
| **导出** | 删之前先备份为 JSON |
| **删除** | 永久删除或放入回收站，你选 |
| **残留审计** | 只读报告原始 rollout 文件、shell snapshot、session_index、history、SQLite、global-state、thread edges、family 状态和断裂 parent/child 关系 |
| **Root 残留扫描** | 不需要先知道 session ID，直接只读扫描整个 root 的疑似残留 |
| **Root 删除预览** | 对 root 残留候选做只读批量 delete preview，不需要手工列 session ID |
| **回收站 & 恢复** | 完整快照保存；恢复时检查 SQLite 主键冲突 |
| **验证** | 报告是否还有残留文件、索引行、数据库记录 |
| **清理索引** | 移除失效索引条目，不动原始数据 |
| **健康检查** | `doctor` 命令做完整诊断 |
| **MCP 服务** | AI Agent（Claude Code、Codex、Kiro）直接管理会话 |
| **会话家族** | 只读查看 parent、child、`/fork`、`/side` 关系；人类输出使用短 `source` 标签 |
| **子对话感知** | 父会话和子会话仍是独立 session；删除、导出、验证都不会自动递归 |

## 给 AI Agent 用（MCP）

加到你的 MCP 配置：

```json
{
  "mcpServers": {
    "codex-sessions": {
      "command": "codex-sessions-mcp",
      "args": []
    }
  }
}
```

暴露 18 个工具：`inspect_root`、`list_sessions`、`summarize_sources`、`list_projects`、`get_session`、`get_session_family`、`audit_session`、`audit_root`、`preview_root_delete`、`export_session_backup`、`preview_delete_sessions`、`delete_sessions`、`list_trash`、`restore_sessions`、`purge_trash`、`cleanup_session_indexes`、`cleanup_stale_indexes`、`verify_sessions`。

`summarize_sources`、`get_session_family`、`audit_session`、`audit_root` 和 `preview_root_delete` 是只读工具，不需要确认。所有破坏性操作需要 `confirm: true`，否则只返回预览。

## CLI 命令

```bash
codex-sessions list [--status active|archived] [--limit N] [--project TEXT]
codex-sessions list --updated-after 2026-04-01 --updated-before 2026-04-30
codex-sessions list --group-by project
codex-sessions list --source-kind cli --model-provider openai
codex-sessions list --source mcp --thread-source mcp
codex-sessions list --agent-role subagent --agent-nickname helper
codex-sessions sources [--json]
codex-sessions projects
codex-sessions doctor [--json]
codex-sessions show <session-id>
codex-sessions family <session-id> [--json]
codex-sessions audit <session-id> [--json]
codex-sessions audit-root [--json] [--limit 50] [--status STATUS...] [--source SOURCE...] [--all]
codex-sessions preview-root [--json] [--limit 50] [--status STATUS...] [--source SOURCE...] [--all]
codex-sessions export <session-id> [--output ./backup.json]
codex-sessions delete <session-id...> [--trash] [--yes]
codex-sessions trash-list
codex-sessions restore <session-id> --yes
codex-sessions purge <session-id> --yes
codex-sessions cleanup-stale [--yes]
codex-sessions cleanup-index <session-id...> [--yes]
codex-sessions verify <session-id...> [--json]
```

**安全第一**：所有破坏性命令需要 `--yes` 才执行，不加只看预览。

官方 Codex UI 删除或归档后，如果想知道本机还剩什么，先用 `audit`。它只读，不会改文件。它会报告原始 rollout 文件、shell snapshot、`session_index`、`history`、SQLite 记录、已知 global-state 引用、未知 global-state 引用、`thread_spawn_edges` 是否还在，也会报告 family 归属和断裂 parent/child 关系。如果仍有残留，建议命令只会给不带 `--yes` 的删除预览；只有你自己加 `--yes` 才会真的删除。

如果你还不知道 session ID，用 `audit-root`。它会扫描整个 Codex root，按风险列出疑似残留：断裂 parent/child 边、没有 rollout 文件但还有未知 global-state 引用、SQLite-only 记录、shell snapshot、index-only 记录，以及其他不完整残留。它只读，默认 `--limit 50`，不会打印聊天正文，每条只建议继续跑对应的单 session `audit` 命令。只有明确想把正常完整会话也列出来时，才加 `--all`。

`audit-root` 支持只影响显示结果的筛选：

- `--status risky-global-state`
- `--status db-only`
- `--status broken-family`
- `--status partial-residue`
- `--status global-state-unknown`
- `--source global-state-unknown`
- `--source global-state-known`
- `--source sqlite`
- `--source session-index`
- `--source history`
- `--source shell-snapshot`
- `--source thread-spawn-edges`

`--status` 和 `--source` 都可以写多次。同一类多个值是 OR；同时使用 status 和 source 时是 AND。这些筛选只缩小显示范围。命中的候选不是删除清单，也不是建议删除；仍然需要逐个 `audit` 或先看只读预览，不能因为出现在筛选结果里就直接认为应该删除。

人类输出和 JSON 都会带摘要：`filters`、`totalCandidatesBeforeFilter`、`totalCandidatesAfterFilter`、`returnedCandidates`、`limit`、`byStatus`、`bySource`。`byStatus` 和 `bySource` 是“筛选后、limit 前”的统计。

需要看会话来源时，用 `sources`。它只读，按推导出来的 `sourceKind`、raw `source`、`thread_source`、`model_provider`、`model` 和 `agent_role` 汇总。`sourceKind` 只会是 `subagent`、`mcp`、`vscode`、`cli`、`exec`、`unknown`。raw `source` 仍会保留在 JSON 输出里，人类输出也会显示；`sourceKind` 只是工具推导出来的分类，不替代原始字段。

`list` 支持同一套来源筛选：`--source-kind`、`--source`、`--thread-source`、`--agent-role`、`--agent-nickname`、`--model-provider`、`--model`。不同字段之间是 AND；同一个字段写多次是 OR。MCP `list_sessions` 支持同名参数，MCP `summarize_sources` 返回和 CLI `sources --json` 相同结构的摘要。

来源字段的边界：

- `source=vscode` 只是 Codex thread 的原始来源标签，不能直接等同 VS Code IDE。
- 不能用排除法判断剩下的是 Desktop。没有标成 `cli`、`mcp`、`vscode` 或 `exec` 的会话是 `unknown`，不是自动归为 Desktop。
- `source=mcp` 表示这个 thread 的来源是 mcp，不是每一次 MCP 工具调用日志。
- `model_provider` 这里只做显示和筛选，不修复 provider 身份，也不改写历史。

如果想对 `audit-root` 选出的候选做批量删除预览，用 `preview-root`。它复用同一套 `status/source` 筛选和保守默认 `--limit 50`，汇总展示只读预览会碰到哪些位置：rollout 文件、shell snapshots、`session_index`、`history`、SQLite、已知 global-state 引用、未知 global-state 引用和 `thread_spawn_edges`。它只读，不删除，不改写 JSONL、SQLite、shell snapshot 或 global-state，不接受 `--yes`，也不会自动递归加入 parent、child 或 family session。`preview-root` 的结果不等于“这些都该删”，也不会建议删除任何 session；它只说明如果之后你明确运行 delete，会碰到什么。真正删除仍然必须单独运行 `delete ... --yes`。

删除 parent 或 child 前先看 `family`。parent 和 child 是不同 session，各自有自己的 ID。删除 parent 不等于删除 child，删除 child 也不等于删除 parent。删除预览和 audit 会提示关系记录指向缺失 session，或相关 session 缺文件/索引。要一起处理多个相关 session，需要把每个 session ID 明确放进预览或删除命令。工具不会自动递归处理 parent 或 child。

人类可读的 `family` 输出会用短 `source` 标签保持表格清楚，例如 `subagent`、`mcp`、`exec`、`side-thread`、`unknown`。需要完整原始 `source` 字段时，用 `family --json` 或 MCP `get_session_family`。

## 标题怎么看

Codex 本地会话可能同时有多个标题：

- `displayTitle`：默认展示标题，优先来自 `session_index.jsonl.thread_name`，更接近 Codex UI 里能搜到的标题。
- `indexTitle`：`session_index.jsonl` 里的标题。
- `sqliteTitle`：`state_N.sqlite` 的 `threads.title`，可能是旧的内部长标题。
- `firstUserMessage`：第一条用户请求。
- `titleSource`：当前展示标题来自哪里。
- `titleMismatch`：这些来源是否出现不一致。
- `titleCandidates`：所有候选标题。

`list` 和搜索结果默认显示 `displayTitle`。人类可读的 `show` 会用短摘要列出 `sqliteTitle`、`firstUserMessage`、所有候选标题和时间线预览，方便确认标题分裂问题，同时避免刷出大段正文。需要完整值和完整时间线时用 `show --json`。

## Codex 存了什么（我们清理什么）

Codex Desktop 删除归档聊天时，可能已经清掉其中一部分。`audit-root` 可以先找出疑似残留 ID，`preview-root` 可以批量预览这些 ID 的删除影响，`audit` 再对单个 ID 给只读报告。真正清理之后，再用 `verify` 复查。确认要清理时，才用 `delete --yes` 或 `cleanup-index --yes` 处理残留。

```
~/.codex/
├── sessions/            ← 原始 rollout JSONL 文件       ✅ 清理
├── archived_sessions/   ← 归档 rollout JSONL 文件       ✅ 清理
├── shell_snapshots/     ← shell 快照脚本                ✅ 清理
├── session_index.jsonl  ← 会话元数据索引                ✅ 清理
├── history.jsonl        ← 对话历史索引                  ✅ 清理
├── state_N.sqlite       ← threads 和相关记录            ✅ 清理
├── logs_N.sqlite        ← 执行日志                      ✅ 清理
└── .codex-global-state.json ← 已知活跃会话引用          ✅ 清理
```

## 文档

- [安全指南](./docs/SAFETY.md) — 删除/回收站/恢复/清除前必读
- [更新日志](./CHANGELOG.md) — 版本记录
- [SKILL.md](./SKILL.md) — Claude Code / Codex 的 AI 技能说明

## 开发

```bash
git clone https://github.com/1939869736luosi/codex-sessions-manager.git
cd codex-sessions-manager
npm install
npm run build
npm test
```

## 许可证

Apache-2.0
