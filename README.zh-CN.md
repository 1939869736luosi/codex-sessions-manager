# codex-sessions

[English](./README.md)

这是一个本地 Codex 会话管理工具集，主形态为：

- Node / TypeScript CLI
- 本地 stdio MCP server
- 一套共享核心逻辑，用来扫描、项目分组、时间筛选、回收站、恢复、永久清除、验证和删除会话

这个仓库已经不再继续发展浏览器 UI。当前主产品是 `CLI + MCP`。
它不包含 UI、TUI、详情页、项目增量扫描，也不做过期自动清理。

## 安装

```bash
npm install
npm run build
```

## CLI 用法

通过构建产物运行：

```bash
node dist/cli/index.js list
node dist/cli/index.js projects
node dist/cli/index.js doctor
node dist/cli/index.js show <session-id>
node dist/cli/index.js export <session-id>
node dist/cli/index.js delete <session-id...>
node dist/cli/index.js trash-list
node dist/cli/index.js restore <trash-id-or-session-id>
node dist/cli/index.js purge <trash-id-or-session-id>
node dist/cli/index.js cleanup-index <session-id...>
node dist/cli/index.js cleanup-index <session-id...> --yes
node dist/cli/index.js cleanup-stale
node dist/cli/index.js cleanup-stale --yes
node dist/cli/index.js verify <session-id...>
```

默认 Codex 根目录是 `~/.codex`，可用 `--root /path/to/.codex` 覆盖。

示例：

```bash
node dist/cli/index.js list --status active --limit 20
node dist/cli/index.js list --project /path/or/name --group-by project
node dist/cli/index.js list --updated-after 2026-04-03 --updated-before 2026-04-03
node dist/cli/index.js projects
node dist/cli/index.js doctor --root ~/.codex --json
node dist/cli/index.js show 019d5240
node dist/cli/index.js export 019d5240 --output ./backup.json
node dist/cli/index.js delete 019d5240 --trash
node dist/cli/index.js delete 019d5240 --trash --yes
node dist/cli/index.js trash-list
node dist/cli/index.js restore 019d5240 --yes
node dist/cli/index.js purge 019d5240 --yes
node dist/cli/index.js delete 019d5240 019d3de0 --yes
node dist/cli/index.js cleanup-stale
node dist/cli/index.js cleanup-stale --yes
node dist/cli/index.js verify 019d5240 --json
```

说明：

- `delete` 不带 `--yes` 时，只输出删除预览，不会执行。
- 永久删除仍是默认行为，用来保持兼容。
- `delete --trash` 不带 `--yes` 时，只预览移入回收站；`delete --trash --yes` 会先写可恢复回收站包，再清理 live session。
- `restore` 和 `purge` 都需要 `--yes`。
- `restore` 遇到同 session live surface 或 SQLite 主键冲突时会拒绝恢复，不会静默覆盖。当前没有 force 覆盖模式。
- `purge` 只删除回收站记录，不会碰 live session。
- `doctor` 是只读诊断，只报告结构和风险，不删除、不恢复、不永久清除，也不写入文件。
- `cleanup-index` 和 `cleanup-stale` 会改写 `session_index.jsonl` 和 `history.jsonl`；不带 `--yes` 时只输出预览。
- `cleanup-index --yes` 只移除所选 session 的 JSONL 痕迹，不删除正文文件或 SQLite rows。
- `cleanup-stale --yes` 会移除那些正文文件和 SQLite 都不存在的失效索引。
- `YYYY-MM-DD` 这种 date-only 筛选按本地日历整天解释，和 CLI 显示一致。ISO datetime 必须带明确时区，例如 `Z` 或 `+08:00`；不带时区的 datetime 会被拒绝。

## MCP 用法

启动本地 stdio MCP server：

```bash
node dist/mcp/server.js
```

暴露的工具包括：

- `inspect_root`
- `list_sessions`
- `list_projects`
- `get_session`
- `export_session_backup`
- `preview_delete_sessions`
- `delete_sessions`
- `list_trash`
- `restore_sessions`
- `purge_trash`
- `cleanup_session_indexes`
- `cleanup_stale_indexes`
- `verify_sessions`

CLI 和 MCP 共用同一套 Node 核心逻辑。

`inspect_root` 是只读诊断工具，用来查看 root 结构、SQLite 表、回收站记录和 global state 警告；它不删除、不恢复、不永久清除，也不写入文件。

会修改数据的 MCP 工具都需要显式确认：

- `delete_sessions` 不带 `confirm=true` 不执行。
- `delete_sessions` 支持 `trash=true`；但不带 `confirm=true` 时仍然只预览。
- `restore_sessions` 和 `purge_trash` 不带 `confirm=true` 不执行。
- `cleanup_session_indexes` 和 `cleanup_stale_indexes` 会改写 JSONL 索引，不带 `confirm=true` 不执行。

## 开发

```bash
npm install
npm run build
npm test
```

## 开源协议

Apache License 2.0。参见 [LICENSE](./LICENSE)。
