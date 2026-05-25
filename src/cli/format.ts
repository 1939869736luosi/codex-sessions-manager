import type {
  BackupBundle,
  CleanupResult,
  DeleteExecutionResult,
  DeletePreview,
  DeleteValidationItem,
  DoctorReport,
  PlanDeleteResult,
  PreviewPlanResult,
  ProjectSummary,
  RootDeletePreview,
  RootDeletePreviewCandidate,
  RootDeletePreviewCounts,
  RootResidueAudit,
  ScanResult,
  SessionEntry,
  SessionFamily,
  SessionFamilyImpact,
  SessionFamilyNode,
  SessionFamilyQuery,
  SessionResidueAudit,
  SessionIndexCleanupResult,
  SourceSummary,
  TimelineItem,
  TrashDeleteResult,
  TrashEntrySummary,
  TrashPurgeResult,
  TrashRestoreResult,
} from "../core/types.js";
import { groupSessionsByProject } from "../core/project.js";
import { summarizeTrashDuplicateSessions } from "../core/trash.js";

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
  if (item.globalStateWarning) {
    return "unknown";
  }

  return [
    `known=${item.globalStateRefsRemaining}`,
    `exact_key=${item.exactKeyGlobalStateRefsRemaining}`,
    `unknown=${item.possibleUnknownGlobalStateRefsRemaining}`,
  ].join(", ");
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
  const normalized = title.replace(/\s+/g, " ").trim();
  return normalized.length > 56 ? `${normalized.slice(0, 53)}...` : normalized;
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
    ["状态", "项目", "更新时间", "来源", "provider", "模型", "大小", "ID", "标题"],
    ...sessions.map((session) => [
      session.kind,
      session.projectName,
      formatDate(session.updatedAt),
      session.sourceKind,
      session.modelProvider ?? "-",
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
    ...report.sqlite.goalsTables.map((table) => [
      "goals",
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
    `goals SQLite: ${report.sqlite.activeGoalsPath ?? "missing"}`,
    "",
    printTable(tableRows),
    "",
    `sessions: ${report.scan.sessionCount ?? "unknown"}`,
    `known global state refs: ${report.globalState.knownRefs.length}`,
    `exact-key global state refs: ${report.globalState.exactKeyRefs.length}`,
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
          ["状态", "更新时间", "来源", "provider", "模型", "大小", "ID", "标题"],
          ...group.sessions.map((session) => [
            session.kind,
            formatDate(session.updatedAt),
            session.sourceKind,
            session.modelProvider ?? "-",
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
    `来源分类: ${session.sourceKind}`,
    `raw source: ${trimDetailText(session.source)}`,
    `thread_source: ${trimDetailText(session.threadSource)}`,
    `model_provider: ${session.modelProvider ?? "-"}`,
    `模型: ${session.model ?? "-"}`,
    `agent_role: ${trimDetailText(session.agentRole)}`,
    `agent_nickname: ${trimDetailText(session.agentNickname)}`,
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

export function formatSourceSummary(scan: ScanResult, summary: SourceSummary): string {
  const byKindRows = [
    ["sourceKind", "sessions"],
    ...Object.entries(summary.bySourceKind).map(([sourceKind, count]) => [sourceKind, String(count)]),
  ];
  const detailRows = [
    ["sessions", "sourceKind", "raw source", "thread_source", "model_provider", "model", "agent_role", "latest"],
    ...summary.rows.map((row) => [
      String(row.count),
      row.sourceKind,
      trimDetailText(row.source),
      trimDetailText(row.threadSource),
      row.modelProvider ?? "-",
      row.model ?? "-",
      trimDetailText(row.agentRole),
      formatDate(row.latestUpdatedAt),
    ]),
  ];
  const warnings = scan.warnings.length ? `\n\n警告:\n- ${scan.warnings.join("\n- ")}` : "";

  return [
    `Root: ${scan.root.rootPath}`,
    `sessions: ${summary.totalSessions}`,
    "",
    "按 sourceKind:",
    printTable(byKindRows),
    "",
    "按来源明细:",
    printTable(detailRows),
  ].join("\n") + warnings;
}

function existsLabel(value: boolean, count?: number): string {
  if (!value) {
    return "no";
  }

  return count === undefined ? "yes" : `yes(${count})`;
}

const FAMILY_TEXT_LIMIT = 80;

function trimFamilyText(value: string | null, limit = FAMILY_TEXT_LIMIT): string {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "-";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function formatFullBlock(label: string, value: string | null): string {
  if (!value) {
    return `  ${label}: -`;
  }

  return [
    `  ${label}:`,
    ...value.split(/\r?\n/).map((line) => `    ${line}`),
  ].join("\n");
}

function formatIdLines(ids: string[]): string[] {
  return ids.length ? ids.map((id) => `- ${id}`) : ["- 无"];
}

function formatRelationLine(relation: { parentThreadId: string; childThreadId: string; status: string | null }): string {
  return `parent=${relation.parentThreadId}, child=${relation.childThreadId}, status=${relation.status ?? "-"}`;
}

function formatMissingRelationGroups(
  groups: SessionFamilyImpact["missingRelations"],
  allBrokenRelations: SessionFamilyImpact["brokenRelations"],
): string[] {
  const otherBrokenRelations = allBrokenRelations.filter(
    (relation) => !relation.missingParentSession && !relation.missingChildSession,
  );

  return [
    "missing parent:",
    ...formatIdLines(groups.missingParents.map(formatRelationLine)),
    "missing child:",
    ...formatIdLines(groups.missingChildren.map(formatRelationLine)),
    ...(otherBrokenRelations.length ? ["other broken relations:", ...otherBrokenRelations.map(formatRelationLine)] : []),
  ];
}

function formatMissingSurfaceGroups(groups: SessionFamilyImpact["missingSurfaces"]): string[] {
  return [
    "missing file:",
    ...formatIdLines(groups.missingFileSessionIds),
    "missing session_index:",
    ...formatIdLines(groups.missingSessionIndexIds),
    "missing thread:",
    ...formatIdLines(groups.missingThreadIds),
  ];
}

function formatFamilyNodes(nodes: SessionFamilyNode[], options: { full?: boolean } = {}): string {
  if (nodes.length === 0) {
    return "无";
  }

  return nodes.map((node) => {
    const commonLines = [
      `  id: ${node.sessionId}`,
      `  relationship: ${node.relationship}; labels: ${node.relationshipLabels.join(", ")}`,
      `  edge: ${node.relationshipStatus ?? "-"}; edgeStatus: ${node.edgeStatus}; updated: ${formatDate(node.updatedAt)}; archived: ${node.archived ? "yes" : "no"}`,
      `  sourceKind: ${node.sourceKind}; childType: ${node.childType}; childTypeLabels: ${node.childTypeLabels.join(", ")}`,
      `  agent_role: ${trimFamilyText(node.agentRole)}; agent_nickname: ${trimFamilyText(node.agentNickname)}; agent_path: ${trimFamilyText(node.agentPath)}`,
      `  surfaces: file=${existsLabel(node.fileExists, node.fileCount)}; index=${existsLabel(node.hasSessionIndex, node.sessionIndexCount)}; history=${existsLabel(node.hasHistory, node.historyCount)}; thread=${existsLabel(node.hasThread)}`,
      `  parentIds: ${node.parentIds.join(", ") || "-"}; childIds: ${node.childIds.join(", ") || "-"}`,
    ];

    if (options.full) {
      return [
        `- ${node.sessionId}`,
        ...commonLines,
        formatFullBlock("标题", node.displayTitle),
        formatFullBlock("raw source", node.source),
        formatFullBlock("thread_source", node.threadSource),
      ].join("\n");
    }

    return [
      `- ${trimTitle(node.displayTitle)}`,
      ...commonLines,
      `  source: ${trimFamilyText(node.sourceLabel)}; thread_source: ${trimFamilyText(node.threadSource)}`,
    ].join("\n");
  }).join("\n");
}

function formatChildrenByCategory(nodes: SessionFamilyNode[]): string[] {
  const counts = nodes.reduce<Record<string, number>>((result, node) => {
    for (const label of node.childTypeLabels) {
      result[label] = (result[label] ?? 0) + 1;
    }
    return result;
  }, {});
  const lines = Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, count]) => `- ${category}: ${count}`);

  return lines.length ? ["child 分类:", ...lines] : ["child 分类: 无"];
}

function formatFamilyImpact(impact: SessionFamilyImpact): string {
  const missingSurfaceRows = impact.missingSurfaceWarnings.length
    ? printTable([
      ["session", "role", "missing", "edge"],
      ...impact.missingSurfaceWarnings.map((warning) => [
        warning.sessionId,
        warning.role,
        warning.missingSurfaces.join(", "),
        warning.edgeStatus ?? "-",
      ]),
    ])
    : "无";
  const warningLines = impact.warnings.length ? ["", "断裂关系警告:", ...impact.warnings.map((warning) => `- ${warning}`)] : [];

  return [
    "family impact（只读，未执行删除，不是删除建议，不生成 --yes）",
    `目标会话: ${impact.targetSessionId}`,
    "",
    "selected（当前 session）:",
    ...formatIdLines(impact.selectedSessionIds),
    "",
    "unselected parents:",
    ...formatIdLines(impact.unselectedParentIds),
    "",
    "unselected children:",
    ...formatIdLines(impact.unselectedChildIds),
    "",
    "unselected family members:",
    ...formatIdLines(impact.unselectedFamilyMemberIds),
    "",
    "missing relations:",
    ...formatMissingRelationGroups(impact.missingRelations, impact.brokenRelations),
    "",
    "missing surfaces:",
    ...formatMissingSurfaceGroups(impact.missingSurfaces),
    "",
    "缺失明细:",
    missingSurfaceRows,
    ...warningLines,
  ].join("\n");
}

export function formatFamily(family: SessionFamily, options: { full?: boolean } = {}): string {
  const parentIds = family.parents.map((node) => node.sessionId);
  const childIds = family.directChildren.map((node) => node.sessionId);
  const warningLines = family.warnings.length ? ["", "警告:", ...family.warnings.map((warning) => `- ${warning}`)] : [];
  const detailHint = options.full
    ? "显示模式: --full，完整标题和完整 raw source 已展开；JSON/MCP 仍保留完整字段。"
    : "显示模式: 默认短输出，长字段会截断；完整内容用 --full、--json 或 MCP get_session_family 查看。";

  return [
    `当前会话: ${family.current.sessionId}`,
    `标题: ${options.full ? family.current.displayTitle : trimFamilyText(family.current.displayTitle)}`,
    `root: ${family.root.sessionId}`,
    `parent: ${parentIds.length ? parentIds.join(", ") : "-"}`,
    `children: ${childIds.length ? childIds.join(", ") : "-"}`,
    `family members: ${family.familyMembers.length}`,
    detailHint,
    "",
    ...formatChildrenByCategory(family.directChildren),
    "",
    "断裂关系:",
    ...formatMissingRelationGroups(family.missingRelations, family.brokenRelations),
    "",
    "缺失位置:",
    ...formatMissingSurfaceGroups(family.missingSurfaces),
    "",
    "当前会话信息:",
    formatFamilyNodes([family.current], options),
    "",
    "root:",
    formatFamilyNodes([family.root], options),
    "",
    "直接 parent:",
    formatFamilyNodes(family.parents, options),
    "",
    "直接 children:",
    formatFamilyNodes(family.directChildren, options),
    "",
    "ancestors:",
    formatFamilyNodes(family.ancestors, options),
    "",
    "descendants:",
    formatFamilyNodes(family.descendants, options),
    "",
    "siblings:",
    formatFamilyNodes(family.siblings, options),
    "",
    "family:",
    formatFamilyNodes(family.familyMembers, options),
    ...warningLines,
  ].join("\n");
}

export function formatFamilyQuery(query: SessionFamilyQuery, options: { full?: boolean } = {}): string {
  const filterLine = query.sourceKinds.length ? `sourceKind filter: ${query.sourceKinds.join(", ")}` : "sourceKind filter: -";
  const warningLines = query.family.warnings.length ? ["", "警告:", ...query.family.warnings.map((warning) => `- ${warning}`)] : [];
  const detailHint = options.full
    ? "显示模式: --full，完整标题和完整 raw source 已展开；JSON/MCP 仍保留完整字段。"
    : "显示模式: 默认短输出，长字段会截断；完整内容用 --full、--json 或 MCP get_session_family 查看。";

  if (query.mode === "impact") {
    return formatFamilyImpact(query.impact as SessionFamilyImpact);
  }

  if (query.mode === "full") {
    if (query.sourceKinds.length > 0) {
      return [
        `当前会话: ${query.family.current.sessionId}`,
        `标题: ${options.full ? query.family.current.displayTitle : trimFamilyText(query.family.current.displayTitle)}`,
        `root: ${query.family.root.sessionId}`,
        "mode: full",
        filterLine,
        `结果数: ${query.nodes.length}`,
        detailHint,
        "",
        "断裂关系:",
        ...formatMissingRelationGroups(query.family.missingRelations, query.family.brokenRelations),
        "",
        "缺失位置:",
        ...formatMissingSurfaceGroups(query.family.missingSurfaces),
        "",
        "family members:",
        formatFamilyNodes(query.nodes, options),
        ...warningLines,
      ].join("\n");
    }
    return formatFamily(query.family, options);
  }

  const titleByMode = {
    children: "直接 children",
    parents: "直接 parent",
    subagents: "family subagents",
  } as const;

  return [
    `当前会话: ${query.family.current.sessionId}`,
    `标题: ${options.full ? query.family.current.displayTitle : trimFamilyText(query.family.current.displayTitle)}`,
    `root: ${query.family.root.sessionId}`,
    `mode: ${query.mode}`,
    filterLine,
    `结果数: ${query.nodes.length}`,
    detailHint,
    "",
    ...(query.mode === "children" ? formatChildrenByCategory(query.nodes) : []),
    query.mode === "children" ? "" : null,
    "断裂关系:",
    ...formatMissingRelationGroups(query.family.missingRelations, query.family.brokenRelations),
    "",
    "缺失位置:",
    ...formatMissingSurfaceGroups(query.family.missingSurfaces),
    "",
    `${titleByMode[query.mode]}:`,
    formatFamilyNodes(query.nodes, options),
    ...warningLines,
  ].filter((line): line is string => line !== null).join("\n");
}

function formatFamilyWarnings(warnings: DeletePreview["familyWarnings"]): string[] {
  if (warnings.length === 0) {
    return [];
  }

  const printedWarnings = new Set<string>();

  return [
    "",
    "关系提醒:",
    ...warnings.flatMap((warning) => {
      const parts = [
        warning.unselectedParentIds.length ? `parent=${warning.unselectedParentIds.join(", ")}` : null,
        warning.unselectedChildIds.length ? `children=${warning.unselectedChildIds.join(", ")}` : null,
        warning.unselectedFamilyMemberIds.length ? `family=${warning.unselectedFamilyMemberIds.join(", ")}` : null,
      ].filter((part): part is string => Boolean(part));
      const lines = parts.length > 0
        ? [`- ${warning.sessionId}: 还有未选中的相关会话 (${parts.join("; ")})。工具不会自动递归处理这些会话。`]
        : [`- ${warning.sessionId}: 关系数据存在异常。工具不会自动递归处理这些会话。`];

      return [
        ...lines,
        ...warning.warnings.flatMap((message) => {
          if (printedWarnings.has(message)) {
            return [];
          }
          printedWarnings.add(message);
          return [`  warning: ${message}`];
        }),
      ];
    }),
  ];
}

export function formatPreview(preview: DeletePreview): string {
  const lines = [
    `将处理 ${preview.items.length} 条会话`,
    `- 原始文件: ${preview.totals.sessionFiles}`,
    `- shell snapshot 文件: ${preview.totals.shellSnapshotFiles}`,
    `- global state 引用: ${preview.totals.globalStateRefs}`,
    `- global state exact-key 引用: ${preview.totals.exactKeyGlobalStateRefs}`,
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
      `  exact_key_global_state_refs: ${item.exactKeyGlobalStateRefs}`,
      ...item.exactKeyGlobalStateRefsDetail.map(
        (ref) =>
          `    - ${ref.path} rule=${ref.ruleId} shape=${ref.valueShape} bytes=${ref.byteEstimate} confirm=${ref.requiresConfirmation ? "required" : "no"} reason=${ref.reason}`,
      ),
      `  possible_unknown_global_state_refs: ${item.possibleUnknownGlobalStateRefs}`,
      `  session_index: ${item.sessionIndexRows}`,
      `  history: ${item.historyRows}`,
      `  sqlite: ${sumSqlite(item.sqlite)}`,
    ]),
    ...formatFamilyWarnings(preview.familyWarnings),
  ];

  return lines.join("\n");
}

function formatPlanIncludeRows(items: PlanDeleteResult["availableIncludes"][keyof PlanDeleteResult["availableIncludes"]]): string {
  if (items.length === 0) {
    return "-";
  }

  return items
    .map((item) => `${item.sessionId} (${item.kind}, ${item.relationship}, sourceKind=${item.sourceKind})`)
    .join("\n");
}

export function formatPlanDelete(plan: PlanDeleteResult): string {
  const warnings = plan.warnings.length ? ["", "警告:", ...plan.warnings.map((warning) => `- ${warning}`)] : [];
  const rejected = plan.rejectedIds.length
    ? ["", "rejectedIds:", ...plan.rejectedIds.map((item) => `- ${item.sessionId}: ${item.reason}`)]
    : [];
  const candidateSource = plan.candidateSource
    ? [
        `candidateSource: ${plan.candidateSource.type}; sourceKind=${plan.candidateSource.sourceKinds.join(",")}; status=${plan.candidateSource.statuses.join(",")}; limit=${plan.candidateSource.limit}`,
        `candidateIds: ${plan.candidateIds?.join(", ") || "-"}`,
      ]
    : ["candidateSource: -", "candidateIds: -"];

  return [
    `只读 plan-delete（${plan.schemaVersion ?? "T7-P1"}）`,
    "未执行删除；这不是删除确认；plan file 只是审计材料，不是授权或 preview token。",
    "family 不默认递归包含；side/fork 只作为 ambiguous available include 输出。",
    "T7-P1 不支持执行能力；T7-P2 仍然 executionSupported=false；T7-P3 sourceKind candidate plan 只列 candidateIds，不会写入 selectedIds，不能用本输出执行 delete-plan。",
    "",
    `readOnly: ${plan.readOnly}`,
    `executionSupported: ${plan.executionSupported}`,
    `seedSessionIds: ${plan.seedSessionIds.join(", ") || "-"}`,
    `selectedIds: ${plan.selectedIds.join(", ") || "-"}`,
    ...candidateSource,
    "includedIds:",
    ...(plan.includedIds.length ? plan.includedIds.map((item) => `- ${item.sessionId}: ${item.reason}`) : ["-"]),
    "",
    "surfaceCounts:",
    `- sessionFiles: ${plan.surfaceCounts.sessionFiles}`,
    `- shellSnapshotFiles: ${plan.surfaceCounts.shellSnapshotFiles}`,
    `- globalStateRefs: ${plan.surfaceCounts.globalStateRefs}`,
    `- exactKeyGlobalStateRefs: ${plan.surfaceCounts.exactKeyGlobalStateRefs}`,
    `- possibleUnknownGlobalStateRefs: ${plan.surfaceCounts.possibleUnknownGlobalStateRefs}`,
    `- sessionIndexRows: ${plan.surfaceCounts.sessionIndexRows}`,
    `- historyRows: ${plan.surfaceCounts.historyRows}`,
    `- sqliteRows: ${plan.surfaceCounts.sqliteRows}`,
    "",
    "availableIncludes.children:",
    formatPlanIncludeRows(plan.availableIncludes.children),
    "",
    "availableIncludes.subagents:",
    formatPlanIncludeRows(plan.availableIncludes.subagents),
    "",
    "availableIncludes.descendants:",
    formatPlanIncludeRows(plan.availableIncludes.descendants),
    "",
    "availableIncludes.family:",
    formatPlanIncludeRows(plan.availableIncludes.family),
    "",
    "availableIncludes.side/fork ambiguous:",
    formatPlanIncludeRows(plan.availableIncludes.sideOrFork),
    "",
    "globalStateExactKey metadata:",
    ...(plan.globalStateExactKey.length
      ? plan.globalStateExactKey.map((ref) => `- ${ref.path} rule=${ref.ruleId} shape=${ref.valueShape} bytes=${ref.byteEstimate}`)
      : ["-"]),
    ...rejected,
    ...warnings,
  ].join("\n");
}

export function formatPreviewPlan(preview: PreviewPlanResult): string {
  const staleLines = preview.stale
    ? ["", "stale: true（拒绝把旧 plan 当当前 preview）", ...preview.staleReasons.map((reason) => `- ${reason}`)]
    : ["", "stale: false"];
  const rejectedLines = preview.rejectedIds.length
    ? ["", "rejectedIds:", ...preview.rejectedIds.map((item) => `- ${item.sessionId}: ${item.reason}`)]
    : [];

  return [
    "只读 preview-plan",
    "未执行删除；plan file 是审计材料，不是授权、不是 preview token、不是删除确认。",
    `schema: ${preview.planSchemaVersion}`,
    `planHash: ${preview.planHash ?? "-"}`,
    `selectedIds: ${preview.selectedIds.join(", ") || "-"}`,
    `deletableSelectedIds: ${preview.deletableSelectedIds.join(", ") || "-"}`,
    ...staleLines,
    ...rejectedLines,
    "",
    preview.deletePreview ? formatPreview(preview.deletePreview) : "delete preview: refused because plan is stale",
  ].join("\n");
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
        item.exactKeyGlobalStateRefsRemaining === 0 &&
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
        item.exactKeyGlobalStateRefsRemaining === 0 &&
        item.possibleUnknownGlobalStateRefsRemaining === 0 &&
        item.sessionIndexRowsRemaining === 0 &&
        item.historyRowsRemaining === 0 &&
        sqliteRemaining === 0;
      const warnings = item.warnings.length ? `, warnings=${item.warnings.join(" | ")}` : "";
      return `- ${item.title}: ${allClean ? "无残留" : "仍有残留"} (files=${item.filePathsRemaining.length}, shell_snapshots=${item.shellSnapshotFilesRemaining.length}, global_state_refs=${formatGlobalStateRemaining(item)}, possible_unknown_global_state_refs=${item.possibleUnknownGlobalStateRefsRemaining}, session_index=${item.sessionIndexRowsRemaining}, history=${item.historyRowsRemaining}, sqlite=${sqliteRemaining}${warnings})`;
    }),
  ].join("\n");
}

function yesNo(value: boolean): string {
  return value ? "是" : "否";
}

function formatSurfaceRows(audit: SessionResidueAudit): string {
  return printTable([
    ["位置", "是否存在", "数量", "说明"],
    [
      "原始 rollout 文件",
      yesNo(audit.surfaces.rolloutFiles.present),
      String(audit.surfaces.rolloutFiles.count),
      audit.surfaces.rolloutFiles.paths.join(", ") || "-",
    ],
    [
      "shell snapshot",
      yesNo(audit.surfaces.shellSnapshots.present),
      String(audit.surfaces.shellSnapshots.count),
      audit.surfaces.shellSnapshots.paths.join(", ") || "-",
    ],
    ["session_index", yesNo(audit.surfaces.sessionIndex.present), String(audit.surfaces.sessionIndex.count), "-"],
    ["history", yesNo(audit.surfaces.history.present), String(audit.surfaces.history.count), "-"],
    [
      "SQLite",
      yesNo(audit.surfaces.sqlite.present),
      String(audit.surfaces.sqlite.rows),
      [
        `threads=${audit.surfaces.sqlite.counts.threadRows}`,
        `logs=${audit.surfaces.sqlite.counts.logRows}`,
        `edges=${audit.surfaces.sqlite.counts.spawnEdgeRows}`,
        `jobs=${audit.surfaces.sqlite.counts.assignedAgentJobs}`,
        `tools=${audit.surfaces.sqlite.counts.dynamicToolRows}`,
        `stage1=${audit.surfaces.sqlite.counts.stage1Rows}`,
        `goals=${audit.surfaces.sqlite.counts.threadGoalRows}`,
      ].join(", "),
    ],
    [
      "global-state 已知引用",
      yesNo(audit.surfaces.globalStateKnown.present),
      String(audit.surfaces.globalStateKnown.count),
      audit.surfaces.globalStateKnown.paths.join(", ") || "-",
    ],
    [
      "global-state exact-key 引用",
      yesNo(audit.surfaces.globalStateExactKey.present),
      String(audit.surfaces.globalStateExactKey.count),
      audit.surfaces.globalStateExactKey.paths.join(", ") || "-",
    ],
    [
      "global-state 未知位置引用",
      yesNo(audit.surfaces.globalStateUnknown.present),
      String(audit.surfaces.globalStateUnknown.count),
      audit.surfaces.globalStateUnknown.paths.join(", ") || "-",
    ],
    [
      "thread_spawn_edges",
      yesNo(audit.surfaces.threadSpawnEdges.present),
      String(audit.surfaces.threadSpawnEdges.count),
      `作为 parent=${audit.surfaces.threadSpawnEdges.asParent}, 作为 child=${audit.surfaces.threadSpawnEdges.asChild}`,
    ],
  ]);
}

function formatAuditStatus(statuses: SessionResidueAudit["overallStatus"]): string {
  return statuses.join(", ");
}

export function formatAudit(audit: SessionResidueAudit): string {
  const warningLines = audit.warnings.length ? ["风险提醒", ...audit.warnings.map((warning) => `- ${warning}`)] : ["风险提醒", "- 无"];
  const familyLines = [
    "家族关系",
    `- 属于 family: ${yesNo(audit.familySummary.isFamilyMember)}`,
    `- root: ${audit.familySummary.rootId}`,
    `- parent: ${audit.familySummary.parentIds.join(", ") || "-"}`,
    `- children: ${audit.familySummary.childIds.join(", ") || "-"}`,
    `- family members: ${audit.familySummary.familyMemberIds.length} 个`,
    `- 断裂关系: ${audit.familySummary.brokenRelationCount} 个`,
  ];
  const brokenRelationLines = audit.brokenRelations.length
    ? [
        "断裂详情",
        ...audit.brokenRelations.map(
          (relation) =>
            `- parent=${relation.parentThreadId}, child=${relation.childThreadId}, status=${relation.status ?? "-"}, missingParent=${yesNo(relation.missingParentSession)}, missingChild=${yesNo(relation.missingChildSession)}`,
        ),
      ]
    : [];
  const nextStepLines = [
    "建议下一步",
    audit.recommendedNextCommand
      ? `- 预览命令: ${audit.recommendedNextCommand}`
      : `- ${audit.recommendedNextCommandNote ?? "不需要处理，当前没有发现本地残留。"}`,
    ...(audit.recommendedNextCommand && audit.recommendedNextCommandNote ? [`- ${audit.recommendedNextCommandNote}`] : []),
  ];

  return [
    "审计结论",
    `- session: ${audit.sessionId}`,
    `- 标题: ${trimDetailText(audit.displayTitle)}`,
    `- 状态: ${formatAuditStatus(audit.overallStatus)}`,
    `- 当前判断: ${audit.currentState.message}`,
    "",
    "本地残留面",
    formatSurfaceRows(audit),
    "",
    ...familyLines,
    ...(brokenRelationLines.length ? ["", ...brokenRelationLines] : []),
    "",
    ...warningLines,
    "",
    ...nextStepLines,
  ].join("\n");
}

function formatRootResidueCounts(candidate: RootResidueAudit["candidates"][number]): string {
  return [
    `rollout=${candidate.surfaces.rolloutFiles}`,
    `shell=${candidate.surfaces.shellSnapshots}`,
    `index=${candidate.surfaces.sessionIndexRows}`,
    `history=${candidate.surfaces.historyRows}`,
    `sqlite=${candidate.surfaces.sqliteRows}`,
    `global_known=${candidate.surfaces.knownGlobalStateRefs}`,
    `global_exact_key=${candidate.surfaces.exactKeyGlobalStateRefs}`,
    `global_unknown=${candidate.surfaces.possibleUnknownGlobalStateRefs}`,
    `edges=${candidate.surfaces.threadSpawnEdges}`,
  ].join(", ");
}

function formatRootPreviewCounts(counts: RootDeletePreviewCounts): string {
  return [
    `rollout=${counts.rolloutFiles}`,
    `shell=${counts.shellSnapshots}`,
    `index=${counts.sessionIndexRows}`,
    `history=${counts.historyRows}`,
    `sqlite=${counts.sqliteRows}`,
    `global_known=${counts.knownGlobalStateRefs}`,
    `global_exact_key=${counts.exactKeyGlobalStateRefs}`,
    `global_unknown=${counts.possibleUnknownGlobalStateRefs}`,
    `edges=${counts.threadSpawnEdges}`,
  ].join(", ");
}

function formatRootSourceLabel(source: string): string {
  switch (source) {
    case "rollout_files":
      return "rollout 文件";
    case "shell_snapshots":
      return "shell snapshot";
    case "session_index":
      return "session_index";
    case "history":
      return "history";
    case "sqlite":
      return "SQLite";
    case "global_state_known":
      return "已知 global-state";
    case "global_state_exact_key":
      return "exact-key global-state";
    case "global_state_unknown":
      return "未知 global-state";
    case "thread_spawn_edges":
      return "thread_spawn_edges（parent/child 关系边）";
    default:
      return source;
  }
}

function formatRootSources(sources: string[]): string {
  return sources.length ? sources.map(formatRootSourceLabel).join(",") : "-";
}

function formatRootPreviewFamilyWarning(candidate: RootDeletePreviewCandidate): string {
  const warningCount = candidate.familyWarnings.length;
  const missingParents = candidate.familyWarnings.reduce((sum, warning) => sum + warning.missingParentIds.length, 0);
  const missingChildren = candidate.familyWarnings.reduce((sum, warning) => sum + warning.missingChildIds.length, 0);
  const unselected = candidate.familyWarnings.reduce((sum, warning) => sum + warning.unselectedRelatedSessionIds.length, 0);
  if (warningCount === 0) {
    return "-";
  }

  return [`warnings=${warningCount}`, `unselected=${unselected}`, `missing_parent=${missingParents}`, `missing_child=${missingChildren}`].join(", ");
}

function formatRootResidueFamily(candidate: RootResidueAudit["candidates"][number]): string {
  return [
    `family=${yesNo(candidate.family.isFamilyMember)}`,
    `broken=${yesNo(candidate.family.brokenFamily)}`,
    `members=${candidate.family.familyMemberCount}`,
  ].join(", ");
}

function formatRootResidueFilters(audit: RootResidueAudit): string {
  const parts = [
    audit.filters.statuses.length ? `status=${audit.filters.statuses.join("|")}` : null,
    audit.filters.sources.length ? `source=${audit.filters.sources.map(formatRootSourceLabel).join("|")}` : null,
    audit.filters.includeAll ? "all=true" : null,
  ].filter((part): part is string => Boolean(part));

  return parts.length ? parts.join(", ") : "无";
}

function formatCountLines(counts: Record<string, number>, formatKey: (key: string) => string = (key) => key): string[] {
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    return ["- 无"];
  }

  return entries.map(([key, value]) => `- ${formatKey(key)}: ${value}`);
}

function formatRootResidueSummary(audit: RootResidueAudit): string[] {
  return [
    `Root: ${audit.rootPath}`,
    `注意: ${audit.safetyNotice}`,
    `疑似残留: ${audit.returnedCandidates}/${audit.totalCandidatesAfterFilter}，limit=${audit.limit}`,
    `筛选前候选: ${audit.totalCandidatesBeforeFilter}`,
    `筛选: ${formatRootResidueFilters(audit)}`,
    "",
    "按状态（筛选后，limit 前）:",
    ...formatCountLines(audit.byStatus),
    "",
    "按来源（筛选后，limit 前）:",
    ...formatCountLines(audit.bySource, formatRootSourceLabel),
  ];
}

export function formatRootResidueAudit(audit: RootResidueAudit): string {
  const warningLines = audit.warnings.length ? ["", "警告:", ...audit.warnings.map((warning) => `- ${warning}`)] : [];

  if (audit.candidates.length === 0) {
    return [
      ...formatRootResidueSummary(audit),
      "",
      "没有发现疑似残留。",
      ...warningLines,
    ].join("\n");
  }

  return [
    ...formatRootResidueSummary(audit),
    "",
    printTable([
      ["状态", "来源", "数量摘要", "family", "session id", "建议 audit 命令"],
      ...audit.candidates.map((candidate) => [
        candidate.statuses.join(","),
        formatRootSources(candidate.sources),
        formatRootResidueCounts(candidate),
        formatRootResidueFamily(candidate),
        candidate.sessionId,
        candidate.recommendedAuditCommand,
      ]),
    ]),
    ...warningLines,
  ].join("\n");
}

function formatRootDeletePreviewFilters(preview: RootDeletePreview): string {
  const parts = [
    preview.filters.statuses.length ? `status=${preview.filters.statuses.join("|")}` : null,
    preview.filters.sources.length ? `source=${preview.filters.sources.map(formatRootSourceLabel).join("|")}` : null,
    preview.filters.includeAll ? "all=true" : null,
  ].filter((part): part is string => Boolean(part));

  return parts.length ? parts.join(", ") : "无";
}

function formatFamilyWarningSummary(preview: RootDeletePreview): string[] {
  const summary = preview.familyWarningSummary;
  return [
    "family 风险摘要",
    `- 有提醒的 ID: ${summary.candidatesWithFamilyWarnings}`,
    `- 未选择 parent: ${summary.unselectedParentIds.length}`,
    `- 未选择 child: ${summary.unselectedChildIds.length}`,
    `- 未选择 family member: ${summary.unselectedFamilyMemberIds.length}`,
    `- 缺失 parent: ${summary.missingParentIds.length}`,
    `- 缺失 child: ${summary.missingChildIds.length}`,
    `- 断裂关系: ${summary.brokenRelationCount}`,
  ];
}

export function formatRootDeletePreview(preview: RootDeletePreview): string {
  const warningLines = preview.warnings.length ? ["", "警告:", ...preview.warnings.map((warning) => `- ${warning}`)] : [];
  const candidateRows = preview.candidates.length
    ? [
        "",
        printTable([
          ["session id", "statuses", "sources", "只读预览计数", "family warning", "建议 audit 命令"],
          ...preview.candidates.map((candidate) => [
            candidate.sessionId,
            candidate.statuses.join(","),
            formatRootSources(candidate.sources),
            formatRootPreviewCounts(candidate.previewCounts),
            formatRootPreviewFamilyWarning(candidate),
            candidate.recommendedAuditCommand,
          ]),
        ]),
      ]
    : ["", "没有匹配候选。"];

  return [
    "root 批量 delete preview（只读，未删除）",
    `Root: ${preview.rootPath}`,
    `注意: ${preview.safetyNotice}`,
    `筛选条件: ${formatRootDeletePreviewFilters(preview)}`,
    `匹配候选数: ${preview.totalCandidatesAfterFilter}`,
    `筛选前候选数: ${preview.totalCandidatesBeforeFilter}`,
    `本次预览 ID 数: ${preview.previewedCandidates}`,
    `省略 ID 数: ${preview.omittedCandidates}`,
    `limit: ${preview.limit}`,
    "",
    "总计",
    `- rollout files: ${preview.aggregatePreview.rolloutFiles}`,
    `- shell snapshots: ${preview.aggregatePreview.shellSnapshots}`,
    `- session_index: ${preview.aggregatePreview.sessionIndexRows}`,
    `- history: ${preview.aggregatePreview.historyRows}`,
    `- SQLite: ${preview.aggregatePreview.sqliteRows}`,
    `- known global-state: ${preview.aggregatePreview.knownGlobalStateRefs}`,
    `- exact-key global-state: ${preview.aggregatePreview.exactKeyGlobalStateRefs}`,
    `- unknown global-state: ${preview.aggregatePreview.possibleUnknownGlobalStateRefs}`,
    `- thread_spawn_edges（parent/child 关系边）: ${preview.aggregatePreview.threadSpawnEdges}`,
    "",
    ...formatFamilyWarningSummary(preview),
    ...candidateRows,
    ...warningLines,
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
    "- 注意: 备份用于恢复，可能包含完整 global-state exact-key value，包括 prompt-history 内容。",
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

  const table = printTable([
    ["trash_id", "创建时间", "sessions", "标题"],
    ...entries.map((entry) => [
      entry.trashId,
      formatDate(entry.createdAt),
      entry.sessionIds.join(", "),
      entry.sessions.map((session) => session.title).join(" | "),
    ]),
  ]);
  const duplicateSessionIds = summarizeTrashDuplicateSessions(entries);
  if (duplicateSessionIds.length === 0) {
    return table;
  }

  return [
    table,
    "",
    "重复 session_id:",
    ...duplicateSessionIds.map((entry) => `- ${entry.sessionId}: ${entry.count} 条 trash entry，写操作必须使用精确 trashId`),
  ].join("\n");
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
