import { spawn } from "node:child_process";
import { chmod, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const distDirectory = path.join(repositoryRoot, "dist");
const require = createRequire(import.meta.url);
const tscPath = require.resolve("typescript/bin/tsc");

function runTypeScriptCompiler() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tscPath, "-p", path.join(repositoryRoot, "tsconfig.json")], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`TypeScript compiler terminated by signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`TypeScript compiler exited with code ${code ?? "unknown"}`));
        return;
      }
      resolve();
    });
  });
}

await rm(distDirectory, { recursive: true, force: true });
await runTypeScriptCompiler();

if (process.platform !== "win32") {
  await Promise.all([
    chmod(path.join(distDirectory, "cli", "index.js"), 0o755),
    chmod(path.join(distDirectory, "mcp", "server.js"), 0o755),
  ]);
}
