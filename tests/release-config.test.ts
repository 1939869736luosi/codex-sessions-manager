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
    expect(workflow).toContain("--testTimeout=30000");
    expect(workflow).toContain("npm run test:coverage");
    expect(workflow).toContain("npm run build");
    expect(workflow).toContain("npm run smoke:release");
    expect(workflow).toContain("npm run pack:check");
  });

  it("publishes an immutable candidate before a separately approved latest promotion", async () => {
    const releaseWorkflow = await readRepositoryFile(".github/workflows/release.yml");
    const promoteWorkflow = await readRepositoryFile(".github/workflows/promote-npm.yml");

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
    expect(releaseWorkflow).toContain("--testTimeout=30000");
    expect(releaseWorkflow).toContain("npm run test:coverage");
    expect(releaseWorkflow).toContain("npm run smoke:release");
    expect(releaseWorkflow).toContain("npm audit --omit=dev --audit-level=high");

    expect(promoteWorkflow).toContain("workflow_dispatch:");
    expect(promoteWorkflow).toContain("environment: npm-production");
    expect(promoteWorkflow).toContain("NPM_DIST_TAG_TOKEN");
    expect(promoteWorkflow).toContain('dist-tag add "codex-sessions-manager@${{ inputs.version }}" latest');
    expect(promoteWorkflow).toContain("expected_sha256");
    expect(promoteWorkflow).toContain("Wait for dist-tag replication");
    expect(promoteWorkflow).toContain("--prefer-online");
    expect(promoteWorkflow).toContain("for ATTEMPT in {1..12}");
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
