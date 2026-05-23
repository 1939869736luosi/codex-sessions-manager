import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { buildRootDeletePreview, buildRootResidueAudit, buildSessionResidueAudit } from "../core/audit.js";
import { exportSessionBackup } from "../core/backup.js";
import { inspectCodexRoot } from "../core/doctor.js";
import {
  buildDeletePreview,
  cleanupSessionIndexes,
  cleanupStaleIndexes,
  deleteSessions,
  previewCleanupSessionIndexes,
  previewCleanupStaleIndexes,
  validateDeletion,
} from "../core/delete.js";
import { buildSessionFamilyQuery } from "../core/family.js";
import { listProjectSummaries } from "../core/project.js";
import { filterSessions, resolveSessions } from "../core/query.js";
import { scanCodexRoot } from "../core/scan.js";
import { summarizeSources } from "../core/sources.js";
import { readSessionTimeline } from "../core/timeline.js";
import { listTrashEntries, moveSessionsToTrash, purgeTrashEntry, restoreTrashEntry } from "../core/trash.js";
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
  | "delete"
  | "trash-list"
  | "restore"
  | "purge"
  | "cleanup-index"
  | "cleanup-stale"
  | "verify";

interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

function defaultIo(): CliIo {
  return {
    stdout: (message) => console.log(message),
    stderr: (message) => console.error(message),
  };
}

export function getHelpText(): string {
  return `codex-sessions

Usage:
  codex-sessions list [--root PATH] [--json] [--query TEXT] [--status KIND] [--limit N]
                     [--project TEXT] [--group-by project]
                     [--updated-after DATE] [--updated-before DATE]
                     [--created-after DATE] [--created-before DATE]
                     [--source-kind KIND] [--source SOURCE] [--thread-source SOURCE]
                     [--agent-role ROLE] [--agent-nickname NAME]
                     [--model-provider PROVIDER] [--model MODEL]
  codex-sessions sources [--root PATH] [--json]
  codex-sessions projects [--root PATH] [--json]
  codex-sessions doctor [--root PATH] [--json]
  codex-sessions show <session-id> [--root PATH] [--json]
  codex-sessions family <session-id> [--root PATH] [--json]
                       [--children | --parents | --subagents | --impact] [--full]
                       [--source-kind KIND]
  codex-sessions audit <session-id> [--root PATH] [--json]
  codex-sessions audit-root [--root PATH] [--json] [--limit N] [--status STATUS...] [--source SOURCE...] [--all]
  codex-sessions preview-root [--root PATH] [--json] [--limit N] [--status STATUS...] [--source SOURCE...] [--all]
  codex-sessions export <session-id> [--root PATH] [--output FILE] [--json]
  codex-sessions delete <session-id...> [--root PATH] [--json] [--yes] [--trash]
  codex-sessions trash-list [--root PATH] [--json]
  codex-sessions restore <trash-id-or-session-id> [--root PATH] [--json] [--yes]
  codex-sessions purge <trash-id-or-session-id> [--root PATH] [--json] [--yes]
  codex-sessions cleanup-index <session-id...> [--root PATH] [--json] [--yes]
  codex-sessions cleanup-stale [--root PATH] [--json] [--yes]
  codex-sessions verify <session-id...> [--root PATH] [--json]

Notes:
  - 默认根目录是 ~/.codex
  - delete 未带 --yes 时只展示预览，不执行删除
  - 真正删除前应先单独预览，再显式加 --yes；family / impact 不能替代 delete preview
  - family 只读查看 parent / child / side / fork / subagent 关系，不会自动递归处理
  - family --impact 只读查看关系影响，不执行删除，不是删除建议，也不生成 --yes
  - audit 只读检查官方 UI 删除或归档后本地还剩哪些记录
  - audit-root 只读扫描整个 root 的疑似残留，默认 limit=50
  - audit-root 多个 --status 或 --source 为 OR；同时使用 status 和 source 时为 AND
  - preview-root 只读批量预览 audit-root 筛出的候选，不删除、不递归处理 family
  - delete --trash --yes 会先写入回收站，再清理 live session
  - restore 和 purge 未带 --yes 时只展示匹配的回收站记录
  - cleanup-index 和 cleanup-stale 未带 --yes 时只展示预览，不改写 JSONL
  - status 可选: all | active | archived | db-only | stale
  - source-kind 可选: subagent | mcp | vscode | cli | exec | unknown
  - sources 只读汇总 sourceKind、raw source、thread_source、model_provider、model、agent_role
  - DATE 支持 YYYY-MM-DD 或带明确时区的 ISO 字符串；YYYY-MM-DD 按本地日期整天筛选
`;
}

function normalizeOptionValues(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : value ? [value] : [];
}

async function writeBackupFile(outputPath: string, payload: unknown): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(payload, null, 2), "utf8");
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
      all: { type: "boolean", default: false },
      children: { type: "boolean", default: false },
      parents: { type: "boolean", default: false },
      subagents: { type: "boolean", default: false },
      impact: { type: "boolean", default: false },
      full: { type: "boolean", default: false },
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
      "group-by": { type: "string" },
      "updated-after": { type: "string" },
      "updated-before": { type: "string" },
      "created-after": { type: "string" },
      "created-before": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

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
    const report = await inspectCodexRoot(rootArg);
    io.stdout(asJson ? JSON.stringify(report, null, 2) : formatDoctor(report));
    return 0;
  }

  const scan = await scanCodexRoot(rootArg);

  switch (command) {
    case "scan":
    case "list": {
      const sessions = filterSessions(scan, {
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
      });

      if (values["group-by"] && values["group-by"] !== "project") {
        throw new Error(`不支持的 group-by：${values["group-by"]}`);
      }

      if (statusValues.length > 1) {
        throw new Error("list 只支持一个 --status。");
      }

      if (asJson) {
        io.stdout(
          JSON.stringify(
            {
              root: scan.root,
              warnings: scan.warnings,
              sessions,
              projectSummaries: values["group-by"] === "project" ? listProjectSummaries(sessions) : undefined,
            },
            null,
            2,
          ),
        );
      } else {
        io.stdout(values["group-by"] === "project" ? formatGroupedList(scan, sessions) : formatList(scan, sessions));
      }
      return 0;
    }

    case "sources": {
      if (rest.length !== 0) {
        throw new Error("sources 不接收 session-id。");
      }

      const summary = summarizeSources(scan.sessions);
      io.stdout(asJson ? JSON.stringify({ root: scan.root, warnings: scan.warnings, summary }, null, 2) : formatSourceSummary(scan, summary));
      return 0;
    }

    case "projects": {
      const projects = listProjectSummaries(scan.sessions);
      io.stdout(asJson ? JSON.stringify({ root: scan.root, warnings: scan.warnings, projects }, null, 2) : formatProjects(projects));
      return 0;
    }

    case "show": {
      if (rest.length !== 1) {
        throw new Error("show 需要 1 个 session-id。");
      }

      const session = resolveSessions(scan, [rest[0]])[0];
      const timeline = await readSessionTimeline(session);
      io.stdout(asJson ? JSON.stringify({ session, timeline }, null, 2) : formatShow(session, timeline));
      return 0;
    }

    case "family": {
      if (rest.length !== 1) {
        throw new Error("family 需要 1 个 session-id。");
      }

      const selectedModes = [
        values.children ? "children" : null,
        values.parents ? "parents" : null,
        values.subagents ? "subagents" : null,
        values.impact ? "impact" : null,
      ].filter((mode): mode is "children" | "parents" | "subagents" | "impact" => Boolean(mode));
      if (selectedModes.length > 1) {
        throw new Error("family 一次只能选择一个 mode：--children、--parents、--subagents 或 --impact。");
      }

      const query = buildSessionFamilyQuery(scan, rest[0], {
        mode: selectedModes[0] ?? "full",
        sourceKind: sourceKindValues,
      });
      io.stdout(
        asJson
          ? JSON.stringify({ root: scan.root, warnings: scan.warnings, ...query }, null, 2)
          : formatFamilyQuery(query, { full: Boolean(values.full) }),
      );
      return 0;
    }

    case "audit": {
      if (rest.length !== 1) {
        throw new Error("audit 需要 1 个 session-id。");
      }

      const audit = buildSessionResidueAudit(scan, rest[0]);
      io.stdout(asJson ? JSON.stringify(audit, null, 2) : formatAudit(audit));
      return 0;
    }

    case "audit-root": {
      if (rest.length !== 0) {
        throw new Error("audit-root 不接收 session-id。");
      }

      const limit = values.limit ? Number(values.limit) : undefined;
      const audit = buildRootResidueAudit(scan, {
        limit,
        includeAll: values.all,
        statuses: statusValues,
        sources: sourceValues,
      });
      io.stdout(asJson ? JSON.stringify(audit, null, 2) : formatRootResidueAudit(audit));
      return 0;
    }

    case "preview-root": {
      if (rest.length !== 0) {
        throw new Error("preview-root 不接收 session-id。");
      }
      if (values.yes) {
        throw new Error("preview-root 不支持 --yes；它始终只读，不执行删除。");
      }
      if (values.trash) {
        throw new Error("preview-root 不支持 --trash；它始终只生成 delete preview。");
      }

      const limit = values.limit ? Number(values.limit) : undefined;
      const preview = buildRootDeletePreview(scan, {
        limit,
        includeAll: values.all,
        statuses: statusValues,
        sources: sourceValues,
      });
      io.stdout(asJson ? JSON.stringify(preview, null, 2) : formatRootDeletePreview(preview));
      return 0;
    }

    case "export": {
      if (rest.length !== 1) {
        throw new Error("export 需要 1 个 session-id。");
      }

      const session = resolveSessions(scan, [rest[0]])[0];
      const bundle = await exportSessionBackup(scan, session);

      if (asJson && !values.output) {
        io.stdout(JSON.stringify(bundle, null, 2));
        return 0;
      }

      const outputPath = path.resolve(values.output ?? `${session.id}-backup.json`);
      await writeBackupFile(outputPath, bundle);
      io.stdout(formatBackup(bundle, outputPath));
      return 0;
    }

    case "delete": {
      if (rest.length === 0) {
        throw new Error("delete 至少需要 1 个 session-id。");
      }

      const sessions = resolveSessions(scan, rest);

      if (!values.yes) {
        const preview = buildDeletePreview(scan, sessions);
        io.stdout(
          asJson
            ? JSON.stringify({ preview, action: values.trash ? "trash" : "delete", requiresConfirmation: true }, null, 2)
            : `${values.trash ? "将移入回收站，未执行。\n\n" : ""}${formatPreview(preview)}`,
        );
        return 0;
      }

      if (values.trash) {
        const result = await moveSessionsToTrash(scan, sessions);
        io.stdout(asJson ? JSON.stringify(result, null, 2) : formatTrashDeleteResult(result));
        return 0;
      }

      const result = await deleteSessions(scan, sessions);
      io.stdout(asJson ? JSON.stringify(result, null, 2) : formatDeleteResult(result));
      return 0;
    }

    case "trash-list": {
      const entries = await listTrashEntries(scan.root.rootPath);
      io.stdout(asJson ? JSON.stringify({ root: scan.root, entries }, null, 2) : formatTrashEntries(entries));
      return 0;
    }

    case "restore": {
      if (rest.length !== 1) {
        throw new Error("restore 需要 1 个 trash-id-or-session-id。");
      }

      if (!values.yes) {
        const entries = await listTrashEntries(scan.root.rootPath);
        const matches = entries.filter(
          (entry) =>
            entry.trashId === rest[0] ||
            entry.trashId.startsWith(rest[0]) ||
            entry.sessionIds.includes(rest[0]) ||
            entry.sessionIds.some((sessionId) => sessionId.startsWith(rest[0])),
        );
        io.stdout(
          asJson
            ? JSON.stringify({ matches, requiresConfirmation: true }, null, 2)
            : `恢复未执行。确认后加 --yes。\n\n${formatTrashEntries(matches)}`,
        );
        return 0;
      }

      const result = await restoreTrashEntry(rootArg, rest[0]);
      io.stdout(asJson ? JSON.stringify(result, null, 2) : formatTrashRestoreResult(result));
      return 0;
    }

    case "purge": {
      if (rest.length !== 1) {
        throw new Error("purge 需要 1 个 trash-id-or-session-id。");
      }

      if (!values.yes) {
        const entries = await listTrashEntries(scan.root.rootPath);
        const matches = entries.filter(
          (entry) =>
            entry.trashId === rest[0] ||
            entry.trashId.startsWith(rest[0]) ||
            entry.sessionIds.includes(rest[0]) ||
            entry.sessionIds.some((sessionId) => sessionId.startsWith(rest[0])),
        );
        io.stdout(
          asJson
            ? JSON.stringify({ matches, requiresConfirmation: true }, null, 2)
            : `永久清除未执行。确认后加 --yes。\n\n${formatTrashEntries(matches)}`,
        );
        return 0;
      }

      const result = await purgeTrashEntry(rootArg, rest[0]);
      io.stdout(asJson ? JSON.stringify(result, null, 2) : formatTrashPurgeResult(result));
      return 0;
    }

    case "cleanup-index": {
      if (rest.length === 0) {
        throw new Error("cleanup-index 至少需要 1 个 session-id。");
      }

      const sessions = resolveSessions(scan, rest);
      if (!values.yes) {
        const preview = previewCleanupSessionIndexes(scan, sessions);
        io.stdout(
          asJson
            ? JSON.stringify({ preview, requiresConfirmation: true }, null, 2)
            : formatCleanupIndexPreview(preview),
        );
        return 0;
      }

      const result = await cleanupSessionIndexes(scan, sessions);
      io.stdout(asJson ? JSON.stringify(result, null, 2) : formatCleanupIndexResult(result));
      return 0;
    }

    case "cleanup-stale": {
      if (!values.yes) {
        const preview = previewCleanupStaleIndexes(scan);
        io.stdout(
          asJson
            ? JSON.stringify({ preview, requiresConfirmation: true }, null, 2)
            : formatCleanupPreview(preview),
        );
        return 0;
      }

      const result = await cleanupStaleIndexes(scan);
      io.stdout(asJson ? JSON.stringify(result, null, 2) : formatCleanupResult(result));
      return 0;
    }

    case "verify": {
      if (rest.length === 0) {
        throw new Error("verify 至少需要 1 个 session-id。");
      }

      const sessions = resolveSessions(scan, rest);
      const result = await validateDeletion(scan, sessions);
      io.stdout(asJson ? JSON.stringify(result, null, 2) : formatVerifyResult(result));
      return 0;
    }

    default:
      throw new Error(`未知命令：${command}`);
  }
}
