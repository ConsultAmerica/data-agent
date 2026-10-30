import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import OriginalStructureView, { FIELD_COLUMNS, fieldPlacement } from "@/components/original-structure/original-structure-view";
import type { LayoutField, OriginalStructure } from "@/lib/original-structure";

vi.mock("@/components/viewers/document-viewer", () => ({
  default: ({ request }: { request: { pageNumber: number } | null }) => <div data-testid="viewer">page {request?.pageNumber}</div>,
}));
vi.mock("@/components/smart-view/oracle-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/smart-view/oracle-status")>()),
  useOracleMappings: () => [],
}));

function field(overrides: Partial<LayoutField>): LayoutField {
  return {
    kind: "field", id: overrides.label ?? "f", record_key: `field:${overrides.id ?? overrides.label ?? "f"}`, group: null, label: "Label", document_value: "", blank: false,
    extracted_value: "", effective_value: "", evidence: null, review_status: "Not reviewed", value_type: "text",
    found_by: "ruled form row", page: 1, bbox: null, value_bbox: null, flags: [], metadata: null, other_metadata: [],
    ...overrides,
  };
}

const data: OriginalStructure = {
  document_id: "d1", source_type: "pdf", pages: 5,
  sections: [
    {
      id: "s1", title: "A. General Information", page: 1,
      items: [
        field({ id: "f1", group: "1. Contractor Information", label: "Legal Entity", document_value: "ORBITAL FIELD SERVICES, LLC",
          extracted_value: "ORBITAL FIELD SERVICES, LLC", effective_value: "ORBITAL FIELD SERVICES, LLC", evidence: "Legal Entity ORBITAL FIELD SERVICES, LLC" }),
        field({ id: "f2", group: "2. Contract Information", label: "Contract Number", document_value: "C05550001",
          extracted_value: "C05550001", effective_value: "C05550001", review_status: "Needs review",
          flags: [{ code: "missed_value", message: "Extraction found no value, but the document shows one" }],
          metadata: { id: 7, field_key: "contract_number", label: "Contract Number", value: "C05550001", original_value: "C05550001",
            review_status: "pending", confidence: 0.99, extraction_method: "label_value", source_text: "Contract Number C05550001", page: 1, validation_status: "passed" },
          other_metadata: [{ id: 8, field_key: "contract_no", label: "contract_no", value: "", original_value: "", review_status: "pending",
            confidence: 0.25, extraction_method: "unresolved_value_region", source_text: null, page: 1, validation_status: "failed" }] }),
        field({ id: "f3", label: "9a. Prime Contractor", blank: true }),
      ],
    },
    {
      id: "s2", title: "C. Summary of Contract Modifications", page: 4,
      items: [{
        kind: "table", id: "t1", record_key: "table:4:0", title: "C. Summary of Contract Modifications", headers: ["Mod Number", "Funding Change"],
        headers_printed: true, pages: [4, 5], continued: true, detection_method: "pdf_ruling_lines", row_count: 3,
        rows: [
          { id: "r1", record_key: "table:4:0:row:0", page: 4, cells: ["1", "$1,000.00"] },
          { id: "r2", record_key: "table:4:0:row:1", page: 4, cells: ["2", "#########"], flags: [{ code: "cell_column_mismatch", column: 1, message: "Value doesn't match the rest of its column" }], review_status: "Needs review" },
          { id: "r3", record_key: "table:4:0:row:2", page: 5, cells: ["3", "$3,000.00"] },
        ],
      }],
    },
  ],
  unplaced: [field({ id: "u1", label: "Effective Date", document_value: null, extracted_value: "08/13/2025", page: 6, found_by: "target" })],
  stats: { sections: 2, fields: 3, blank_fields: 1, tables: 1, table_rows: 3, needs_review: 2, unplaced: 1 },
};

vi.mock("@/lib/original-structure", () => ({ getOriginalStructure: vi.fn(() => Promise.resolve(data)) }));
const { downloadMock } = vi.hoisted(() => ({ downloadMock: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/staging-workbook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staging-workbook")>()),
  downloadExport: downloadMock,
}));

function renderView() {
  render(<OriginalStructureView documentId="d1" documentName="brief.pdf" pageCount={6} stagingProfileId="generic_business_document" />);
}

describe("OriginalStructureView", () => {
  it("lists fields in document order with Type, Found By and Source Page as the last columns", async () => {
    renderView();
    const grid = (await screen.findAllByTestId("layout-field-grid"))[0];
    expect(within(grid).getAllByRole("columnheader").map((th) => th.textContent)).toEqual([...FIELD_COLUMNS]);
    expect(FIELD_COLUMNS.slice(-3)).toEqual(["Type", "Found By", "Source Page"]);
    const rows = within(grid).getAllByTestId("layout-field-row");
    // The item number has its own column; each item's name is printed once.
    expect(within(grid).getAllByTestId("item-number").map((c) => c.textContent)).toEqual(["1.", "2.", "9a."]);
    expect(within(grid).getAllByTestId("item-category").map((c) => c.textContent)).toEqual(["Contractor Information", "Contract Information", "Prime Contractor"]);
    expect(rows.map((row) => within(row).getAllByRole("cell")[2].textContent)).toEqual(["Legal Entity", "Contract Number", "Prime Contractor"]);
    expect(within(rows[0]).getAllByRole("cell")[7]).toHaveTextContent("Form line");
    // Blank printed fields are shown, not hidden.
    expect(within(rows[2]).getByText("Blank in document")).toBeInTheDocument();
    expect(screen.getByTestId("original-structure-stats")).toHaveTextContent("3 fields (1 blank on the page) · 1 tables · 3 table rows");
  });

  it("places numbered items consistently", () => {
    expect(fieldPlacement({ group: null, label: "3. Briefed Through" })).toEqual({ number: "3.", category: "Briefed Through", label: "Briefed Through" });
    expect(fieldPlacement({ group: "2. Contract Information", label: "Contract Number" })).toEqual({ number: "2.", category: "Contract Information", label: "Contract Number" });
    expect(fieldPlacement({ group: null, label: "Contract Type" })).toEqual({ number: "", category: "—", label: "Contract Type" });
  });

  it("prints each item's name once over all its rows", async () => {
    const one = { ...data, sections: [{ ...data.sections[0], items: [
      field({ id: "a", group: "10. Acquisition Agency", label: "Agency", document_value: "DOD" }),
      field({ id: "b", group: "10. Acquisition Agency", label: "Address" }),
      field({ id: "c", group: "10. Acquisition Agency", label: "Phone" }),
    ] }], unplaced: [] };
    render(<OriginalStructureView documentId="d1" documentName="brief.pdf" pageCount={6} stagingProfileId={null} structure={one} />);
    const grid = (await screen.findAllByTestId("layout-field-grid"))[0];
    const categories = within(grid).getAllByTestId("item-category");
    expect(categories).toHaveLength(1);
    expect(categories[0]).toHaveTextContent("Acquisition Agency");
    expect(categories[0]).toHaveAttribute("rowspan", "3");
    expect(within(grid).getByTestId("item-number")).toHaveTextContent("10.");
  });

  it("gives the grid the full width until a record is selected", async () => {
    renderView();
    await screen.findAllByTestId("layout-field-row");
    expect(screen.queryByRole("complementary", { name: "Record details" })).toBeNull();
    expect(screen.getByTestId("original-structure-hint")).toBeInTheDocument();
    fireEvent.click(screen.getAllByTestId("layout-field-row")[0]);
    expect(screen.getByRole("complementary", { name: "Record details" })).toBeInTheDocument();
    expect(screen.queryByTestId("original-structure-hint")).toBeNull();
  });

  it("exports the structure as Excel in its original layout", async () => {
    renderView();
    fireEvent.click(await screen.findByRole("button", { name: /Export Excel/ }));
    expect(downloadMock).toHaveBeenCalledWith(
      expect.objectContaining({ format: "xlsx", href: "/api/documents/d1/original-structure/export.xlsx" }),
      "brief - original structure.xlsx",
    );
  });

  it("collapses a section without dropping its records", async () => {
    renderView();
    const section = await screen.findByRole("region", { name: "A. General Information" });
    const toggle = within(section).getByRole("button", { name: /A. General Information/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(section).queryByTestId("layout-field-row")).toBeNull();
    fireEvent.click(toggle);
    expect(within(section).getAllByTestId("layout-field-row")).toHaveLength(3);
  });

  it("shows tables with their printed headers, one row per record, and flags cells that don't fit", async () => {
    renderView();
    const table = await screen.findByTestId("layout-table");
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["Mod Number", "Funding Change"]);
    expect(within(table).getAllByTestId("layout-table-row")).toHaveLength(3);
    expect(table).toHaveTextContent("pages 4–5 · continued across pages");
    expect(within(table).getByText("#########").className).toContain("text-danger");
  });

  it("opens record details with the original label, source text, extracted and reviewed values", async () => {
    renderView();
    fireEvent.click((await screen.findAllByTestId("layout-field-row"))[1]);
    const details = screen.getByTestId("layout-record-details");
    expect(details).toHaveTextContent("Original labelContract Number");
    expect(details).toHaveTextContent("Original source text");
    expect(details).toHaveTextContent("Extraction found no value, but the document shows one");
    expect(details).toHaveTextContent("Other extractionscontract_no: (empty)");
    expect(within(details).getByRole("link", { name: /Metadata review/ })).toHaveAttribute("href", "/documents/d1/review");
    expect(within(details).getByTestId("layout-oracle")).toHaveTextContent("No Oracle mapping configured.");
    expect(screen.getByTestId("viewer")).toHaveTextContent("page 1");
  });

  it("groups every candidate for a field, keeping confidence, validation and review apart", async () => {
    renderView();
    const row = (await screen.findAllByTestId("layout-field-row"))[1];
    expect(within(row).getByTestId("candidate-count")).toHaveTextContent("2 candidates");
    fireEvent.click(row);
    const candidates = within(screen.getByTestId("layout-candidates")).getAllByTestId("layout-candidate");
    expect(candidates.map((c) => within(c).getAllByRole("cell").map((cell) => cell.textContent))).toEqual([
      ["Contract Number", "C05550001", "99%", "passed", "Pending"],
      ["contract_no", "(empty)", "25%", "failed", "Pending"],
    ]);
  });

  it("keeps extracted fields that have no place in the layout", async () => {
    renderView();
    const other = await screen.findByRole("region", { name: /Other extracted fields/ });
    expect(within(other).getByText("Effective Date")).toBeInTheDocument();
    expect(within(other).getByText("08/13/2025")).toBeInTheDocument();
  });
});
