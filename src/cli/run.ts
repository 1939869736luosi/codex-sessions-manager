import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { exportSessionBackup } from "../core/backup.js";
import {
  buildDeletePreview,
  cleanupSessionIndexes,
  cleanupStaleIndexes,
  deleteSessions,
  validateDeletion,
} from "../core/delete.js";
import { filterSessions, resolveSessions } from "../core/query.js";
import { scanCodexRoot } from "../core/scan.js";
import { readSessionTimeline } from "../core/timeline.js";
import {
  formatBackup,
  formatCleanupIndexResult,
  formatCleanupResult,
  formatDeleteResult,
  formatList,
  formatPreview,
  formatShow,
  formatVerifyResult,
} from "./format.js";

type CommandName = "scan" | "list" | "show" | "export" | "delete" | "cleanup-index" | "cleanup-stale" | "verify";

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
  codex-sessions show <session-id> [--root PATH] [--json]
  codex-sessions export <session-id> [--root PATH] [--output FILE] [--json]
  codex-sessions delete <session-id...> [--root PATH] [--json] [--yes]
  codex-sessions cleanup-index <session-id...> [--root PATH] [--json]
  codex-sessions cleanup-stale [--root PATH] [--json]
  codex-sessions verify <session-id...> [--root PATH] [--json]

Notes:
  - 默认根目录是 ~/.codex
  - delete 未带 --yes 时只展示预览，不执行删除
  - status 可选: all | active | archived | db-only | stale
`;
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
      query: { type: "string" },
      status: { type: "string" },
      limit: { type: "string" },
      output: { type: "string" },
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
  const scan = await scanCodexRoot(rootArg);

  switch (command) {
    case "scan":
    case "list": {
      const sessions = filterSessions(scan, {
        query: values.query,
        status: (values.status as "all" | "active" | "archived" | "db-only" | "stale" | undefined) ?? "all",
        limit: values.limit ? Number(values.limit) : undefined,
      });

      io.stdout(asJson ? JSON.stringify({ root: scan.root, warnings: scan.warnings, sessions }, null, 2) : formatList(scan, sessions));
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
        io.stdout(asJson ? JSON.stringify(preview, null, 2) : formatPreview(preview));
        return 0;
      }

      const result = await deleteSessions(scan, sessions);
      io.stdout(asJson ? JSON.stringify(result, null, 2) : formatDeleteResult(result));
      return 0;
    }

    case "cleanup-index": {
      if (rest.length === 0) {
        throw new Error("cleanup-index 至少需要 1 个 session-id。");
      }

      const sessions = resolveSessions(scan, rest);
      const result = await cleanupSessionIndexes(scan, sessions);
      io.stdout(asJson ? JSON.stringify(result, null, 2) : formatCleanupIndexResult(result));
      return 0;
    }

    case "cleanup-stale": {
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
