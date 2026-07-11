import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const allowMissingDist = process.argv.includes("--allow-missing-dist");
const npmCacheDirectory = mkdtempSync(path.join(tmpdir(), "codex-sessions-pack-cache-"));
process.once("exit", () => {
  rmSync(npmCacheDirectory, { recursive: true, force: true });
});

const allowedFiles = new Set([
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "SKILL.md",
  "agents/openai.yaml",
  "docs/SAFETY.md",
  "docs/SKILL_DETAIL.md",
  "docs/UNKNOWN_GLOBAL_STATE_RULES.md",
  "examples/codex-sessions-manager.SKILL.md",
  "package.json",
  "adapters/amp/README.md",
  "adapters/amp/mcp.json",
  "adapters/claude-code/README.md",
  "adapters/codex/README.md",
  "adapters/cursor/README.md",
  "adapters/cursor/mcp.json.example",
  "adapters/factory-droid/README.md",
  "skills/codex-sessions-manager/SKILL.md",
  "skills/codex-sessions-manager/docs/SAFETY.md",
  "skills/codex-sessions-manager/docs/SKILL_DETAIL.md",
]);
const allowedDistPath = /^dist\/(?:[a-z0-9-]+\/)*[a-z0-9-]+(?:\.js(?:\.map)?|\.d\.ts)$/u;
const requiredRuntimeFiles = ["dist/cli/index.js", "dist/mcp/server.js"];
const privatePathPatterns = [
  /(^|\/)session-exports(\/|$)/iu,
  /(^|\/)docs\/local(\/|$)/iu,
  /(^|\/)private-archives(\/|$)/iu,
  /(^|\/)advisory-drafts(\/|$)/iu,
  /(^|\/)compat\/runs\/private(\/|$)/iu,
  /(^|\/)security_best_practices_report\.md$/iu,
  /\.tar\.gpg(?:\.sha256)?$/iu,
];
const privateContentPatterns = [
  { label: "macOS user home path", pattern: /\/Users\/[^/\s]+\//u },
  { label: "Windows user home path", pattern: /[A-Za-z]:\\Users\\[^\\\r\n]+\\/u },
  { label: "private session export path", pattern: /(^|[\s"'`])session-exports\//iu },
  { label: "private security report name", pattern: /security_best_practices_report\.md/iu },
];

function runNpmPack() {
  const npmArguments = ["pack", "--dry-run", "--json", "--ignore-scripts"];
  const npmEnvironment = {
    ...process.env,
    npm_config_cache: npmCacheDirectory,
    npm_config_update_notifier: "false",
  };
  if (process.env.npm_execpath) {
    return spawnSync(process.execPath, [process.env.npm_execpath, ...npmArguments], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: npmEnvironment,
    });
  }

  return spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", npmArguments, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: npmEnvironment,
  });
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

const packResult = runNpmPack();
if (packResult.error) {
  throw packResult.error;
}
if (packResult.status !== 0) {
  process.stderr.write(packResult.stderr);
  throw new Error(`npm pack --dry-run failed with exit code ${packResult.status ?? "unknown"}`);
}

let manifest;
try {
  manifest = JSON.parse(packResult.stdout);
} catch (error) {
  process.stderr.write(packResult.stdout);
  throw new Error(`npm pack returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
}

const files = manifest[0]?.files;
if (!Array.isArray(files)) {
  throw new Error("npm pack did not return a file manifest");
}

const packagedPaths = files.map((entry) => String(entry.path).replaceAll("\\", "/"));
const unexpectedPaths = packagedPaths.filter(
  (filePath) => !allowedFiles.has(filePath) && !allowedDistPath.test(filePath),
);
const privatePaths = packagedPaths.filter((filePath) => privatePathPatterns.some((pattern) => pattern.test(filePath)));
const missingRuntimeFiles = allowMissingDist
  ? []
  : requiredRuntimeFiles.filter((filePath) => !packagedPaths.includes(filePath));
const privateContentFindings = [];
const binaryContentFindings = [];
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
for (const filePath of packagedPaths) {
  const absolutePath = path.join(repositoryRoot, filePath);
  if (!statSync(absolutePath).isFile()) continue;
  const bytes = readFileSync(absolutePath);
  let text;
  try {
    if (
      bytes.includes(0)
      || (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)))
    ) {
      throw new Error("NUL or UTF-16 marker");
    }
    text = utf8Decoder.decode(bytes);
    if (/[^\t\n\r\x20-\x7e\u0080-\u{10ffff}]/u.test(text)) {
      throw new Error("unsupported control character");
    }
  } catch {
    binaryContentFindings.push(filePath);
    continue;
  }
  for (const check of privateContentPatterns) {
    if (check.pattern.test(text)) {
      privateContentFindings.push(`${filePath}: ${check.label}`);
    }
  }
}

if (unexpectedPaths.length > 0) {
  fail(`Package contains paths outside the public allowlist:\n${unexpectedPaths.join("\n")}`);
}
if (privatePaths.length > 0) {
  fail(`Package contains private material:\n${privatePaths.join("\n")}`);
}
if (missingRuntimeFiles.length > 0) {
  fail(`Package is missing runtime entrypoints:\n${missingRuntimeFiles.join("\n")}`);
}
if (privateContentFindings.length > 0) {
  fail(`Package contains private-looking content:\n${privateContentFindings.join("\n")}`);
}
if (binaryContentFindings.length > 0) {
  fail(`Package contains non-UTF-8 or binary content:\n${binaryContentFindings.join("\n")}`);
}

if (process.exitCode !== 1) {
  console.log(`Package manifest check passed (${packagedPaths.length} files).`);
}
