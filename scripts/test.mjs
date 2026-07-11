import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const require = createRequire(import.meta.url);
const vitestCliPath = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");

async function runVitest(arguments_) {
  const child = spawn(process.execPath, [vitestCliPath, "run", ...arguments_], {
    cwd: repositoryRoot,
    stdio: "inherit",
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => {
      if (signal) {
        reject(new Error(`Vitest terminated by signal ${signal}`));
        return;
      }
      resolve(exitCode ?? 1);
    });
  });
  if (code !== 0) process.exitCode = code;
  return code;
}

// The package test invokes npm pack against the repository. Run it only after
// crash tests finish rebuilding dist so neither process observes a transient
// build directory.
const coreCode = await runVitest([
  "--exclude",
  "tests/release-config.test.ts",
  "--testTimeout=30000",
  ...process.argv.slice(2),
]);
if (coreCode === 0) {
  await runVitest(["tests/release-config.test.ts", "--testTimeout=30000", ...process.argv.slice(2)]);
}
