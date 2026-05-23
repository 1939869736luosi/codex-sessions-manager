import type {
  BackupBundle,
  CleanupResult,
  DeleteExecutionResult,
  DeletePreview,
  DeleteValidationItem,
  DoctorReport,
  ProjectSummary,
  ScanResult,
  SessionEntry,
  SessionIndexCleanupResult,
  TimelineItem,
  TrashDeleteResult,
  TrashEntrySummary,
  TrashPurgeResult,
  TrashRestoreResult,
} from "../core/types.js";
import { groupSessionsByProject } from "../core/project.js";

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

function formatGlobalStateRemaining(item: DeleteValidationItem): string {
  return item.globalStateWarning ? "unknown" : String(item.globalStateRefsRemaining);
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

function trimTitle(title: string): string {
  return title.length > 56 ? `${title.slice(0, 53)}...` : title;
}

const DETAIL_TEXT_LIMIT = 180;
const TIMELINE_PREVIEW_LIMIT = 20;

function trimDetailText(value: string | null): string {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "-";
  }
  if (normalized.length <= DETAIL_TEXT_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, DETAIL_TEXT_LIMIT - 3)}... (${normalized.length} chars)`;
}

function formatTitleCandidates(session: SessionEntry): string {
  return session.titleCandidates.map((candidate) => `${candidate.source}=${trimDetailText(candidate.title)}`).join(" | ");
}

function formatTimelinePreview(timeline: TimelineItem[]): string[] {
  const rows = timeline
    .slice(0, TIMELINE_PREVIEW_LIMIT)
    .map((item) => `- [${item.roleLabel}] ${item.body.replace(/\s+/g, " ").slice(0, 220)}`);
  if (timeline.length > TIMELINE_PREVIEW_LIMIT) {
    rows.push(`- ... 还有 ${timeline.length - TIMELINE_PREVIEW_LIMIT} 条，使用 show --json 查看完整时间线`);
  }
  return rows;
}

export function formatList(scan: ScanResult, sessions: SessionEntry[]): string {
  const rows = [
    ["状态", "项目", "更新时间", "模型", "大小", "ID", "标题"],
    ...sessions.map((session) => [
      session.kind,
      session.projectName,
      formatDate(session.updatedAt),
      session.model ?? "-",
      formatBytes(session.totalFileSize),
      session.id,
      trimTitle(session.displayTitle),
    ]),
  ];

  const warnings = scan.warnings.length ? `\n\n警告:\n- ${scan.warnings.join("\n- ")}` : "";
  return `${printTable(rows)}${warnings}`;
}

function statusLabel(status: { exists: boolean; readable: boolean }, extra?: string): string {
  if (!status.exists) return "missing";
  if (!status.readable) return "warning";
  return extra ?? "OK";
}

export function formatDoctor(report: DoctorReport): string {
  const pathRows = [
    ["项目", "状态", "路径"],
    ["sessions", statusLabel(report.paths.sessionsDir), report.paths.sessionsDir.path],
    ["archived_sessions", statusLabel(report.paths.archivedSessionsDir), report.paths.archivedSessionsDir.path],
    ["session_index", statusLabel(report.paths.sessionIndex), report.paths.sessionIndex.path],
    ["history", statusLabel(report.paths.history), report.paths.history.path],
    [
      "global_state",
      statusLabel(
        report.paths.globalState,
        report.paths.globalState.parseable === false ? "warning" : report.paths.globalState.parseable === true ? "OK" : "OK",
      ),
      report.paths.globalState.path,
    ],
    ["shell_snapshots", statusLabel(report.paths.shellSnapshotsDir), report.paths.shellSnapshotsDir.path],
    ["trash", `${statusLabel(report.paths.trashDir)} (${report.paths.trashDir.entryCount})`, report.paths.trashDir.path],
  ];

  const tableRows = [
    ["库", "表", "状态", "关联列"],
    ...report.sqlite.stateTables.map((table) => [
      "state",
      table.table,
      table.exists ? "OK" : "missing",
      table.associationColumns.join(", ") || "-",
    ]),
    ...report.sqlite.logsTables.map((table) => [
      "logs",
      table.table,
      table.exists ? "OK" : "missing",
      table.associationColumns.join(", ") || "-",
    ]),
  ];

  return [
    `Root: ${report.rootPath}`,
    "",
    printTable(pathRows),
    "",
    `state SQLite: ${report.sqlite.activeStatePath ?? "missing"}`,
    `logs SQLite: ${report.sqlite.activeLogsPath ?? "missing"}`,
    "",
    printTable(tableRows),
    "",
    `sessions: ${report.scan.sessionCount ?? "unknown"}`,
    `known global state refs: ${report.globalState.knownRefs.length}`,
    `possible unknown global state refs: ${report.globalState.possibleUnknownRefs.length}`,
    report.warnings.length ? `\n警告:\n- ${report.warnings.join("\n- ")}` : "\n警告: 无",
  ].join("\n");
}

export function formatGroupedList(scan: ScanResult, sessions: SessionEntry[]): string {
  const groups = groupSessionsByProject(sessions);
  const warnings = scan.warnings.length ? `\n\n警告:\n- ${scan.warnings.join("\n- ")}` : "";

  return `${groups
    .map((group) =>
      [
        `${group.project.projectName} (${group.project.sessionCount}) ${group.project.projectPath ?? ""}`.trim(),
        printTable([
          ["状态", "更新时间", "模型", "大小", "ID", "标题"],
          ...group.sessions.map((session) => [
            session.kind,
            formatDate(session.updatedAt),
            session.model ?? "-",
            formatBytes(session.totalFileSize),
            session.id,
            trimTitle(session.displayTitle),
          ]),
        ]),
      ].join("\n"),
    )
    .join("\n\n")}${warnings}`;
}

export function formatProjects(projects: ProjectSummary[]): string {
  return printTable([
    ["项目", "sessions", "active", "archived", "db-only", "stale", "最新更新时间", "大小", "路径"],
    ...projects.map((project) => [
      project.projectName,
      String(project.sessionCount),
      String(project.activeCount),
      String(project.archivedCount),
      String(project.dbOnlyCount),
      String(project.staleCount),
      formatDate(project.latestUpdatedAt),
      formatBytes(project.totalFileSize),
      project.projectPath ?? "-",
    ]),
  ]);
}

export function formatShow(session: SessionEntry, timeline: TimelineItem[]): string {
  const lines = [
    `标题: ${trimDetailText(session.displayTitle)}`,
    `ID: ${session.id}`,
    `标题来源: ${session.titleSource}`,
    `标题不一致: ${session.titleMismatch ? "是" : "否"}`,
    `session_index 标题: ${trimDetailText(session.indexTitle)}`,
    `SQLite 标题: ${trimDetailText(session.sqliteTitle)}`,
    `第一条用户请求: ${trimDetailText(session.firstUserMessage)}`,
    `标题候选: ${formatTitleCandidates(session)}`,
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
    ...formatTimelinePreview(timeline),
  ];

  return lines.join("\n");
}

export function formatPreview(preview: DeletePreview): string {
  const lines = [
    `将处理 ${preview.items.length} 条会话`,
    `- 原始文件: ${preview.totals.sessionFiles}`,
    `- shell snapshot 文件: ${preview.totals.shellSnapshotFiles}`,
    `- global state 引用: ${preview.totals.globalStateRefs}`,
    `- global state 未知位置引用: ${preview.totals.possibleUnknownGlobalStateRefs}`,
    `- session_index 记录: ${preview.totals.sessionIndexRows}`,
    `- history 记录: ${preview.totals.historyRows}`,
    `- SQLite 记录: ${preview.totals.sqliteRows}`,
    "",
    ...preview.items.flatMap((item) => [
      `${item.title}`,
      `  id: ${item.sessionId}`,
      `  archived: ${item.archived ? "yes" : "no"}`,
      `  files: ${item.filePaths.length}`,
      `  shell_snapshots: ${item.shellSnapshotFiles.length}`,
      `  global_state_refs: ${item.globalStateRefs}`,
      `  possible_unknown_global_state_refs: ${item.possibleUnknownGlobalStateRefs}`,
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
        item.shellSnapshotFilesRemaining.length === 0 &&
        !item.globalStateWarning &&
        item.globalStateRefsRemaining === 0 &&
        item.possibleUnknownGlobalStateRefsRemaining === 0 &&
        item.sessionIndexRowsRemaining === 0 &&
        item.historyRowsRemaining === 0 &&
        sqliteRemaining === 0;
      const warnings = item.warnings.length ? `, warnings=${item.warnings.join(" | ")}` : "";
      return `- ${item.title}: ${allClean ? "已清理干净" : "仍有残留"} (files=${item.filePathsRemaining.length}, shell_snapshots=${item.shellSnapshotFilesRemaining.length}, global_state_refs=${formatGlobalStateRemaining(item)}, possible_unknown_global_state_refs=${item.possibleUnknownGlobalStateRefsRemaining}, session_index=${item.sessionIndexRowsRemaining}, history=${item.historyRowsRemaining}, sqlite=${sqliteRemaining}${warnings})`;
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
        item.shellSnapshotFilesRemaining.length === 0 &&
        !item.globalStateWarning &&
        item.globalStateRefsRemaining === 0 &&
        item.possibleUnknownGlobalStateRefsRemaining === 0 &&
        item.sessionIndexRowsRemaining === 0 &&
        item.historyRowsRemaining === 0 &&
        sqliteRemaining === 0;
      const warnings = item.warnings.length ? `, warnings=${item.warnings.join(" | ")}` : "";
      return `- ${item.title}: ${allClean ? "无残留" : "仍有残留"} (files=${item.filePathsRemaining.length}, shell_snapshots=${item.shellSnapshotFilesRemaining.length}, global_state_refs=${formatGlobalStateRemaining(item)}, possible_unknown_global_state_refs=${item.possibleUnknownGlobalStateRefsRemaining}, session_index=${item.sessionIndexRowsRemaining}, history=${item.historyRowsRemaining}, sqlite=${sqliteRemaining}${warnings})`;
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

export function formatCleanupPreview(result: CleanupResult): string {
  return [
    "cleanup-stale 未执行。确认后加 --yes。",
    `- 将处理 stale session: ${result.staleSessionIds.length}`,
    `- 将移除 session_index 记录: ${result.removedSessionIndexRows}`,
    `- 将移除 history 记录: ${result.removedHistoryRows}`,
  ].join("\n");
}

export function formatCleanupIndexResult(result: SessionIndexCleanupResult): string {
  return [
    `已处理 ${result.sessionIds.length} 条会话的索引痕迹`,
    `- 移除 session_index 记录: ${result.removedSessionIndexRows}`,
    `- 移除 history 记录: ${result.removedHistoryRows}`,
  ].join("\n");
}

export function formatCleanupIndexPreview(result: SessionIndexCleanupResult): string {
  return [
    "cleanup-index 未执行。确认后加 --yes。",
    `- 将处理 session: ${result.sessionIds.length}`,
    `- 将移除 session_index 记录: ${result.removedSessionIndexRows}`,
    `- 将移除 history 记录: ${result.removedHistoryRows}`,
  ].join("\n");
}

export function formatBackup(bundle: BackupBundle, outputPath: string): string {
  return [
    `备份已导出: ${outputPath}`,
    `- 会话: ${bundle.manifest.title}`,
    `- session_id: ${bundle.manifest.sessionId}`,
    `- 原始文件数: ${bundle.sessionFiles.length}`,
    `- shell snapshot 文件: ${bundle.shellSnapshots.length}`,
    `- global state 引用: ${bundle.globalStateRefs.length}`,
    `- session_index 记录: ${bundle.sessionIndexRecords.length}`,
    `- history 记录: ${bundle.historyRecords.length}`,
    `- SQLite 线程: ${bundle.sqlite.threads.length}`,
    `- SQLite 目标: ${bundle.sqlite.threadGoals.length}`,
  ].join("\n");
}

export function formatTrashDeleteResult(result: TrashDeleteResult): string {
  return [
    `已移入回收站: ${result.trashEntry.trashId}`,
    `- 会话数: ${result.trashEntry.sessionIds.length}`,
    `- session_id: ${result.trashEntry.sessionIds.join(", ")}`,
    "",
    formatDeleteResult(result.deletion),
  ].join("\n");
}

export function formatTrashEntries(entries: TrashEntrySummary[]): string {
  if (entries.length === 0) {
    return "回收站为空";
  }

  return printTable([
    ["trash_id", "创建时间", "sessions", "标题"],
    ...entries.map((entry) => [
      entry.trashId,
      formatDate(entry.createdAt),
      entry.sessionIds.join(", "),
      entry.sessions.map((session) => session.title).join(" | "),
    ]),
  ]);
}

export function formatTrashRestoreResult(result: TrashRestoreResult): string {
  return [
    `已恢复: ${result.trashEntry.trashId}`,
    `- session_id: ${result.restoredSessionIds.join(", ")}`,
    `- 原始文件: ${result.restoredSessionFiles}`,
    `- shell snapshot: ${result.restoredShellSnapshots}`,
    `- session_index: ${result.restoredSessionIndexRecords}`,
    `- history: ${result.restoredHistoryRecords}`,
    `- global state 引用: ${result.restoredGlobalStateRefs}`,
    `- SQLite 记录: ${result.restoredSqliteRows.total}`,
    `- SQLite skipped: ${result.skippedSqliteRows.total}`,
    ...(result.skippedSqliteTables.length ? [`- SQLite skipped tables: ${result.skippedSqliteTables.join(", ")}`] : []),
    ...(result.warnings.length ? [`- warning: ${result.warnings.join(" | ")}`] : []),
  ].join("\n");
}

export function formatTrashPurgeResult(result: TrashPurgeResult): string {
  return [
    `已永久清除回收站记录: ${result.trashEntry.trashId}`,
    `- session_id: ${result.trashEntry.sessionIds.join(", ")}`,
  ].join("\n");
}
