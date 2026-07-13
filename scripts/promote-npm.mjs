#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const packageName = "codex-sessions-manager";
const repository = "1939869736luosi/codex-sessions-manager";
const publicRegistry = "https://registry.npmjs.org/";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function required(value, name, pattern) {
  if (!value || !pattern.test(value)) fail(`${name} is missing or invalid.`);
  return value;
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    fail(result.stderr?.trim() || `${command} ${args.join(" ")} failed.`);
  }
  return result.stdout?.trim() ?? "";
}

function npmEnvironment() {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (
      key.toLowerCase().startsWith("npm_config_")
      || ["node_auth_token", "npm_token", "npm_auth_token"].includes(key.toLowerCase())
    ) {
      delete environment[key];
    }
  }
  return environment;
}

function npmArguments(args, cacheDirectory, userConfig, globalConfig) {
  return [
    ...args,
    `--registry=${publicRegistry}`,
    "--userconfig", userConfig,
    "--globalconfig", globalConfig,
    "--prefer-online",
    "--cache", cacheDirectory,
  ];
}

function runNpm(args, cacheDirectory, userConfig, globalConfig, workingDirectory, options = {}) {
  return run("npm", npmArguments(args, cacheDirectory, userConfig, globalConfig), {
    ...options,
    cwd: workingDirectory,
    env: npmEnvironment(),
  });
}

function readVersion(specification, cacheDirectory, userConfig, globalConfig, workingDirectory) {
  return JSON.parse(runNpm(
    ["view", specification, "version", "--json"],
    cacheDirectory,
    userConfig,
    globalConfig,
    workingDirectory,
  ));
}

function readTags(cacheDirectory, userConfig, globalConfig, workingDirectory) {
  const result = spawnSync("npm", npmArguments(
    ["view", packageName, "dist-tags", "--json"],
    cacheDirectory,
    userConfig,
    globalConfig,
  ), { encoding: "utf8", cwd: workingDirectory, env: npmEnvironment() });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

const versionPattern = /^\d+\.\d+\.\d+$/u;
const shaPattern = /^[0-9a-f]{64}$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const integerPattern = /^\d+$/u;
const version = required(argument("--version"), "--version", versionPattern);
const expectedLatest = required(argument("--expected-latest"), "--expected-latest", versionPattern);
if (compareVersions(version, expectedLatest) <= 0) {
  fail(`Refusing to promote ${version}: it must be newer than current latest ${expectedLatest}.`);
}
const expectedSha256 = required(argument("--expected-sha256"), "--expected-sha256", shaPattern);
const tag = required(argument("--tag"), "--tag", new RegExp(`^v${version.replaceAll(".", "\\.")}$`, "u"));
const expectedCommit = required(argument("--expected-commit"), "--expected-commit", commitPattern);
const expectedVerificationCommit = required(
  argument("--expected-verification-commit"),
  "--expected-verification-commit",
  commitPattern,
);
const candidateRunId = required(argument("--candidate-run-id"), "--candidate-run-id", integerPattern);
const verificationRunId = required(argument("--verification-run-id"), "--verification-run-id", integerPattern);
const npmUserConfigSource = path.resolve(required(argument("--npm-userconfig"), "--npm-userconfig", /^.+$/u));
const npmUserConfigStat = lstatSync(npmUserConfigSource, { throwIfNoEntry: false });
if (!npmUserConfigStat?.isFile() || npmUserConfigStat.isSymbolicLink()) {
  fail("--npm-userconfig must identify a regular, non-symlinked file created for this promotion.");
}

const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "csm-npm-promotion-"));
let temporaryDirectoryRemoved = false;
let interactiveNpmChild = null;
const signalExitCodes = new Map([["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]]);
const signalHandlers = new Map();
function removeTemporaryDirectory() {
  if (temporaryDirectoryRemoved) return;
  temporaryDirectoryRemoved = true;
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
function removeSignalHandlers() {
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
}
for (const [signal, number] of signalExitCodes) {
  const handler = () => {
    interactiveNpmChild?.kill(signal);
    removeTemporaryDirectory();
    removeSignalHandlers();
    process.exit(128 + number);
  };
  signalHandlers.set(signal, handler);
  process.once(signal, handler);
}
process.once("exit", removeTemporaryDirectory);

try {
  const isolatedUserConfig = path.join(temporaryDirectory, "promotion.npmrc");
  writeFileSync(isolatedUserConfig, readFileSync(npmUserConfigSource), { mode: 0o600 });
  const isolatedGlobalConfig = path.join(temporaryDirectory, "global.npmrc");
  writeFileSync(isolatedGlobalConfig, "", { mode: 0o600 });
  const npmCheckCache = path.join(temporaryDirectory, "npm-check-cache");
  const configuredRegistry = runNpm(
    ["config", "get", "registry"],
    npmCheckCache,
    isolatedUserConfig,
    isolatedGlobalConfig,
    temporaryDirectory,
  );
  if (configuredRegistry !== publicRegistry) {
    fail(`npm resolved an unexpected registry: ${configuredRegistry}`);
  }
  const npmIdentity = runNpm(
    ["whoami"],
    npmCheckCache,
    isolatedUserConfig,
    isolatedGlobalConfig,
    temporaryDirectory,
  );
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(npmIdentity)) {
    fail("npm did not return a valid authenticated identity for the public registry.");
  }
  console.log(`Authenticated to the public npm registry as ${npmIdentity}.`);

  const evidenceDirectory = path.join(temporaryDirectory, "evidence");
  run("gh", [
    "run", "download", verificationRunId,
    "--repo", repository,
    "--name", `npm-registry-verification-${version}-${verificationRunId}`,
    "--dir", evidenceDirectory,
  ]);
  const report = JSON.parse(readFileSync(path.join(evidenceDirectory, "verification.json"), "utf8"));
  const expectedReport = {
    status: "passed",
    version,
    tag,
    expectedCommit,
    candidateRunId,
    verificationRunId,
    expectedSha256,
    sourceSha256: expectedSha256,
    registrySha256: expectedSha256,
    securityVerify: version,
    latestBefore: expectedLatest,
    latestAfter: expectedLatest,
    workflowPath: ".github/workflows/verify-npm-registry.yml",
    workflowRef: "main",
  };
  for (const [key, value] of Object.entries(expectedReport)) {
    if (String(report[key]) !== String(value)) fail(`verification evidence mismatch: ${key}`);
  }
  if (
    report.provenanceMetadataPresent !== true
    || report.smoke?.cli !== true
    || report.smoke?.mcp !== true
    || report.smoke?.doctor !== true
    || report.candidate?.publish !== true
    || report.candidate?.replication !== true
    || report.candidate?.registrySmoke !== true
  ) {
    fail("verification evidence is missing provenance or smoke results.");
  }
  if (
    report.candidate.runConclusion === "success"
      ? report.candidate.compareStep !== "success"
      : report.candidate.runConclusion === "failure"
        ? report.candidate.compareStep !== "failure"
          || report.candidate.compareFailureReason !== "ETARGET"
          || report.candidate.compareFailureOnlyRecovery !== true
          || report.candidate.compareFailureVersion !== version
        : true
  ) {
    fail("candidate evidence does not prove an accepted publish/compare outcome.");
  }

  const verificationRun = JSON.parse(run("gh", ["api", `repos/${repository}/actions/runs/${verificationRunId}`]));
  const verificationWorkflow = JSON.parse(run("gh", [
    "api", `repos/${repository}/actions/workflows/verify-npm-registry.yml`,
  ]));
  const verifierMainComparison = JSON.parse(run("gh", [
    "api", `repos/${repository}/compare/${expectedVerificationCommit}...main`,
  ]));
  if (
    verificationRun.status !== "completed"
    || verificationRun.conclusion !== "success"
    || verificationRun.event !== "workflow_dispatch"
    || verificationRun.path !== report.workflowPath
    || verificationRun.head_branch !== "main"
    || verificationRun.head_sha !== expectedVerificationCommit
    || report.workflowCommit !== expectedVerificationCommit
    || verificationRun.workflow_id !== verificationWorkflow.id
    || !["ahead", "identical"].includes(verifierMainComparison.status)
  ) {
    fail("live verification run identity does not match the evidence.");
  }
  const candidateRun = JSON.parse(run("gh", ["api", `repos/${repository}/actions/runs/${candidateRunId}`]));
  if (
    candidateRun.status !== "completed"
    || candidateRun.event !== "push"
    || candidateRun.path !== ".github/workflows/release.yml"
    || candidateRun.head_sha !== expectedCommit
    || candidateRun.head_branch !== tag
    || candidateRun.conclusion !== report.candidate?.runConclusion
  ) {
    fail("live candidate run identity does not match the reviewed release.");
  }
  const liveTagCommit = JSON.parse(run("gh", ["api", `repos/${repository}/commits/${tag}`])).sha;
  if (liveTagCommit !== expectedCommit) fail("live immutable tag no longer identifies the reviewed commit.");

  const registryPackDirectory = path.join(temporaryDirectory, "registry-pack");
  mkdirSync(registryPackDirectory, { recursive: true });
  const packResult = JSON.parse(runNpm([
    "pack", `${packageName}@${version}`, "--ignore-scripts", "--json", "--pack-destination", registryPackDirectory,
  ], path.join(temporaryDirectory, "pack-cache"), isolatedUserConfig, isolatedGlobalConfig, temporaryDirectory));
  const registryTarball = path.join(registryPackDirectory, packResult[0]?.filename ?? "");
  if (sha256(registryTarball) !== expectedSha256) fail("fresh registry tarball SHA-256 does not match reviewed evidence.");

  const candidate = readVersion(
    `${packageName}@security-verify`,
    path.join(temporaryDirectory, "candidate"),
    isolatedUserConfig,
    isolatedGlobalConfig,
    temporaryDirectory,
  );
  const currentLatest = readVersion(
    `${packageName}@latest`,
    path.join(temporaryDirectory, "latest"),
    isolatedUserConfig,
    isolatedGlobalConfig,
    temporaryDirectory,
  );
  if (candidate !== version) fail(`security-verify identifies ${candidate}, not ${version}.`);
  if (currentLatest !== expectedLatest) {
    fail(`latest changed from expected ${expectedLatest} to ${currentLatest}; rerun release verification.`);
  }

  console.log(`Verified commit, tag, independent run, tarball, provenance, smoke, and candidate ${version}.`);
  console.log(`Running: npm dist-tag add ${packageName}@${version} latest`);
  console.log("Complete the npm browser or Touch ID confirmation if prompted.");
  const promotion = await new Promise((resolve) => {
    interactiveNpmChild = spawn("npm", npmArguments(
      ["dist-tag", "add", `${packageName}@${version}`, "latest"],
      path.join(temporaryDirectory, "promotion-cache"),
      isolatedUserConfig,
      isolatedGlobalConfig,
    ), {
      stdio: "inherit",
      cwd: temporaryDirectory,
      env: npmEnvironment(),
    });
    interactiveNpmChild.once("error", (error) => resolve({ status: null, signal: null, error }));
    interactiveNpmChild.once("exit", (status, signal) => resolve({ status, signal, error: null }));
  });
  interactiveNpmChild = null;

  let tags = null;
  const verificationAttempts = process.env.NODE_ENV === "test"
    ? Math.max(1, Number.parseInt(process.env.CSM_PROMOTION_TEST_VERIFY_ATTEMPTS ?? "12", 10) || 12)
    : 12;
  const verificationDelayMs = process.env.NODE_ENV === "test"
    ? Math.max(0, Number.parseInt(process.env.CSM_PROMOTION_TEST_VERIFY_DELAY_MS ?? "5000", 10) || 0)
    : 5_000;
  for (let attempt = 1; attempt <= verificationAttempts; attempt += 1) {
    tags = readTags(
      path.join(temporaryDirectory, `verify-${attempt}`),
      isolatedUserConfig,
      isolatedGlobalConfig,
      temporaryDirectory,
    );
    if (tags?.latest === version && tags?.["security-verify"] === version) break;
    if (attempt < verificationAttempts) await new Promise((resolve) => setTimeout(resolve, verificationDelayMs));
  }
  if (tags?.latest !== version || tags?.["security-verify"] !== version) {
    if (promotion.status !== 0) fail("Promotion status was ambiguous and the registry did not confirm the requested tags.");
    fail(`Registry tags did not confirm ${version}: ${JSON.stringify(tags)}`);
  }

  console.log(`Verified: latest and security-verify both identify ${version}.`);
  console.log("Revoke any temporary npm token and remove temporary credentials now.");
} finally {
  removeSignalHandlers();
  removeTemporaryDirectory();
}
