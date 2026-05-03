import { describe, expect, it } from "vitest";

import { filterJsonLines } from "../src/core/jsonl.js";

describe("jsonl helpers", () => {
  it("filters matching rows while preserving invalid lines", () => {
    const input = [
      '{"id":"keep-1","value":1}',
      '{"id":"drop-1","value":2}',
      "not-json",
      '{"id":"drop-1","value":3}',
    ].join("\n");

    const result = filterJsonLines<{ id?: string }>(input, (record) => !record || record.id !== "drop-1");

    expect(result.removedCount).toBe(2);
    expect(result.text).toContain('{"id":"keep-1","value":1}');
    expect(result.text).toContain("not-json");
    expect(result.text).not.toContain('"drop-1"');
  });
});
