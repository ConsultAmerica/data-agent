import { render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ExtractionResultsWorkspace from "@/components/extraction/extraction-results-workspace";
import { showsClauses } from "@/lib/classification";
import { PLATFORM_SECTIONS } from "@/components/navigation/nav-config";
import type { ContractAnalysisResult, UploadedDocument } from "@/types/document";

// Clauses (FAR/DFARS) and contract relationships appear only for contract
// and FAR documents — not for invoices, passports, transcripts or reports.

const { getClassification, getClauses, extractClauses, extractTables } = vi.hoisted(() => ({
  getClassification: vi.fn(),
  getClauses: vi.fn(),
  extractClauses: vi.fn(),
  extractTables: vi.fn(),
}));

vi.mock("@/lib/classification", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/classification")>()),
  getClassification,
}));
vi.mock("@/lib/documents", () => ({ getClauses, extractClauses, extractTables }));
vi.mock("@/components/extraction/extraction-document-header", () => ({ default: () => <div /> }));

const document = {
  document_id: "doc-1", original_filename: "invoice.pdf", status: "ready", content_type: "application/pdf",
  size_bytes: 10, checksum_sha256: null, page_count: 1, encrypted: false, uploaded_at: "2026-10-29T00:00:00Z", message: "",
} as UploadedDocument;

function analysis(relationship: ContractAnalysisResult["relationship"] = null): ContractAnalysisResult {
  return {
    document_id: "doc-1",
    classification: { document_type: "Invoice", industry: null, contract_side: "unknown", language: "en", document_status: "Original", confidence: 0.9 } as never,
    metadata_fields: [],
    relationship,
    warnings: [],
  };
}

function renderWorkspace(relationship: ContractAnalysisResult["relationship"] = null) {
  return render(
    <ExtractionResultsWorkspace document={document} analysis={analysis(relationship)} pages={[]} structuredOutput={null} universalResult={null}
      extractingPages={false} pagesError="" onRetryPages={vi.fn()} relationshipBusy={false} onRelationshipAction={vi.fn()} onRelationshipChange={vi.fn()} />,
  );
}

const tabs = () => within(screen.getAllByRole("tablist")[0]).getAllByRole("tab").map((t) => t.textContent);

beforeEach(() => {
  vi.clearAllMocks();
  getClauses.mockResolvedValue({ clauses: [] });
  extractClauses.mockResolvedValue({ clauses: [] });
  extractTables.mockResolvedValue({ tables: [] });
});

describe("Clause tools by document type", () => {
  it("hides Clauses and Relationships for an invoice, and never runs clause extraction on it", async () => {
    getClassification.mockResolvedValue({ family: "invoice" });
    renderWorkspace();
    await waitFor(() => expect(getClauses).toHaveBeenCalled());
    expect(tabs()).not.toContain("Clauses");
    expect(tabs()).not.toContain("Relationships");
    expect(tabs()).toEqual(expect.arrayContaining(["Overview", "Extracted Data", "Tables", "Pages", "Structured Output", "Activity"]));
    expect(extractClauses).not.toHaveBeenCalled();
    expect(screen.queryByText("Clauses")).toBeNull();
  });

  it.each(["passport", "academic_transcript", "generic_business"])("hides them for a %s too", async (family) => {
    getClassification.mockResolvedValue({ family });
    renderWorkspace();
    await waitFor(() => expect(getClauses).toHaveBeenCalled());
    expect(tabs()).not.toContain("Clauses");
  });

  it("shows Clauses and Relationships for a contract and extracts its clauses", async () => {
    getClassification.mockResolvedValue({ family: "government_contract" });
    renderWorkspace();
    await waitFor(() => expect(tabs()).toContain("Clauses"));
    expect(tabs()).toContain("Relationships");
    await waitFor(() => expect(extractClauses).toHaveBeenCalledWith("doc-1"));
  });

  it("still shows clauses or a relationship a non-contract document actually has", async () => {
    getClassification.mockResolvedValue({ family: "generic_business" });
    getClauses.mockResolvedValue({ clauses: [{ clause_type: "FAR" }] });
    renderWorkspace({
      parent_document_id: "p", parent_document_title: "Base contract", parent_document_number: "W1", relationship_type: "amendment_of",
      confidence: 0.9, matched_on: "contract_number", status: "pending", reasons: [], detection_method: "automatic",
    } as never);
    await waitFor(() => expect(tabs()).toContain("Clauses"));
    expect(tabs()).toContain("Relationships");
  });

  it("decides from the family and any extracted clauses", () => {
    expect(showsClauses("far_regulation")).toBe(true);
    expect(showsClauses("invoice")).toBe(false);
    expect(showsClauses("invoice", 2)).toBe(true);
    expect(showsClauses(null)).toBe(false);
  });

  it("keeps FAR / DFARS out of the header's general Intelligence menu", () => {
    const intelligence = PLATFORM_SECTIONS.find((group) => group.title === "Intelligence");
    expect(intelligence?.tiles.map((tile) => tile.label)).not.toContain("FAR / DFARS");
  });
});
