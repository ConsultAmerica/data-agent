import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ContractSmartView, { categoryOf } from "@/components/smart-view/contract-smart-view";
import SmartDataGrid from "@/components/smart-view/smart-data-grid";
import SmartWorkspace from "@/components/smart-view/smart-workspace";
import { downloadBlob } from "@/lib/export";
import type { StagingCell, StagingDataset, StagingRecord, StagingWorkbook } from "@/lib/staging-workbook";

// Grids render 50 rows per pass; leave room when the suite runs in parallel.
vi.setConfig({ testTimeout: 20000 });

vi.mock("@/lib/export", () => ({ downloadBlob: vi.fn() }));
vi.mock("@/components/source-verification-panel", () => ({
  default: ({ request }: { request: { pageNumber: number; highlightText?: string } | null }) => (
    <div data-testid="source-viewer">page {request?.pageNumber} · {request?.highlightText}</div>
  ),
}));
vi.mock("@/lib/staging-workbook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staging-workbook")>()),
  getStagingRecord: vi.fn(),
}));
vi.mock("@/lib/classification", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/classification")>()),
  getClassification: vi.fn(async () => ({ family_label: "Government Contract", subtype: "SF 33 Solicitation / Award", status: "classified", confidence_level: "high" })),
}));
vi.mock("@/lib/oracle-templates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/oracle-templates")>()),
  listAllProfiles: vi.fn(async () => []),
}));
vi.mock("@/lib/doc-schemas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/doc-schemas")>()),
  documentForm: vi.fn(),
}));

function cell(field: string, label: string, value: string | null, page?: number): StagingCell {
  return {
    canonical_field: field, display_label: label, value, raw_value: value, value_type: "text",
    provenance: page ? { source_document_id: "d", source_filename: "c.pdf", source_type: "pdf", source_page: page, highlight_text: value } as StagingCell["provenance"] : null,
    validation: { status: value ? "passed" : "not_checked", checks: [] }, review_status: value ? "Verified" : "Missing", review_reasons: [],
  };
}

const SLOTS = ["section", "record_type", "record_id", "title", "value", "incorporation_type", "effective_date", "period_from", "period_to", "quantity_period", "pricing", "amount", "source_section"];

function record(id: string, values: Partial<Record<string, string>>, status = "Verified"): StagingRecord {
  return {
    record_id: id, record_status: status, links_to_dataset: null, source_columns: [], truncated_fields: [],
    cells: Object.fromEntries(SLOTS.map((s) => [`contract.data.${s}`, cell(`contract.data.${s}`, s, values[s] ?? null)])),
  } as unknown as StagingRecord;
}

function workbook(profileId = "contract_v3"): StagingWorkbook {
  const data: StagingDataset = {
    dataset_id: "contract_data", display_name: "Contract Data", cardinality: "repeating", role: "business", description: null, identity_fields: [],
    columns: SLOTS.map((key) => ({ canonical_field: `contract.data.${key}`, key, display_label: key.replace("_", " "), value_type: "text", expected: false })),
    records: [
      record("clin:1", { section: "CLINs", record_type: "CLIN", record_id: "0001", title: "ALL SERVICES", quantity_period: "10 Months", pricing: "Unit Price USD 142,035.17", amount: "USD 1,420,351.70" }),
      record("clin:2", { section: "CLINs", record_type: "CLIN", record_id: "0002", title: "TRAVEL", amount: "USD 30,000.00" }, "Needs Review"),
      record("del:1", { section: "Delivery", record_type: "Delivery", record_id: "0001", value: "POP 01 Oct 2024 to 31 Jul 2025", period_from: "01 Oct 2024", period_to: "31 Jul 2025" }),
      record("del:2", { section: "Delivery", record_type: "Delivery", record_id: "0002", value: "As required", period_from: "TBD" }),
      record("cl:1", { section: "FAR Clauses", record_type: "Clause", record_id: "52.246-2", title: "Inspection of Supplies", incorporation_type: "Incorporated by Reference", effective_date: "Aug 1996", source_section: "Section E" }),
      record("cl:2", { section: "DFARS Clauses", record_type: "Clause", record_id: "252.204-7012", title: "Safeguarding", source_section: "Section I" }),
      record("ref:1", { section: "FAR References", record_type: "Narrative reference", record_id: "52.212-4", title: "cited in text" }),
      record("f:1", { section: "Parties", record_type: "Field", record_id: "offeror", title: "15A. NAME", value: "CHUGACH" }),
      record("f:2", { section: "Overview", record_type: "Field", record_id: "contract_number", title: "2. CONTRACT NUMBER", value: "FA300224C0008" }),
    ],
    compact: true,
  };
  return {
    document_id: "doc-1", document_filename: "c.pdf",
    profile: { profile_id: profileId, profile_version: 1, display_name: "Contract", description: "", document_families: [], export_capabilities: [], oracle_mapping_capability: "none" },
    outcome: { status: "populated", title: "", message: "", details: [], record_count: 9, needs_review_count: 1 },
    datasets: [data], qa_summary: { verified: 8, needs_review: 1, missing: 0, record_count: 9 }, processing_metadata: {},
  } as unknown as StagingWorkbook;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: (q: string) => ({ matches: q.includes("min-width"), addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
});

// ---------------------------------------------------------------- SmartDataGrid

describe("SmartDataGrid", () => {
  const columns = [
    { key: "id", label: "CLIN", width: 100, pinned: true },
    { key: "desc", label: "Description", width: 300 },
    { key: "qty", label: "Quantity", width: 100 },
    { key: "empty", label: "Unit Price", width: 120 },
    { key: "reg", label: "Regulation", width: 110, filter: "options" as const },
  ];
  const rows = Array.from({ length: 60 }, (_, i) => ({
    id: `r${i}`, status: i % 2 ? "Verified" : "Needs Review",
    values: { id: String(i + 1).padStart(4, "0"), desc: `Item ${i + 1}`, qty: String(60 - i), empty: "", reg: i % 3 ? "FAR" : "DFARS" },
  }));
  const headers = () => screen.getAllByRole("columnheader").map((h) => h.textContent);

  it("hides columns empty for every shown row and brings them back with Show all fields", () => {
    render(<SmartDataGrid tableKey="t1" columns={columns} rows={rows} />);
    expect(headers().join(" ")).not.toContain("Unit Price");
    fireEvent.click(screen.getByLabelText(/Show all fields/));
    expect(headers().join(" ")).toContain("Unit Price");
    // An empty cell is shown as missing, never as data.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("sorts numerically, paginates, filters with chips and clears them", () => {
    render(<SmartDataGrid tableKey="t2" columns={columns} rows={rows} />);
    expect(screen.getByText("Page 1 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sort by Quantity" }));
    expect(screen.getAllByTestId("smart-row")[0]).toHaveTextContent("Item 60");
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.change(screen.getByLabelText("Filter Regulation"), { target: { value: "DFARS" } });
    fireEvent.change(screen.getByLabelText("Search records"), { target: { value: "Item 1" } });
    const chips = screen.getByTestId("filter-chips");
    expect(chips).toHaveTextContent("2 filters");
    expect(chips).toHaveTextContent("Regulation: DFARS");
    expect(screen.getAllByTestId("smart-row").every((r) => r.textContent?.includes("Item 1"))).toBe(true);
    fireEvent.click(within(chips).getByRole("button", { name: "Clear all" }));
    expect(screen.queryByTestId("filter-chips")).not.toBeInTheDocument();
  });

  it("pins identifiers, remembers column choices and exports what is filtered or selected", async () => {
    const { unmount } = render(<SmartDataGrid tableKey="t3" columns={columns} rows={rows} exportName="lines" />);
    await act(async () => undefined); // saved preferences load after mount (no hydration mismatch)
    expect(screen.getAllByRole("columnheader")[1].className).toContain("sticky");
    fireEvent.click(screen.getByRole("button", { name: /Columns/ }));
    fireEvent.click(screen.getByLabelText("Show Description"));
    expect(headers().join(" ")).not.toContain("Description");
    unmount();
    render(<SmartDataGrid tableKey="t3" columns={columns} rows={rows} exportName="lines" />);
    return waitFor(() => expect(headers().join(" ")).not.toContain("Description")).then(() => {
      fireEvent.click(screen.getAllByRole("checkbox", { name: /^Select / })[0]);
      fireEvent.click(screen.getByRole("button", { name: /Export selected/ }));
      expect(vi.mocked(downloadBlob).mock.calls[0][1]).toBe("lines-selected.csv");
    });
  });

  it("moves between cells with the arrow keys and copies a cell", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<SmartDataGrid tableKey="t4" columns={columns} rows={rows.slice(0, 3)} />);
    const first = document.querySelector<HTMLElement>('[data-cell="0:0"]')!;
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(document.querySelector('[data-cell="1:0"]'));
    fireEvent.click(screen.getAllByRole("button", { name: "Copy CLIN" })[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("0001"));
  });
});

// ---------------------------------------------------------------- Contract Smart View

describe("ContractSmartView", () => {
  function renderView(category: Parameters<typeof ContractSmartView>[0]["category"], onCategory = vi.fn(), onSelect = vi.fn()) {
    render(<ContractSmartView documentId="doc-1" workbook={workbook()} category={category} onCategory={onCategory} onSelect={onSelect} selectedId={null} mappings={[]} />);
    return { onCategory, onSelect };
  }

  it("categorises records by section and shows counts from the data", () => {
    const wb = workbook();
    const data = wb.datasets[0];
    expect(data.records.map(categoryOf)).toEqual(["lines", "lines", "deliveries", "deliveries", "clauses", "clauses", "clauses", "parties", "header"]);
    const { onCategory } = renderView("overview");
    const tabs = within(screen.getByRole("tablist", { name: "Contract categories" })).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toContain("Contract Lines2");
    expect(tabs.find((t) => t.textContent?.startsWith("Attachments"))!.className).toContain("opacity-60"); // empty, still open
    const cards = screen.getAllByTestId("metric-card").map((c) => c.textContent);
    expect(cards).toContain("FAR / DFARS clauses21 FAR · 1 DFARS · 0 other");
    expect(cards).toContain("Records needing review1");
    fireEvent.click(tabs.find((t) => t.textContent?.startsWith("FAR/DFARS"))!);
    expect(onCategory).toHaveBeenCalledWith("clauses");
  });

  it("shows clauses with clause columns only, derived regulation labelled, and references separately", () => {
    renderView("clauses");
    const head = screen.getAllByRole("columnheader").map((h) => h.textContent).join("|");
    expect(head).toContain("Regulation (from section)");
    expect(head).toContain("Clause Number");
    expect(head).not.toContain("amount");
    expect(screen.getAllByTestId("smart-row").map((r) => r.textContent)).toEqual([
      expect.stringContaining("52.246-2FARInspection of Supplies"), expect.stringContaining("252.204-7012DFARSSafeguarding"),
    ]);
    fireEvent.click(screen.getByRole("tab", { name: /References in the text/ }));
    expect(screen.getAllByTestId("smart-row")).toHaveLength(1);
  });

  it("gives each CLIN its performance period from its delivery record and expands to its schedules", () => {
    renderView("lines");
    const first = screen.getAllByTestId("smart-row")[0];
    expect(first).toHaveTextContent("01 Oct 2024 – 31 Jul 2025");
    expect(first).toHaveTextContent("0001"); // leading zeros kept
    fireEvent.click(within(first).getByRole("button", { name: "Expand row" }));
    const details = screen.getByTestId("line-details");
    expect(details).toHaveTextContent("POP 01 Oct 2024 to 31 Jul 2025");
    expect(details).toHaveTextContent("No saved mapping exports contract lines.");
  });

  it("draws a timeline only from valid printed dates", () => {
    renderView("deliveries");
    fireEvent.click(screen.getByRole("button", { name: /Timeline \(1 dated\)/ }));
    const timeline = screen.getByTestId("delivery-timeline");
    expect(within(timeline).getAllByRole("listitem")).toHaveLength(1); // "TBD" is not a date
    // The timeline follows the table's search and filters.
    fireEvent.change(screen.getByLabelText("Search records"), { target: { value: "As required" } });
    expect(screen.getByTestId("delivery-timeline")).toHaveTextContent("No dated records match");
  });

  it("never assigns an Oracle object to clauses or deliveries", () => {
    renderView("oracle");
    const view = screen.getByTestId("oracle-category-view");
    const clauses = within(view).getByText("FAR/DFARS Clauses").closest("tr")!;
    expect(clauses).toHaveTextContent("No Verified Oracle Import Destination");
    const header = within(view).getByText("Contract Header").closest("tr")!;
    expect(header).toHaveTextContent("No saved mapping yet");
  });
});

// ---------------------------------------------------------------- Smart workspace

describe("SmartWorkspace", () => {
  it("opens a selected record's evidence and keeps confidence, validation and human review apart", async () => {
    const { getStagingRecord } = await import("@/lib/staging-workbook");
    const full = record("cl:1", { section: "FAR Clauses", record_type: "Clause", record_id: "52.246-2", title: "Inspection of Supplies" });
    full.cells["contract.data.title"] = cell("contract.data.title", "Clause Title", "Inspection of Supplies", 82);
    vi.mocked(getStagingRecord).mockResolvedValue(full);
    render(<SmartWorkspace documentId="doc-1" workbook={workbook()} filename="c.pdf" pageCount={288} />);
    fireEvent.click(within(screen.getByRole("tablist", { name: "Contract categories" })).getByRole("tab", { name: /FAR\/DFARS/ }));
    fireEvent.click(screen.getAllByTestId("smart-row")[0]);
    await waitFor(() => expect(screen.getByTestId("source-viewer")).toHaveTextContent("page 82 · Inspection of Supplies"));
    const signals = screen.getByTestId("review-signals");
    expect(signals).toHaveTextContent("Evidence verified");
    expect(signals).toHaveTextContent("Passed");
    expect(signals).toHaveTextContent("Not provided by the extraction");
    expect(signals).toHaveTextContent("Not reviewed");
    expect(screen.getByTestId("intelligence-panel")).toHaveTextContent("No Verified Oracle Import Destination");
  });

  it("uses the document's schema form for other document types", async () => {
    const { documentForm } = await import("@/lib/doc-schemas");
    vi.mocked(documentForm).mockResolvedValue({
      document_id: "doc-1", schema_id: 7, schema_name: "Invoice", version_id: 70, version: "1.0", version_status: "published",
      assignment_kind: "automatic", newer_version: null,
      form: { found: 1, not_found: 0, issues: [], groups: [{ group_id: "summary", label: "Invoice Summary", kind: "section", description: null, columns: [], rows: [], total_rows: 0, page_size: 25, children: [],
        fields: [{ field_id: "invoice.number", label: "Invoice Number", type: "identifier", required: true, description: null, instructions: null,
          value: { value: "INV-1", status: "found", review_status: "Verified", page: 1, highlight: "INV-1", document_label: null, method: null } }] }] },
    });
    render(<SmartWorkspace documentId="doc-1" workbook={workbook("invoice")} filename="i.pdf" pageCount={1} />);
    expect(await screen.findByTestId("generic-smart-view")).toHaveTextContent("Invoice v1.0");
    fireEvent.click(screen.getByRole("button", { name: /INV-1/ }));
    expect(screen.getByTestId("source-viewer")).toHaveTextContent("page 1 · INV-1");
  });
});
