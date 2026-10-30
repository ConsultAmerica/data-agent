import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import OriginalStructureView, { FIELD_COLUMNS, fieldPlacement } from "@/components/original-structure/original-structure-view";
import type { LayoutField, LayoutTable, OriginalStructure } from "@/lib/original-structure";
import { RecordSelectionProvider } from "@/lib/record-selection";

vi.mock("@/components/viewers/document-viewer", () => ({
  default: ({ request }: { request: { pageNumber: number } | null }) => <div data-testid="viewer">page {request?.pageNumber}</div>,
}));
vi.mock("@/components/smart-view/oracle-status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/smart-view/oracle-status")>()),
  useOracleMappings: () => [],
}));

/** The item a field belongs to, as the backend layout sends it. */
function item(number: string, name: string, has_subfields = true) {
  return { id: `item:s1:${number}:${name}`, number, name, has_subfields };
}

function field(overrides: Partial<LayoutField>): LayoutField {
  return {
    kind: "field", id: overrides.label ?? "f", record_key: `field:${overrides.id ?? overrides.label ?? "f"}`, group: null, label: "Label", document_value: "", blank: false,
    extracted_value: "", effective_value: "", evidence: null, review_status: "Not reviewed", value_type: "text",
    found_by: "ruled form row", page: 1, bbox: null, value_bbox: null, flags: [], metadata: null, other_metadata: [],
    item: null, field_name: overrides.label ?? "Label", quality: "confirmed", quality_label: "Confirmed source value",
    ...overrides,
  };
}

const data: OriginalStructure = {
  document_id: "d1", source_type: "pdf", pages: 5,
  sections: [
    {
      id: "s1", title: "A. General Information", page: 1,
      items: [
        field({ id: "f1", group: "1. Contractor Information", label: "Legal Entity", item: item("1.", "Contractor Information"), document_value: "ORBITAL FIELD SERVICES, LLC",
          extracted_value: "ORBITAL FIELD SERVICES, LLC", effective_value: "ORBITAL FIELD SERVICES, LLC", evidence: "Legal Entity ORBITAL FIELD SERVICES, LLC" }),
        field({ id: "f2", group: "2. Contract Information", label: "Contract Number", item: item("2.", "Contract Information"), document_value: "C05550001",
          extracted_value: "C05550001", effective_value: "C05550001", review_status: "Needs review",
          flags: [{ code: "missed_value", message: "Extraction found no value, but the document shows one" }],
          metadata: { id: 7, field_key: "contract_number", label: "Contract Number", value: "C05550001", original_value: "C05550001",
            review_status: "pending", confidence: 0.99, extraction_method: "label_value", source_text: "Contract Number C05550001", page: 1, validation_status: "passed" },
          other_metadata: [{ id: 8, field_key: "contract_no", label: "contract_no", value: "", original_value: "", review_status: "pending",
            confidence: 0.25, extraction_method: "unresolved_value_region", source_text: null, page: 1, validation_status: "failed" }] }),
        field({ id: "f3", label: "9a. Prime Contractor", field_name: "Prime Contractor", item: item("9a.", "Prime Contractor", false), blank: true,
          quality: "blank", quality_label: "Blank in source" }),
      ],
    },
    {
      id: "s2", title: "C. Summary of Contract Modifications", page: 4,
      items: [{
        kind: "table", id: "t1", record_key: "table:4:0", title: "C. Summary of Contract Modifications", headers: ["Mod Number", "Funding Change"],
        headers_printed: true, pages: [4, 5], continued: true, detection_method: "pdf_ruling_lines", row_count: 3,
        context_source: "inherited",
        context: [
          { label: "Contractor Name", value: "ORBITAL FIELD SERVICES, LLC", record_key: "field:f1", page: 1 },
          { label: "Contract Number", value: "C05550001", record_key: "field:f2", page: 1 },
        ],
        rows: [
          { id: "r1", record_key: "table:4:0:row:0", page: 4, cells: ["1", "$1,000.00"], bbox: [40, 300, 560, 314] },
          { id: "r2", record_key: "table:4:0:row:1", page: 4, cells: ["2", "#########"], flags: [{ code: "cell_column_mismatch", column: 1, message: "Value doesn't match the rest of its column" }], review_status: "Needs review",
            cell_issues: [{ column: 1, quality: "unreadable", message: "Unreadable source value" }] },
          { id: "r3", record_key: "table:4:0:row:2", page: 5, cells: ["3", "$3,000.00"], cell_issues: [{ column: 1, quality: "unverified_ocr", message: "Unverified OCR result" }] },
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
    // The item number has its own column; each item's name is printed once,
    // as the backend layout decided it.
    expect(within(grid).getAllByTestId("item-number").map((c) => c.textContent)).toEqual(["1.", "2.", "9a."]);
    expect(within(grid).getAllByTestId("item-category").map((c) => c.textContent)).toEqual(["Contractor Information", "Contract Information", "Prime Contractor"]);
    // Sub-fields are sub-attributes; an item that is its own field has none.
    expect(within(grid).getAllByTestId("sub-attribute").map((c) => c.textContent)).toEqual(["Legal Entity", "Contract Number", ""]);
    expect(within(rows[0]).getAllByRole("cell")[8]).toHaveTextContent("Form line");
    // Blank printed fields are shown, not hidden, and say they are blank in the source.
    expect(within(rows[2]).getAllByText("Blank in source").length).toBeGreaterThan(0);
    expect(within(rows[2]).getByTestId("quality-chip")).toHaveTextContent("Blank in source");
    expect(within(rows[0]).queryByTestId("quality-chip")).toBeNull();
    expect(screen.getByTestId("original-structure-stats")).toHaveTextContent("3 fields (1 blank on the page) · 1 tables · 3 table rows");
  });

  it("places fields by the item the backend sent, never by re-reading the label", () => {
    expect(fieldPlacement({ record_key: "a", label: "3. Briefed Through", field_name: "Briefed Through", item: item("3.", "Briefed Through", false) }))
      .toEqual({ key: "item:s1:3.:Briefed Through", number: "3.", name: "Briefed Through", detail: "" });
    expect(fieldPlacement({ record_key: "b", label: "Contract Number", field_name: "Contract Number", item: item("2.", "Contract Information") }))
      .toEqual({ key: "item:s1:2.:Contract Information", number: "2.", name: "Contract Information", detail: "Contract Number" });
    // A numbered-looking label without an item from the backend stays as printed.
    expect(fieldPlacement({ record_key: "c", label: "4. Contract Type", field_name: "4. Contract Type", item: null }))
      .toEqual({ key: "c", number: "", name: "4. Contract Type", detail: "" });
  });

  it("shows a table's contract once above it and marks cells worth a second look", async () => {
    renderView();
    const table = await screen.findByTestId("layout-table");
    expect(within(table).getByTestId("table-context")).toHaveTextContent("Contractor Name: ORBITAL FIELD SERVICES, LLC");
    expect(within(table).getByTestId("table-context")).toHaveTextContent("Contract Number: C05550001");
    const rows = within(table).getAllByTestId("layout-table-row");
    // Not repeated in any row.
    expect(rows.every((row) => !row.textContent?.includes("C05550001"))).toBe(true);
    expect(within(rows[1]).getByText("#########")).toHaveAttribute("data-quality", "unreadable");
    expect(within(rows[2]).getByText("$3,000.00")).toHaveAttribute("title", "Unverified OCR result");
    expect(within(rows[0]).getByText("$1,000.00")).not.toHaveAttribute("data-quality");
  });

  it("adds no context line when the document prints the table's metadata above it", async () => {
    const printed = { ...data, sections: [data.sections[1]].map((section) => ({
      ...section, items: section.items.map((i) => (i.kind === "table" ? { ...i, context_source: "printed" as const } : i)),
    })), unplaced: [] };
    render(<OriginalStructureView documentId="d1" documentName="brief.pdf" pageCount={6} stagingProfileId={null} structure={printed} />);
    await screen.findByTestId("layout-table");
    expect(screen.queryByTestId("table-context")).toBeNull();
  });

  it("prints each item's name once over all its rows", async () => {
    const one = { ...data, sections: [{ ...data.sections[0], items: [
      field({ id: "a", group: "10. Acquisition Agency", label: "Agency", item: item("10.", "Acquisition Agency"), document_value: "DOD" }),
      field({ id: "b", group: "10. Acquisition Agency", label: "Address", item: item("10.", "Acquisition Agency") }),
      field({ id: "c", group: "10. Acquisition Agency", label: "Phone", item: item("10.", "Acquisition Agency") }),
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
      "brief - original file.xlsx",
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
    const other = await screen.findByRole("region", { name: /Extracted fields without a printed position/ });
    expect(within(other).getByText("Effective Date")).toBeInTheDocument();
    expect(within(other).getByText("08/13/2025")).toBeInTheDocument();
  });
});

describe("Original File grouping", () => {
  const periods: LayoutTable = {
    kind: "table", id: "t2", record_key: "table:2:0", title: "Contract Periods", headers: ["Item", "Contract Number", "Period", "Start Date", "Amount"],
    headers_printed: true, pages: [2], continued: false, detection_method: "pdf_ruling_lines", row_count: 3, context: [], context_source: null,
    shared_columns: [{ column: 0, label: "Item", value: "1" }, { column: 1, label: "Contract Number", value: "FA30-001" }],
    rows: [
      { id: "p0", record_key: "table:2:0:row:0", page: 2, cells: ["1", "FA30-001", "Base", "01/01/2025", "$100,000"] },
      { id: "p1", record_key: "table:2:0:row:1", page: 2, cells: ["1", "FA30-001", "Option 1", "", "$110,000"] },
      { id: "p2", record_key: "table:2:0:row:2", page: 2, cells: ["1", "FA30-001", "Option 2", "01/01/2027", "$120,000"] },
    ],
  };
  const pop = field({ id: "pop", label: "Period of Performance", document_value: "01/01/2025 - 12/31/2025", extracted_value: "01/01/2025 - 12/31/2025",
    effective_value: "01/01/2025 - 12/31/2025", parts: [{ label: "Start Date", value: "01/01/2025" }, { label: "End Date", value: "12/31/2025" }] });
  const grouped: OriginalStructure = {
    ...data, unplaced: [],
    sections: [
      { id: "s0", title: null, page: 1, items: [field({ id: "n", label: "Notice", document_value: "x", extracted_value: "x", effective_value: "x" })] },
      { id: "s1", title: "B. Contract Periods", page: 2, items: [pop, periods] },
    ],
    stats: { ...data.stats, artifacts_hidden: 2 },
  };
  const show = (structure = grouped) =>
    render(
      <RecordSelectionProvider scalars={[]} tables={[]}>
        <OriginalStructureView documentId="d1" documentName="brief.pdf" pageCount={6} stagingProfileId={null} structure={structure} />
      </RecordSelectionProvider>,
    );

  it("splits a printed date range into Start and End Date rows and keeps the printed text", async () => {
    show();
    const grid = (await screen.findAllByTestId("layout-field-grid"))[1];
    const parts = within(grid).getAllByTestId("composite-part");
    expect(parts.map((row) => within(row).getAllByRole("cell").slice(1, 3).map((c) => c.textContent))).toEqual([
      ["01/01/2025", "↳ Start Date"], ["12/31/2025", "↳ End Date"],
    ]);
    expect(within(grid).getByTestId("composite-source")).toHaveTextContent("Printed as 01/01/2025 - 12/31/2025");
    // The field's name spans its own row and its parts.
    expect(within(grid).getByTestId("item-category")).toHaveAttribute("rowspan", "3");
    // A part is not a record of its own: it opens the field.
    fireEvent.click(parts[1]);
    expect(screen.getByTestId("layout-record-details")).toHaveTextContent("Original labelPeriod of Performance");
  });

  it("shows a contract and item shared by every row once above the table, keeping every row", async () => {
    show();
    const table = await screen.findByTestId("layout-table");
    expect(within(table).getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["Period", "Start Date", "Amount"]);
    expect(within(table).getAllByTestId("shared-column").map((c) => c.textContent)).toEqual(["Item: 1", "Contract Number: FA30-001"]);
    const rows = within(table).getAllByTestId("layout-table-row");
    expect(rows.map((row) => row.textContent)).toEqual(["Base01/01/2025$100,000", "Option 1$110,000", "Option 201/01/2027$120,000"]);
    // A blank source cell stays a blank cell.
    expect(within(rows[1]).getAllByRole("cell").map((c) => c.textContent)).toEqual(["", "Option 1", "", "$110,000"]);
  });

  it("leaves other tabs' tables as they are", async () => {
    const { TableView } = await import("@/components/original-structure/original-structure-view");
    render(<TableView table={periods} selectedId={null} onSelect={() => undefined} />);
    expect(within(screen.getByTestId("layout-table")).getAllByRole("columnheader")).toHaveLength(5);
    expect(screen.queryByTestId("shared-column")).toBeNull();
  });

  it("names sections by their printed heading and a table by its own caption", async () => {
    show();
    expect(await screen.findByRole("region", { name: "Before the first heading" })).toBeInTheDocument();
    expect(screen.queryByText("Document start")).toBeNull();
    expect(within(await screen.findByTestId("layout-table")).getByText("Contract Periods")).toBeInTheDocument();
    expect(screen.getByTestId("original-structure-stats")).toHaveTextContent("2 empty layout artifacts hidden");
  });

  it("selects a section's records, shows a part-selected section, and keeps selection while collapsed", async () => {
    show();
    const section = await screen.findByRole("region", { name: "B. Contract Periods" });
    const all = within(section).getByRole("checkbox", { name: "Select all records in B. Contract Periods" }) as HTMLInputElement;
    fireEvent.click(all);
    expect(all.checked).toBe(true);
    const row = within(section).getByRole("checkbox", { name: "Select row 2 of Contract Periods" }) as HTMLInputElement;
    expect(row.checked).toBe(true);
    fireEvent.click(row);
    expect(all.checked).toBe(false);
    expect(all.indeterminate).toBe(true);
    fireEvent.click(within(section).getByRole("button", { name: /B. Contract Periods/ }));
    fireEvent.click(within(section).getByRole("button", { name: /B. Contract Periods/ }));
    expect((within(section).getByRole("checkbox", { name: "Select row 1 of Contract Periods" }) as HTMLInputElement).checked).toBe(true);
    expect((within(section).getByRole("checkbox", { name: "Select row 2 of Contract Periods" }) as HTMLInputElement).checked).toBe(false);
  });
});

describe("Original File metadata and source location", () => {
  it("names a table's contract with the label the document printed, and says where each record can be traced", async () => {
    const located = {
      ...data,
      sections: data.sections.map((section) => ({
        ...section,
        items: section.items.map((i) => (i.kind === "table"
          ? { ...i, context: [{ label: "Contractor Name", printed_label: "Legal Entity", value: "ORBITAL FIELD SERVICES, LLC", record_key: "field:f1", page: 1 }],
              rows: i.rows.map((r) => ({ ...r, source_location: "exact" as const })) }
          : i)),
      })),
      unplaced: [{ ...data.unplaced[0], quality: "extracted", quality_label: "Extracted value", source_location: "page" as const }],
    };
    render(<OriginalStructureView documentId="d1" documentName="brief.pdf" pageCount={6} stagingProfileId={null} structure={located} />);
    const context = await screen.findByTestId("table-context");
    expect(context).toHaveTextContent("Legal Entity: ORBITAL FIELD SERVICES, LLC");
    expect(context).not.toHaveTextContent("Contractor Name:");
    // An extracted value without coordinates: its quality is not an error,
    // and its location is said on its own.
    const other = screen.getByRole("region", { name: /Extracted fields without a printed position/ });
    fireEvent.click(within(other).getByTestId("layout-field-row"));
    const details = screen.getByTestId("layout-record-details");
    expect(details).toHaveTextContent("Data qualityExtracted value");
    expect(details).toHaveTextContent("Source locationSource page only (no exact position recorded)");
    fireEvent.click(within(screen.getByTestId("layout-table")).getAllByTestId("layout-table-row")[0]);
    expect(screen.getByTestId("layout-record-details")).toHaveTextContent("Source locationExact region on the page");
  });
});

describe("TableView", () => {
  it("hides columns and rows with nothing in them, but never a printed column", async () => {
    const { TableView } = await import("@/components/original-structure/original-structure-view");
    const table = {
      kind: "table" as const, id: "t", record_key: "table:1:0", title: "Schedule", headers: ["Column 1", "Column 2", "Column 3"],
      headers_printed: false, pages: [1], continued: false, detection_method: "pdf_ruling_lines", row_count: 3,
      rows: [
        { id: "a", record_key: "table:1:0:row:0", page: 1, cells: ["0001", "", "Firm Price"] },
        { id: "b", record_key: "table:1:0:row:1", page: 1, cells: ["", "", ""] },
        { id: "c", record_key: "table:1:0:row:2", page: 1, cells: ["0002", "", "Estimated Cost"] },
      ],
    };
    render(<TableView table={table} selectedId={null} onSelect={() => undefined} />);
    const box = screen.getByTestId("layout-table");
    expect(within(box).getAllByRole("columnheader").map((th) => th.textContent)).toEqual(["Column 1", "Column 3"]);
    expect(within(box).getAllByTestId("layout-table-row")).toHaveLength(2);
    expect(box).toHaveTextContent("1 empty column hidden · 1 empty row hidden");
  });
});
