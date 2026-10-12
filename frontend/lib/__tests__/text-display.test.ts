import { describe, expect, it } from "vitest";

import { displayLines, normalizeDisplayLine } from "@/lib/text-display";

describe("normalizeDisplayLine", () => {
  it("turns private-use and box bullets into a real bullet", () => {
    expect(normalizeDisplayLine("\uF0B7 Experience with SDLC")).toBe("• Experience with SDLC");
    expect(normalizeDisplayLine("□ Swim lane diagrams")).toBe("• Swim lane diagrams");
    expect(normalizeDisplayLine("☒ including business teams")).toBe("• including business teams");
  });

  it("leaves ordinary lines alone", () => {
    expect(normalizeDisplayLine("Plain sentence.")).toBe("Plain sentence.");
  });
});

describe("displayLines", () => {
  it("splits and drops empty lines", () => {
    expect(displayLines("\uF0B7 One\n\n□ Two\n")).toEqual(["• One", "• Two"]);
  });
});
