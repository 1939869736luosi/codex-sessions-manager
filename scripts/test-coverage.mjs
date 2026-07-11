import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

let providerAvailable = true;
try {
  require.resolve("@vitest/coverage-v8/package.json");
} catch {
  providerAvailable = false;
  console.error(
    "Coverage provider missing: add @vitest/coverage-v8 at the same version as Vitest before using test:coverage.",
  );
  process.exitCode = 1;
}

async function runVitest(arguments_) {
  const vitestPackagePath = require.resolve("vitest/package.json");
  const vitestCliPath = path.join(path.dirname(vitestPackagePath), "vitest.mjs");
  const child = spawn(process.execPath, [vitestCliPath, "run", ...arguments_], {
    stdio: "inherit",
  });

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Vitest terminated by signal ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (providerAvailable) {
  const forwardedArguments = process.argv.slice(2);
  const coverageCode = await runVitest([
    "--exclude",
    "tests/release-config.test.ts",
    "--coverage",
    "--coverage.reporter=text",
    "--coverage.include=src/**/*.ts",
    "--coverage.exclude=tests/helpers/**",
    "--coverage.thresholds.lines=80",
    "--coverage.thresholds.functions=80",
    "--coverage.thresholds.branches=80",
    "--coverage.thresholds.statements=80",
    "--maxWorkers=1",
    "--testTimeout=60000",
    ...forwardedArguments,
  ]);
  if (coverageCode !== 0) {
    process.exitCode = coverageCode;
  } else {
    process.exitCode = await runVitest([
      "tests/release-config.test.ts",
      "--testTimeout=30000",
      ...forwardedArguments,
    ]);
  }
}
