import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseMode = process.argv.includes("--release");

function fail(message) {
  throw new Error(`Compatibility check failed: ${message}`);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

async function readText(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

async function listFiles(directory) {
  const absoluteDirectory = path.join(repositoryRoot, directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const relativePath = path.posix.join(directory.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) results.push(...await listFiles(relativePath));
    else if (entry.isFile()) results.push(relativePath);
  }
  return results;
}

const baseline = JSON.parse(await readText("compat/upstream-baseline.json"));
const capabilityBaseline = JSON.parse(await readText("compat/upstream-capabilities.json"));
assert(baseline.schemaVersion === 1, "baseline schemaVersion must be 1");
assert(baseline.product === "openai/codex", "baseline product must be openai/codex");
assert(/^\d+\.\d+\.\d+$/u.test(baseline.stableVersion), "stableVersion must be X.Y.Z");
assert(/^\d{4}-\d{2}-\d{2}$/u.test(baseline.checkedAt), "checkedAt must use YYYY-MM-DD");
assert(
  baseline.releaseUrl === `https://github.com/openai/codex/releases/tag/rust-v${baseline.stableVersion}`,
  "releaseUrl must pin the stable tag",
);
assert(
  baseline.tagUrl === `https://github.com/openai/codex/tree/rust-v${baseline.stableVersion}`,
  "tagUrl must pin the stable tag",
);
assert(/^[0-9a-f]{40}$/u.test(baseline.commit?.sha ?? ""), "commit SHA must contain 40 lowercase hex characters");
assert(
  baseline.commit.url === `https://github.com/openai/codex/commit/${baseline.commit.sha}`,
  "commit URL must pin the recorded SHA",
);
assert(capabilityBaseline.schemaVersion === 1, "capability baseline schemaVersion must be 1");
assert(capabilityBaseline.product === baseline.product, "capability baseline product must match storage baseline");
assert(
  capabilityBaseline.stableVersion === baseline.stableVersion,
  "capability baseline version must match storage baseline",
);
assert(capabilityBaseline.checkedAt === baseline.checkedAt || capabilityBaseline.checkedAt > baseline.checkedAt,
  "capability baseline must be checked on or after the storage baseline");
assert(Array.isArray(capabilityBaseline.capabilities), "capability baseline must contain capabilities");
const officialStatuses = new Set(["available", "experimental", "not-available", "unknown"]);
const projectOverlaps = new Set(["full", "partial", "none", "complementary"]);
const projectDispositions = new Set([
  "official-first",
  "stop-expanding",
  "verify-and-recover",
  "retain",
  "observe",
  "verify-only",
  "defer",
  "removed",
]);
const capabilityIds = new Set();
for (const capability of capabilityBaseline.capabilities) {
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(capability.id ?? ""), "capability ids must use kebab-case");
  assert(!capabilityIds.has(capability.id), `duplicate capability id ${capability.id}`);
  capabilityIds.add(capability.id);
  assert(officialStatuses.has(capability.officialStatus), `${capability.id} has invalid officialStatus`);
  assert(projectOverlaps.has(capability.projectOverlap), `${capability.id} has invalid projectOverlap`);
  assert(projectDispositions.has(capability.projectDisposition), `${capability.id} has invalid projectDisposition`);
  if (capability.projectDisposition === "removed") {
    assert(
      typeof capability.removalReason === "string" && capability.removalReason.length > 20,
      `${capability.id} removed capabilities need a removalReason`,
    );
    assert(
      typeof capability.migrationNotes === "string" && capability.migrationNotes.length > 20,
      `${capability.id} removed capabilities need migrationNotes`,
    );
  }
  assert(typeof capability.summary === "string" && capability.summary.length > 20, `${capability.id} needs a summary`);
  assert(Array.isArray(capability.evidence) && capability.evidence.length > 0, `${capability.id} needs evidence`);
  for (const evidenceUrl of capability.evidence) {
    const officialDocs = typeof evidenceUrl === "string" && evidenceUrl.startsWith("https://learn.chatgpt.com/docs/");
    const pinnedSource = typeof evidenceUrl === "string"
      && evidenceUrl.startsWith(`https://github.com/openai/codex/blob/rust-v${baseline.stableVersion}/`);
    assert(officialDocs || pinnedSource, `${capability.id} evidence must be official docs or pinned release source`);
  }
}
for (const requiredCapability of [
  "thread-delete",
  "post-delete-residue-verification",
  "memory-entry-management",
  "thread-memory-delete-reconsolidation",
]) {
  assert(capabilityIds.has(requiredCapability), `capability baseline is missing ${requiredCapability}`);
}

for (const documentationUrl of Object.values(baseline.documentation ?? {})) {
  assert(
    typeof documentationUrl === "string" && documentationUrl.startsWith("https://learn.chatgpt.com/docs/"),
    "documentation URLs must use the official learn.chatgpt.com domain",
  );
}
assert(
  baseline.knownSchema?.paginatedCanonicalRecord === "event_msg.payload.type=item_completed",
  "paginated canonical record must match the official persisted shape",
);
for (const requiredMigration of [
  "0025_thread_timestamps_millis.sql",
  "0039_threads_recency_at.sql",
  "0040_threads_history_mode.sql",
]) {
  assert(baseline.knownSchema?.migrations?.includes(requiredMigration), `baseline is missing ${requiredMigration}`);
}

if (releaseMode) {
  const checkedAt = new Date(`${baseline.checkedAt}T23:59:59.999Z`).getTime();
  const ageDays = (Date.now() - checkedAt) / 86_400_000;
  assert(ageDays >= -1, "baseline checkedAt is unexpectedly in the future");
  assert(ageDays <= 7, `release baseline is ${ageDays.toFixed(1)} days old; maximum is 7 days`);
  const capabilityCheckedAt = new Date(`${capabilityBaseline.checkedAt}T23:59:59.999Z`).getTime();
  const capabilityAgeDays = (Date.now() - capabilityCheckedAt) / 86_400_000;
  assert(capabilityAgeDays >= -1, "capability baseline checkedAt is unexpectedly in the future");
  assert(
    capabilityAgeDays <= 7,
    `release capability baseline is ${capabilityAgeDays.toFixed(1)} days old; maximum is 7 days`,
  );
}

const adapter = await readText("adapters/codex/README.md");
assert(adapter.includes("[mcp_servers.codex-sessions]"), "Codex adapter must use official TOML MCP configuration");
assert(
  adapter.includes("codex mcp add codex-sessions -- codex-sessions-mcp --profile read-only"),
  "Codex adapter must include the official CLI registration path",
);
assert(!adapter.includes('"mcpServers"'), "Codex adapter must not contain Claude-style JSON MCP configuration");

const rootSkill = await readText("SKILL.md");
const nestedSkill = await readText("skills/codex-sessions-manager/SKILL.md");
const rootOpenAiMetadata = await readText("agents/openai.yaml");
const nestedOpenAiMetadata = await readText("skills/codex-sessions-manager/agents/openai.yaml");
const rootDetail = await readText("docs/SKILL_DETAIL.md");
const nestedDetail = await readText("skills/codex-sessions-manager/docs/SKILL_DETAIL.md");
const rootSafety = await readText("docs/SAFETY.md");
const nestedSafety = await readText("skills/codex-sessions-manager/docs/SAFETY.md");
assert(rootSkill === nestedSkill, "root and packaged SKILL.md files have drifted");
assert(
  rootOpenAiMetadata.trimEnd() === nestedOpenAiMetadata.trimEnd(),
  "root and nested agents/openai.yaml files have drifted",
);
assert(rootDetail === nestedDetail, "root and packaged SKILL_DETAIL.md files have drifted");
assert(rootSafety === nestedSafety, "root and packaged SAFETY.md files have drifted");
assert(rootSkill.includes(".agents/skills/codex-sessions-manager"), "Skill must document project-scope .agents discovery");
assert(rootSkill.includes("$HOME/.agents/skills/codex-sessions-manager"), "Skill must document user-scope .agents discovery");

const requiredFixturePaths = [
  "compat/fixtures/legacy-timeline.jsonl",
  "compat/fixtures/paginated-timeline.jsonl",
  "compat/fixtures/sqlite-thread-schema.sql",
  "compat/fixtures/source-metadata.json",
  "compat/fixtures/active-session.jsonl.zst",
  "compat/fixtures/archived-session.jsonl.zst",
];
const compatFiles = await listFiles("compat");
assert(
  compatFiles.every((filePath) => !filePath.startsWith("compat/runs/private/")),
  "private compatibility runs must not be tracked",
);
for (const fixturePath of requiredFixturePaths) {
  assert(compatFiles.includes(fixturePath), `missing fixture ${fixturePath}`);
}

for (const timelinePath of [
  "compat/fixtures/legacy-timeline.jsonl",
  "compat/fixtures/paginated-timeline.jsonl",
]) {
  const records = (await readText(timelinePath))
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        fail(`${timelinePath}:${index + 1} is invalid JSON: ${error.message}`);
      }
    });
  assert(records.some((record) => record.type === "session_meta"), `${timelinePath} lacks session_meta`);
}
const paginatedTimeline = await readText("compat/fixtures/paginated-timeline.jsonl");
assert(paginatedTimeline.includes('"type":"item_completed"'), "paginated fixture lacks ItemCompleted event");
const legacyTimeline = await readText("compat/fixtures/legacy-timeline.jsonl");
assert(legacyTimeline.includes('"type":"response_item"'), "legacy fixture lacks response_item");

const sqliteSchema = await readText("compat/fixtures/sqlite-thread-schema.sql");
for (const column of ["recency_at_ms", "recency_at", "updated_at_ms", "history_mode"]) {
  assert(sqliteSchema.includes(column), `SQLite fixture lacks ${column}`);
}
const sourceMetadata = JSON.parse(await readText("compat/fixtures/source-metadata.json"));
for (const surface of ["external_agent_config_imports", "logs_N.sqlite", "memories_N.sqlite", "remote-control"]) {
  assert(sourceMetadata.observationOnly?.includes(surface), `source metadata fixture lacks ${surface}`);
}

for (const compressedFixture of [
  "compat/fixtures/active-session.jsonl.zst",
  "compat/fixtures/archived-session.jsonl.zst",
]) {
  const bytes = await readFile(path.join(repositoryRoot, compressedFixture));
  assert(
    bytes.length > 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd,
    `${compressedFixture} is not a zstd frame`,
  );
}

const publicRunPaths = compatFiles.filter((filePath) => /^compat\/runs\/[^/]+\.json$/u.test(filePath));
assert(publicRunPaths.length > 0, "at least one public compatibility run is required");
for (const runPath of publicRunPaths) {
  const run = JSON.parse(await readText(runPath));
  assert(run.schemaVersion === 1 && run.immutable === true, `${runPath} must be immutable schemaVersion 1`);
  assert(Array.isArray(run.findings) && Array.isArray(run.fixes), `${runPath} must separate findings and fixes`);
  assert(Array.isArray(run.postFixVerification), `${runPath} must record post-fix verification`);
  assert(run.privacy?.syntheticOnly === true, `${runPath} must declare synthetic-only evidence`);
}

const forbiddenPublicPatterns = [
  /\/Users\//u,
  /[A-Za-z]:\\Users\\/u,
  /session-exports/iu,
  /security_best_practices_report\.md/iu,
];
for (const filePath of compatFiles.filter((candidate) => !candidate.endsWith(".zst"))) {
  const text = await readText(filePath);
  for (const pattern of forbiddenPublicPatterns) {
    assert(!pattern.test(text), `${filePath} contains private-looking content (${pattern})`);
  }
}

console.log(`Compatibility check passed (${compatFiles.length} public files, Codex ${baseline.stableVersion}).`);
