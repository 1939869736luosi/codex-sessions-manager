import type {
  BackupBundle,
  CleanupResult,
  DeleteExecutionResult,
  DeletePreview,
  DeleteValidationItem,
  ScanResult,
  SessionEntry,
  SessionIndexCleanupResult,
  TimelineItem,
} from "../core/types.js";

function formatDate(value: string | null): string {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatBytes(bytes: number): string {
  if (!bytes) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function sumSqlite(item: DeleteValidationItem["sqlite"]): number {
  return (
    item.threadRows +
    item.logRows +
    item.spawnEdgeRows +
    item.assignedAgentJobs +
    item.dynamicToolRows +
    item.stage1Rows +
    item.threadGoalRows
  );
}

function printTable(rows: string[][]): string {
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index].length)));
  return rows
    .map((row, rowIndex) =>
      row
        .map((cell, index) => cell.padEnd(widths[index]))
        .join("  ")
        .concat(rowIndex === 0 ? `\n${widths.map((width) => "-".repeat(width)).join("  ")}` : ""),
    )
    .join("\n");
}

export function formatList(scan: ScanResult, sessions: SessionEntry[]): string {
  const rows = [
    ["状态", "更新时间", "模型", "大小", "ID", "标题"],
    ...sessions.map((session) => [
      session.kind,
      formatDate(session.updatedAt),
      session.model ?? "-",
      formatBytes(session.totalFileSize),
      session.id,
      session.title.length > 56 ? `${session.title.slice(0, 53)}...` : session.title,
    ]),
  ];

  const warnings = scan.warnings.length ? `\n\n警告:\n- ${scan.warnings.join("\n- ")}` : "";
  return `${printTable(rows)}${warnings}`;
}

export function formatShow(session: SessionEntry, timeline: TimelineItem[]): string {
  const lines = [
    `标题: ${session.title}`,
    `ID: ${session.id}`,
    `状态: ${session.kind}`,
    `创建时间: ${formatDate(session.createdAt)}`,
    `更新时间: ${formatDate(session.updatedAt)}`,
    `模型: ${session.model ?? "-"}`,
    `工作目录: ${session.cwd ?? "-"}`,
    `rollout_path: ${session.rolloutPath ?? "-"}`,
    `原始文件数: ${session.fileTargets.length}`,
    `session_index 命中: ${session.sessionIndexCount}`,
    `history 命中: ${session.historyCount}`,
    `SQLite 线程: ${session.hasThread ? "是" : "否"}`,
    "",
    "时间线预览:",
    ...timeline.map((item) => `- [${item.roleLabel}] ${item.body.replace(/\n/g, " ").slice(0, 220)}`),
  ];

  return lines.join("\n");
}

export function formatPreview(preview: DeletePreview): string {
  const lines = [
    `将处理 ${preview.items.length} 条会话`,
    `- 原始文件: ${preview.totals.sessionFiles}`,
    `- session_index 记录: ${preview.totals.sessionIndexRows}`,
    `- history 记录: ${preview.totals.historyRows}`,
    `- SQLite 记录: ${preview.totals.sqliteRows}`,
    "",
    ...preview.items.flatMap((item) => [
      `${item.title}`,
      `  id: ${item.sessionId}`,
      `  archived: ${item.archived ? "yes" : "no"}`,
      `  files: ${item.filePaths.length}`,
      `  session_index: ${item.sessionIndexRows}`,
      `  history: ${item.historyRows}`,
      `  sqlite: ${sumSqlite(item.sqlite)}`,
    ]),
  ];

  return lines.join("\n");
}

export function formatDeleteResult(result: DeleteExecutionResult): string {
  return [
    formatPreview(result.preview),
    "",
    "验证结果:",
    ...result.validation.map((item) => {
      const sqliteRemaining = sumSqlite(item.sqlite);
      const allClean =
        item.filePathsRemaining.length === 0 &&
        item.sessionIndexRowsRemaining === 0 &&
        item.historyRowsRemaining === 0 &&
        sqliteRemaining === 0;
      return `- ${item.title}: ${allClean ? "已清理干净" : "仍有残留"} (files=${item.filePathsRemaining.length}, session_index=${item.sessionIndexRowsRemaining}, history=${item.historyRowsRemaining}, sqlite=${sqliteRemaining})`;
    }),
  ].join("\n");
}

export function formatVerifyResult(items: DeleteValidationItem[]): string {
  return [
    "验证结果:",
    ...items.map((item) => {
      const sqliteRemaining = sumSqlite(item.sqlite);
      const allClean =
        item.filePathsRemaining.length === 0 &&
        item.sessionIndexRowsRemaining === 0 &&
        item.historyRowsRemaining === 0 &&
        sqliteRemaining === 0;
      return `- ${item.title}: ${allClean ? "无残留" : "仍有残留"} (files=${item.filePathsRemaining.length}, session_index=${item.sessionIndexRowsRemaining}, history=${item.historyRowsRemaining}, sqlite=${sqliteRemaining})`;
    }),
  ].join("\n");
}

export function formatCleanupResult(result: CleanupResult): string {
  return [
    `已清理 ${result.staleSessionIds.length} 条失效会话索引`,
    `- 移除 session_index 记录: ${result.removedSessionIndexRows}`,
    `- 移除 history 记录: ${result.removedHistoryRows}`,
  ].join("\n");
}

export function formatCleanupIndexResult(result: SessionIndexCleanupResult): string {
  return [
    `已处理 ${result.sessionIds.length} 条会话的索引痕迹`,
    `- 移除 session_index 记录: ${result.removedSessionIndexRows}`,
    `- 移除 history 记录: ${result.removedHistoryRows}`,
  ].join("\n");
}

export function formatBackup(bundle: BackupBundle, outputPath: string): string {
  return [
    `备份已导出: ${outputPath}`,
    `- 会话: ${bundle.manifest.title}`,
    `- session_id: ${bundle.manifest.sessionId}`,
    `- 原始文件数: ${bundle.sessionFiles.length}`,
    `- session_index 记录: ${bundle.sessionIndexRecords.length}`,
    `- history 记录: ${bundle.historyRecords.length}`,
    `- SQLite 线程: ${bundle.sqlite.threads.length}`,
    `- SQLite 目标: ${bundle.sqlite.threadGoals.length}`,
  ].join("\n");
}
