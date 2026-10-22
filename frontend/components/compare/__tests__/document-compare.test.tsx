import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DocumentCompare from "@/components/compare/document-compare";
import { compareDocuments, type CompareResult } from "@/lib/compare";
import { listDocuments } from "@/lib/documents";
import type { DocumentSummary } from "@/types/document";

const replace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => searchParams,
}));
vi.mock("@/lib/documents", () => ({ listDocuments: vi.fn() }));
vi.mock("@/lib/compare", () => ({ compareDocuments: vi.fn() }));

function doc(id: string, name: string): DocumentSummary {
  return {
    document_id: id,
    original_filename: name,
    document_type: "Government Contract",
    status: "completed",
    confidence: 0.9,
    uploaded_at: "2026-09-01T00:00:00Z",
    page_count: 2,
    fields_extracted: 10,
    last_updated: "2026-09-01T00:00:00Z",
  } as DocumentSummary;
}

const RESULT: CompareResult = {
  left: { document_id: "a", name: "base.pdf", document_type: null, profile: null },
  right: { document_id: "b", name: "mod.pdf", document_type: null, profile: null },
  summary: { changed: 1, added: 1, removed: 0, unchanged: 1 },
  sections: [
    {
      section_id: "line_items",
      label: "Line items / CLINs",
      counts: { changed: 1, added: 1, removed: 0, unchanged: 1 },
      rows: [
        { key: "0001.amount", label: "CLIN 0001 · Amount", group: "CLIN 0001", left: "$1,000.00", right: "$1,200.00", change: "changed", detail: "+$200.00" },
        { key: "0003", label: "CLIN 0003", group: "CLIN 0003", left: null, right: "Option year", change: "added", detail: null },
        { key: "0004", label: "CLIN 0004", group: "CLIN 0004", left: "Travel", right: "Travel", change: "unchanged", detail: null },
      ],
    },
  ],
};

describe("DocumentCompare", () => {
  beforeEach(() => {
    replace.mockReset();
    vi.mocked(listDocuments).mockResolvedValue([doc("a", "base.pdf"), doc("b", "mod.pdf")]);
    vi.mocked(compareDocuments).mockResolvedValue(RESULT);
  });

  it("asks for two documents before comparing", async () => {
    searchParams = new URLSearchParams();
    render(<DocumentCompare />);
    expect(await screen.findByText(/Pick a base document/)).toBeTruthy();
    expect(compareDocuments).not.toHaveBeenCalled();
  });

  it("syncs the picked documents to the URL", async () => {
    searchParams = new URLSearchParams("left=a");
    render(<DocumentCompare />);
    await screen.findAllByRole("option", { name: /mod\.pdf/ });
    fireEvent.change(screen.getByLabelText("Compared document"), { target: { value: "b" } });
    expect(replace).toHaveBeenCalledWith("/compare?left=a&right=b");
    fireEvent.click(screen.getByRole("button", { name: "Swap documents" }));
    expect(replace).toHaveBeenLastCalledWith("/compare?right=a");
  });

  it("shows differences with deltas and hides unchanged rows by default", async () => {
    searchParams = new URLSearchParams("left=a&right=b");
    render(<DocumentCompare />);
    expect(await screen.findByText("CLIN 0001 · Amount")).toBeTruthy();
    expect(compareDocuments).toHaveBeenCalledWith("a", "b");
    expect(screen.getByText("+$200.00")).toBeTruthy();
    expect(screen.getByText("Option year").closest("tr")?.getAttribute("data-change")).toBe("added");
    expect(screen.queryByText("CLIN 0004")).toBeNull();

    const summary = screen.getByRole("list", { name: "Change summary" });
    expect(within(summary).getByText("Changed")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Show unchanged"));
    expect(screen.getByText("CLIN 0004")).toBeTruthy();
  });

  it("reports a failed comparison", async () => {
    searchParams = new URLSearchParams("left=a&right=b");
    vi.mocked(compareDocuments).mockRejectedValueOnce(new Error("Document not found."));
    render(<DocumentCompare />);
    expect((await screen.findByRole("alert")).textContent).toContain("Document not found.");
  });
});
