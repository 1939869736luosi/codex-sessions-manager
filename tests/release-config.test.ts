import { access, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function subprocessEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  // Vitest's V8 provider assigns one coverage file per worker. npm pack starts
  // child Node processes, so inheriting this variable makes those children
  // race the worker for the same temporary coverage file.
  delete environment.NODE_V8_COVERAGE;
  return environment;
}

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

describe("release configuration", () => {
  it("keeps private session, advisory, and archive material out of Git", async () => {
    const gitignore = await readRepositoryFile(".gitignore");
    const ignoredEntries = new Set(
      gitignore
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#")),
    );

    expect(ignoredEntries).toContain("session-exports/");
    expect(ignoredEntries).toContain("security_best_practices_report.md");
    expect(ignoredEntries).toContain("private-archives/");
    expect(ignoredEntries).toContain("advisory-drafts/");
    expect(ignoredEntries).toContain("compat/runs/private/");
    expect(ignoredEntries).toContain("*.tar.gpg");
    expect(ignoredEntries).toContain("*.tar.gpg.sha256");
  });

  it("uses explicit, cross-platform release scripts and a Node 20 floor", async () => {
    const packageJson = JSON.parse(await readRepositoryFile("package.json")) as {
      engines?: { node?: string };
      files?: string[];
      scripts?: Record<string, string>;
    };

    expect(packageJson.engines?.node).toBe(">=20");
    expect(packageJson.scripts).toMatchObject({
      build: "node scripts/build.mjs",
      "compat:check": "node scripts/check-compat.mjs",
      "compat:release-check": "node scripts/check-compat.mjs --release",
      test: "node scripts/test.mjs",
      typecheck: "tsc -p tsconfig.json --noEmit",
      "test:coverage": "node scripts/test-coverage.mjs",
      "pack:check": "node scripts/check-package.mjs",
      "smoke:release": "node scripts/smoke-release.mjs",
    });
    expect(packageJson.files).toEqual(expect.arrayContaining(["dist", "README.md", "LICENSE"]));
    expect(packageJson.files).not.toEqual(expect.arrayContaining([".", "docs", "session-exports"]));

    const buildScript = await readRepositoryFile("scripts/build.mjs");
    const coverageScript = await readRepositoryFile("scripts/test-coverage.mjs");
    expect(buildScript).toContain("rm(distDirectory");
    expect(buildScript).toContain("process.platform !== \"win32\"");
    expect(buildScript).not.toContain("rm -rf");
    expect(buildScript).not.toContain("chmod +x");
    expect(coverageScript).toContain("@vitest/coverage-v8/package.json");
    expect(coverageScript).toContain("--coverage.include=src/**/*.ts");
    expect(coverageScript).toContain("--coverage.exclude=tests/helpers/**");
    expect(coverageScript).toContain("--coverage.thresholds.lines=80");
  });

  it("ships the official Codex TOML adapter and nested Skill metadata without drift", async () => {
    const adapter = await readRepositoryFile("adapters/codex/README.md");
    const rootSkill = await readRepositoryFile("SKILL.md");
    const packagedSkill = await readRepositoryFile("skills/codex-sessions-manager/SKILL.md");
    const rootOpenAiMetadata = await readRepositoryFile("agents/openai.yaml");
    const nestedOpenAiMetadata = await readRepositoryFile("skills/codex-sessions-manager/agents/openai.yaml");
    const rootDetail = await readRepositoryFile("docs/SKILL_DETAIL.md");
    const nestedDetail = await readRepositoryFile("skills/codex-sessions-manager/docs/SKILL_DETAIL.md");
    const rootSafety = await readRepositoryFile("docs/SAFETY.md");
    const nestedSafety = await readRepositoryFile("skills/codex-sessions-manager/docs/SAFETY.md");

    expect(adapter).toContain("[mcp_servers.codex-sessions]");
    expect(adapter).toContain("codex mcp add codex-sessions -- codex-sessions-mcp --profile read-only");
    expect(adapter).not.toContain('"mcpServers"');
    expect(rootSkill).toContain(".agents/skills/codex-sessions-manager");
    expect(rootSkill).toContain("$HOME/.agents/skills/codex-sessions-manager");
    expect(packagedSkill).toBe(rootSkill);
    expect(nestedOpenAiMetadata.trimEnd()).toBe(rootOpenAiMetadata.trimEnd());
    expect(nestedDetail).toBe(rootDetail);
    expect(nestedSafety).toBe(rootSafety);
  });

  it("tracks an offline compatibility baseline and report-only upstream watch", async () => {
    const baseline = JSON.parse(await readRepositoryFile("compat/upstream-baseline.json")) as {
      stableVersion?: string;
      checkedAt?: string;
      commit?: { sha?: string; url?: string };
    };
    const compatReadme = await readRepositoryFile("compat/README.md");
    const maintainerPrompt = await readRepositoryFile("compat/MAINTAINER_PROMPT.md");
    const compatWorkflow = await readRepositoryFile(".github/workflows/compat-watch.yml");

    expect(baseline).toMatchObject({
      stableVersion: "0.144.1",
      checkedAt: "2026-07-11",
      commit: {
        sha: "44918ea10c0f99151c6710411b4322c2f5c96bea",
        url: "https://github.com/openai/codex/commit/44918ea10c0f99151c6710411b4322c2f5c96bea",
      },
    });
    expect(compatReadme).toContain("Storage structure");
    expect(compatReadme).toContain("Local read-only smoke");
    expect(maintainerPrompt).toContain("maintainer-only");
    expect(compatWorkflow).toContain("schedule:");
    expect(compatWorkflow).toContain("workflow_dispatch:");
    expect(compatWorkflow).toContain("scripts/check-upstream-version.mjs");
    expect(compatWorkflow).toContain("GITHUB_TOKEN: ${{ github.token }}");
    expect(compatWorkflow).not.toContain("issues: write");
    expect(compatWorkflow).not.toContain("pull-requests: write");

    const result = spawnSync(process.execPath, ["scripts/check-compat.mjs"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: subprocessEnvironment(),
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Compatibility check passed");
  });

  it("defines the required cross-platform CI matrix", async () => {
    const workflow = await readRepositoryFile(".github/workflows/ci.yml");

    expect(workflow).toContain("os: ubuntu-latest");
    expect(workflow).toContain("node: 20");
    expect(workflow).toContain("node: 22");
    expect(workflow).toContain("node: 24");
    expect(workflow).toContain("os: macos-latest");
    expect(workflow).toContain("os: windows-latest");
    expect(workflow).toContain("npm run typecheck");
    expect(workflow).toContain("npm test");
    expect(workflow).toContain("if: runner.os != 'Windows'");
    expect(workflow).toContain("tests/windows-destructive-policy.test.ts");
    expect(workflow).toContain("tests/compat-v063.test.ts");
    expect(workflow).toContain("--testTimeout=30000");
    expect(workflow).toContain("npm run test:coverage");
    expect(workflow).toContain("npm run build");
    expect(workflow).toContain("npm run smoke:release");
    expect(workflow).toContain("npm run pack:check");
  });

  it("publishes an immutable candidate before a separately approved latest promotion", async () => {
    const releaseWorkflow = await readRepositoryFile(".github/workflows/release.yml");
    const promoteWorkflow = await readRepositoryFile(".github/workflows/promote-npm.yml");
    const verifyRegistryWorkflow = await readRepositoryFile(".github/workflows/verify-npm-registry.yml");

    expect(releaseWorkflow).toContain("tags:");
    expect(releaseWorkflow).toContain('uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6');
    expect(releaseWorkflow).toContain("id-token: write");
    expect(releaseWorkflow).toContain("npm@11.16.0");
    expect(releaseWorkflow).toContain("--tag security-verify");
    expect(releaseWorkflow).toContain("Wait for registry replication");
    expect(releaseWorkflow).toContain('npm view "codex-sessions-manager@${PACKAGE_VERSION}" version');
    expect(releaseWorkflow).toContain("for ATTEMPT in {1..12}");
    expect(releaseWorkflow).toContain("--prefer-online --cache");
    expect(releaseWorkflow).toContain("Compare the registry tarball with the reviewed tarball");
    const compareRegistryIndex = releaseWorkflow.indexOf("Compare the registry tarball with the reviewed tarball");
    const preserveEvidenceIndex = releaseWorkflow.indexOf("Preserve only the public package evidence");
    const compareRegistryBlock = releaseWorkflow.slice(compareRegistryIndex, preserveEvidenceIndex);
    expect(compareRegistryBlock).toContain("for ATTEMPT in {1..12}");
    expect(compareRegistryBlock).toContain("--prefer-online");
    expect(compareRegistryBlock).toContain("--cache");
    expect(compareRegistryBlock).toContain("--ignore-scripts");
    expect(releaseWorkflow).toContain("node scripts/check-compat.mjs --release");
    expect(releaseWorkflow).toContain("npm run compat:release-check");
    expect(releaseWorkflow).not.toContain("dist-tag add");
    expect(releaseWorkflow).toContain("needs: [release-metadata, verify-matrix, production-audit]");
    expect(releaseWorkflow).toContain('git merge-base --is-ancestor "${GITHUB_SHA}" refs/remotes/origin/main');
    expect(releaseWorkflow).toContain("os: ubuntu-latest");
    expect(releaseWorkflow).toContain("node: 20");
    expect(releaseWorkflow).toContain("node: 22");
    expect(releaseWorkflow).toContain("node: 24");
    expect(releaseWorkflow).toContain("os: macos-latest");
    expect(releaseWorkflow).toContain("os: windows-latest");
    expect(releaseWorkflow).toContain("if: runner.os != 'Windows'");
    expect(releaseWorkflow).toContain("Verify Windows read-only safety gates");
    expect(releaseWorkflow).toContain("tests/windows-destructive-policy.test.ts");
    expect(releaseWorkflow).toContain("tests/compat-v063.test.ts");
    expect(releaseWorkflow).toContain("--testTimeout=30000");
    expect(releaseWorkflow).toContain("npm run test:coverage");
    expect(releaseWorkflow).toContain("npm run smoke:release");
    expect(releaseWorkflow).toContain("CSM_REGISTRY_COMPARE_START version=${PACKAGE_VERSION}");
    expect(releaseWorkflow).toContain("npm audit --omit=dev --audit-level=high");
    const sharedConcurrencyBlock = [
      "concurrency:",
      "  group: npm-package-codex-sessions-manager",
      "  cancel-in-progress: false",
    ].join("\n");
    expect(releaseWorkflow).toContain(sharedConcurrencyBlock);

    expect(promoteWorkflow).toContain("workflow_dispatch:");
    expect(promoteWorkflow).toContain("environment: npm-production");
    expect(promoteWorkflow).toContain("NPM_DIST_TAG_TOKEN");
    expect(promoteWorkflow).toContain('dist-tag add "codex-sessions-manager@${{ inputs.version }}" latest');
    expect(promoteWorkflow).toContain("expected_sha256");
    expect(promoteWorkflow).toContain("verification_run_id");
    expect(promoteWorkflow).toContain("candidate_run_id");
    expect(promoteWorkflow).toContain("expected_commit");
    expect(promoteWorkflow).toContain("expected_latest");
    expect(promoteWorkflow).toContain("actions: read");
    expect(promoteWorkflow).toContain("Require independent registry verification evidence");
    expect(promoteWorkflow).toContain("gh run download");
    expect(promoteWorkflow).toContain("npm-registry-verification-${VERSION}-${VERIFICATION_RUN_ID}");
    expect(promoteWorkflow).toContain('run.event !== "workflow_dispatch"');
    expect(promoteWorkflow).toContain("run.head_sha !== process.env.GITHUB_SHA");
    expect(promoteWorkflow).toContain("run.head_branch !== process.env.GITHUB_REF_NAME");
    expect(promoteWorkflow).toContain("run.workflow_id !== workflow.id");
    expect(promoteWorkflow).toContain("Require live release tag identity");
    expect(promoteWorkflow).toContain('git/ref/tags/${TAG}');
    expect(promoteWorkflow).toContain('git/tags/${OBJECT_SHA}');
    expect(promoteWorkflow).toContain('test "${OBJECT_SHA}" = "${EXPECTED_COMMIT}"');
    expect(promoteWorkflow).toContain("workflowCommit");
    expect(promoteWorkflow).toContain('candidate.runConclusion === "failure"');
    expect(promoteWorkflow).toContain('candidate.compareFailureReason !== "ETARGET"');
    expect(promoteWorkflow).toContain("candidate.compareFailureVersion !== expected.version");
    expect(promoteWorkflow).toContain("candidate.candidateJobLogSha256");
    expect(promoteWorkflow).toContain('candidate.runConclusion === "success"');
    expect(promoteWorkflow).toContain("report.latestBefore !== expectedLatest");
    expect(promoteWorkflow).toContain("report.latestAfter !== expectedLatest");
    expect(promoteWorkflow).toContain("Require current latest has not changed");
    expect(promoteWorkflow).toContain('test "${CURRENT_LATEST}" = "${EXPECTED_LATEST}"');
    expect(promoteWorkflow).toContain("Wait for dist-tag replication");
    expect(promoteWorkflow).toContain("--prefer-online");
    expect(promoteWorkflow).toContain("for ATTEMPT in {1..12}");
    expect(promoteWorkflow).toContain(sharedConcurrencyBlock);
    const candidatePrecheckIndex = promoteWorkflow.indexOf("Require security-verify candidate identity");
    const verificationEvidenceIndex = promoteWorkflow.indexOf("Require independent registry verification evidence");
    const liveTagIdentityIndex = promoteWorkflow.indexOf("Require live release tag identity");
    const liveLatestIndex = promoteWorkflow.indexOf("Require current latest has not changed");
    const moveLatestIndex = promoteWorkflow.indexOf("Move latest only after exact-version verification");
    const replicationIndex = promoteWorkflow.indexOf("Wait for dist-tag replication");
    expect(candidatePrecheckIndex).toBeGreaterThan(-1);
    expect(verificationEvidenceIndex).toBeGreaterThan(-1);
    expect(verificationEvidenceIndex).toBeLessThan(moveLatestIndex);
    expect(liveTagIdentityIndex).toBeGreaterThan(verificationEvidenceIndex);
    expect(liveTagIdentityIndex).toBeLessThan(moveLatestIndex);
    expect(liveLatestIndex).toBeGreaterThan(liveTagIdentityIndex);
    expect(liveLatestIndex).toBeLessThan(moveLatestIndex);
    expect(candidatePrecheckIndex).toBeLessThan(moveLatestIndex);
    expect(moveLatestIndex).toBeLessThan(replicationIndex);
    const replicationBlock = promoteWorkflow.slice(replicationIndex);
    expect(replicationBlock).toContain("LATEST=\"$(npm view codex-sessions-manager@latest version");
    expect(replicationBlock).toContain("CANDIDATE=\"$(npm view codex-sessions-manager@security-verify version");
    expect(replicationBlock).toContain(
      'if [ "${LATEST}" = "${VERSION}" ] && [ "${CANDIDATE}" = "${VERSION}" ]; then',
    );

    expect(verifyRegistryWorkflow).toContain("workflow_dispatch:");
    for (const input of [
      "version:",
      "expected_sha256:",
      "tag:",
      "expected_commit:",
      "candidate_run_id:",
      "expected_latest:",
    ]) {
      expect(verifyRegistryWorkflow).toContain(input);
    }
    expect(verifyRegistryWorkflow).toContain("contents: read");
    expect(verifyRegistryWorkflow).toContain("actions: read");
    expect(verifyRegistryWorkflow).not.toContain("id-token: write");
    expect(verifyRegistryWorkflow).not.toContain("NODE_AUTH_TOKEN");
    expect(verifyRegistryWorkflow).not.toContain("NPM_DIST_TAG_TOKEN");
    expect(verifyRegistryWorkflow).not.toContain("packages: write");
    expect(verifyRegistryWorkflow).not.toContain("npm publish");
    expect(verifyRegistryWorkflow).not.toContain("npm dist-tag");
    expect(verifyRegistryWorkflow).not.toContain("npm deprecate");
    expect(verifyRegistryWorkflow).not.toContain("npm unpublish");
    expect(verifyRegistryWorkflow).toContain(sharedConcurrencyBlock);
    expect(verifyRegistryWorkflow).toContain("for ATTEMPT in {1..12}");
    expect(verifyRegistryWorkflow).toContain("--prefer-online");
    expect(verifyRegistryWorkflow).toContain("--cache");
    expect(verifyRegistryWorkflow).toContain("dist.attestations");
    expect(verifyRegistryWorkflow).toContain("candidate-jobs.json");
    expect(verifyRegistryWorkflow).toContain('actions/jobs/${JOB_ID}/logs');
    expect(verifyRegistryWorkflow).toContain("candidate-job.log");
    expect(verifyRegistryWorkflow).toContain("npm error code ETARGET");
    expect(verifyRegistryWorkflow).toContain("No matching version found for codex-sessions-manager@");
    expect(verifyRegistryWorkflow).toContain("codex-sessions-manager@${PACKAGE_VERSION}");
    expect(verifyRegistryWorkflow).toContain('compareFailureReason = "ETARGET"');
    expect(verifyRegistryWorkflow).toContain("lastIndexOf(packCommand)");
    expect(verifyRegistryWorkflow).toContain("lastIndexOf(compareMarker)");
    expect(verifyRegistryWorkflow).toContain("CSM_REGISTRY_COMPARE_START version=${version}");
    expect(verifyRegistryWorkflow).toContain("compareFailureVersion = version");
    expect(verifyRegistryWorkflow).toContain('createHash("sha256")');
    expect(verifyRegistryWorkflow).toContain("candidate-state.json");
    expect(verifyRegistryWorkflow).toContain("Publish with the non-default security-verify tag");
    expect(verifyRegistryWorkflow).toContain("Install the exact registry version and smoke both entrypoints");
    expect(verifyRegistryWorkflow).toContain('step.conclusion !== "success"');
    expect(verifyRegistryWorkflow).toContain("workflowCommit");
    expect(verifyRegistryWorkflow).toContain("provenanceMetadataPresent: true");
    expect(verifyRegistryWorkflow).not.toContain("provenance: true");
    expect(verifyRegistryWorkflow).not.toContain("compareFailureOnlyRecovery: true");
    expect(verifyRegistryWorkflow).toContain("files.length !== 110");
    expect(verifyRegistryWorkflow).toContain('tags["security-verify"]');
    expect(verifyRegistryWorkflow).toContain("tags.latest");
    expect(verifyRegistryWorkflow).toContain("npm-registry-verification-${{ inputs.version }}-${{ github.run_id }}");
    expect(verifyRegistryWorkflow).toContain("actions/upload-artifact@b7c566a772e6b6bfb58ed0dc250532a479d7789f # v6");
  });

  it("rejects private material from the actual npm dry-run manifest", () => {
    const result = spawnSync(process.execPath, ["scripts/check-package.mjs", "--allow-missing-dist"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: subprocessEnvironment(),
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Package manifest check passed");
  });

  it("keeps private sentinel files out of the real npm manifest", async () => {
    const relativeSentinels = [
      "session-exports/release-config-pack-sentinel.txt",
      "private-archives/release-config-pack-sentinel.tar.gpg",
      "advisory-drafts/release-config-pack-sentinel.md",
      "compat/runs/private/release-config-pack-sentinel.json",
      "security_best_practices_report.md",
    ];
    const createdFiles: string[] = [];
    const createdDirectories: string[] = [];

    async function exists(targetPath: string): Promise<boolean> {
      return access(targetPath).then(
        () => true,
        () => false,
      );
    }

    async function ensureParentDirectory(parentDirectory: string): Promise<void> {
      const missingDirectories: string[] = [];
      let cursor = parentDirectory;
      while (cursor.startsWith(repositoryRoot) && !(await exists(cursor))) {
        missingDirectories.push(cursor);
        cursor = path.dirname(cursor);
      }
      await mkdir(parentDirectory, { recursive: true });
      for (const missingDirectory of missingDirectories.reverse()) {
        if (!createdDirectories.includes(missingDirectory)) createdDirectories.push(missingDirectory);
      }
    }

    try {
      for (const relativePath of relativeSentinels) {
        const absolutePath = path.join(repositoryRoot, relativePath);
        const parentDirectory = path.dirname(absolutePath);
        await ensureParentDirectory(parentDirectory);
        if (!(await exists(absolutePath))) {
          await writeFile(absolutePath, "private npm pack sentinel\n", { encoding: "utf8", flag: "wx" });
          createdFiles.push(absolutePath);
        }
      }

      const result = spawnSync(process.execPath, ["scripts/check-package.mjs", "--allow-missing-dist"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: subprocessEnvironment(),
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Package manifest check passed");
    } finally {
      await Promise.all(createdFiles.map((filePath) => rm(filePath, { force: true })));
      for (const directoryPath of createdDirectories.reverse()) {
        await rmdir(directoryPath).catch(() => undefined);
      }
    }
  });

  it("rejects private-looking content even when its path is publicly allowlisted", async () => {
    const sentinelPath = path.join(repositoryRoot, "adapters", "private-content-sentinel.txt");
    try {
      await writeFile(
        sentinelPath,
        "local evidence: /Users/private-owner/.codex/sessions/example.jsonl\n",
        { encoding: "utf8", flag: "wx" },
      );
      const result = spawnSync(process.execPath, ["scripts/check-package.mjs", "--allow-missing-dist"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: subprocessEnvironment(),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("private-looking content");
      expect(result.stderr).toContain("adapters/private-content-sentinel.txt");
    } finally {
      await rm(sentinelPath, { force: true });
    }
  });

  it("rejects unknown binary paths from the real npm manifest", async () => {
    const sentinelPath = path.join(repositoryRoot, "adapters", "amp", "unreviewed-payload.bin");
    try {
      await writeFile(sentinelPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]), { flag: "wx" });
      const result = spawnSync(process.execPath, ["scripts/check-package.mjs", "--allow-missing-dist"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: subprocessEnvironment(),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("outside the public allowlist");
      expect(result.stderr).toContain("adapters/amp/unreviewed-payload.bin");
    } finally {
      await rm(sentinelPath, { force: true });
    }
  });

  it.each([
    ["NUL bytes", Buffer.from("public-looking\0/Users/private-owner/.codex/session.jsonl", "utf8")],
    ["UTF-16", Buffer.from("\ufefflocal evidence: /Users/private-owner/.codex/session.jsonl", "utf16le")],
    ["SQLite", Buffer.from("SQLite format 3\0/Users/private-owner/.codex/session.jsonl", "utf8")],
    ["invalid UTF-8", Buffer.from([0x70, 0x75, 0x62, 0x6c, 0x69, 0x63, 0xff, 0xfe, 0x00])],
  ])("rejects %s hidden inside a real allowlisted npm file", async (_label, payload) => {
    const allowlistedPath = path.join(repositoryRoot, "adapters", "amp", "README.md");
    const original = await readFile(allowlistedPath);
    try {
      await writeFile(allowlistedPath, payload);
      const result = spawnSync(process.execPath, ["scripts/check-package.mjs", "--allow-missing-dist"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: subprocessEnvironment(),
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("non-UTF-8 or binary content");
      expect(result.stderr).toContain("adapters/amp/README.md");
    } finally {
      await writeFile(allowlistedPath, original);
    }
  });
});
