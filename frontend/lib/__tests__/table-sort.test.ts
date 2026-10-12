import { describe, expect, it } from "vitest";

import { compareText, cycleSort, sortByText } from "@/lib/table-sort";

describe("cycleSort", () => {
  it("cycles none → asc → desc → none for the same field", () => {
    expect(cycleSort(null, "name")).toEqual({ field: "name", direction: "asc" });
    expect(cycleSort({ field: "name", direction: "asc" }, "name")).toEqual({
      field: "name",
      direction: "desc",
    });
    expect(cycleSort({ field: "name", direction: "desc" }, "name")).toBeNull();
  });

  it("starts ascending when switching columns", () => {
    expect(cycleSort({ field: "name", direction: "desc" }, "amount")).toEqual({
      field: "amount",
      direction: "asc",
    });
  });
});

describe("compareText", () => {
  it("orders numbers numerically", () => {
    expect(compareText("10", "2")).toBeGreaterThan(0);
    expect(compareText("$1,200", "900")).toBeGreaterThan(0);
  });

  it("orders text case-insensitively", () => {
    expect(compareText("apple", "Banana")).toBeLessThan(0);
  });

  it("pushes blanks to the end", () => {
    expect(compareText("", "a")).toBeGreaterThan(0);
  });
});

describe("sortByText", () => {
  const rows = [
    { name: "Charlie", amount: "10" },
    { name: "Alice", amount: "2" },
    { name: "Bob", amount: "20" },
  ];

  it("sorts ascending and descending", () => {
    expect(
      sortByText(rows, { field: "name", direction: "asc" }, (row, field) =>
        String(row[field as keyof typeof row]),
      ).map((row) => row.name),
    ).toEqual(["Alice", "Bob", "Charlie"]);

    expect(
      sortByText(rows, { field: "amount", direction: "desc" }, (row, field) =>
        String(row[field as keyof typeof row]),
      ).map((row) => row.amount),
    ).toEqual(["20", "10", "2"]);
  });

  it("returns a copy when unsorted", () => {
    const result = sortByText(rows, null, (row) => row.name);
    expect(result).toEqual(rows);
    expect(result).not.toBe(rows);
  });
});
