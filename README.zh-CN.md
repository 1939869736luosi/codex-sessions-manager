# codex-sessions

[English](./README.md)

这是一个本地 Codex 会话管理工具集，主形态为：

- Node / TypeScript CLI
- 本地 stdio MCP server
- 一套共享核心逻辑，用来扫描、预览、导出、验证和删除会话

这个仓库已经不再继续发展浏览器 UI。当前主产品是 `CLI + MCP`。

## 安装

```bash
npm install
npm run build
```

## CLI 用法

通过构建产物运行：

```bash
node dist/cli/index.js list
node dist/cli/index.js show <session-id>
node dist/cli/index.js export <session-id>
node dist/cli/index.js delete <session-id...>
node dist/cli/index.js cleanup-index <session-id...>
node dist/cli/index.js cleanup-stale
node dist/cli/index.js verify <session-id...>
```

默认 Codex 根目录是 `~/.codex`，可用 `--root /path/to/.codex` 覆盖。

示例：

```bash
node dist/cli/index.js list --status active --limit 20
node dist/cli/index.js show 019d5240
node dist/cli/index.js export 019d5240 --output ./backup.json
node dist/cli/index.js delete 019d5240 019d3de0 --yes
node dist/cli/index.js cleanup-stale
node dist/cli/index.js verify 019d5240 --json
```

说明：

- `delete` 不带 `--yes` 时，只输出删除预览，不会执行。
- `cleanup-index` 只会改写 `session_index.jsonl` 和 `history.jsonl`。
- `cleanup-stale` 会移除那些正文文件和 SQLite 都不存在的失效索引。

## MCP 用法

启动本地 stdio MCP server：

```bash
node dist/mcp/server.js
```

暴露的工具包括：

- `list_sessions`
- `get_session`
- `export_session_backup`
- `preview_delete_sessions`
- `delete_sessions`
- `cleanup_session_indexes`
- `cleanup_stale_indexes`
- `verify_sessions`

CLI 和 MCP 共用同一套 Node 核心逻辑。

## 开发

```bash
npm install
npm run build
npm test
```

## 开源协议

Apache License 2.0。参见 [LICENSE](./LICENSE)。
