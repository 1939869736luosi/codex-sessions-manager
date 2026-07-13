import { readFile } from "node:fs/promises";
import path from "node:path";

function fail(version) {
  console.error(
    `CHANGELOG.md must contain exactly one dated heading for ${version}: `
      + `## ${version} (YYYY-MM-DD)`,
  );
  process.exitCode = 1;
}

const repositoryRoot = process.cwd();
const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);
const version = packageJson.version;

if (typeof version !== "string" || version.length === 0) {
  throw new Error("package.json must contain a non-empty version string");
}

const changelog = await readFile(path.join(repositoryRoot, "CHANGELOG.md"), "utf8");
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const versionHeadingPattern = new RegExp(
  `^## ${escapedVersion}(?=\\s|$).*$`,
  "gmu",
);
const versionHeadings = [...changelog.matchAll(versionHeadingPattern)].map((match) => match[0]);
const datedHeadingPattern = new RegExp(
  `^## ${escapedVersion} \\((\\d{4}-\\d{2}-\\d{2})\\)$`,
  "u",
);
const datedHeading = versionHeadings.length === 1
  ? datedHeadingPattern.exec(versionHeadings[0])
  : null;

if (!datedHeading) {
  fail(version);
} else {
  const releaseDate = datedHeading[1];
  const parsedDate = new Date(`${releaseDate}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== releaseDate) {
    fail(version);
  } else {
    console.log(`Release changelog check passed for ${version} (${releaseDate}).`);
  }
}
