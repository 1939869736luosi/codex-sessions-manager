import os from "node:os";
import path from "node:path";
import { link, mkdtemp, rm } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { buildSessionResidueAudit } from "../src/core/audit.js";
import { scanCodexRoot } from "../src/core/scan.js";
import { readSessionTimeline } from "../src/core/timeline.js";
import { createFixture, FIXTURE_IDS } from "./helpers/fixture.js";

describe("hard-linked rollout inventory", () => {
  it.runIf(process.platform !== "win32")("counts the rollout as present while content reads remain blocked", async () => {
    const fixture = await createFixture();
    const mirrorRoot = await mkdtemp(path.join(os.tmpdir(), "csm-rollout-mirror-"));
    try {
      await link(fixture.paths.activeSessionFile, path.join(mirrorRoot, "mirror.jsonl"));

      const scan = await scanCodexRoot(fixture.rootDir);
      const session = scan.sessions.find((entry) => entry.id === FIXTURE_IDS.ACTIVE_ID);
      const audit = buildSessionResidueAudit(scan, FIXTURE_IDS.ACTIVE_ID);

      expect(session?.fileTargets).toHaveLength(1);
      expect(audit.counts.rawSessionFiles).toBe(1);
      expect(scan.safety.complete).toBe(false);
      expect(scan.warnings.join("\n")).toMatch(/hard link|multiple hard links/iu);
      await expect(readSessionTimeline(session!, fixture.rootDir)).rejects.toThrow(/hard link|UNSAFE_PATH/iu);
    } finally {
      await fixture.cleanup();
      await rm(mirrorRoot, { recursive: true, force: true });
    }
  });
});
