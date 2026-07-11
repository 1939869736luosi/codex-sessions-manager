import path from "node:path";
import { mkdir } from "node:fs/promises";

import { atomicWriteManagedFile, MutationSafetyError } from "./mutation-safety.js";
import { createTrustedRootContext } from "./path-safety.js";

/** Writes an explicitly user-selected export/plan file atomically as 0600. */
export async function writePrivateOutputFile(
  outputPath: string,
  contents: string | Uint8Array,
): Promise<string> {
  const absolutePath = path.resolve(outputPath);
  const parentPath = path.dirname(absolutePath);
  const fileName = path.basename(absolutePath);
  if (!fileName || fileName === "." || fileName === "..") {
    throw new MutationSafetyError("UNSAFE_PATH", `invalid private output file path: ${outputPath}`);
  }
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  const parentContext = await createTrustedRootContext(parentPath);
  await atomicWriteManagedFile(parentContext, fileName, contents, 0o600);
  return absolutePath;
}
