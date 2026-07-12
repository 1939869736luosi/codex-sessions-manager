# CSM CLI-First Universal Architecture Refactor v0.6.0

> **Archived:** implementation completed. This document is historical evidence, not the current roadmap. See `ROADMAP.md` for active work.

> **Oracle Review Status**: Reviewed. All feedback integrated (rev4, 2026-06-27).
> rev2 → rev3 (2026-05-27): 从"不做任何生态特有适配"改为"核心不站队 + 各生态薄适配文档/配置"。
> rev3 → rev4 (2026-06-27): 更新 base version 为 0.5.2，同步项目定位变化，新增前置依赖和进度追踪。
> rev4 → rev5 (2026-06-27): 实现全部完成并推送（`a5a333d`/`85ac0cb`/`62da801`）。进度表标记完成；记录 post-review 修复（examples 死链、防漂移 guard 测试、read-only 行为测试）。仅剩 npm publish 待用户手动执行。

## 目标

将 codex-sessions-manager 从 MCP-first 转为 CLI-first 架构。

- **核心**：通用 CLI + 保守 read-only MCP 层，不绑定任何平台。
- **Skill**：遵循 Agent Skills 开放标准，作为通用 skill 入口。
- **MCP**：降级为 optional/advanced，增加 `--profile` 支持，默认 read-only。
- **薄适配**：为主流 AI agent 生态（Amp / Claude Code / Codex / Cursor / Factory Droid）各提供轻量配置示例和接入说明，但核心不知道自己跑在哪个宿主里。

> v0.6.0 保持通用 CLI-first。Amp 的 skill-bundled mcp.json 可以作为一个可选适配器，但不是主架构。Codex、Claude Code、Cursor、Factory Droid 等平台应通过各自的薄适配文档接入。核心接口仍是 CLI，MCP 只作为保守只读辅助面。

## 前置依赖与进度

### 前置依赖

| 依赖 | 状态 | 说明 |
|---|---|---|
| T9/0.5.2 发布 | ✅ git 已发布 | `3282e40`，tag `v0.5.2` 已推送；npm publish 待用户手动执行 |
| 0.5.2 作为 base | ✅ 已解除 | v0.6.0 基于 0.5.2 构建，commit 链完整 |

### 执行进度

| 步骤 | 状态 | commit |
|---|---|---|
| **Session 1: 代码 + 测试** | | |
| 1. `src/mcp/server.ts` --profile 实现 | ✅ 完成 | `a5a333d` |
| 2. 测试 MCP profile 验收 | ✅ 完成 | `a5a333d` |
| **Session 2: 文档 + adapters + 发版** | | |
| 3. 创建 `skills/` 自包含目录 | ✅ 完成 | `85ac0cb` |
| 4. `SKILL_DETAIL.md` 从 SKILL.md 拆出 | ✅ 完成 | `85ac0cb` |
| 5. `SKILL.md` 重写精简版（90 行） | ✅ 完成 | `85ac0cb` |
| 6. `examples/` 同步精简 | ✅ 完成 | `85ac0cb` |
| 7. `adapters/` 5 个生态薄适配 | ✅ 完成 | `85ac0cb` |
| 8. README + README.zh-CN 重构 | ✅ 完成 | `85ac0cb` |
| 9. CHANGELOG migration note | ✅ 完成 | `85ac0cb` |
| 10. package.json files + version bump 0.6.0 | ✅ 完成 | `85ac0cb` |
| 11. npm pack 验证 | ✅ 完成 | — |
| 12. 全量验收 checklist | ✅ 完成 | — |
| **Post-review 修复（5 步 review 发现）** | | |
| 13. 修 root SKILL.md 死链 + amp includeTools | ✅ 完成 | `62da801` |
| 14. examples/ 死链指向 skills/ 规范路径 | ✅ 完成 | `6d5ca26` |
| 15. 加防漂移 guard 测试（root==skills 三类文档字节一致） | ✅ 完成 | `6d5ca26` |
| 16. 加 read-only callTool 被拒行为测试 | ✅ 完成 | `6d5ca26` |
| 17. 修 `--profile` 缺值静默降级 bug + 测试 | ✅ 完成 | `a9055d6` |
| 18. admin block 缩进修正 | ✅ 完成 | `a9055d6` |

**实际状态**: 代码 + 文档全部完成，205 测试通过。tag `v0.6.0` 已重打到 `a9055d6`。
**当前阻塞**: 仅剩 npm publish。需用户 `npm login` 后先发 0.5.2 再发 0.6.0。

### 产品定位更新（rev4）

自 rev3 以来，项目定位已从"session manager"进一步明确为：

> CSM 是官方 Codex 的**本地历史审计与残留验证工具**，不是官方 UI 的替代品。
> 它帮助高级用户确认 ~/.codex 到底还剩什么，并在明确确认下做小批量、安全、可验证的清理。

此定位变化影响 Change 4（README 重构）的措辞，但不改变架构决策。

## 背景

### 问题

1. **Context bloat**: 20 个 MCP tool schema 在每个 turn 都占位（~8-12K tokens），即使用户没有 session 管理需求
2. **MCP-first 架构多余**: MCP server (785 行) 本质是 CLI 的翻译层，调用同一套 core 逻辑，没有增加 CLI 做不到的能力
3. **Tool selection noise**: 20 个相似命名的 tools（audit_session / audit_root / preview_root_delete / plan_delete_sessions...）增加 LLM 选错 tool 的概率
4. **Context compression 提前触发**: 静态 schema 填满 context window，长对话更早丢失关键信息
5. **SKILL.md 过长**: 390 行全部注入 prompt，违背 progressive disclosure 原则
6. **生态碎片化**: MCP 配置路径各生态不同，维护成本高

### 参考文献

- [Factory Deferred Context Engine](https://factory.ai/news/deferred-context-engine) — 只有 5.4% session 实际执行 MCP tool；100+ hidden tools 时 token 节省 50.8%
- [Amp Owner's Manual #MCP](https://ampcode.com/manual#mcp) — Skills bundled MCP、Toolbox、progressive disclosure
- [Amp: Efficient MCP Tool Loading](https://ampcode.com/news/lazy-load-mcp-with-skills) — MCP in Skills 的具体实现
- [Claude Code Skills Docs](https://code.claude.com/docs/en/skills) — Agent Skills 开放标准、Skill 生命周期、body 按需加载
- [Claude Code Plugins Docs](https://code.claude.com/docs/en/plugins) — Plugin 支持 `.mcp.json` 捆绑

### 主流 AI agent 生态差异

| 平台 | 主要机制 | 对 CSM 的启发 |
|---|---|---|
| **Amp** | `.agents/skills/`、skill 内 `mcp.json` deferred loading、toolbox、plugins | 提供 Amp skill + mcp.json 作为一个薄适配器 |
| **Claude Code** | `CLAUDE.md`、Skills、Subagents、MCP、Plugins (`.mcp.json`)、Hooks | Skill 和 MCP 分工：Skill 教怎么用，MCP 提供工具 |
| **OpenAI Codex** | `AGENTS.md`、CLI-first、MCP config、Skills、Subagents、slash commands | CSM 保持 CLI-first，适合 AGENTS.md/Skill/命令模板 |
| **Cursor** | `.cursor/mcp.json`、global MCP、Marketplace、Extension API、Rules | 提供 Cursor MCP config 示例 |
| **Factory Droid** | `AGENTS.md`、Skills、Plugins、MCP、Missions、Custom Droids、Deferred Context Engine | 证明 deferred context 是趋势，各家实现不同 |

### 各生态 MCP-in-Skill 支持情况

| 生态 | 在哪里捆绑 MCP | 配置文件 | 复杂度 |
|---|---|---|---|
| **Amp** | Skill 目录 | `mcp.json`（与 SKILL.md 同级） | 轻量 |
| **Claude Code** | **Plugin** 根目录（非 Skill） | `.mcp.json` | 较重（需完整 `.claude-plugin/plugin.json` 清单） |
| **Claude Code Skill alone** | 不支持 | — | — |
| **Codex / Cursor / Droid** | 各自独立 MCP 配置 | 各异 | 需逐生态配置 |

结论：没有跨生态通用的 MCP-in-Skill 机制。CLI 是唯一真正普适的接口。各生态通过薄适配（配置片段 + 接入说明）接入 CSM，核心不绑定任何平台。

### 决策记录

| 决策点 | 结论 | 理由 |
|---|---|---|
| MCP-first vs CLI-first | CLI-first | CLI 零适配成本，所有 agent 都能执行 shell |
| 非 Amp 生态的 MCP 处理 | 保留二进制，标记 advanced/optional | 不强制删除功能，但降低默认曝光 |
| Profile 分层 | 两档：read-only (默认) + admin | 安全边界清晰（不改数据 vs 改数据），比五档简单 |
| export_session_backup 归属 | read-only | 不改 session 数据，是安全备份操作 |
| SKILL.md 瘦身 | ~80-100 行，详细规则用引用子文件 | progressive disclosure，减少 context 占用 |
| 生态适配策略 | **核心不站队 + 各生态薄适配** | CSM 用户是"需要治理 Codex sessions 的人和 agent"，不是某个宿主的用户 |
| Amp mcp.json | **做，作为 adapter 示例** | rev2 决定不做 → rev3 改为做。成本 <10 行，作为 adapters/ 中的一个，不代表架构 |
| Claude Code Plugin | **不做** | 过重，需完整 `.claude-plugin/plugin.json` 清单，投入产出不匹配 |
| --profile 无效值处理 | **硬错误退出** | Oracle review: 静默降级是安全隐患 |
| v0.6.0 breaking 定性 | **deliberate MCP exposure change** | Oracle review: 20→15 默认 tools 对 MCP 用户是行为变化 |

## 架构

```
用户 / AI Agent
    │
    ├─ [通用] CLI: codex-sessions ────────────────┐
    │                                              │
    ├─ [通用] SKILL.md (教 agent 用 CLI) ──────────┤
    │                                              ▼
    ├─ [可选] MCP: codex-sessions-mcp ──────► src/core/*
    │         │
    │         ├─ 默认: read-only (15 tools)
    │         └─ --profile admin: all 20 tools
    │
    └─ [薄适配] adapters/
              ├─ amp/          ← mcp.json + 使用说明
              ├─ claude-code/  ← skill layout + MCP config 示例
              ├─ codex/        ← AGENTS.md snippet + 命令模板
              ├─ cursor/       ← .cursor/mcp.json 示例
              └─ factory-droid/ ← skills/missions 接入说明
```

核心原则：**CSM 的用户是"需要治理 Codex sessions 的人和 agent"，不是某个宿主的用户。** 核心不知道自己跑在哪个平台。各平台通过 adapters/ 里的薄适配接入。

### 用户使用方式

**所有生态通用（CLI）：**
```bash
npm install -g codex-sessions-manager
codex-sessions list --limit 10   # 立即可用，任何 agent 都能 shell 调用
```

**Claude Code / Amp 用户（加 Skill）：**
```bash
# 复制整个 skill 目录，不是单个文件，否则引用会断
mkdir -p ~/.claude/skills/codex-sessions-manager
cp -r skills/codex-sessions-manager/* ~/.claude/skills/codex-sessions-manager/
```

**各生态进阶适配：**
```bash
# 参考 adapters/ 下对应生态的说明
ls adapters/amp/          # Amp: mcp.json deferred loading
ls adapters/claude-code/  # Claude Code: skill layout + MCP config
ls adapters/codex/        # Codex: AGENTS.md + slash commands
ls adapters/cursor/       # Cursor: .cursor/mcp.json
ls adapters/factory-droid/ # Factory Droid: skills + missions
```

### Skill 包结构（自包含目录）

```
skills/codex-sessions-manager/
  SKILL.md                  ← 精简路由（~80-100 行）
  docs/
    SKILL_DETAIL.md         ← 完整参数和规则引用
    SAFETY.md               ← 安全模型文档
```

> **Oracle fix**: SKILL.md 引用 `docs/SKILL_DETAIL.md` 等子文件时，这些文件必须在同一 skill 目录下。
> 如果用户只复制 SKILL.md 而不复制 docs/，引用会断。
> npm package 的 `files` 字段也需要包含完整 skill 目录。

## 变更清单

### Change 1: MCP Server 增加 `--profile` 支持

**文件**: `src/mcp/server.ts`

通过 `process.argv` 解析 `--profile` 参数（不引入新依赖）：

- `codex-sessions-mcp` 或 `codex-sessions-mcp --profile read-only` → 只注册 15 个 read-only tools
- `codex-sessions-mcp --profile admin` → 注册全部 20 个 tools

**read-only profile (15 tools，默认)**:

1. `inspect_root`
2. `list_sessions`
3. `summarize_sources`
4. `list_projects`
5. `get_session`
6. `get_session_family`
7. `audit_session`
8. `audit_root`
9. `preview_root_delete`
10. `export_session_backup`
11. `preview_delete_sessions`
12. `plan_delete_sessions`
13. `preview_delete_plan`
14. `verify_sessions`
15. `list_trash`

**admin-only (额外 5 个)**:

16. `delete_sessions`
17. `restore_sessions`
18. `purge_trash`
19. `cleanup_session_indexes`
20. `cleanup_stale_indexes`

**实现方式**:

```typescript
const VALID_PROFILES = ["read-only", "admin"] as const;
type Profile = (typeof VALID_PROFILES)[number];

const ADMIN_ONLY_TOOLS = new Set([
  "delete_sessions",
  "restore_sessions",
  "purge_trash",
  "cleanup_session_indexes",
  "cleanup_stale_indexes",
]);

function parseProfile(): Profile {
  const idx = process.argv.indexOf("--profile");
  if (idx === -1 || idx + 1 >= process.argv.length) return "read-only";
  const val = process.argv[idx + 1];
  if (!VALID_PROFILES.includes(val as Profile)) {
    process.stderr.write(
      `Error: invalid --profile value "${val}". Valid values: ${VALID_PROFILES.join(", ")}\n`
    );
    process.exit(1);
  }
  return val as Profile;
}

const profile = parseProfile();

// 在每个 admin tool 注册前检查：
// if (profile === "admin") { server.tool(...) }
```

> **Oracle fix**: 无效 `--profile` 值（如 `--profile adminn`）必须硬错误退出（非零 exit code），
> 不能静默降级为 read-only。静默降级是安全隐患：用户以为启用了 admin 但实际没有。

### Change 2: SKILL.md 瘦身（390 行 → ~80-100 行）

**文件**: `SKILL.md`

精简后结构：

```markdown
---
name: codex-sessions-manager
description: Use this skill when the user wants to inspect, search, export, verify,
  clean up, delete, restore, or purge local Codex sessions stored under ~/.codex.
---

# Codex Sessions Manager

## Overview (~5 行)
CLI-first 本地 Codex session 审计和清理工具。

## Setup (~10 行)
npm install -g codex-sessions-manager
codex-sessions --version

## When To Use (~10 行)
触发场景列表（list / show / audit / family / delete / restore / verify ...）

## CLI Quick Reference (~25 行)
核心命令 + 常用参数，不展开全部参数。

## Safety Rules (~10 行)
- 所有破坏性命令需 --yes，否则只有 preview
- preview / plan-delete / family / impact 是只读，不是删除授权
- 删除不自动递归到 parent/child，需显式列出每个 session ID

## MCP (Optional) (~5 行)
codex-sessions-mcp [--profile read-only|admin]
默认 read-only，admin 需显式启用。

## Detailed References (~5 行)
- See [detailed rules](docs/SKILL_DETAIL.md) for full CLI/MCP parameter reference
- See [safety guide](docs/SAFETY.md) for delete/trash/restore safety model
```

核心原则：**SKILL.md 只做路由** — 告诉 agent "什么场景用什么 CLI 命令"。

### Change 3: 创建 Skill 详情引用文件

**文件**: `docs/SKILL_DETAIL.md`（新建）

从 SKILL.md 移出的内容：

- 完整 CLI 参数说明（list 的所有 filter 参数、family 的所有 mode、audit-root 的所有 status/source 过滤器）
- P11 exact-key 规则（prompt-history / heartbeat-thread-permissions-by-id）
- preview/delete 的详细安全规则
- sourceKind 限制说明（source=vscode 不代表 VS Code IDE、source=mcp 不代表每次 MCP 调用）
- family 模式详细行为（children / parents / subagents / impact / full）
- plan-delete 完整语义（selectedIds / candidateIds / rejectedIds / sourceKind 候选模式）
- plan-file 格式和 preview-plan stale 检测
- trash 重复条目处理规则
- session title 规则（displayTitle / indexTitle / sqliteTitle / firstUserMessage）
- MCP tools 完整参数说明
- T7-P3 / T8-P2 等版本特性说明

### Change 4: README 文档重构

**文件**: `README.md`, `README.zh-CN.md`

改动点：

1. Quick Start 保持 CLI 在前（已经是）
2. 重写 "Use with AI Agents (MCP)" 为 "Use with AI Agents"：
   - 第一优先：**CLI** — 所有生态通用，agent 直接 shell 调用
   - 第二优先：**Skill** — 放到 `~/.claude/skills/codex-sessions-manager/` 即可覆盖 Claude Code + Amp
   - 第三优先：**MCP (Advanced/Optional)** — 适合需要结构化 JSON 响应的场景
   - 第四：**各生态薄适配** — 指向 `adapters/` 目录
3. 新增 MCP Profile 段落：说明默认 read-only，admin 需显式 `--profile admin`
4. 新增 Adapters 段落：简要列出 5 个生态 + 指向 `adapters/<platform>/README.md`
5. 不再在显眼位置推荐全局 MCP 配置
6. 新增 Migration Note：MCP 默认从 20 tools 变为 15 tools，需 `--profile admin` 恢复全部

### Change 5: examples/ 更新

**文件**: `examples/codex-sessions-manager.SKILL.md`

同步精简，与主 SKILL.md 保持一致。

### Change 6: 创建 adapters/ 薄适配目录

**目录**: `adapters/`（新建）

各生态的薄适配，只包含配置片段和接入说明，不包含代码。

#### `adapters/amp/`

```
adapters/amp/
  README.md           ← Amp 接入说明
  mcp.json            ← Amp Skill-bundled MCP deferred loading 配置
```

**`mcp.json` 内容**（<10 行）：
```json
{
  "codex-sessions": {
    "command": "codex-sessions-mcp",
    "args": ["--profile", "read-only"],
    "includeTools": [
      "inspect_root", "list_sessions", "summarize_sources",
      "list_projects", "get_session", "get_session_family",
      "audit_session", "audit_root", "preview_root_delete",
      "export_session_backup", "preview_delete_sessions",
      "plan_delete_sessions", "preview_delete_plan",
      "verify_sessions", "list_trash"
    ]
  }
}
```

**`README.md` 内容**：安装说明 + 如何把 mcp.json 和 SKILL.md 放到 `.agents/skills/codex-sessions-manager/`。

#### `adapters/claude-code/`

```
adapters/claude-code/
  README.md           ← Claude Code 接入说明
```

内容：
- Skill 安装路径：`~/.claude/skills/codex-sessions-manager/`
- MCP 配置示例（`.claude/mcp.json`）
- Plugin 说明：v0.6.0 不提供完整 Plugin 包，因为需要 `.claude-plugin/plugin.json` 清单，投入产出不匹配。如需 deferred MCP loading，等 Claude Code Skill 原生支持 MCP bundling。

#### `adapters/codex/`

```
adapters/codex/
  README.md           ← OpenAI Codex 接入说明
```

内容：
- AGENTS.md 推荐片段（教 Codex agent 使用 `codex-sessions` CLI）
- MCP 配置示例
- Slash command / prompt 模板示例

#### `adapters/cursor/`

```
adapters/cursor/
  README.md           ← Cursor 接入说明
  mcp.json.example    ← .cursor/mcp.json 配置示例
```

#### `adapters/factory-droid/`

```
adapters/factory-droid/
  README.md           ← Factory Droid 接入说明
```

内容：
- `droid mcp add` 命令示例
- Skills / Missions 接入说明
- AGENTS.md 推荐片段

## 不做的事情

- 不删除 MCP server 代码
- 不减少 MCP tool 总数（仍是 20 个，通过 profile 控制暴露面）
- 不引入新的 npm 依赖
- 不改变 `src/core/` 层任何逻辑
- 不改变 CLI 任何行为
- 不做 Claude Code Plugin（过重）
- 不改 `package.json` 的 `bin` 入口

## 明确排除出 v0.6.0 的内容

> **Oracle review**: 以下内容不应混入 CLI-first 架构重构，应另开独立 spec/ticket。

- logs-only inventory / sensitivity / retention policy（只读日志盘点、敏感性评估、保留策略）
- byte-forensic audit（字节级取证审计）
- SQLite VACUUM / WAL checkpoint
- trash manifest corrupt purge
- permissions hardening
- exact destructive ID enforcement
- active session refusal
- post-delete validation shape change
- symlink/realpath hardening
- delete-by-plan execution
- preview token binding
- sourceKind-based delete execution
- automatic family/side/subagent recursive deletion

## 验收标准

> **Oracle review**: spec 必须包含可执行的验收标准。

### MCP profile 验收

- [x] `codex-sessions-mcp` 无参数 → 默认 read-only，注册 15 个 tools
- [x] `codex-sessions-mcp --profile read-only` → 注册 15 个 tools
- [x] `codex-sessions-mcp --profile admin` → 注册全部 20 个 tools
- [x] read-only profile 不暴露 `delete_sessions` / `restore_sessions` / `purge_trash` / `cleanup_session_indexes` / `cleanup_stale_indexes`
- [x] `codex-sessions-mcp --profile invalid` → 非零退出，stderr 输出错误信息
- [x] `codex-sessions-mcp --profile`（缺值） → 非零退出，stderr 输出错误信息
- [x] `codex-sessions-mcp --version` → 输出版本号，不启动 MCP stdio server

### Skill 包验收

- [x] skill 目录自包含：`SKILL.md` + `docs/SKILL_DETAIL.md` + `docs/SAFETY.md` 在同一目录下
- [x] SKILL.md 精简到 ~80-100 行（实际 90 行）
- [x] SKILL.md 中对 `docs/` 的引用路径正确（相对路径）
- [x] `npm pack --dry-run` 输出包含完整 skill 目录和 adapters 目录内容
- [x] README 不能说"全局 MCP 是推荐方式"

### Adapters 验收

- [x] `adapters/amp/mcp.json` 存在且只使用 `--profile read-only`
- [x] `adapters/amp/mcp.json` 的 `includeTools` 不包含任何 admin-only tool
- [x] `adapters/amp/README.md` 说明安装步骤
- [x] `adapters/claude-code/README.md` 包含 skill 安装路径和 MCP 配置示例
- [x] `adapters/codex/README.md` 包含 AGENTS.md 推荐片段
- [x] `adapters/cursor/README.md` 包含 `.cursor/mcp.json` 配置示例
- [x] `adapters/factory-droid/README.md` 包含 `droid mcp add` 示例
- [x] 所有 adapter README 不能暗示该生态是 CSM 的主架构

### docs 安全语义验收

- [x] 文档明确说明 `verify` 是 logical live-surface verification，不是 byte-forensic cleanup
- [x] 文档明确说明 `verify` 不检查：SQLite WAL、SQLite free pages、app/terminal logs、backups、exports、trash bundles、filesystem slack
- [x] 文档明确说明 logs-only residue 不属于普通 delete 语义
- [x] 文档明确说明 rollback 是 best-effort，不是 crash-safe transaction

### Migration 验收

- [x] CHANGELOG 包含 deliberate MCP exposure change 说明
- [x] README 包含 migration note：MCP 默认从 20 tools 变为 15 tools（read-only profile）
- [x] 现有 MCP 用户升级后如需全部 tools，文档指引使用 `--profile admin`

## 实施顺序

### 前提：T9/0.5.2 先发布

v0.6.0 基于 0.5.2。在 0.5.2 发布前可以并行开发 --profile 和文档，但 npm publish 0.6.0 必须等 0.5.2 先落地。

### Session 1: 代码 + 测试（可在 0.5.2 发布前开始）

1. `src/mcp/server.ts` — 增加 `--profile` 解析（含无效值硬错误）+ tool 条件注册
2. 测试：验证上述 MCP profile 验收标准全部通过

### Session 2: 文档 + adapters + 发版（建议在 0.5.2 发布后执行）

3. 创建 `skills/codex-sessions-manager/` 自包含目录结构
4. `skills/codex-sessions-manager/docs/SKILL_DETAIL.md` — 从 SKILL.md 拆出详细规则（新建）
5. `skills/codex-sessions-manager/SKILL.md` — 重写精简版（~80-100 行）
6. `examples/codex-sessions-manager.SKILL.md` — 同步精简
7. 创建 `adapters/` 目录和全部 5 个生态的薄适配：
   - `adapters/amp/` — README.md + mcp.json
   - `adapters/claude-code/` — README.md
   - `adapters/codex/` — README.md
   - `adapters/cursor/` — README.md + mcp.json.example
   - `adapters/factory-droid/` — README.md
8. `README.md` + `README.zh-CN.md` — 文档重构 + migration note + adapters 说明 + 新定位措辞
9. `CHANGELOG.md` — deliberate MCP exposure change 说明
10. `package.json` — `files` 字段更新（包含 skill 目录 + adapters 目录）；版本号 → 0.6.0
11. `npm pack --dry-run` — 验证包内容完整
12. 验收：逐条核对上述所有验收标准
