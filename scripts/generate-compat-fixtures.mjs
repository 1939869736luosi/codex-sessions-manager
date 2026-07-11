import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = path.join(repositoryRoot, "compat", "fixtures");
await mkdir(fixtureDirectory, { recursive: true });

const fixtures = [
  ["active-session.jsonl.zst", "KLUv/SBrnQIAAsUQFpCnbVad+Gghrv2aCZk5tvbjyJMzHhxDURyz76jg0O2Ja0oqbLMOPh4gVQUgpG5HPWHHW0I69PHrNOWsMiffnij1iQUAIMBOAihhKuEmA2U="],
  ["archived-session.jsonl.zst", "KLUv/SBojQIAcsQPF5CnLQZkMcEgQYaOKm919yJ14s3GsggcRFG8gyPg2caSiOwhlZrCYwEgsF3Myy6XZy89PoWIGNKoom5jWvUKBgAgwE4CEA5lQiXcZKAM"],
];

for (const [fileName, base64] of fixtures) {
  const outputPath = path.join(fixtureDirectory, fileName);
  await writeFile(outputPath, Buffer.from(base64, "base64"));
  await chmod(outputPath, 0o644);
}

console.log(`Generated ${fixtures.length} synthetic zstd fixtures.`);
