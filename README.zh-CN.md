# codex-sessions-manager

[![npm](https://img.shields.io/npm/v/codex-sessions-manager)](https://www.npmjs.com/package/codex-sessions-manager)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[English](./README.md)

> 普通 task 管理和永久删除优先使用官方 Codex。从 Codex 0.144.1 开始，官方 `thread/delete` 会删除持久化 thread、spawned descendants、rollout 文件和关联状态。本项目负责独立检查实际还剩什么，并处理可恢复清理、旧版本遗留、损坏状态和孤儿记录。

**codex-sessions-manager** 是 CLI-first 的本地 Codex 历史审计和恢复工具。它的 **Skill**、**CLI** 和有限返回的 **MCP Server** 共享同一套核心逻辑。它用来核验官方删除、发现旧版或损坏的本地残留、执行可预览且可恢复的清理，并只对当前版本实际检查过的存储位置作出结论。

它面向安全敏感的本地历史管理：prompt/history 隐私、精确会话删除、能够安全证明时回滚、否则显式恢复、恢复冲突检查、SQLite/global-state 一致性，以及删除后的残留验证。

欢迎报告安全问题。支持边界和报告方式见 [SECURITY.md](./SECURITY.md)。

项目资料：[架构](./ARCHITECTURE.md) · [路线图](./ROADMAP.md) · [贡献指南](./CONTRIBUTING.md) · [发布检查表](./docs/RELEASE.md)

## 为什么选这个？

普通 task 的读取、搜索、改名、归档、继续、fork、发送消息和永久删除优先使用官方 Codex。这个工具处理另一类问题：证明官方删完后还剩什么、从清理故障中恢复、处理旧版或损坏的存储，以及定期批量清理已经确认的残留。

这个项目把以下能力放进同一个本地工具：

- 清理当前版本已理解的 session 层：文件、JSONL 索引、已知 SQLite 行和白名单 global-state key；
- 持久 mutation journal；记录状态足以证明安全时回滚，否则要求显式恢复；
- 可恢复的回收站和冲突检测；
- 按声明的清理范围做删除后验证；
- 供 AI Agent 使用的有限 MCP 接口；
- 只读识别 `/side` 和 `/fork` 父子关系。

## 官方重叠与项目保留价值

每次 Codex 基线变化和每次发版前都要复查这张表。详细证据保存在[官方能力基线](https://github.com/1939869736luosi/codex-sessions-manager/blob/main/compat/upstream-capabilities.json)。

| 能力 | 官方 Codex 状态 | 本项目决定 |
|---|---|---|
| 普通 list、search、read、rename、archive、resume、fork、send、steer、goal | 已提供 | 官方优先，不再增加平行控制工具 |
| 普通永久删除 | 0.144.1 已提供 | 官方优先；本项目保留独立核验和异常清理 |
| 可恢复回收站、恢复冲突检查、写操作中断恢复 | 未找到同等公开接口 | 保留 |
| 旧版、损坏、部分完成和孤儿状态审计 | 未找到同等公开接口 | 保留 |
| 按 task 控制 memory 使用/生成、全部重置 memory | 已提供 | 使用官方控制 |
| 按条或按 session 精确编辑/删除最终 memory | 未找到受支持接口 | 只观察，不直接修改 |
| App Server turn/item 分段读取 | 实验中 | 保留现有的进程内分段书签；没有跨宿主实证前，不扩建成跨应用 handoff/resource 协议 |

兼容巡检以后同时回答两个问题：

1. 本项目还能不能正确读取并安全处理当前 Codex 存储格式？
2. 官方 Codex 有没有取代、缩小或新开放某项能力？

官方能力变化后，项目能力可以改为官方优先、保留、只核验、延期或删除。发现变化只会生成审查结论，不会自动删代码或发布版本。

### 目前怎样管理 memory

官方目前没有提供“逐条查看、逐条修改、逐条删除最终 memory”的受支持接口，也不能保证最终 memory 中一段话只来自一个 session。当前建议使用官方控制：

- 用 `/memories` 决定当前 task 是否使用已有 memory、是否参与未来 memory 生成；
- 需要记住、忘记或纠正某件事时，直接明确告诉 Codex，让官方的追加式更正输入在后续整理中处理；
- 确实要清空全部本地 memory 时，才使用 **Reset all memories**；
- 需要删除某个 session 作为 memory 来源时，先使用官方 thread 删除并等待后台重新整理。本项目目前只能报告有限的 thread-linked Stage 1 关联，也可能返回 `unknown`；不能证明最终 memory 中某段文字已经消失。

精确的 memory 来源追踪和删除后重新整理核验仍是 roadmap 项目。兼容巡检若发现官方提供了可用接口或足够可靠的证据，再讨论开发。

不要直接修改 `memories_N.sqlite`，也不要把手工删改 `MEMORY.md`、`memory_summary.md`、`raw_memories.md` 或 `rollout_summaries/` 当成可靠删除办法。这些都是自动生成状态，可能再次重建。参见[官方 Memories 文档](https://learn.chatgpt.com/docs/customization/memories)。

## 建议的定期使用方式

1. 正常永久删除先用官方 Codex。
2. 每月一次，或者发现存储异常时，运行 `monthly-review` 获取一份范围受限、完全只读的审计与预览报告。
3. 对候选运行 `audit <id>`，区分“确认有残留”和“从未发现过这个 ID”。
4. 只对确认残留的完整 IDs 做批量预览；仍需本地处理时优先使用 `delete --trash --yes`。
5. 最后运行 `verify`，把结构化结果当作本地删除记录。

当前兼容边界：Codex 可能通过 `sqlite_home` 或 `CODEX_SQLITE_HOME` 把 SQLite 放在 Codex root 外。本工具会按 `config.toml sqlite_home`、`CODEX_SQLITE_HOME`、Codex root 的顺序解析，并在 root 顶层和 SQLite home 同时存在 DB 时报警。旧式 `event_msg` / `response_item` timeline 和 paginated `item_completed` timeline 都会解析，并明确报告完整性。会话排序按 `recency_at_ms`、`recency_at`、`updated_at` 依次回退，结构化结果会显示 `historyMode`。压缩 rollout 文件 `.jsonl.zst` 已进入扫描、删除、回收站和恢复路径，并按二进制保存；如果某个 session 只剩 `.jsonl.zst`，`show` 不会解压正文，而会报告 `compressed_unread`，精确压缩字节通过 `export` 获取。确认永久删除时，只删除 `logs.thread_id` 与所选完整 UUID 精确相等的日志行；移入 trash 时保留这些日志，直到最终 purge。`memories_N.sqlite` 及 Phase 2 memory 输出始终只读，remote-control 状态也只做观察。

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

# 把一条精确 session 流式转换为 canonical JSONL（安全，只读）
codex-sessions events <完整-session-id>
codex-sessions events <完整-session-id> --output ./session-events.jsonl

# 查看父子关系（安全，不做任何修改）
codex-sessions family <session-id>
codex-sessions family <session-id> --children
codex-sessions family <session-id> --parents
codex-sessions family <session-id> --subagents
codex-sessions family <session-id> --impact

# 审计官方删除后本机还剩什么（安全，不做任何修改）
codex-sessions audit <session-id>

# 扫描整个 root 里的疑似残留 ID（安全，不做任何修改）
codex-sessions audit-root --limit 50
codex-sessions audit-root --status risky-global-state --source global-state-unknown --limit 50

# 批量预览 root 残留候选的删除影响（安全，不做任何修改）
codex-sessions preview-root --limit 50
codex-sessions preview-root --source global-state-unknown --limit 20

# 预览删除（安全，不做任何修改）
codex-sessions delete <session-id>

# 预览白名单 exact-key global-state 清理（安全，不做任何修改）
codex-sessions delete <session-id> --root <path-to-codex-root>

# 预览确认后，使用标准完整 UUID 删除到回收站（推荐）
codex-sessions delete <full-session-uuid> --trash --yes

# 后悔了？使用精确内部 trashId 恢复
codex-sessions restore <exact-trash-id> --yes

# 验证当前版本覆盖的 live surfaces
codex-sessions verify <session-id>
```

## 删除到底做了什么

处理旧版、孤儿或明确选择的可恢复清理时，这个工具会：

```
1. 提交前重新扫描并核验可信 root、目标和 active-session 状态
2. 获取独占锁，写入 operation journal，并预先生成受影响文件的替换内容
3. 原子替换 `session_index.jsonl`、`history.jsonl` 和允许清理的 global-state exact-key
4. 删除原始 session 文件和 shell snapshot 文件
5. 在数据库事务内删除已知 SQLite session 记录（threads、spawn edges、agent jobs、dynamic tools、legacy state-owned `stage1_outputs`、thread goals；新版 Codex 可能把 goals 放在 `goals_N.sqlite`），并删除 dedicated logs 数据库中 `thread_id` 精确匹配的日志行
6. 按实际覆盖范围验证结果，并记录 committed、rolled_back 或 recovery_required

提交前失败不会修改数据。提交途中失败时，只在能够证明恢复安全的情况下回滚；状态无法确认时返回 `recovery_required` 并阻止后续写操作。已经提交但验证不完整或失败时，结果仍明确标为 committed，CLI 返回状态 2，不会误报成“没有执行”。
```

删完之后跑 `verify`，确认当前版本覆盖的 surface 没有残留。永久删除必须报告精确 thread-linked log 行为零；trash 会故意保留它们，restore 不修改它们，最终 purge 会在同一 session ID 未重新出现于 live storage 时删除它们。`.jsonl.zst` 已按 session 文件处理；`memories_N.sqlite` 始终只读，验证只报告可观察到的关联，不会修改 memory。

## 功能一览

| 功能 | 说明 |
|------|------|
| **列出 & 筛选** | 按项目、状态、时间范围、来源信息、model provider 和 model 筛选；按项目分组 |
| **来源汇总** | 只读汇总 `sourceKind`，同时保留 raw `source`、`thread_source`、`model_provider`、`model` 和 `agent_role` |
| **标题来源拆分** | 列表默认显示 Codex UI 可搜标题；详情显示 `session_index`、SQLite 和首条请求的标题差异 |
| **导出** | 删之前生成 JSON 恢复包；UTF-8 文件以文本保存，压缩或二进制文件以 base64 保存，并附带相关索引、global-state、snapshot 和 SQLite 行 |
| **删除** | 永久删除或放入回收站，你选 |
| **残留审计** | 只读报告原始 rollout 文件、shell snapshot、session_index、history、SQLite、global-state、thread edges、family 状态和断裂 parent/child 关系 |
| **Root 残留扫描** | 不需要先知道 session ID，直接只读扫描整个 root 的疑似残留 |
| **Root 删除预览** | 对 root 残留候选做只读批量 delete preview，不需要手工列 session ID |
| **每月残留检查** | 一份范围受限、完全只读的 root 审计与预览合并报告；只有显式传入 `--details` 才展开 warning 详情 |
| **Codex SQLite 结构** | 按 `config.toml sqlite_home` / `CODEX_SQLITE_HOME` / root fallback 顺序解析；精确 thread-linked logs 跟随永久删除与 purge 生命周期，`memories_N.sqlite` 始终只读。 |
| **回收站 & 恢复** | 完整快照保存；`.jsonl.zst` 会话文件按二进制安全保存；恢复时检查 SQLite 主键冲突 |
| **验证** | 报告当前版本支持的文件、索引行和数据库记录是否仍有残留 |
| **清理索引** | 移除失效索引条目，不动原始数据 |
| **健康检查** | `doctor` 默认返回有限的 root 健康摘要；`--details` 才展开完整引用数组 |
| **MCP 服务** | AI Agent 获取有限的审计、验证、恢复和显式批准的清理操作 |
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

MCP `get_session` 有固定上限：`compact` 最多 20 items / 64 KiB，并且最多读取 1 MiB rollout 源文件；`full` 最多 200 items / 256 KiB，并且最多读取 8 MiB。session metadata 同样受限。两种模式都会返回 `completeness`、底层 `sourceCompleteness`、已返回/已知数量、metadata 截断、省略原因和是否可精确导出。读取上限先于文件结尾触发时，`itemsKnown` 会返回 `null`，不会给出伪完整总数；工具输出截断也会标成 `truncated_limit`。需要全部本地可解析 semantic items 时用 `codex-sessions show <id> --json`；需要可恢复的完整源文件表示时用 `export`，其中 UTF-8 内容直接进入 JSON，压缩或二进制内容使用 base64。

MCP `list_sessions` 只返回精简记录，默认最多 50 个 session，参数上限为 200，整个结构化结果最多 256 KiB。`totalMatches`、`sessionsReturned`、`hasMore`、`byteLimited` 和 `omittedReason` 会明确说明省略情况。需要完整结果集或完整 session metadata 时用 `codex-sessions list --json`。

**当前版本在 Windows 上仍只允许只读操作。** 删除、移入回收站、恢复、永久清除、索引清理和中断恢复都会直接拒绝。待真实 Windows 环境完成 junction/reparse point、大小写和异常退出测试后，才会重新开放写操作。Windows 上即使请求 MCP `admin` profile，也只注册只读工具。

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

v0.6.0 把 MCP 默认 profile 从 20 个工具缩减为 15 个。恢复支持把两个 profile 增至 16 和 22 个工具。0.7.0 用有界 canonical event reader 替换无界的 `export_session_backup`，因此两个 profile 仍是 16 和 22 个工具；精确导出只走 CLI。需要写操作时添加 `--profile admin`，但仍然必须明确确认。

所有 MCP structured response 最后都经过统一的 256 KiB 和“每个集合最多 200 项”限制。触及限制时会返回 `responseCompleteness=truncated_limit` 与 `responseOmittedReason`；已经提交的写操作状态仍保留在原来的 `result` 内。显式 session 操作最多接收 50 个 ID；`list_trash` 默认返回 50 项，最大 200 项。完整本地结果请使用 CLI JSON 或文件输出。

仅凭 `memories_N.sqlite` 存在不能证明 memory 已启用，因此 `doctor` 在没有可靠官方信号时返回 `enabled=unknown`。session 的 `memory_mode` 只有精确的 `enabled`/`disabled` 才映射为布尔值；缺失值和未来新值保留为 `unknown`。当前 Stage 1 的选中标记也不能证明最终 Phase 2 provenance；无法确认时只返回 `unknown`，不猜成 `known` 或 `none`。普通 session 删除仍会保留全部 memory surface。

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
codex-sessions doctor [--json] [--details]
codex-sessions show <session-id> [--json]
codex-sessions events <完整-session-id> [--output ./session-events.jsonl]
codex-sessions family <session-id> [--json] [--children|--parents|--subagents|--impact] [--full] [--source-kind KIND]
codex-sessions audit <session-id> [--json]
codex-sessions audit-root [--json] [--limit 50] [--status STATUS...] [--source SOURCE...] [--all]
codex-sessions preview-root [--json] [--limit 50] [--status STATUS...] [--source SOURCE...] [--all]
codex-sessions monthly-review [--json] [--details] [--limit 50] [--status STATUS...] [--source SOURCE...] [--all]
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

兼容检查以 [compat baseline](https://github.com/1939869736luosi/codex-sessions-manager/tree/main/compat) 为准：旧式和 paginated timeline 都有合成 fixture；`.jsonl.zst` 只剩压缩文件时明确报告 `compressed_unread`；确认永久删除只处理精确 thread-linked logs，`memories_N.sqlite`、external agent imports 和 remote-control 继续只做观察。

官方 Codex 删除后，如果想知道本机还剩什么，先用 `audit`。它只读，不会改文件。它会报告原始 rollout 文件、shell snapshot、`session_index`、`history`、SQLite 记录、已知 global-state 引用、白名单 exact-key global-state 引用、未知 global-state 引用、`thread_spawn_edges` 是否还在，也会报告 family 归属和断裂 parent/child 关系。如果仍有残留，建议命令只会给不带 `--yes` 的删除预览；只有你自己加 `--yes` 才会真的删除。

官方归档后，同一命令只用于查看本机保存了什么。归档的 rollout 和索引本来就应该保留，不能仅因为它们存在就当成残留或清理候选。

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

`list` 支持同一套来源筛选：`--source-kind`、`--source`、`--thread-source`、`--agent-role`、`--agent-nickname`、`--model-provider`、`--model`。不同字段之间是 AND；同一个字段写多次是 OR。MCP `list_sessions` 支持同名参数，但只返回受限的精简结果（默认 50、最大 200、总响应 256 KiB）；完整本地列表使用 CLI JSON。MCP `summarize_sources` 返回和 CLI `sources --json` 相同结构的摘要。

来源字段的边界：

- `source=vscode` 只是 Codex thread 的原始来源标签，不能直接等同 VS Code IDE。
- 不能用排除法判断剩下的是 Desktop。没有标成 `cli`、`mcp`、`vscode` 或 `exec` 的会话是 `unknown`，不是自动归为 Desktop。
- `source=mcp` 表示这个 thread 的来源是 mcp，不是每一次 MCP 工具调用日志。
- `model_provider` 这里只做显示和筛选，不修复 provider 身份，也不改写历史。

如果想对 `audit-root` 选出的候选做批量删除预览，用 `preview-root`。它复用同一套 `status/source` 筛选和保守默认 `--limit 50`，汇总展示 rollout 文件、压缩 `.jsonl.zst` 文件、shell snapshots、索引、精确 thread-linked SQLite 行（包含 dedicated logs）、global-state 引用和 family edges。Memory 永远不是删除面。它只读，不接受 `--yes`，不会建议删除任何 session，也不会自动递归加入亲属 session。真正删除仍必须回到单独的明确 ID 预览与确认。

每月定期检查使用 `monthly-review`。它把 `audit-root` 和 `preview-root` 合并为一份只读报告，默认最多返回 5 条 warning 样本，只有传入 `--details` 才展开更多详情。它给出的下一步只包含逐 session 的只读审计，绝不生成确认删除命令。

如果已经有明确 session ID，并且想在任何删除预览或写操作前先做更安全的关系感知计划，用 `plan-delete`。它只读，JSON 里会标明 `readOnly: true` 和 `executionSupported: false`，也可通过只读 MCP `plan_delete_sessions` 调用。默认只选择 seed IDs。相关 parent、child、subagent、descendant、family member，以及 `/side`/`/fork` 这类 ambiguous session，会出现在 `availableIncludes` 或 warning 里。`--include-children`、`--include-subagents`、`--include-descendants` 和 `--include-family` 只改变 `selectedIds`，不会执行删除；其中 `--include-family` 风险最高，会给出强提醒。exact-key global-state 只显示 path、rule、shape 和 byteEstimate 元数据；unknown global-state 仍然只是 warning-only。

root-level source 候选使用保守形式：`plan-delete --source-kind subagent --limit 20 [--status archived] [--json]`。`--source-kind` 可重复，OR 语义；`--status` 也可重复，OR 语义。`--limit` 必填，最大 50。root-level `sourceKind=unknown` 会被拒绝；unknown 会话必须用 explicit session ID 人工复核。这个模式只写 `candidateIds`，绝不写 `selectedIds`，active/current 命中会留在 `rejectedIds`。它只是候选列表：`sourceKind` 是筛选维度，不是删除授权。`mcp` 只表示 thread source，不代表每次 MCP tool call；`vscode` 是 Codex 原始标签，不等同 VS Code IDE；`exec` 不代表执行日志可安全批量删除。本版本故意不支持 sourceKind candidate plan 的 `--write-plan`。

MCP `plan_delete_sessions` 支持同样的 sourceKind candidate 语义：传 `sourceKind`、必填 `limit` 和可选 `status`；`selectedIds` 保持为空，命中只进入 `candidateIds`；root-level `unknown` 拒绝，active/current 命中进入 `rejectedIds`。MCP 不支持 `writePlan`，不会生成 preview token，也不能执行删除。

`plan-delete --write-plan FILE` 会写出稳定的 `codex-sessions-delete-plan.v1` JSON 审计文件。文件包含 `scanTimestamp`、`planHash`、root fingerprint、selected surface counts、family edges 和 exact-key global-state paths。它不能包含 transcript 正文、prompt text 或完整 global-state values；exact-key global-state 条目只限 path/rule/shape/byteEstimate 元数据。plan file 只是审计材料，不是授权、不是 preview token、不是删除确认，也不能传给任何删除执行命令。

`preview-plan <plan-file>` 会只读重扫 root，并把 plan 和当前状态做比较。它检查 root realpath、SQLite home realpath/source、`session_index`、`history`、`.codex-global-state.json`、state/log/goals/memories SQLite 的 mtime/size/parseability、selected surface counts、family edges 和 exact-key paths。selected surface counts 会包含已选 session 的压缩 `.jsonl.zst` rollout 文件。只要已覆盖的 fingerprint 有差异，就返回 `stale=true`，并且不产生当前 delete preview，避免把旧 plan 当成当前预览。`preview-plan` 不接受 `--yes`、`--trash`、`--force` 或任何删除执行模式。

MCP `preview_delete_plan` 接收 `planFile` 或 inline `plan` object，并复用同一套 stale detection。它只读，不接受 `confirm`、`trash`、`yes` 或 `force`；当 `stale=true` 时不会返回当前 `deletePreview`。

当前设计上不支持 delete-by-plan、preview token、`--force`、sourceKind-based delete execution，或高级 family/sourceKind 自动删除编排。真正删除仍然必须回到单独的明确 ID delete preview，并在人工确认后显式执行。

### 白名单 exact-key global-state 清理

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

source metadata compatibility layer 补充了稳定的 `sourceKind` 粗粒度兼容分类（`subagent`、`mcp`、`vscode`、`cli`、`exec`、`unknown`）。JSON 输出还可能包含 `sourceInfo`，记录 raw `source`、raw `thread_source`、可可靠派生时的官方 Codex v2 source-kind metadata、thread-source analytics metadata 和简明 evidence。这只用于观测：不改变 filters、delete preview、plan-delete selection、MCP planning 或删除授权。尤其是内部 raw `mcp`、raw `appServer` 或 raw `app-server` 会报告为稳定 `sourceKind=mcp` 和官方 metadata `appServer`；它不是 individual MCP tool-call 的证明。

## 标题怎么看

Codex 本地会话可能同时有多个标题：

- `displayTitle`：默认展示标题，优先来自 `session_index.jsonl.thread_name`，更接近 Codex UI 里能搜到的标题。
- `indexTitle`：`session_index.jsonl` 里的标题。
- `sqliteTitle`：`state_N.sqlite` 的 `threads.title`，可能是旧的内部长标题。
- `firstUserMessage`：第一条用户请求。
- `titleSource`：当前展示标题来自哪里。
- `titleMismatch`：这些来源是否出现不一致。
- `titleCandidates`：所有候选标题。

`list` 和搜索结果默认显示 `displayTitle`。人类可读的 `show` 会用短摘要列出 `sqliteTitle`、`firstUserMessage`、所有候选标题和时间线预览，方便确认标题分裂问题，同时避免刷出大段正文。需要本机能够解析的全部 semantic items 时用 `show --json`；未知类型、parse error、压缩源不可读和单项工具输出截断仍会通过 completeness 字段如实标记。

## Codex 存了什么（我们清理什么）

Codex 0.144.1 的官方删除会处理持久化 thread、spawned descendants、rollout 文件和大量关联状态。本项目不会在没有检查的情况下断言旧版、损坏、延迟整理或未知位置已经干净。`audit-root` 先找疑似残留 ID，`preview-root` 批量预览候选，`audit` 检查单个 ID，`verify` 记录当前版本支持的复查范围。只有确认还存在需要本地处理的残留时，才使用 `delete --trash --yes` 或 `cleanup-index --yes`。

```
~/.codex/
├── sessions/            ← 原始 rollout .jsonl/.jsonl.zst 文件       ✅ 清理
├── archived_sessions/   ← 归档 rollout .jsonl/.jsonl.zst 文件       ✅ 清理
├── shell_snapshots/     ← shell 快照脚本                ✅ 清理
├── session_index.jsonl  ← 会话元数据索引                ✅ 清理
├── history.jsonl        ← 对话历史索引                  ✅ 清理
├── state_N.sqlite       ← threads 和相关记录            ✅ 清理
├── goals_N.sqlite       ← 拆分出的 thread goals         ✅ 清理
├── logs_N.sqlite        ← 精确 thread-linked logs 跟随永久删除/purge，trash 期间保留
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
