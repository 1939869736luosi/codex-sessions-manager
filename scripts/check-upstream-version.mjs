import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = process.argv[2];
if (!outputPath) throw new Error("Usage: node scripts/check-upstream-version.mjs <output.json>");

const baseline = JSON.parse(await readFile(path.join(repositoryRoot, "compat", "upstream-baseline.json"), "utf8"));
const capabilityBaseline = JSON.parse(
  await readFile(path.join(repositoryRoot, "compat", "upstream-capabilities.json"), "utf8"),
);
const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "codex-sessions-manager-compat-watch",
  "X-GitHub-Api-Version": "2022-11-28",
};
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const response = await fetch("https://api.github.com/repos/openai/codex/releases?per_page=30", {
  headers,
});
if (!response.ok) throw new Error(`GitHub releases request failed: ${response.status}`);

const releases = await response.json();
const stable = releases.find((release) =>
  release && !release.draft && !release.prerelease && /^rust-v\d+\.\d+\.\d+$/u.test(String(release.tag_name)),
);
if (!stable) throw new Error("No stable rust-vX.Y.Z Codex release found");

const latestVersion = String(stable.tag_name).replace(/^rust-v/u, "");
const report = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  baselineVersion: baseline.stableVersion,
  latestStableVersion: latestVersion,
  changed: latestVersion !== baseline.stableVersion,
  releaseUrl: stable.html_url,
  capabilityBaselineCheckedAt: capabilityBaseline.checkedAt,
  recordedOfficialReplacements: capabilityBaseline.capabilities.filter(
    (capability) => capability.projectOverlap === "full" || capability.projectOverlap === "partial",
  ).length,
  replacementReviewRequired: latestVersion !== baseline.stableVersion,
  action: latestVersion === baseline.stableVersion
    ? "No version-triggered compatibility or replacement review is required. Recheck before release if the official docs changed."
    : "Run the maintainer compatibility and replacement review; do not edit or publish automatically.",
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify(report));
