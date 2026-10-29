import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ContractTabs, { TABS } from "@/components/contract-tabs";
import ExtractionWorkspace from "@/components/extraction-workspace";
import ReviewFieldList from "@/components/review-field-list";
import type { MetadataField } from "@/types/document";

// Clause tools appear only where clauses exist (contracts, FAR documents);
// and "Accept" always says what it did or why it was refused.

function workspace(showClauses: boolean) {
  return (
    <ExtractionWorkspace
      clauses={[]} extractingClauses={false} clausesError="" onExtractClauses={vi.fn()} onViewClauseSource={vi.fn()}
      tables={[]} extractingTables={false} tablesError="" onExtractTables={vi.fn()}
      signatures={[]} extractingSignatures={false} signaturesError="" onExtractSignatures={vi.fn()} onViewSignatureSource={vi.fn()}
      showClauses={showClauses}
    />
  );
}

describe("Clause tools by document type", () => {
  it("leaves the Clauses tab out of the document tabs when given the applicable tabs", () => {
    const onChange = vi.fn();
    render(<ContractTabs active="Data" onChange={onChange} tabs={TABS.filter((t) => t !== "Clauses")} />);
    const names = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(names).toEqual(["Overview", "Data", "Relationships", "Documents", "Activity"]);
    expect(screen.getByRole("tab", { name: "Data" }).getAttribute("aria-selected")).toBe("true");
  });

  it("shows every tab by default", () => {
    render(<ContractTabs active="Data" onChange={vi.fn()} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toContain("Clauses");
  });

  it("hides the clause panel (and Extract Clauses) for documents without clauses", () => {
    const { unmount } = render(workspace(false));
    expect(screen.queryByRole("button", { name: /^Clauses/ })).toBeNull();
    expect(screen.queryByText(/Extract Clauses/)).toBeNull();
    expect(screen.getByRole("button", { name: /^Tables/ })).toBeTruthy();
    unmount();
    render(workspace(true));
    expect(screen.getByRole("button", { name: /^Clauses/ })).toBeTruthy();
  });
});

describe("Accept pending values", () => {
  const field = {
    id: 1, field_group: "Legal", field_key: "governing_law", label: "Governing Law", value: "Delaware", confidence: 0.9,
    extraction_method: "label_value", extraction_source: "contract", evidence: { page_number: 1, source_text: "x", source_reference: "p1" },
    verified: false, review_status: "pending", original_value: "Delaware", extracted_value: "Delaware",
  } as unknown as MetadataField;

  it("shows why Accept was refused instead of doing nothing", () => {
    const onAcceptAll = vi.fn();
    render(
      <ReviewFieldList documentId="d1" fields={[field]} activeFieldId={null} onSelectField={vi.fn()} onReviewField={vi.fn()}
        onAcceptAll={onAcceptAll} reviewingFieldId={null} acceptingAll={false}
        acceptAllMessage={{ tone: "error", text: "Metadata review mutations are disabled for this release." }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Accept low-risk pending/ }));
    expect(onAcceptAll).toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe("Metadata review mutations are disabled for this release.");
  });

  it("says what is left after accepting low-risk values", () => {
    render(
      <ReviewFieldList documentId="d1" fields={[field]} activeFieldId={null} onSelectField={vi.fn()} onReviewField={vi.fn()}
        onAcceptAll={vi.fn()} reviewingFieldId={null} acceptingAll={false}
        acceptAllMessage={{ tone: "info", text: "Low-risk values accepted. 3 flagged values still need an individual decision." }} />,
    );
    expect(screen.getByRole("status").textContent).toContain("3 flagged values");
  });
});
