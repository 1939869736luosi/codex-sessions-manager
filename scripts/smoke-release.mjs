import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repositoryRoot, "dist", "cli", "index.js");
const mcpPath = path.join(repositoryRoot, "dist", "mcp", "server.js");
const smokeRoot = await mkdtemp(path.join(os.tmpdir(), "codex-sessions-release-smoke-"));
let client;

function assert(condition, message) {
  if (!condition) throw new Error(`Release smoke failed: ${message}`);
}

try {
  const cli = spawnSync(process.execPath, [cliPath, "doctor", "--root", smokeRoot, "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert(cli.status === 0, `CLI doctor exited ${cli.status}: ${cli.stderr}`);
  const doctor = JSON.parse(cli.stdout);
  assert(await realpath(doctor.rootPath) === await realpath(smokeRoot), "CLI doctor returned the wrong root");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpPath, "--profile", "read-only"],
    cwd: repositoryRoot,
    stderr: "pipe",
  });
  client = new Client({ name: "codex-sessions-release-smoke", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = new Set(tools.tools.map((tool) => tool.name));
  assert(toolNames.has("inspect_root"), "read-only MCP profile lacks inspect_root");
  assert(!toolNames.has("delete_sessions"), "read-only MCP profile exposed delete_sessions");

  const result = await client.callTool({ name: "inspect_root", arguments: { root: smokeRoot } });
  assert(!result.isError, "MCP inspect_root returned an error");
  const report = result.structuredContent?.report;
  assert(report && await realpath(report.rootPath) === await realpath(smokeRoot), "MCP inspect_root returned the wrong root");

  console.log("Release smoke passed for CLI and read-only MCP process entrypoints.");
} finally {
  if (client) await client.close().catch(() => undefined);
  await rm(smokeRoot, { recursive: true, force: true });
}
