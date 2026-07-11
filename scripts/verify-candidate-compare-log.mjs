#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) fail("invalid parser arguments");
    values.set(name, value);
  }
  return values;
}

const argumentsMap = readArguments(process.argv.slice(2));
const logPath = argumentsMap.get("--log");
const statePath = argumentsMap.get("--state");
const version = argumentsMap.get("--version");
const candidateRunId = argumentsMap.get("--candidate-run-id");
if (!logPath || !statePath || !version || !candidateRunId) fail("missing parser argument");
if (!/^\d+\.\d+\.\d+$/u.test(version)) fail("invalid version");
if (!/^\d+$/u.test(candidateRunId)) fail("invalid candidate run ID");

const log = fs.readFileSync(logPath, "utf8");
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
if (state.runConclusion !== "failure" || state.compareStep !== "failure") fail("candidate state is not a failed compare");

const markerPrefix = "CSM_REGISTRY_COMPARE_ATTEMPT_START ";
const markerIndex = log.lastIndexOf(markerPrefix);
let compareLog;

if (markerIndex >= 0) {
  compareLog = log.slice(markerIndex);
  const firstLine = compareLog.split(/\r?\n/u, 1)[0];
  const match = firstLine.match(/^CSM_REGISTRY_COMPARE_ATTEMPT_START attempt=(\d+) version=(\d+\.\d+\.\d+)$/u);
  if (!match) fail("invalid final compare attempt marker");
  const [, attempt, markerVersion] = match;
  if (markerVersion !== version) fail("final compare attempt version mismatch");
  const recoveryMarker = `CSM_REGISTRY_COMPARE_ATTEMPT_FAILURE attempt=${attempt} reason=ETARGET version=${version}`;
  const packSuccessMarker = `CSM_REGISTRY_COMPARE_PACK_SUCCESS attempt=${attempt} version=${version}`;
  const hashMismatchMarker = `CSM_REGISTRY_COMPARE_ATTEMPT_FAILURE attempt=${attempt} reason=HASH_MISMATCH version=${version}`;
  if (!compareLog.includes(recoveryMarker)) fail("final compare attempt was not an ETARGET failure");
  if (compareLog.includes(packSuccessMarker) || compareLog.includes(hashMismatchMarker)) {
    fail("final compare attempt downloaded bytes or reached a hash mismatch");
  }
} else {
  if (version !== "0.6.3" || candidateRunId !== "29150488700") fail("legacy recovery is restricted to the known 0.6.3 incident");
  const legacyCommand = "npm pack \"codex-sessions-manager@${PACKAGE_VERSION}\"";
  const legacyIndex = log.lastIndexOf(legacyCommand);
  if (legacyIndex < 0) fail("legacy compare command was not found");
  compareLog = log.slice(legacyIndex);
}

const exactNotarget = `npm error notarget No matching version found for codex-sessions-manager@${version}.`;
if (!compareLog.includes("npm error code ETARGET")) fail("final compare attempt did not contain ETARGET");
if (!compareLog.includes(exactNotarget)) fail("final compare attempt did not contain the exact-version notarget error");

state.compareFailureReason = "ETARGET";
state.compareFailureOnlyRecovery = true;
state.compareFailureVersion = version;
state.candidateJobLogSha256 = crypto.createHash("sha256").update(log).digest("hex");
fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
