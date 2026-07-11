import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const parserPath = path.join(repositoryRoot, "scripts/verify-candidate-compare-log.mjs");
const temporaryDirectories: string[] = [];

async function parseLog(log: string, version = "0.6.3", candidateRunId = "30000000000") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "csm-recovery-log-"));
  temporaryDirectories.push(directory);
  const logPath = path.join(directory, "candidate.log");
  const statePath = path.join(directory, "state.json");
  await writeFile(logPath, log, "utf8");
  await writeFile(
    statePath,
    `${JSON.stringify({
      runConclusion: "failure",
      compareStep: "failure",
      compareFailureReason: null,
      compareFailureOnlyRecovery: false,
      compareFailureVersion: null,
      candidateJobLogSha256: null,
    })}\n`,
    "utf8",
  );
  const result = spawnSync(
    process.execPath,
    [parserPath, "--log", logPath, "--state", statePath, "--version", version, "--candidate-run-id", candidateRunId],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
  return { result, state };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("npm candidate compare-log recovery parser", () => {
  it("accepts only the final attempt when it ends in an exact-version ETARGET", async () => {
    const { result, state } = await parseLog(`
CSM_REGISTRY_COMPARE_ATTEMPT_START attempt=1 version=0.6.3
npm error code ETARGET
npm error notarget No matching version found for codex-sessions-manager@0.6.3.
CSM_REGISTRY_COMPARE_ATTEMPT_FAILURE attempt=1 reason=ETARGET version=0.6.3
CSM_REGISTRY_COMPARE_ATTEMPT_START attempt=2 version=0.6.3
npm error code ETARGET
npm error notarget No matching version found for codex-sessions-manager@0.6.3.
CSM_REGISTRY_COMPARE_ATTEMPT_FAILURE attempt=2 reason=ETARGET version=0.6.3
`);
    expect(result.status).toBe(0);
    expect(state.compareFailureReason).toBe("ETARGET");
    expect(state.compareFailureVersion).toBe("0.6.3");
    expect(state.compareFailureOnlyRecovery).toBe(true);
    expect(state.candidateJobLogSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects an earlier ETARGET followed by a successful pack and hash mismatch", async () => {
    const { result, state } = await parseLog(`
CSM_REGISTRY_COMPARE_ATTEMPT_START attempt=1 version=0.6.3
npm error code ETARGET
npm error notarget No matching version found for codex-sessions-manager@0.6.3.
CSM_REGISTRY_COMPARE_ATTEMPT_FAILURE attempt=1 reason=ETARGET version=0.6.3
CSM_REGISTRY_COMPARE_ATTEMPT_START attempt=2 version=0.6.3
CSM_REGISTRY_COMPARE_PACK_SUCCESS attempt=2 version=0.6.3
CSM_REGISTRY_COMPARE_ATTEMPT_FAILURE attempt=2 reason=HASH_MISMATCH version=0.6.3
`);
    expect(result.status).not.toBe(0);
    expect(state.compareFailureReason).toBeNull();
    expect(state.compareFailureOnlyRecovery).toBe(false);
  });

  it("rejects a final ETARGET for another version", async () => {
    const { result } = await parseLog(`
CSM_REGISTRY_COMPARE_ATTEMPT_START attempt=1 version=0.6.4
npm error code ETARGET
npm error notarget No matching version found for codex-sessions-manager@0.6.4.
CSM_REGISTRY_COMPARE_ATTEMPT_FAILURE attempt=1 reason=ETARGET version=0.6.4
`);
    expect(result.status).not.toBe(0);
  });

  it("accepts the single-attempt legacy 0.6.3 incident only for its exact run", async () => {
    const legacyLog = `
npm pack "codex-sessions-manager@\${PACKAGE_VERSION}" --pack-destination
npm error code ETARGET
npm error notarget No matching version found for codex-sessions-manager@0.6.3.
`;
    const accepted = await parseLog(legacyLog, "0.6.3", "29150488700");
    expect(accepted.result.status).toBe(0);
    const rejected = await parseLog(legacyLog, "0.6.3", "29150488701");
    expect(rejected.result.status).not.toBe(0);
  });
});
