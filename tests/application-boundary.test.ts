import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function readSource(relativePath: string): Promise<string> {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

describe("application adapter boundary", () => {
  it.each(["src/cli/run.ts", "src/mcp/server.ts"])(
    "%s delegates storage operations through the application layer",
    async (relativePath) => {
      const source = await readSource(relativePath);

      expect(source).toContain("../application/");
      expect(source).not.toMatch(/from ["']\.\.\/core\/(delete|trash|recovery|scan|query|plan-delete|plan-file)\.js["']/);
    },
  );

  it("never lets MCP invoke the CLI or expose a generic command runner", async () => {
    const source = await readSource("src/mcp/server.ts");

    expect(source).not.toMatch(/node:child_process|execa|shell\s*:\s*true/);
    expect(source).not.toMatch(/registerTool\(\s*["']run_command["']/);
    expect(source).not.toMatch(/dist\/cli|src\/cli|\.\.\/cli\//);
  });

  it("keeps mutation policy and execution in one application module", async () => {
    const source = await readSource("src/application/mutation-operations.ts");

    for (const operation of [
      "deleteSessionsOperation",
      "restoreTrashOperation",
      "purgeTrashOperation",
      "cleanupSessionIndexesOperation",
      "cleanupStaleIndexesOperation",
      "recoverOperation",
    ]) {
      expect(source).toContain(`function ${operation}`);
    }
    expect(source).toContain("assertConfirmedSessionSelection");
    expect(source).toContain("assertCanonicalSessionIds");
  });
});
