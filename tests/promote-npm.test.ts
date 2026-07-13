import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];
const version = "9.9.9";
const previousVersion = "9.9.8";
const releaseCommit = "a".repeat(40);
const verifierCommit = "b".repeat(40);
const tarballContents = "reviewed registry tarball";
const tarballSha256 = createHash("sha256").update(tarballContents).digest("hex");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

interface HarnessOptions {
  candidateEvent?: string;
  promotionFails?: boolean;
  tagsConverge?: boolean;
  candidateRecovery?: boolean;
}

async function createHarness(options: HarnessOptions = {}) {
  const {
    candidateEvent = "push",
    promotionFails = false,
    tagsConverge = true,
    candidateRecovery = false,
  } = options;
  const directory = await mkdtemp(path.join(tmpdir(), "csm-promote-test-"));
  temporaryDirectories.push(directory);
  const binDirectory = path.join(directory, "bin");
  const logPath = path.join(directory, "commands.jsonl");
  const userConfig = path.join(directory, "promotion.npmrc");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(binDirectory, { recursive: true }));
  await writeFile(userConfig, "//registry.npmjs.org/:_authToken=fake-test-token\n", { mode: 0o600 });

  const npmScript = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const userConfig = args.includes("--userconfig") ? args[args.indexOf("--userconfig") + 1] : null;
const globalConfig = args.includes("--globalconfig") ? args[args.indexOf("--globalconfig") + 1] : null;
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify({
  command: "npm",
  args,
  cwd: process.cwd(),
  registryEnv: process.env.NPM_CONFIG_REGISTRY ?? null,
  userconfigEnv: process.env.NPM_CONFIG_USERCONFIG ?? null,
  globalconfigEnv: process.env.NPM_CONFIG_GLOBALCONFIG ?? null,
  mixedCaseConfigEnv: process.env.nPm_CoNfIg_FuNd ?? null,
  nodeAuthToken: process.env.NODE_AUTH_TOKEN ?? null,
  npmToken: process.env.NPM_TOKEN ?? null,
  userConfigContents: userConfig ? fs.readFileSync(userConfig, "utf8") : null,
  globalConfigContents: globalConfig ? fs.readFileSync(globalConfig, "utf8") : null,
}) + "\\n");
if (args[0] === "config" && args[1] === "get" && args[2] === "registry") process.stdout.write("https://registry.npmjs.org/\\n");
else if (args[0] === "whoami") process.stdout.write("test-maintainer\\n");
else if (args[0] === "pack") {
  const destination = args[args.indexOf("--pack-destination") + 1];
  const filename = "codex-sessions-manager-${version}.tgz";
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, filename), ${JSON.stringify(tarballContents)});
  process.stdout.write(JSON.stringify([{ filename }]));
} else if (args[0] === "view" && args[2] === "version") {
  process.stdout.write(JSON.stringify(args[1].endsWith("@latest") ? ${JSON.stringify(previousVersion)} : ${JSON.stringify(version)}));
} else if (args[0] === "view" && args[1] === "codex-sessions-manager" && args[2] === "dist-tags") {
  process.stdout.write(JSON.stringify({ latest: ${JSON.stringify(tagsConverge ? version : previousVersion)}, "security-verify": ${JSON.stringify(version)} }));
} else if (args[0] === "dist-tag" && args[1] === "add") {
  if (process.env.BLOCK_DIST_TAG === "1") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  ${promotionFails ? "process.stderr.write('simulated ambiguous failure\\n'); process.exit(1);" : "process.stdout.write('ok\\n');"}
}
else { process.stderr.write("unexpected npm command: " + args.join(" ")); process.exit(2); }
`;

  const report = {
    status: "passed",
    version,
    tag: `v${version}`,
    expectedCommit: releaseCommit,
    candidateRunId: "101",
    verificationRunId: "202",
    expectedSha256: tarballSha256,
    sourceSha256: tarballSha256,
    registrySha256: tarballSha256,
    securityVerify: version,
    latestBefore: previousVersion,
    latestAfter: previousVersion,
    workflowPath: ".github/workflows/verify-npm-registry.yml",
    workflowRef: "main",
    workflowCommit: verifierCommit,
    provenanceMetadataPresent: true,
    smoke: { cli: true, mcp: true, doctor: true },
    candidate: {
      publish: true,
      replication: true,
      registrySmoke: true,
      runConclusion: candidateRecovery ? "failure" : "success",
      compareStep: candidateRecovery ? "failure" : "success",
      compareFailureReason: candidateRecovery ? "ETARGET" : undefined,
      compareFailureOnlyRecovery: candidateRecovery || undefined,
      compareFailureVersion: candidateRecovery ? version : undefined,
    },
  };
  const ghScript = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.COMMAND_LOG, JSON.stringify({ command: "gh", args, cwd: process.cwd() }) + "\\n");
if (args[0] === "run" && args[1] === "download") {
  const destination = args[args.indexOf("--dir") + 1];
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "verification.json"), ${JSON.stringify(JSON.stringify(report))});
  process.exit(0);
}
const endpoint = args[1];
let response;
if (endpoint.endsWith("/actions/runs/202")) response = { status: "completed", conclusion: "success", event: "workflow_dispatch", path: ".github/workflows/verify-npm-registry.yml", head_branch: "main", head_sha: ${JSON.stringify(verifierCommit)}, workflow_id: 77 };
else if (endpoint.endsWith("/actions/workflows/verify-npm-registry.yml")) response = { id: 77 };
else if (endpoint.includes("/compare/")) response = { status: "identical" };
else if (endpoint.endsWith("/actions/runs/101")) response = { status: "completed", conclusion: ${JSON.stringify(candidateRecovery ? "failure" : "success")}, event: ${JSON.stringify(candidateEvent)}, path: ".github/workflows/release.yml", head_branch: "v${version}", head_sha: ${JSON.stringify(releaseCommit)} };
else if (endpoint.endsWith("/commits/v${version}")) response = { sha: ${JSON.stringify(releaseCommit)} };
else { process.stderr.write("unexpected gh endpoint: " + endpoint); process.exit(2); }
process.stdout.write(JSON.stringify(response));
`;

  for (const [name, contents] of [["npm", npmScript], ["gh", ghScript]] as const) {
    const executable = path.join(binDirectory, name);
    await writeFile(executable, contents);
    await chmod(executable, 0o755);
  }

  return { directory, binDirectory, logPath, userConfig };
}

function promotionArgs(harness: Awaited<ReturnType<typeof createHarness>>) {
  return [
    "scripts/promote-npm.mjs",
    "--version", version,
    "--expected-latest", previousVersion,
    "--expected-sha256", tarballSha256,
    "--tag", `v${version}`,
    "--expected-commit", releaseCommit,
    "--expected-verification-commit", verifierCommit,
    "--candidate-run-id", "101",
    "--verification-run-id", "202",
    "--npm-userconfig", harness.userConfig,
  ];
}

function promotionEnvironment(harness: Awaited<ReturnType<typeof createHarness>>) {
  return {
    ...process.env,
    PATH: `${harness.binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    COMMAND_LOG: harness.logPath,
    TMPDIR: harness.directory,
    NODE_ENV: "test",
    CSM_PROMOTION_TEST_VERIFY_ATTEMPTS: "2",
    CSM_PROMOTION_TEST_VERIFY_DELAY_MS: "0",
    NPM_CONFIG_REGISTRY: "https://attacker.invalid/",
    NPM_CONFIG_USERCONFIG: path.join(harness.directory, "attacker.npmrc"),
    NPM_CONFIG_GLOBALCONFIG: path.join(harness.directory, "attacker-global.npmrc"),
    nPm_CoNfIg_FuNd: "false",
    NODE_AUTH_TOKEN: "attacker-node-token",
    NPM_TOKEN: "attacker-npm-token",
  };
}

function runPromotion(harness: Awaited<ReturnType<typeof createHarness>>) {
  return spawnSync(process.execPath, [
    ...promotionArgs(harness),
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: promotionEnvironment(harness),
  });
}

interface RecordedCommand {
  command: string;
  args: string[];
  cwd: string;
  registryEnv?: string | null;
  userconfigEnv?: string | null;
  globalconfigEnv?: string | null;
  mixedCaseConfigEnv?: string | null;
  nodeAuthToken?: string | null;
  npmToken?: string | null;
  userConfigContents?: string | null;
  globalConfigContents?: string | null;
}

async function readCommands(logPath: string): Promise<RecordedCommand[]> {
  const contents = await readFile(logPath, "utf8");
  return contents.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

describe("local npm promotion", () => {
  it("pins every npm read and write to the public registry with an isolated user config", async () => {
    const harness = await createHarness();
    const sourceBefore = await readFile(harness.userConfig);
    const sourceModeBefore = (await stat(harness.userConfig)).mode & 0o777;
    const result = runPromotion(harness);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const npmCommands = (await readCommands(harness.logPath)).filter((entry) => entry.command === "npm");
    expect(npmCommands.some((entry) => entry.args.slice(0, 3).join(" ") === "config get registry")).toBe(true);
    expect(npmCommands.some((entry) => entry.args[0] === "whoami")).toBe(true);
    expect(npmCommands.some((entry) => entry.args[0] === "dist-tag" && entry.args[1] === "add")).toBe(true);
    const isolatedUserConfigs = new Set<string>();
    const isolatedGlobalConfigs = new Set<string>();
    for (const command of npmCommands) {
      expect(command.args).toContain("--registry=https://registry.npmjs.org/");
      const userConfigIndex = command.args.indexOf("--userconfig");
      const globalConfigIndex = command.args.indexOf("--globalconfig");
      expect(userConfigIndex).toBeGreaterThanOrEqual(0);
      expect(globalConfigIndex).toBeGreaterThanOrEqual(0);
      isolatedUserConfigs.add(command.args[userConfigIndex + 1]!);
      isolatedGlobalConfigs.add(command.args[globalConfigIndex + 1]!);
      expect(command.cwd).not.toBe(repositoryRoot);
      expect(command.registryEnv).toBeNull();
      expect(command.userconfigEnv).toBeNull();
      expect(command.globalconfigEnv).toBeNull();
      expect(command.mixedCaseConfigEnv).toBeNull();
      expect(command.nodeAuthToken).toBeNull();
      expect(command.npmToken).toBeNull();
      expect(command.userConfigContents).toBe(sourceBefore.toString("utf8"));
      expect(command.globalConfigContents).toBe("");
    }
    expect([...isolatedUserConfigs]).toHaveLength(1);
    expect([...isolatedGlobalConfigs]).toHaveLength(1);
    expect([...isolatedUserConfigs][0]).not.toBe(harness.userConfig);
    expect([...isolatedGlobalConfigs][0]).not.toBe(harness.userConfig);
    expect(path.basename(path.dirname([...isolatedUserConfigs][0]!))).toMatch(/^csm-npm-promotion-/u);
    expect(path.dirname([...isolatedGlobalConfigs][0]!)).toBe(path.dirname([...isolatedUserConfigs][0]!));
    expect(await readFile(harness.userConfig)).toEqual(sourceBefore);
    expect((await stat(harness.userConfig)).mode & 0o777).toBe(sourceModeBefore);
  });

  it("rejects a candidate run that was not triggered by a tag push before changing dist-tags", async () => {
    const harness = await createHarness({ candidateEvent: "workflow_dispatch" });
    const result = runPromotion(harness);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("live candidate run identity");
    const commands = await readCommands(harness.logPath);
    expect(commands.some((entry) => entry.command === "npm" && entry.args[0] === "dist-tag")).toBe(false);
    expect((await readdir(harness.directory)).some((name) => name.startsWith("csm-npm-promotion-"))).toBe(false);
  });

  it("treats a failed dist-tag command as success only when the public registry converged", async () => {
    const converged = await createHarness({ promotionFails: true, tagsConverge: true });
    const convergedResult = runPromotion(converged);
    expect(convergedResult.status, `${convergedResult.stdout}\n${convergedResult.stderr}`).toBe(0);

    const unchanged = await createHarness({ promotionFails: true, tagsConverge: false });
    const unchangedResult = runPromotion(unchanged);
    expect(unchangedResult.status).toBe(1);
    expect(unchangedResult.stderr).toContain("registry did not confirm");
  });

  it("accepts the bounded ETARGET recovery evidence", async () => {
    const harness = await createHarness({ candidateRecovery: true });
    const result = runPromotion(harness);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    it(`removes the private credential copy when interrupted by ${signal}`, async () => {
      const harness = await createHarness();
      const child = spawn(process.execPath, promotionArgs(harness), {
        cwd: repositoryRoot,
        stdio: "ignore",
        env: { ...promotionEnvironment(harness), BLOCK_DIST_TAG: "1" },
      });
      let promotionDirectory: string | undefined;
      let reachedInteractivePromotion = false;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        promotionDirectory = (await readdir(harness.directory)).find((name) => name.startsWith("csm-npm-promotion-"));
        const commands = await readFile(harness.logPath, "utf8").catch(() => "");
        reachedInteractivePromotion = commands.includes('"dist-tag"');
        if (promotionDirectory && reachedInteractivePromotion) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(promotionDirectory).toBeDefined();
      expect(reachedInteractivePromotion).toBe(true);
      expect(child.kill(signal)).toBe(true);
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      expect((await readdir(harness.directory)).some((name) => name.startsWith("csm-npm-promotion-"))).toBe(false);
    });
  }
});
