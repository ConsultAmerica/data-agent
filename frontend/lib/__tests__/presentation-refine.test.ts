import { describe, expect, it } from "vitest";

import { orderGroups, refineGroups, type PresentationGroup, type PresentationSection } from "@/lib/presentation-manifest";

function detail(id: string, title: string | null, count: number): PresentationSection {
  return {
    id,
    title,
    pattern: "detail",
    items: Array.from({ length: count }, (_, i) => ({ id: `${id}:${i}`, label: `Field ${i}` })),
  } as unknown as PresentationSection;
}

describe("refineGroups", () => {
  const base = (): PresentationGroup[] => [
    { id: "summary", label: "Invoice Summary", sections: [detail("main", null, 4), detail("refs", "References", 1)] },
    { id: "parties", label: "Parties", sections: [detail("p", null, 2)] },
  ];

  it("names the summary Summary, titles its card and merges a single reference", () => {
    const groups = refineGroups(base(), "Invoice");
    const summary = groups.at(-1)!;
    // Summary is always the last tab.
    expect(summary.label).toBe("Summary");
    expect(summary.sections).toHaveLength(1);
    expect(summary.sections[0]).toMatchObject({ pattern: "card", title: "Invoice Details" });
    expect(summary.sections[0].items).toHaveLength(5);
  });

  it("folds a small Other Information into the Summary", () => {
    const groups = refineGroups([...base(), { id: "other", label: "Other Information", sections: [detail("notes", "Notes", 1)] }], "Invoice");
    expect(groups.map((group) => group.label)).toEqual(["Parties", "Summary"]);
    expect(groups[1].sections.at(-1)).toMatchObject({ title: "Additional Information" });
  });

  it("names a single-subject Other tab after its subject", () => {
    const groups = refineGroups(
      [...base(), { id: "other", label: "Other Information", sections: [detail("ship", "Shipping & Commercial", 6)] }],
      "Invoice",
    );
    expect(groups.map((group) => group.label)).toEqual(["Parties", "Shipping & Commercial", "Summary"]);
    expect(groups[1].sections[0].title).toBeNull();
  });

  it("orders tabs Content, Contacts, Line Items, Table Data, Other Information, with Summary last", () => {
    const group = (id: string, label: string) => ({ id, label, sections: [detail(id, null, 1)] });
    const ordered = orderGroups([
      group("summary", "Summary"), group("other", "Other Information"), group("tables", "Table Data"),
      group("charges", "Charges & Totals"), group("lines", "Line Items"), group("contacts", "Contacts"), group("content", "Content"),
    ]);
    expect(ordered.map((g) => g.label)).toEqual([
      "Content", "Contacts", "Line Items", "Charges & Totals", "Table Data", "Other Information", "Summary",
    ]);
  });

  it("uses Document Details for a long document title", () => {
    const summary = refineGroups(base(), "Part 52 - Solicitation Provisions and Contract Clauses").at(-1)!;
    expect(summary.sections[0].title).toBe("Document Details");
  });
});
