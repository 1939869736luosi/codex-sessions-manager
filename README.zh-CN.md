# codex-sessions-manager

[![npm](https://img.shields.io/npm/v/codex-sessions-manager)](https://www.npmjs.com/package/codex-sessions-manager)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[English](./README.md)

> Codex Desktop 现在已经有归档聊天删除入口。实测中，它会删除主会话文件和部分 thread 记录，但仍可能留下索引、执行日志和桌面状态引用。

**codex-sessions-manager** 是 CLI-first 的本地 Codex 会话审计和清理工具。它的 **Skill**、**CLI** 和有限返回的 **MCP Server** 共享同一套核心逻辑。它用来检查 `~/.codex` 里还剩什么、审计官方 UI 删除/归档后留下的本地残留、按精确 session ID 处理隐藏记录，并验证当前版本已覆盖的本机 surface 是否仍有残留。

它面向安全敏感的本地历史管理：prompt/history 隐私、精确会话删除、失败回滚、恢复冲突检查、SQLite/global-state 一致性，以及删除后的残留验证。

欢迎报告安全问题。支持边界和报告方式见 [SECURITY.md](./SECURITY.md)。

## 为什么选这个？

普通归档聊天优先用 Codex Desktop 官方删除入口。这个工具面向更难的本机场景：官方删完后验残留、清理孤儿记录、按精确 session ID 处理，以及让 AI Agent 安全管理本地历史。

| | codex-sessions-manager | 其他工具 |
|--|:---:|:---:|
| 清理已覆盖的 session 层（文件 + JSONL + 已知 SQLite + 已知全局状态） | ✅ | ❌ 只清部分 |
| 持久 journal、失败回滚和明确的崩溃恢复 | ✅ | ❌ |
| 可恢复的回收站 + 冲突检测 | ✅ | ❌ 或简单备份 |
| 删完验证有没有残留 | ✅ | ❌ |
| AI Agent 可直接调用（MCP） | ✅ | ❌ |
| 识别 `/side` 和 `/fork` 父子关系 | ✅ | ❌ |

当前兼容边界：Codex 可能通过 `sqlite_home` 或 `CODEX_SQLITE_HOME` 把 SQLite 放在 Codex root 外。本工具会按 `config.toml sqlite_home`、`CODEX_SQLITE_HOME`、Codex root 的顺序解析，并在 root 顶层和 SQLite home 同时存在 DB 时报警。旧式 `event_msg` / `response_item` timeline 和 paginated `item_completed` timeline 都会解析，并明确报告完整性。会话排序按 `recency_at_ms`、`recency_at`、`updated_at` 依次回退，结构化结果会显示 `historyMode`。压缩 rollout 文件 `.jsonl.zst` 已进入扫描、删除、回收站和恢复路径，并按二进制保存；如果某个 session 只剩 `.jsonl.zst`，`show` 不会解压正文，而会报告 `compressed_unread`，精确压缩字节通过 `export` 获取。`logs_N.sqlite` 执行日志、`memories_N.sqlite` memory 数据和 remote-control 状态当前都不作为普通 session cleanup surface。

确认写操作只接受标准完整 session UUID；删除 active session 还要显式提供 `--allow-active` / `allowActive=true`。managed symlink、junction、hard link、root 外路径和过期计划都会拒绝。写操作若被中断，会保留恢复记录并阻止后续写入，直到使用精确 operation ID 完成恢复。退出状态、验证范围和同一用户持续抢占文件系统时的边界见 [安全指南](./docs/SAFETY.md)。

## 快速开始

```bash
# 全局安装
npm install -g codex-sessions-manager

# 查看已安装包版本
codex-sessions --version
codex-sessions-mcp --version

# 列出最近的会话
codex-sessions list --limit 10

# 汇总会话来源（安全，不做任何修改）
codex-sessions sources

# 查看父子关系（安全，不做任何修改）
codex-sessions family <session-id>
codex-sessions family <session-id> --children
codex-sessions family <session-id> --parents
codex-sessions family <session-id> --subagents
codex-sessions family <session-id> --impact

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

# 预览 P11 exact-key global-state 清理（安全，不做任何修改）
codex-sessions delete <session-id> --root <path-to-codex-root>

# 预览确认后，使用标准完整 UUID 删除到回收站（推荐）
codex-sessions delete <full-session-uuid> --trash --yes

# 后悔了？使用精确内部 trashId 恢复
codex-sessions restore <exact-trash-id> --yes

# 验证当前版本覆盖的 live surfaces
codex-sessions verify <session-id>
```

## 删除到底做了什么

其他工具：删一个文件或一行数据库记录 → 完事 → 到处是孤儿文件。

这个工具：

```
1. 快照所有文件（万一要回滚）
2. 改写 session_index.jsonl（移除匹配行）
3. 改写 history.jsonl（移除匹配行）
4. 只清理已知 `.codex-global-state.json` 引用和两个 P11 exact-key 候选
5. 删除原始 session 文件
6. 删除 shell snapshot 文件
7. 删除已知 SQLite session 记录（threads、spawn edges、agent jobs、dynamic tools、legacy state-owned `stage1_outputs`、thread goals；新版 Codex 可能把 goals 放在 `goals_N.sqlite`）。`logs_N.sqlite` 执行日志默认保留。

如果任何一步失败 → 全部回滚到原始状态。
```

删完之后跑 `verify`，确认当前版本覆盖的 surface 没有残留。`verify` 可能显示 `retained_sqlite=logs=N`，这是预期结果。`.jsonl.zst` 已按 session 文件处理；`memories_N.sqlite` 仍是只读 memory surface，必须另做 memory 删除安全设计后，才能声称完整 memory cleanup。

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
| **Codex SQLite 结构** | 按 `config.toml sqlite_home` / `CODEX_SQLITE_HOME` / root fallback 顺序解析；识别 `state_N.sqlite`、`logs_N.sqlite`、`goals_N.sqlite` 和只读 `memories_N.sqlite`；`doctor`、`audit`、`verify` 和预览会统计 `goals_N.sqlite.thread_goals`，但 `logs_N.sqlite` 和 `memories_N.sqlite` 默认不删除。 |
| **回收站 & 恢复** | 完整快照保存；`.jsonl.zst` 会话文件按二进制安全保存；恢复时检查 SQLite 主键冲突 |
| **验证** | 报告当前版本支持的文件、索引行和数据库记录是否仍有残留 |
| **清理索引** | 移除失效索引条目，不动原始数据 |
| **健康检查** | `doctor` 命令做完整诊断 |
| **MCP 服务** | AI Agent（Claude Code、Codex、Kiro）直接管理会话 |
| **会话家族** | 只读查看 parent、child、ancestor、descendant、sibling、subagent、`/fork`、`/side` 和 impact；人类输出默认使用短 `source` 标签，`--full` 显示更完整 |
| **子对话感知** | 父会话和子会话仍是独立 session；删除、导出、验证都不会自动递归 |

## 给 AI Agent 用

### 1. CLI（通用，所有生态）

任何能执行 shell 命令的 AI agent 都可以直接使用：

```bash
codex-sessions list --limit 10
codex-sessions audit <session-id>
codex-sessions delete <session-id>   # 不加 --yes 只做预览
```

适用于 Amp、Claude Code、Codex、Cursor、Factory Droid 及任何有 shell 权限的 agent。

### 2. Skill（Codex、Claude Code、Amp）

复制自包含的 skill 目录获得更完整的 agent 集成：

```bash
# Codex 项目级官方共享目录
mkdir -p .agents/skills/codex-sessions-manager
cp -r skills/codex-sessions-manager/* .agents/skills/codex-sessions-manager/

# Codex 用户级目录
mkdir -p "$HOME/.agents/skills/codex-sessions-manager"
cp -r skills/codex-sessions-manager/* "$HOME/.agents/skills/codex-sessions-manager/"

# Claude Code
mkdir -p ~/.claude/skills/codex-sessions-manager
cp -r skills/codex-sessions-manager/* ~/.claude/skills/codex-sessions-manager/

# 分发的 Skill 内含 nested agents/openai.yaml。
```

### 3. MCP（可选，进阶）

Codex 使用官方注册命令，或使用 [Codex adapter](adapters/codex/) 中等价的 TOML：

```bash
codex mcp add codex-sessions -- codex-sessions-mcp --profile read-only
```

其他 MCP host 可继续使用它们各自的 JSON 配置，例如：

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

默认 **read-only** profile（16 个工具）。需要破坏性操作时使用 `--profile admin`（22 个工具）。

MCP `get_session` 有固定上限：`compact` 最多 20 items / 64 KiB，`full` 最多 200 items / 256 KiB。两者都会返回 `completeness`、底层 `sourceCompleteness`、已返回/已知数量、省略原因和是否可精确导出。需要全部本地可解析 semantic items 时用 `codex-sessions show <id> --json`；需要 byte-exact 原始内容时用 `export`。

**Windows 上的 0.6 系列安全补丁仅支持只读。** 删除、移入回收站、恢复、永久清除、索引清理和中断恢复都会直接拒绝。待真实 Windows 环境完成 junction/reparse point、大小写和异常退出测试后，才会重新开放写操作。Windows 上即使请求 MCP `admin` profile，也只注册只读工具。

### 4. 生态适配器

各平台的具体配置指南在 `adapters/` 目录下：

| 平台 | 适配器 | 核心特性 |
|------|--------|----------|
| Amp | [`adapters/amp/`](adapters/amp/) | Skill 内 `mcp.json` 延迟加载 |
| Claude Code | [`adapters/claude-code/`](adapters/claude-code/) | Skill 目录 + MCP 配置 |
| OpenAI Codex | [`adapters/codex/`](adapters/codex/) | AGENTS.md 片段 + CLI 模板 |
| Cursor | [`adapters/cursor/`](adapters/cursor/) | `.cursor/mcp.json` 示例 |
| Factory Droid | [`adapters/factory-droid/`](adapters/factory-droid/) | `droid mcp add` 一行接入 |

### 升级说明（v0.5.x → v0.6.0）

v0.6.0 把 MCP 默认 profile 从 20 个工具缩减为 15 个。v0.6.1 增加只读恢复状态检查和 admin-only 确认恢复工具，两个 profile 现在分别是 16 和 22 个工具。需要写操作时添加 `--profile admin`，但仍然必须明确确认。

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
codex-sessions show <session-id> [--json]
codex-sessions family <session-id> [--json] [--children|--parents|--subagents|--impact] [--full] [--source-kind KIND]
codex-sessions audit <session-id> [--json]
codex-sessions audit-root [--json] [--limit 50] [--status STATUS...] [--source SOURCE...] [--all]
codex-sessions preview-root [--json] [--limit 50] [--status STATUS...] [--source SOURCE...] [--all]
codex-sessions export <session-id> [--output ./backup.json]
codex-sessions plan-delete <session-id...> [--json] [--write-plan FILE] [--include-children] [--include-subagents] [--include-descendants] [--include-family]
codex-sessions plan-delete --source-kind KIND [--source-kind KIND...] --limit N [--status STATUS...] [--json]
codex-sessions preview-plan <plan-file> [--json]
codex-sessions delete <full-session-uuid...> [--trash] [--yes] [--allow-active]
codex-sessions cleanup-index <full-session-uuid...> [--yes] [--allow-active]
codex-sessions recovery-status [--json]
codex-sessions recover <exact-operation-id> --yes
codex-sessions trash-list
codex-sessions restore <exact-trash-id> --yes
codex-sessions purge <exact-trash-id> --yes
codex-sessions cleanup-stale [--yes]
codex-sessions verify <session-id...> [--json]
```

**安全第一**：所有破坏性命令需要 `--yes` 才执行，不加只看预览。真正删除前，先对明确的 session ID 单独预览；`family`、`impact`、`audit-root`、`preview-root`、`plan-delete`、plan files 和 `preview-plan` 都不能算删除许可，也不能替代删除确认。

只读查询可以解析唯一短前缀。确认 session 写操作只接受小写完整 UUID，删除 active session 还要加 `--allow-active`；确认 restore/purge 只接受精确 `trashId`。退出状态 `2` 表示写操作已提交，但验证不完整或失败；状态 `3` 表示必须恢复，后续写操作已经阻止。

`export` 和 trash bundle 是恢复数据，不是预览。它们可能包含完整 global-state exact-key value，包括 prompt-history 内容。人工 delete 预览只显示 path、rule、shape 和 byte count。

兼容检查以 [compat baseline](https://github.com/1939869736luosi/codex-sessions-manager/tree/main/compat) 为准：旧式和 paginated timeline 都有合成 fixture；`.jsonl.zst` 只剩压缩文件时明确报告 `compressed_unread`；`logs_N.sqlite`、`memories_N.sqlite`、external agent imports 和 remote-control 继续只做观察，不进入普通 session cleanup。

官方 Codex UI 删除或归档后，如果想知道本机还剩什么，先用 `audit`。它只读，不会改文件。它会报告原始 rollout 文件、shell snapshot、`session_index`、`history`、SQLite 记录、已知 global-state 引用、P11 exact-key global-state 引用、未知 global-state 引用、`thread_spawn_edges` 是否还在，也会报告 family 归属和断裂 parent/child 关系。如果仍有残留，建议命令只会给不带 `--yes` 的删除预览；只有你自己加 `--yes` 才会真的删除。

如果你还不知道 session ID，用 `audit-root`。它会扫描整个 Codex root，按风险列出疑似残留：断裂 parent/child 边、没有 rollout 文件但还有未知 global-state 引用、SQLite-only 记录、shell snapshot、index-only 记录，以及其他不完整残留。它只读，默认 `--limit 50`，不会打印聊天正文，每条只建议继续跑对应的单 session `audit` 命令。只有明确想把正常完整会话也列出来时，才加 `--all`。

`audit-root` 支持只影响显示结果的筛选：

- `--status risky-global-state`
- `--status global-state-exact-key`
- `--status db-only`
- `--status broken-family`
- `--status partial-residue`
- `--status global-state-unknown`
- `--source global-state-unknown`
- `--source global-state-exact-key`
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

如果想对 `audit-root` 选出的候选做批量删除预览，用 `preview-root`。它复用同一套 `status/source` 筛选和保守默认 `--limit 50`，汇总展示只读预览会碰到哪些位置：rollout 文件、压缩 `.jsonl.zst` rollout 文件、shell snapshots、`session_index`、`history`、SQLite（包含存在时的 `goals_N.sqlite.thread_goals`）、已知 global-state 引用、P11 exact-key global-state 引用、未知 global-state 引用和 `thread_spawn_edges`。`logs_N.sqlite` 和 `memories_N.sqlite` 不是默认删除面。它只读，不删除，不改写 JSONL、SQLite、shell snapshot 或 global-state，不接受 `--yes`，也不会自动递归加入 parent、child 或 family session。`preview-root` 的结果不等于“这些都该删”，也不会建议删除任何 session；它只说明如果之后你明确运行 delete，会碰到什么。真正删除应先跑单独的明确 ID `delete` 预览供检查，再单独运行显式确认的 `delete ... --yes`。

如果已经有明确 session ID，并且想在任何删除预览或写操作前先做更安全的关系感知计划，用 `plan-delete`。它只读，JSON 里会标明 `readOnly: true` 和 `executionSupported: false`，也可通过只读 MCP `plan_delete_sessions` 调用。默认只选择 seed IDs。相关 parent、child、subagent、descendant、family member，以及 `/side`/`/fork` 这类 ambiguous session，会出现在 `availableIncludes` 或 warning 里。`--include-children`、`--include-subagents`、`--include-descendants` 和 `--include-family` 只改变 `selectedIds`，不会执行删除；其中 `--include-family` 风险最高，会给出强提醒。exact-key global-state 只显示 path、rule、shape 和 byteEstimate 元数据；unknown global-state 仍然只是 warning-only。

T7-P3 新增一个保守的 root-level source 候选形式：`plan-delete --source-kind subagent --limit 20 [--status archived] [--json]`。`--source-kind` 可重复，OR 语义；`--status` 也可重复，OR 语义。`--limit` 必填，最大 50。root-level `sourceKind=unknown` 会被拒绝；unknown 会话必须用 explicit session ID 人工复核。这个模式只写 `candidateIds`，绝不写 `selectedIds`，active/current 命中会留在 `rejectedIds`。它只是候选列表：`sourceKind` 是筛选维度，不是删除授权。`mcp` 只表示 thread source，不代表每次 MCP tool call；`vscode` 是 Codex 原始标签，不等同 VS Code IDE；`exec` 不代表执行日志可安全批量删除。本版本故意不支持 sourceKind candidate plan 的 `--write-plan`。

MCP `plan_delete_sessions` 支持同样的 sourceKind candidate 语义：传 `sourceKind`、必填 `limit` 和可选 `status`；`selectedIds` 保持为空，命中只进入 `candidateIds`；root-level `unknown` 拒绝，active/current 命中进入 `rejectedIds`。MCP 不支持 `writePlan`，不会生成 preview token，也不能执行删除。

`plan-delete --write-plan FILE` 会写出稳定的 `codex-sessions-delete-plan.v1` JSON 审计文件。文件包含 `scanTimestamp`、`planHash`、root fingerprint、selected surface counts、family edges 和 exact-key global-state paths。它不能包含 transcript 正文、prompt text 或完整 global-state values；exact-key global-state 条目只限 path/rule/shape/byteEstimate 元数据。plan file 只是审计材料，不是授权、不是 preview token、不是删除确认，也不能传给任何删除执行命令。

`preview-plan <plan-file>` 会只读重扫 root，并把 plan 和当前状态做比较。它检查 root realpath、SQLite home realpath/source、`session_index`、`history`、`.codex-global-state.json`、state/log/goals/memories SQLite 的 mtime/size/parseability、selected surface counts、family edges 和 exact-key paths。selected surface counts 会包含已选 session 的压缩 `.jsonl.zst` rollout 文件。只要已覆盖的 fingerprint 有差异，就返回 `stale=true`，并且不产生当前 delete preview，避免把旧 plan 当成当前预览。`preview-plan` 不接受 `--yes`、`--trash`、`--force` 或任何删除执行模式。

MCP `preview_delete_plan` 接收 `planFile` 或 inline `plan` object，并复用同一套 stale detection。它只读，不接受 `confirm`、`trash`、`yes` 或 `force`；当 `stale=true` 时不会返回当前 `deletePreview`。

当前设计上不支持 delete-by-plan、preview token、`--force`、sourceKind-based delete execution，或高级 family/sourceKind 自动删除编排。真正删除仍然必须回到单独的明确 ID delete preview，并在人工确认后显式执行。

### P11 exact-key global-state 清理

只有两个原本属于 unknown 的 `.codex-global-state.json` 路径可以在确认删除时一起清理：

- `$.electron-persisted-atom-state.prompt-history.<session-id>`
- `$.electron-persisted-atom-state.heartbeat-thread-permissions-by-id.<session-id>`

前提是 session id 必须是完整对象键，value 形状也必须符合规则。预览会显示 exact path、rule id、value shape、估算字节数、相关残留面、family 提醒，以及是否需要确认。它不会打印 prompt 内容，也不会打印完整 global-state value。

其它 unknown global-state 引用仍然只是警告。UUID 字符串、数组里的 UUID、部分路径命中、heartbeat 异常形状、installation id、root 扫描候选，都不会自动删除。一个 ID 如果只命中这些不合规则的 unknown 引用，确认删除也会拒绝。

使用现有明确 ID 删除流程：

```bash
codex-sessions delete <session-id> --root <path-to-codex-root>
codex-sessions delete <session-id> --root <path-to-codex-root> --yes
codex-sessions delete <session-id> --root <path-to-codex-root> --trash --yes
```

MCP 规则相同：先调用 `preview_delete_sessions` 检查 exact path，再在确认符合预期时调用 `delete_sessions` 并设置 `confirm=true`。当前没有 preview token，也不会把某一次 preview 调用和后续 confirm 调用强绑定。确认命令会重新扫描 root；如果 global-state 文件在这次确认命令内部、写入前又发生变化，或文件无法解析、没有可回滚保护，写操作会拒绝。

删除 parent 或 child 前先看 `family`。parent 和 child 是不同 session，各自有自己的 ID。删除 parent 不等于删除 child，删除 child 也不等于删除 parent。删除预览和 audit 会提示关系记录指向缺失 session，或相关 session 缺文件/索引。要一起处理多个相关 session，需要把每个 session ID 明确放进预览或删除命令。工具不会自动递归处理 parent 或 child。

`thread_spawn_edges` 是通用 parent/child 关系边，不是 subagent 专用表。`/side`、`/fork`、subagent、MCP、exec、VS Code、CLI 和 unknown 都可能表现为 child thread。判断 child 类型时，看 child 自己的 `sourceKind`、raw `source`、`thread_source`、`agent_role`、`agent_nickname` 和 `agent_path`。一个 child 可以同时带多个标签，比如同时是 `subagent` 和 `side/fork`；JSON/MCP 会返回 `childTypeLabels` 和 `relationshipLabels`，避免把混合身份压成单一类型。

`family` 的这些视图全部只读：

- `family <id> --children` 只显示直接 children，包含 `sourceKind`、edge 状态、child 类型标签、标题、更新时间、agent 信息，以及 file/index/thread 是否存在。
- `family <id> --parents` 只显示直接 parents，保留同样的来源和 edge 信息。
- `family <id> --subagents` 显示 family 里 `sourceKind=subagent` 或带 agent 信息的成员。
- `family <id> --impact` 只读显示如果之后只处理当前 session，哪些 parent、child、family member 没被选中，以及 missing parent/child、缺 file/index/thread 等风险。输出会分组展示 `selected`、`unselected parents`、`unselected children`、`unselected family members`、`missing relations` 和 `missing surfaces`。它不删除，不建议删除，也不会生成 `--yes`。
- `family <id> --full` 在块状输出里显示完整 raw `source` 和完整标题，避免用一行宽表撑爆屏幕。JSON 输出和 MCP 始终保留完整字段。

可以给 family 视图加 `--source-kind subagent|mcp|vscode|cli|exec|unknown`，只看匹配成员。默认人类输出会保持紧凑，长文本可能缩短；需要完整原始字段时，用 `--full`、`family --json` 或 MCP `get_session_family`。真正删除仍然必须单独跑明确 ID 预览，并显式确认。

T8-P2/T9 增加 source metadata compatibility layer。稳定的 `sourceKind` 字段仍然保持粗粒度兼容分类（`subagent`、`mcp`、`vscode`、`cli`、`exec`、`unknown`）。JSON 输出还可能包含 `sourceInfo`，记录 raw `source`、raw `thread_source`、可可靠派生时的官方 Codex v2 source-kind metadata、thread-source analytics metadata 和简明 evidence。这只用于观测：不改变 filters、delete preview、plan-delete selection、MCP planning 或删除授权。尤其是内部 raw `mcp`、raw `appServer` 或 raw `app-server` 会报告为稳定 `sourceKind=mcp` 和官方 metadata `appServer`；它不是 individual MCP tool-call 的证明。

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
├── sessions/            ← 原始 rollout .jsonl/.jsonl.zst 文件       ✅ 清理
├── archived_sessions/   ← 归档 rollout .jsonl/.jsonl.zst 文件       ✅ 清理
├── shell_snapshots/     ← shell 快照脚本                ✅ 清理
├── session_index.jsonl  ← 会话元数据索引                ✅ 清理
├── history.jsonl        ← 对话历史索引                  ✅ 清理
├── state_N.sqlite       ← threads 和相关记录            ✅ 清理
├── goals_N.sqlite       ← 拆分出的 thread goals         ✅ 清理
├── logs_N.sqlite        ← 执行日志                      👁 默认保留
├── memories_N.sqlite    ← 官方 memory state             👁 只做 doctor/schema watch
└── .codex-global-state.json ← 已知活跃会话引用          ✅ 清理
```

SQLite 可以在 `~/.codex` 顶层，也可以在 `config.toml sqlite_home` / `CODEX_SQLITE_HOME` 指定的 SQLite home；两者同时存在时，`config.toml sqlite_home` 优先。`doctor` 会显示当前 active SQLite home，并在两边同时有 DB 候选时给 dual-home warning。

`.jsonl.zst` 已作为 session 文件纳入 scan、preview、delete、trash、restore 和 stale detection。它不会在 `show` 中解压正文；compressed-only session 会报告 `compressed_unread`，索引或历史摘要也会明确标成 history，不冒充 transcript 正文。

## 文档

- [安全策略](./SECURITY.md) — 报告数据丢失、删除不完整、恢复、回滚、路径处理和本地历史泄露问题
- [安全指南](./docs/SAFETY.md) — 删除/回收站/恢复/清除前必读
- [更新日志](./CHANGELOG.md) — 版本记录
- [SKILL.md](./SKILL.md) — AI 技能说明（精简路由文件，~90 行）
- [详细工具参考](./skills/codex-sessions-manager/docs/SKILL_DETAIL.md) — 完整 CLI/MCP 参数文档
- [生态适配器](./adapters/) — Amp、Claude Code、Codex、Cursor、Factory Droid 各平台配置指南
- [兼容基线](https://github.com/1939869736luosi/codex-sessions-manager/tree/main/compat) — 固定 Codex 版本、合成 fixtures、公开巡检结果和发版新鲜度规则

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
