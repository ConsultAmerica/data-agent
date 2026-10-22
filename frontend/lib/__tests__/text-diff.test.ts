import { describe, expect, it } from "vitest";

import { searchTerms } from "@/lib/clause-citations";
import { diffStats, wordDiff, type DiffSegment } from "@/lib/text-diff";

function side(segments: DiffSegment[], keep: "insert" | "delete"): string {
  return segments
    .filter((segment) => segment.op === "equal" || segment.op === keep)
    .map((segment) => segment.text)
    .join("");
}

describe("wordDiff", () => {
  it("marks inserted and deleted words and reproduces the newer text", () => {
    const before = "The Contractor shall report within 72 hours of discovery.";
    const after = "The Contractor shall rapidly report within 72 hours of discovery of any incident.";
    const segments = wordDiff(before, after);
    expect(side(segments, "insert")).toBe(after);
    expect(segments.filter((segment) => segment.op === "insert").map((segment) => segment.text.trim())).toEqual([
      "rapidly",
      "discovery of any incident.",
    ]);
    expect(segments.filter((segment) => segment.op === "delete").map((segment) => segment.text.trim())).toEqual([
      "discovery.",
    ]);
    expect(diffStats(segments)).toEqual({ inserted: 5, deleted: 1, unchanged: 8 });
  });

  it("returns one equal segment for identical texts", () => {
    expect(wordDiff("same text", "same text")).toEqual([{ op: "equal", text: "same text" }]);
  });

  it("handles empty sides", () => {
    expect(wordDiff("", "new words")).toEqual([{ op: "insert", text: "new words" }]);
    expect(wordDiff("old words", "")).toEqual([{ op: "delete", text: "old words" }]);
  });

  it("diffs long texts line by line without blowing up", () => {
    const lines = Array.from({ length: 1500 }, (_, index) => `(${index}) paragraph text number ${index} stays the same.`);
    const before = lines.join("\n");
    const changed = [...lines];
    changed[700] = "(700) paragraph text number 700 was amended.";
    const after = changed.join("\n");
    const segments = wordDiff(before, after);
    expect(side(segments, "insert")).toBe(after);
    const stats = diffStats(segments);
    expect(stats.inserted).toBeGreaterThan(0);
    expect(stats.inserted).toBeLessThan(5);
  });
});

describe("searchTerms", () => {
  it("searches the clause numbers a question names, else the whole query", () => {
    expect(searchTerms("Which contracts include DFARS 252.204-7012 or 52.204-21?")).toEqual(["252.204-7012", "52.204-21"]);
    expect(searchTerms("GSAR 552.204-9")).toEqual(["GSAR 552.204-9"]);
    expect(searchTerms("liquidated damages")).toEqual(["liquidated damages"]);
  });
});
