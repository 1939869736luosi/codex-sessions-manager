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
      description?: string;
      engines?: { node?: string };
      files?: string[];
      scripts?: Record<string, string>;
    };

    expect(packageJson.engines?.node).toBe(">=20");
    expect(packageJson.description).toContain("Verify official Codex deletion");
    expect(packageJson.description).toContain("bounded MCP tools");
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
    const capabilityBaseline = JSON.parse(
      await readRepositoryFile("compat/upstream-capabilities.json"),
    ) as {
      stableVersion?: string;
      checkedAt?: string;
      capabilities?: Array<{ id?: string; officialStatus?: string; projectDisposition?: string }>;
    };
    const compatReadme = await readRepositoryFile("compat/README.md");
    const compatValidator = await readRepositoryFile("scripts/check-compat.mjs");
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
    expect(capabilityBaseline).toMatchObject({
      stableVersion: baseline.stableVersion,
      checkedAt: "2026-07-12",
    });
    expect(capabilityBaseline.checkedAt! >= baseline.checkedAt!).toBe(true);
    expect(capabilityBaseline.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "thread-delete", officialStatus: "available", projectDisposition: "verify-and-recover" }),
      expect.objectContaining({ id: "memory-entry-management", officialStatus: "not-available", projectDisposition: "observe" }),
    ]));
    expect(compatReadme).toContain("Storage structure");
    expect(compatReadme).toContain("Local read-only smoke");
    expect(compatReadme).toContain("Capability replacement");
    expect(compatValidator).toContain('"removed"');
    expect(compatValidator).toContain("removalReason");
    expect(compatValidator).toContain("migrationNotes");
    expect(maintainerPrompt).toContain("maintainer-only");
    expect(compatWorkflow).toContain("schedule:");
    expect(compatWorkflow).toContain("workflow_dispatch:");
    expect(compatWorkflow).toContain("scripts/check-upstream-version.mjs");
    expect(compatWorkflow).toContain("compatibility and replacement report");
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
    const dependabot = await readRepositoryFile(".github/dependabot.yml");

    expect(workflow).toContain("push:\n    branches: [main]");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("cancel-in-progress: true");
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
    expect(dependabot).toContain("github-actions-dependencies:");
    expect(dependabot).toContain("patterns:\n          - \"*\"");
  });

  it("publishes an immutable candidate before a verified local interactive latest promotion", async () => {
    const releaseWorkflow = await readRepositoryFile(".github/workflows/release.yml");
    const verifyRegistryWorkflow = await readRepositoryFile(".github/workflows/verify-npm-registry.yml");
    const releaseGuide = await readRepositoryFile("docs/RELEASE.md");
    const localPromotion = await readRepositoryFile("scripts/promote-npm.mjs");
    const recoveryParser = await readRepositoryFile("scripts/verify-candidate-compare-log.mjs");

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
    expect(releaseWorkflow).toContain("CSM_REGISTRY_COMPARE_ATTEMPT_START attempt=${ATTEMPT} version=${PACKAGE_VERSION}");
    expect(releaseWorkflow).toContain("CSM_REGISTRY_COMPARE_PACK_SUCCESS attempt=${ATTEMPT} version=${PACKAGE_VERSION}");
    expect(releaseWorkflow).toContain("reason=HASH_MISMATCH");
    expect(releaseWorkflow).toContain("reason=${FAILURE_REASON}");
    expect(releaseWorkflow).toContain("npm audit --omit=dev --audit-level=high");
    const sharedConcurrencyBlock = [
      "concurrency:",
      "  group: npm-package-codex-sessions-manager",
      "  cancel-in-progress: false",
    ].join("\n");
    expect(releaseWorkflow).toContain(sharedConcurrencyBlock);

    await expect(access(path.join(repositoryRoot, ".github/workflows/promote-npm.yml"))).rejects.toThrow();
    expect(releaseGuide).toContain("npm dist-tag add codex-sessions-manager@<version> latest");
    expect(releaseGuide).toContain("browser or Touch ID");
    expect(releaseGuide).toContain("npm view codex-sessions-manager dist-tags --json");
    expect(releaseGuide).toContain("revoke");
    expect(releaseGuide).not.toContain("NPM_DIST_TAG_TOKEN");
    expect(localPromotion).toContain("--expected-latest");
    expect(localPromotion).toContain("--expected-sha256");
    expect(localPromotion).toContain("--expected-commit");
    expect(localPromotion).toContain("--expected-verification-commit");
    expect(localPromotion).toContain("--candidate-run-id");
    expect(localPromotion).toContain("--verification-run-id");
    expect(localPromotion).toContain("verification.json");
    expect(localPromotion).toContain("registryTarball");
    expect(localPromotion).toContain("liveTagCommit");
    expect(localPromotion).toContain('verificationRun.head_branch !== "main"');
    expect(localPromotion).toContain("verificationRun.workflow_id !== verificationWorkflow.id");
    expect(localPromotion).toContain('const packageName = "codex-sessions-manager"');
    expect(localPromotion).toContain("@security-verify");
    expect(localPromotion).toContain('["dist-tag", "add"');
    expect(localPromotion).toContain("Promotion status was ambiguous");
    expect(localPromotion).toContain("latest and security-verify both identify");
    const downgradeAttempt = spawnSync(
      process.execPath,
      ["scripts/promote-npm.mjs", "--version", "0.7.1", "--expected-latest", "0.7.1"],
      { cwd: repositoryRoot, encoding: "utf8", env: subprocessEnvironment() },
    );
    expect(downgradeAttempt.status).toBe(1);
    expect(downgradeAttempt.stderr).toContain("must be newer than current latest");

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
    expect(verifyRegistryWorkflow).toContain("scripts/verify-candidate-compare-log.mjs?ref=${GITHUB_SHA}");
    expect(verifyRegistryWorkflow).toContain("application/vnd.github.raw+json");
    expect(recoveryParser).toContain("npm error code ETARGET");
    expect(recoveryParser).toContain("No matching version found for codex-sessions-manager@");
    expect(recoveryParser).toContain("CSM_REGISTRY_COMPARE_ATTEMPT_START");
    expect(recoveryParser).toContain("CSM_REGISTRY_COMPARE_PACK_SUCCESS");
    expect(recoveryParser).toContain("HASH_MISMATCH");
    expect(recoveryParser).toContain('compareFailureReason = "ETARGET"');
    expect(recoveryParser).toContain("legacy recovery is restricted to the known 0.6.3 incident");
    expect(recoveryParser).toContain("29150488700");
    expect(recoveryParser).toContain("compareFailureVersion = version");
    expect(recoveryParser).toContain('createHash("sha256")');
    expect(verifyRegistryWorkflow).toContain("candidate-state.json");
    expect(verifyRegistryWorkflow).toContain("Publish with the non-default security-verify tag");
    expect(verifyRegistryWorkflow).toContain("Install the exact registry version and smoke both entrypoints");
    expect(verifyRegistryWorkflow).toContain('step.conclusion !== "success"');
    expect(verifyRegistryWorkflow).toContain("workflowCommit");
    expect(verifyRegistryWorkflow).toContain("provenanceMetadataPresent: true");
    expect(verifyRegistryWorkflow).not.toContain("provenance: true");
    expect(verifyRegistryWorkflow).not.toContain("compareFailureOnlyRecovery: true");
    expect(verifyRegistryWorkflow).not.toContain("files.length !== 110");
    expect(verifyRegistryWorkflow).toContain("SOURCE_FILE_COUNT");
    expect(verifyRegistryWorkflow).toContain("files.length !== Number(process.argv[3])");
    expect(verifyRegistryWorkflow).toContain("entries.length !== Number(process.argv[2])");
    expect(verifyRegistryWorkflow).toContain("dist.fileCount !== Number(process.argv[4])");
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
