import { describe, expect, it } from "vitest";

import { hasSourcePage, sourcePageLabel } from "@/lib/source-page";

describe("source page", () => {
  it("treats page 0 and missing pages as no source page", () => {
    expect(hasSourcePage(0)).toBe(false);
    expect(hasSourcePage(null)).toBe(false);
    expect(hasSourcePage(undefined)).toBe(false);
    expect(sourcePageLabel(0)).toBe("No source page");
  });

  it("labels real pages", () => {
    expect(hasSourcePage(1)).toBe(true);
    expect(sourcePageLabel(12)).toBe("Page 12");
  });
});
