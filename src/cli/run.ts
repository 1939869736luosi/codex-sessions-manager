import path from "node:path";
import { parseArgs } from "node:util";

import {
  getSessionOperation,
  inspectRootOperation,
  listSessionsOperation,
} from "../application/session-operations.js";
import {
  streamSessionEventsOperation,
  writeSessionEventsOperation,
} from "../application/event-operations.js";
import {
  auditRootOperation,
  auditSessionOperation,
  exportSessionOperation,
  getRecoveryStatusOperation,
  getSessionFamilyOperation,
  listProjectsOperation,
  listTrashOperation,
  planDeleteOperation,
  previewDeletePlanOperation,
  previewRootDeleteOperation,
  summarizeSourcesOperation,
  verifySessionsOperation,
  writeDeletePlanOperation,
} from "../application/read-operations.js";
import {
  cleanupSessionIndexesOperation,
  cleanupStaleIndexesOperation,
  deleteSessionsOperation,
  purgeTrashOperation,
  recoverOperation,
  restoreTrashOperation,
} from "../application/mutation-operations.js";
import { writePrivateOutputFile } from "../core/private-output.js";
import { parseSourceKind } from "../core/sources.js";
import type { SessionKind } from "../core/types.js";
import {
  formatAudit,
  formatBackup,
  formatCleanupIndexPreview,
  formatCleanupIndexResult,
  formatCleanupPreview,
  formatCleanupResult,
  formatDeleteResult,
  formatDoctor,
  formatFamilyQuery,
  formatGroupedList,
  formatList,
  formatPlanDelete,
  formatPreviewPlan,
  formatPreview,
  formatProjects,
  formatRootDeletePreview,
  formatRootResidueAudit,
  formatSourceSummary,
  formatShow,
  formatTrashDeleteResult,
  formatTrashEntries,
  formatTrashPurgeResult,
  formatTrashRestoreResult,
  formatVerifyResult,
} from "./format.js";
import { TOOL_VERSION } from "../version.js";

type CommandName =
  | "scan"
  | "doctor"
  | "list"
  | "sources"
  | "projects"
  | "show"
  | "family"
  | "audit"
  | "audit-root"
  | "preview-root"
  | "export"
  | "events"
  | "plan-delete"
  | "preview-plan"
  | "delete"
  | "trash-list"
  | "restore"
  | "purge"
  | "cleanup-index"
  | "cleanup-stale"
  | "recovery-status"
  | "recover"
  | "verify";

interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export function cliUnhandledErrorExitCode(error: unknown): 1 | 2 | 3 {
  const errorCode = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  if (errorCode === "RECOVERY_REQUIRED") return 3;
  if (errorCode === "POST_COMMIT_VERIFY_FAILED") return 2;
  return 1;
}

function defaultIo(): CliIo {
  return {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  };
}

export function mutationExitCode(result: { verificationStatus: string }): 0 | 2 {
  return result.verificationStatus === "passed" ? 0 : 2;
}

export function getHelpText(): string {
  return `codex-sessions

Usage:
  codex-sessions --version
  codex-sessions list [--root PATH] [--json] [--query TEXT] [--status KIND] [--limit N]
                     [--project TEXT] [--group-by project]
                     [--updated-after DATE] [--updated-before DATE]
                     [--created-after DATE] [--created-before DATE]
                     [--source-kind KIND] [--source SOURCE] [--thread-source SOURCE]
                     [--agent-role ROLE] [--agent-nickname NAME]
                     [--model-provider PROVIDER] [--model MODEL]
  codex-sessions sources [--root PATH] [--json]
  codex-sessions projects [--root PATH] [--json]
  codex-sessions doctor [--root PATH] [--json] [--details]
  codex-sessions show <session-id> [--root PATH] [--json]
  codex-sessions family <session-id> [--root PATH] [--json]
                       [--children | --parents | --subagents | --impact] [--full]
                       [--source-kind KIND]
  codex-sessions audit <session-id> [--root PATH] [--json]
  codex-sessions audit-root [--root PATH] [--json] [--limit N] [--status STATUS...] [--source SOURCE...] [--all]
  codex-sessions preview-root [--root PATH] [--json] [--limit N] [--status STATUS...] [--source SOURCE...] [--all]
  codex-sessions export <session-id> [--root PATH] [--output FILE] [--json]
  codex-sessions events <exact-session-id> [--root PATH] [--output FILE]
  codex-sessions plan-delete <session-id...> [--root PATH] [--json] [--write-plan FILE]
                            [--include-children] [--include-subagents]
                            [--include-descendants] [--include-family]
  codex-sessions plan-delete --source-kind KIND [--source-kind KIND...] --limit N
                            [--status STATUS...] [--root PATH] [--json]
  codex-sessions preview-plan <plan-file> [--root PATH] [--json]
  codex-sessions delete <session-id...> [--root PATH] [--json] [--yes] [--trash] [--allow-active]
  codex-sessions trash-list [--root PATH] [--json]
  codex-sessions restore <trash-id-or-session-id> [--root PATH] [--json] [--yes]
  codex-sessions purge <trash-id-or-session-id> [--root PATH] [--json] [--yes]
  codex-sessions cleanup-index <session-id...> [--root PATH] [--json] [--yes] [--allow-active]
  codex-sessions cleanup-stale [--root PATH] [--json] [--yes]
  codex-sessions recovery-status [--root PATH] [--json]
  codex-sessions recover <operation-id> [--root PATH] [--json] [--yes]
  codex-sessions verify <session-id...> [--root PATH] [--json]

Notes:
  - 默认根目录是 ~/.codex
  - doctor 默认只返回统计、风险和每类最多 5 个样本；--details 才展开完整引用
  - events 输出完整 canonical event JSONL；MCP 只提供受条数和字节双重限制的分页读取
  - events 默认排除模型内部 reasoning；--output 创建 0600 私密文件并拒绝覆盖
  - delete 未带 --yes 时只展示预览，不执行删除
  - 真正删除前应先单独预览供检查，再显式加 --yes；当前没有 preview token；family / impact 不能替代 delete preview
  - family 只读查看 parent / child / side / fork / subagent 关系，不会自动递归处理
  - family --impact 只读查看关系影响，不执行删除，不是删除建议，也不生成 --yes
  - audit 只读检查官方 UI 删除或归档后本地还剩哪些记录
  - audit-root 只读扫描整个 root 的疑似残留，默认 limit=50
  - audit-root 多个 --status 或 --source 为 OR；同时使用 status 和 source 时为 AND
  - preview-root 只读批量预览 audit-root 筛出的候选，不删除、不递归处理 family
  - plan-delete 是只读删除计划：explicit session IDs 会进入 selectedIds；sourceKind root-level 模式只输出 candidateIds，不是授权
  - plan-delete --source-kind 必须显式 --limit（最大 50），拒绝 unknown；可重复 --source-kind/--status 使用 OR
  - plan-delete --source-kind 暂不支持 --write-plan；candidateIds 需人工复核后再显式 ID 预览
  - preview-plan 只读重扫 root 并检查 stale；plan file 是审计材料，不是授权、不是 preview token、不是删除确认
  - plan-delete include flags 只影响 selectedIds；family 不默认递归包含，--include-family 为高风险只读计划
  - plan-delete side/fork 仅作为 ambiguous available include 输出；当前没有 side/fork 专用 include flags
  - global-state exact-key 只支持 P11 两个路径；delete 预览只显示 path/rule/shape/bytes，不打印 prompt 或完整 value
  - 删除 exact-key 应先看 delete 预览，再加 --yes；audit-root / preview-root 不能当作删除确认
  - 其它 unknown global-state 只报警，不会因为路径相似、全文命中或 root 扫描候选而删除
  - audit-root/preview-root --status 可选: absent | clean | present | partial | broken-family | risky-global-state | db-only | index-only | partial-residue | global-state-exact-key | global-state-unknown | shell-snapshot-residue | index-residue | sqlite-residue | missing-parent-edge | missing-child-edge
  - audit-root/preview-root --source 可选: rollout-files | shell-snapshots | session-index | history | sqlite | global-state-known | global-state-exact-key | global-state-unknown | thread-spawn-edges
  - delete --trash --yes 会先写入回收站，再清理 live session
  - delete / cleanup-index 确认执行只接受完整 UUID；active session 还必须显式加 --allow-active
  - restore 和 purge 未带 --yes 时可用唯一短前缀预览；确认执行只接受精确 trashId
  - cleanup-index 和 cleanup-stale 未带 --yes 时只展示预览，不改写 JSONL
  - recovery-status 只读显示中断操作；recover 必须使用精确 operation ID 和 --yes
  - status 可选: all | active | archived | db-only | stale
  - source-kind 可选: subagent | mcp | vscode | cli | exec | unknown
  - sources 只读汇总 sourceKind、raw source、thread_source、model_provider、model、agent_role
  - DATE 支持 YYYY-MM-DD 或带明确时区的 ISO 字符串；YYYY-MM-DD 按本地日期整天筛选
`;
}

function normalizeOptionValues(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}

const PLAN_DELETE_CANDIDATE_LIMIT_MAX = 50;

function parsePlanDeleteLimit(value: string | undefined): number {
  if (!value) {
    throw new Error("plan-delete --source-kind 需要显式 --limit，且最大为 50。");
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("plan-delete --source-kind 的 --limit 必须是 1 到 50 的整数。");
  }
  if (limit > PLAN_DELETE_CANDIDATE_LIMIT_MAX) {
    throw new Error("plan-delete --source-kind 的 --limit 最大为 50。");
  }
  return limit;
}

function parsePlanDeleteStatuses(values: string[]): SessionKind[] {
  const statuses = values.length > 0 ? values : ["active", "archived", "db-only", "stale"];
  return statuses.map((value) => {
    if (value === "active" || value === "archived" || value === "db-only" || value === "stale") {
      return value;
    }
    if (value === "all") {
      throw new Error("plan-delete --source-kind 不支持 --status all；省略 --status 表示全部状态候选。");
    }
    throw new Error("plan-delete --source-kind --status 可选: active | archived | db-only | stale");
  });
}

async function writeBackupFile(outputPath: string, payload: unknown): Promise<void> {
  await writePrivateOutputFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
}

export async function runCli(argv: string[], io: CliIo = defaultIo()): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      root: { type: "string" },
      json: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      trash: { type: "boolean", default: false },
      "allow-active": { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      children: { type: "boolean", default: false },
      parents: { type: "boolean", default: false },
      subagents: { type: "boolean", default: false },
      impact: { type: "boolean", default: false },
      full: { type: "boolean", default: false },
      details: { type: "boolean", default: false },
      "include-children": { type: "boolean", default: false },
      "include-subagents": { type: "boolean", default: false },
      "include-descendants": { type: "boolean", default: false },
      "include-family": { type: "boolean", default: false },
      query: { type: "string" },
      project: { type: "string" },
      status: { type: "string", multiple: true },
      source: { type: "string", multiple: true },
      "source-kind": { type: "string", multiple: true },
      "thread-source": { type: "string", multiple: true },
      "agent-role": { type: "string", multiple: true },
      "agent-nickname": { type: "string", multiple: true },
      "model-provider": { type: "string", multiple: true },
      model: { type: "string", multiple: true },
      limit: { type: "string" },
      output: { type: "string" },
      "write-plan": { type: "string" },
      "group-by": { type: "string" },
      "updated-after": { type: "string" },
      "updated-before": { type: "string" },
      "created-after": { type: "string" },
      "created-before": { type: "string" },
      version: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.version) {
    io.stdout(TOOL_VERSION);
    return 0;
  }

  if (values.help || positionals.length === 0) {
    io.stdout(getHelpText());
    return 0;
  }

  const [command, ...rest] = positionals as [CommandName, ...string[]];
  const rootArg = values.root;
  const asJson = values.json;
  const statusValues = normalizeOptionValues(values.status);
  const sourceValues = normalizeOptionValues(values.source);
  const sourceKindValues = normalizeOptionValues(values["source-kind"]);
  const threadSourceValues = normalizeOptionValues(values["thread-source"]);
  const agentRoleValues = normalizeOptionValues(values["agent-role"]);
  const agentNicknameValues = normalizeOptionValues(values["agent-nickname"]);
  const modelProviderValues = normalizeOptionValues(values["model-provider"]);
  const modelValues = normalizeOptionValues(values.model);
  if (command === "doctor") {
    const { report } = await inspectRootOperation({ root: rootArg, includeDetails: values.details });
    io.stdout(asJson ? JSON.stringify(report, null, 2) : formatDoctor(report));
    return 0;
  }

  if (command === "list" || command === "scan") {
    if (values["group-by"] && values["group-by"] !== "project") {
      throw new Error(`不支持的 group-by：${values["group-by"]}`);
    }
    if (statusValues.length > 1) {
      throw new Error("list 只支持一个 --status。");
    }
    const result = await listSessionsOperation({
      root: rootArg,
      groupBy: values["group-by"] as "project" | undefined,
      filters: {
        query: values.query,
        project: values.project,
        status: (statusValues[0] as "all" | "active" | "archived" | "db-only" | "stale" | undefined) ?? "all",
        limit: values.limit ? Number(values.limit) : undefined,
        updatedAfter: values["updated-after"],
        updatedBefore: values["updated-before"],
        createdAfter: values["created-after"],
        createdBefore: values["created-before"],
        sourceKind: sourceKindValues,
        source: sourceValues,
        threadSource: threadSourceValues,
        agentRole: agentRoleValues,
        agentNickname: agentNicknameValues,
        modelProvider: modelProviderValues,
        model: modelValues,
      },
    });
    io.stdout(
      asJson
        ? JSON.stringify(result.data, null, 2)
        : values["group-by"] === "project"
          ? formatGroupedList(result.scan, result.data.sessions)
          : formatList(result.scan, result.data.sessions),
    );
    return 0;
  }

  if (command === "show") {
    if (rest.length !== 1) {
      throw new Error("show 需要 1 个 session-id。");
    }
    const result = await getSessionOperation({ root: rootArg, sessionId: rest[0] });
    const { session, timeline, ...timelineMetadata } = result.data;
    io.stdout(
      asJson
        ? JSON.stringify(result.data, null, 2)
        : formatShow(session, timeline, timelineMetadata),
    );
    return 0;
  }

  if (command === "events") {
    if (rest.length !== 1) {
      throw new Error("events 需要 1 个完整、精确的 session-id。");
    }
    if (values.output) {
      const result = await writeSessionEventsOperation({
        root: rootArg,
        sessionId: rest[0],
        outputPath: values.output,
      });
      io.stdout(`Wrote ${result.eventCount} canonical event(s) for ${result.sessionId} to ${result.outputPath}. Internal reasoning was excluded.`);
      return 0;
    }
    for await (const event of streamSessionEventsOperation({ root: rootArg, sessionId: rest[0] })) {
      io.stdout(JSON.stringify(event));
    }
    return 0;
  }

  if (command === "sources") {
    if (rest.length !== 0) throw new Error("sources 不接收 session-id。");
    const result = await summarizeSourcesOperation({ root: rootArg });
    io.stdout(asJson ? JSON.stringify(result.data, null, 2) : formatSourceSummary(result.scan, result.data.summary));
    return 0;
  }

  if (command === "projects") {
    if (rest.length !== 0) throw new Error("projects 不接收 session-id。");
    const result = await listProjectsOperation({ root: rootArg });
    io.stdout(asJson ? JSON.stringify(result.data, null, 2) : formatProjects(result.data.projects));
    return 0;
  }

  if (command === "family") {
    if (rest.length !== 1) throw new Error("family 需要 1 个 session-id。");
    const selectedModes = [
      values.children ? "children" : null,
      values.parents ? "parents" : null,
      values.subagents ? "subagents" : null,
      values.impact ? "impact" : null,
    ].filter((mode): mode is "children" | "parents" | "subagents" | "impact" => Boolean(mode));
    if (selectedModes.length > 1) {
      throw new Error("family 一次只能选择一个 mode：--children、--parents、--subagents 或 --impact。");
    }
    const result = await getSessionFamilyOperation({
      root: rootArg,
      sessionId: rest[0],
      mode: selectedModes[0] ?? "full",
      sourceKind: sourceKindValues,
    });
    const { root: _root, warnings: _warnings, ...query } = result.data;
    io.stdout(asJson ? JSON.stringify(result.data, null, 2) : formatFamilyQuery(query, { full: Boolean(values.full) }));
    return 0;
  }

  if (command === "audit") {
    if (rest.length !== 1) throw new Error("audit 需要 1 个 session-id。");
    const result = await auditSessionOperation({ root: rootArg, sessionId: rest[0] });
    io.stdout(asJson ? JSON.stringify(result.data, null, 2) : formatAudit(result.data));
    return 0;
  }

  if (command === "audit-root" || command === "preview-root") {
    if (rest.length !== 0) throw new Error(`${command} 不接收 session-id。`);
    if (values.yes) throw new Error(`${command} 不支持 --yes；它始终只读，不执行删除。`);
    if (values.trash) throw new Error(`${command} 不支持 --trash；它始终只读，不执行删除。`);
    const input = {
      root: rootArg,
      limit: values.limit ? Number(values.limit) : undefined,
      includeAll: values.all,
      statuses: statusValues,
      sources: sourceValues,
    };
    if (command === "audit-root") {
      const result = await auditRootOperation(input);
      io.stdout(asJson ? JSON.stringify(result.data, null, 2) : formatRootResidueAudit(result.data));
    } else {
      const result = await previewRootDeleteOperation(input);
      io.stdout(asJson ? JSON.stringify(result.data, null, 2) : formatRootDeletePreview(result.data));
    }
    return 0;
  }

  if (command === "export") {
    if (rest.length !== 1) throw new Error("export 需要 1 个 session-id。");
    const result = await exportSessionOperation({ root: rootArg, sessionId: rest[0] });
    if (asJson && !values.output) {
      io.stdout(JSON.stringify(result.data, null, 2));
      return 0;
    }
    const outputPath = path.resolve(values.output ?? `${result.session.id}-backup.json`);
    await writeBackupFile(outputPath, result.data);
    io.stdout(formatBackup(result.data, outputPath));
    return 0;
  }

  if (command === "trash-list") {
    if (rest.length !== 0) throw new Error("trash-list 不接收参数。");
    const result = await listTrashOperation({ root: rootArg });
    io.stdout(asJson ? JSON.stringify(result.data, null, 2) : formatTrashEntries(result.data.entries));
    return 0;
  }

  if (command === "verify") {
    if (rest.length === 0) throw new Error("verify 至少需要 1 个 session-id。");
    const result = await verifySessionsOperation({ root: rootArg, sessionIds: rest });
    io.stdout(asJson ? JSON.stringify(result.data, null, 2) : formatVerifyResult(result.data));
    return 0;
  }

  if (command === "plan-delete") {
    if (values.yes) throw new Error("plan-delete 不支持 --yes；它始终只读，不执行删除。");
    if (values.trash) throw new Error("plan-delete 不支持 --trash；它不会执行或生成可执行删除计划。");
    if (rest.length === 0 && sourceKindValues.length > 0) {
      if (values["write-plan"]) {
        throw new Error("--write-plan 暂不支持 sourceKind candidate plan；candidateIds 不是删除授权，请改用 JSON 输出人工复核后再显式 ID 预览。");
      }
      if (
        sourceValues.length > 0 || values.all || values.query || values.project || values.children ||
        values.parents || values.subagents || values.impact || values["include-children"] ||
        values["include-subagents"] || values["include-descendants"] || values["include-family"]
      ) {
        throw new Error("plan-delete --source-kind candidate plan 只支持 --source-kind、--status、--limit、--root、--json。");
      }
      const sourceKinds = sourceKindValues.map(parseSourceKind);
      if (sourceKinds.includes("unknown")) {
        throw new Error("unknown sourceKind must be reviewed by explicit session ID；不支持 root-level unknown candidate plan。");
      }
      const result = await planDeleteOperation({
        root: rootArg,
        sessionIds: [],
        options: {
          candidateSource: {
            sourceKinds,
            statuses: parsePlanDeleteStatuses(statusValues),
            limit: parsePlanDeleteLimit(values.limit),
          },
        },
      });
      io.stdout(asJson ? JSON.stringify(result.data, null, 2) : formatPlanDelete(result.data));
      return 0;
    }
    if (rest.length === 0) throw new Error("plan-delete 至少需要 1 个 session-id。");
    if (
      sourceKindValues.length > 0 || sourceValues.length > 0 || statusValues.length > 0 || values.all ||
      values.query || values.project || values.limit || values.children || values.parents || values.subagents || values.impact
    ) {
      throw new Error("plan-delete 只支持 explicit session IDs 和 include flags；不支持 root 级批量选择或 family mode filters。");
    }
    const input = {
      root: rootArg,
      sessionIds: rest,
      options: {
        includeChildren: values["include-children"],
        includeSubagents: values["include-subagents"],
        includeDescendants: values["include-descendants"],
        includeFamily: values["include-family"],
      },
    };
    if (values["write-plan"]) {
      const result = await writeDeletePlanOperation({ ...input, outputPath: values["write-plan"] });
      io.stdout(
        asJson
          ? JSON.stringify({ planFile: values["write-plan"], ...result.data }, null, 2)
          : `${formatPlanDelete(result.data)}\n\nplan file written: ${values["write-plan"]}`,
      );
      return 0;
    }
    const result = await planDeleteOperation(input);
    io.stdout(asJson ? JSON.stringify(result.data, null, 2) : formatPlanDelete(result.data));
    return 0;
  }

  if (command === "preview-plan") {
    if (rest.length !== 1) throw new Error("preview-plan 需要 1 个 plan-file。");
    if (values.yes) throw new Error("preview-plan 不支持 --yes；plan file 不是删除确认。");
    if (values.trash) throw new Error("preview-plan 不支持 --trash；它始终只读，不执行删除。");
    const result = await previewDeletePlanOperation({ root: rootArg, planFile: rest[0] });
    io.stdout(asJson ? JSON.stringify(result.data, null, 2) : formatPreviewPlan(result.data));
    return 0;
  }

  if (command === "recovery-status") {
    if (rest.length !== 0) throw new Error("recovery-status 不接收 operation ID。");
    const { data: status } = await getRecoveryStatusOperation({ root: rootArg });
    io.stdout(
      asJson
        ? JSON.stringify(status, null, 2)
        : status.pending
          ? status.invalidReason
            ? `恢复元数据无效，后续写操作已阻止。\n- 原因: ${status.invalidReason}`
            : `存在待恢复操作: ${status.operationId}\n- kind: ${status.kind}\n- stage: ${status.stage}\n- recovery payload: ${status.hasRecoveryPayload ? "存在" : "缺失"}`
          : "没有待恢复操作。",
    );
    return 0;
  }

  if (command === "recover") {
    if (rest.length !== 1) throw new Error("recover 需要 1 个精确 operation ID。");
    const operation = await recoverOperation({
      root: rootArg,
      operationId: rest[0],
      confirm: values.yes,
    });
    if (!operation.executed) {
      io.stdout(
        asJson
          ? JSON.stringify(operation.data, null, 2)
          : `恢复未执行。核对 operation ${rest[0]} 后加 --yes。\n- kind: ${operation.data.status.kind}\n- stage: ${operation.data.status.stage}`,
      );
      return 0;
    }
    const result = operation.result;
    io.stdout(
      asJson
        ? JSON.stringify(result, null, 2)
        : `恢复处理完成: ${result.operationId}\n- kind: ${result.kind}\n- action: ${result.recoveredBy}\n- operationStatus: ${result.operationStatus}\n- verificationStatus: ${result.verificationStatus}`,
    );
    return mutationExitCode(result);
  }

  switch (command) {
    case "delete": {
      if (rest.length === 0) {
        throw new Error("delete 至少需要 1 个 session-id。");
      }

      const operation = await deleteSessionsOperation({
        root: rootArg,
        sessionIds: rest,
        confirm: values.yes,
        trash: values.trash,
        allowActive: values["allow-active"],
      });
      if (!operation.executed) {
        io.stdout(
          asJson
            ? JSON.stringify(operation.data, null, 2)
            : `${values.trash ? "将移入回收站，未执行。\n\n" : ""}${formatPreview(operation.data.preview)}\n\n确认执行必须使用完整 UUID${operation.data.activeSessionIds.length > 0 ? "，并为 active session 加 --allow-active" : ""}。`,
        );
        return 0;
      }

      if (operation.action === "trash") {
        const result = operation.result;
        io.stdout(asJson ? JSON.stringify(result, null, 2) : formatTrashDeleteResult(result));
        return mutationExitCode(result);
      }

      const result = operation.result;
      io.stdout(asJson ? JSON.stringify(result, null, 2) : formatDeleteResult(result));
      return mutationExitCode(result);
    }

    case "restore": {
      if (rest.length !== 1) {
        throw new Error("restore 需要 1 个 trash-id-or-session-id。");
      }

      const operation = await restoreTrashOperation({ root: rootArg, id: rest[0], confirm: values.yes });
      if (!operation.executed) {
        io.stdout(
          asJson
            ? JSON.stringify(operation.data, null, 2)
            : `恢复未执行。确认执行必须使用表中的精确 trashId 后加 --yes。\n\n${formatTrashEntries(operation.data.matches)}`,
        );
        return 0;
      }

      const result = operation.result;
      io.stdout(asJson ? JSON.stringify(result, null, 2) : formatTrashRestoreResult(result));
      return mutationExitCode(result);
    }

    case "purge": {
      if (rest.length !== 1) {
        throw new Error("purge 需要 1 个 trash-id-or-session-id。");
      }

      const operation = await purgeTrashOperation({ root: rootArg, id: rest[0], confirm: values.yes });
      if (!operation.executed) {
        io.stdout(
          asJson
            ? JSON.stringify(operation.data, null, 2)
            : `永久清除未执行。确认执行必须使用表中的精确 trashId 后加 --yes。\n\n${formatTrashEntries(operation.data.matches)}`,
        );
        return 0;
      }

      const result = operation.result;
      io.stdout(asJson ? JSON.stringify(result, null, 2) : formatTrashPurgeResult(result));
      return mutationExitCode(result);
    }

    case "cleanup-index": {
      if (rest.length === 0) {
        throw new Error("cleanup-index 至少需要 1 个 session-id。");
      }

      const operation = await cleanupSessionIndexesOperation({
        root: rootArg,
        sessionIds: rest,
        confirm: values.yes,
        allowActive: values["allow-active"],
      });
      if (!operation.executed) {
        io.stdout(
          asJson
            ? JSON.stringify(operation.data, null, 2)
            : `${formatCleanupIndexPreview(operation.data.preview)}\n确认执行必须使用完整 UUID${operation.data.activeSessionIds.length > 0 ? "，并为 active session 加 --allow-active" : ""}。`,
        );
        return 0;
      }

      const result = operation.result;
      io.stdout(asJson ? JSON.stringify(result, null, 2) : formatCleanupIndexResult(result));
      return mutationExitCode(result);
    }

    case "cleanup-stale": {
      const operation = await cleanupStaleIndexesOperation({ root: rootArg, confirm: values.yes });
      if (!operation.executed) {
        io.stdout(
          asJson
            ? JSON.stringify(operation.data, null, 2)
            : formatCleanupPreview(operation.data.preview),
        );
        return 0;
      }

      const result = operation.result;
      io.stdout(asJson ? JSON.stringify(result, null, 2) : formatCleanupResult(result));
      return mutationExitCode(result);
    }

    default:
      throw new Error(`未知命令：${command}`);
  }
}
