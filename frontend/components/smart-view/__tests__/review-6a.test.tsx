import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ContractSmartView, { categoryOf, printedCurrency, type CategoryId, type SelectedRecord } from "@/components/smart-view/contract-smart-view";
import type { CategoryMapping } from "@/components/smart-view/oracle-status";
import RecordDetails, { sourceRequestFor } from "@/components/smart-view/record-details";
import SmartDataGrid, { numberOf } from "@/components/smart-view/smart-data-grid";
import SmartWorkspace from "@/components/smart-view/smart-workspace";
import { downloadBlob } from "@/lib/export";
import type { StagingCell, StagingRecord, StagingWorkbook } from "@/lib/staging-workbook";

// Increment 6A: dedicated contract tables, intelligent columns and record
// details, against the real SF 1442 award's staging workbook
// (reference/regression/SF1442 Award_N4019223D2803.pdf, contract_data and
// contract_overview datasets only).

vi.setConfig({ testTimeout: 30000 });

vi.mock("@/lib/export", () => ({ downloadBlob: vi.fn() }));
vi.mock("@/components/source-verification-panel", () => ({
  default: ({ request }: { request: { pageNumber: number; highlightText?: string; region?: unknown } | null }) => (
    <div data-testid="source-viewer">page {request?.pageNumber} · {request?.highlightText}{request?.region ? " · region" : ""}</div>
  ),
}));
vi.mock("@/lib/source-view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/source-view")>()),
  getSourceView: vi.fn(async () => ({ viewer: "pdf", format: "pdf", verified: true, note: null })),
}));
vi.mock("@/lib/staging-workbook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staging-workbook")>()),
  getStagingRecord: vi.fn(),
}));
vi.mock("@/lib/classification", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/classification")>()),
  getClassification: vi.fn(async () => null),
}));
vi.mock("@/lib/oracle-templates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/oracle-templates")>()),
  listAllProfiles: vi.fn(async () => []),
}));

const SF1442 = JSON.parse(
  readFileSync(resolve(process.cwd(), "components/smart-view/__tests__/fixtures/sf1442-workbook.json"), "utf-8"),
) as StagingWorkbook;
const DATA = SF1442.datasets.find((d) => d.dataset_id === "contract_data")!;
// Full records (every cell with its provenance), as getStagingRecord loads them.
const FULL = JSON.parse(
  readFileSync(resolve(process.cwd(), "components/smart-view/__tests__/fixtures/sf1442-records.json"), "utf-8"),
) as Record<string, StagingRecord>;
const full = (record: StagingRecord) => FULL[record.record_id] ?? record;
const field = (record: StagingRecord, key: string) => String(record.cells[`contract.data.${key}`]?.value ?? "");
const bySection = (section: string) => DATA.records.filter((r) => field(r, "section") === section);

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: (q: string) => ({ matches: q.includes("min-width"), addEventListener: vi.fn(), removeEventListener: vi.fn() }) });
});

function renderContract(category: CategoryId, onSelect = vi.fn()) {
  const view = (id: CategoryId) => (
    <ContractSmartView documentId="doc-1" workbook={SF1442} category={id} onCategory={(next) => rerender(view(next))} onSelect={onSelect} selectedId={null} mappings={[]} />
  );
  const { rerender } = render(view(category));
  return { onSelect };
}

const tab = (name: RegExp) => within(screen.getByRole("tablist", { name: "Contract categories" })).getByRole("tab", { name });
// The first header is the row-selection checkbox.
const headers = () => screen.getAllByRole("columnheader").slice(1).map((h) => h.textContent ?? "");
/** Stored column preferences load just after mount. */
const settle = () => act(async () => {});

// ---------------------------------------------------------------- classification and counts

describe("Contract categories (SF 1442)", () => {
  it("puts every extracted record in a category — none are lost", () => {
    const uncategorised = DATA.records.filter((r) => categoryOf(r) === null);
    expect(uncategorised).toEqual([]);
    expect(DATA.records).toHaveLength(244);
  });

  it("classifies clauses, contract lines and deliveries from the extracted section and record type", () => {
    const of = (id: CategoryId) => DATA.records.filter((r) => categoryOf(r) === id);
    expect(of("lines").map((r) => field(r, "record_id"))).toEqual(["0001", "0002", "0003", "0004"]);
    const clauses = of("clauses").filter((r) => field(r, "section") !== "FAR References");
    expect(clauses).toHaveLength(bySection("FAR Clauses").length + bySection("DFARS Clauses").length);
    expect(of("deliveries").every((r) => ["Delivery", "Performance"].includes(field(r, "section")))).toBe(true);
    expect(of("deliveries").some((r) => field(r, "record_type") === "Field")).toBe(false);
  });

  it("shows tab counts calculated from the records", () => {
    renderContract("overview");
    expect(tab(/Contract Lines/)).toHaveTextContent("4");
    expect(tab(/FAR\/DFARS Clauses/)).toHaveTextContent("183");
    expect(tab(/Deliveries/)).toHaveTextContent(String(DATA.records.filter((r) => categoryOf(r) === "deliveries").length));
    expect(tab(/All Records/)).toHaveTextContent("244");
  });

  it("switches categories and keeps All Records complete", () => {
    renderContract("overview");
    fireEvent.click(tab(/All Records/));
    expect(screen.getByText(/of 244/)).toBeInTheDocument();
    // Every column of the dataset can be revealed.
    fireEvent.click(screen.getByRole("button", { name: /^Show all fields/ }));
    expect(headers().length).toBeGreaterThanOrEqual(DATA.columns.length + 1);
    fireEvent.click(tab(/Contract Lines/));
    expect(screen.getByText(/of 4$/)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- dedicated tables

describe("Dedicated tables", () => {
  it("shows clauses with clause columns, regulation from the section, and filters by regulation and review status", () => {
    renderContract("clauses");
    // The clause number is pinned first.
    expect(headers().slice(0, 3)).toEqual(["Clause Number", "Regulation (from section)", "Clause Title"]);
    expect(headers().join(" ")).not.toMatch(/Unit Price|Amount|CLIN/);
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.change(screen.getByLabelText("Filter Regulation (from section)"), { target: { value: "DFARS" } });
    expect(screen.getByText(`${bySection("DFARS Clauses").length} of 183`)).toBeInTheDocument();
    const statuses = [...new Set(bySection("DFARS Clauses").map((r) => r.record_status))];
    fireEvent.change(screen.getByLabelText("Filter Review status"), { target: { value: statuses[0] } });
    expect(screen.getByTestId("filter-chips")).toHaveTextContent(`Review status: ${statuses[0]}`);
    // Search by clause number.
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    const first = bySection("DFARS Clauses")[0];
    fireEvent.change(screen.getByLabelText("Search records"), { target: { value: field(first, "record_id") } });
    expect(screen.getAllByTestId("smart-row")[0]).toHaveTextContent(field(first, "record_id"));
  });

  it("shows contract lines with leading zeros, unit, amount and the currency as printed — and filters by amount", () => {
    renderContract("lines");
    const rows = screen.getAllByTestId("smart-row");
    expect(rows.map((r) => r.textContent?.slice(0, 4))).toEqual(["0001", "0002", "0003", "0004"]);
    expect(headers().join(" ")).toMatch(/CLIN.*Description.*Quantity.*Unit.*Unit Price.*Amount.*Currency \(as printed\)/);
    expect(rows[0]).toHaveTextContent("$600,000,000.00 NTE");
    expect(rows[0]).toHaveTextContent("$");
    // "NSP" states no amount: excluded by an amount range, never read as 0.
    fireEvent.click(screen.getByRole("button", { name: /^Filters/ }));
    fireEvent.change(screen.getByLabelText("Amount minimum"), { target: { value: "1000" } });
    expect(screen.getAllByTestId("smart-row")).toHaveLength(1);
    expect(screen.getByTestId("filter-chips")).toHaveTextContent("Amount: ≥ 1,000");
  });

  it("shows deliveries with their own columns and keeps records with no CLIN", () => {
    renderContract("deliveries");
    const deliveries = DATA.records.filter((r) => categoryOf(r) === "deliveries");
    expect(screen.getAllByTestId("smart-row")).toHaveLength(deliveries.length);
    expect(headers()[0]).toBe("Related CLIN");
    expect(headers().join(" ")).toContain("Delivery Description");
    // No delivery date is invented: the extraction records none.
    expect(headers().join(" ")).not.toContain("Delivery Date");
  });
});

// ---------------------------------------------------------------- intelligent columns

describe("Intelligent column visibility", () => {
  const columns = [
    { key: "id", label: "CLIN", pinned: true },
    { key: "desc", label: "Description" },
    { key: "zero", label: "Quantity" },
    { key: "late", label: "Late value" },
    { key: "never", label: "Never filled" },
    { key: "ident", label: "Clause No.", essential: true },
  ];
  const rows = Array.from({ length: 60 }, (_, i) => ({
    id: `r${i}`,
    values: { id: String(i + 1).padStart(4, "0"), desc: `Item ${i + 1}`, zero: "0", late: i === 59 ? "only on page 2" : "", never: "", ident: "" },
  }));

  it("hides only columns empty across all filtered rows, keeping literal zeros and essential identifiers", () => {
    render(<SmartDataGrid tableKey="cols-1" columns={columns} rows={rows} />);
    const shown = headers().join(" | ");
    expect(shown).toContain("Quantity"); // "0" is a value
    expect(shown).toContain("Late value"); // filled on page 2 only
    expect(shown).toContain("Clause No."); // essential, though empty
    expect(shown).not.toContain("Never filled");
  });

  it("lets the user's column choices override the defaults, remembers them, and resets", async () => {
    const { unmount } = render(<SmartDataGrid tableKey="cols-2" columns={columns} rows={rows} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Columns/ }));
    fireEvent.click(screen.getByLabelText("Show Never filled"));
    fireEvent.click(screen.getByLabelText("Show Description"));
    expect(headers().join(" ")).toContain("Never filled");
    expect(headers().join(" ")).not.toContain("Description");
    unmount();

    render(<SmartDataGrid tableKey="cols-2" columns={columns} rows={rows} />);
    await settle();
    expect(headers().join(" ")).toContain("Never filled");
    expect(headers().join(" ")).not.toContain("Description");
    fireEvent.click(screen.getAllByRole("button", { name: "Reset columns" })[0]);
    expect(headers().join(" ")).toContain("Description");
    expect(headers().join(" ")).not.toContain("Never filled");
  });

  it("remembers Show all fields per table", async () => {
    const { unmount } = render(<SmartDataGrid tableKey="cols-3" columns={columns} rows={rows} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Show all fields \(\+1\)/ }));
    unmount();
    render(<SmartDataGrid tableKey="cols-3" columns={columns} rows={rows} />);
    await settle();
    expect(headers().join(" ")).toContain("Never filled");
    expect(screen.getByRole("button", { name: "Hide empty columns" })).toBeInTheDocument();
  });

  it("reads printed numbers and currencies without inventing them", () => {
    expect(numberOf("USD 1,420,351.70")).toBe(1420351.7);
    expect(numberOf("(1,000.00)")).toBe(-1000);
    expect(numberOf("NSP")).toBeNull();
    expect(printedCurrency("USD 5")).toBe("USD");
    expect(printedCurrency("$5")).toBe("$");
    expect(printedCurrency("NSP", "")).toBe("");
  });

  it("sorts amounts by value, opens a record with Enter, and exports what is shown", () => {
    const onOpen = vi.fn();
    const amountRows = ["USD 142,035.17", "USD 1,420,351.70", "USD 30,000.00"].map((amount, i) => ({ id: `a${i}`, values: { id: `000${i + 1}`, amount } }));
    render(<SmartDataGrid tableKey="cols-4" columns={[{ key: "id", label: "CLIN", pinned: true }, { key: "amount", label: "Amount", filter: "range" as const }]} rows={amountRows} onOpen={onOpen} exportName="lines" />);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Amount" }));
    // 30,000 < 142,035.17 < 1,420,351.70 — not digit-group order.
    expect(screen.getAllByTestId("smart-row").map((r) => r.textContent?.slice(0, 4))).toEqual(["0003", "0001", "0002"]);
    const firstCell = screen.getAllByTestId("smart-row")[0].querySelector<HTMLElement>("[data-cell]")!;
    firstCell.focus();
    fireEvent.keyDown(firstCell, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "a2" }));
    fireEvent.click(screen.getByRole("button", { name: /Export all \(3\)/ }));
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), "lines.csv", "text/csv");
  });
});

// ---------------------------------------------------------------- record details

function selection(record: StagingRecord, category: CategoryId): SelectedRecord {
  return { datasetId: "contract_data", record, category, title: field(record, "record_id") };
}

function withCell(record: StagingRecord, key: string, patch: Partial<StagingCell>): StagingRecord {
  const name = `contract.data.${key}`;
  return { ...record, cells: { ...record.cells, [name]: { ...record.cells[name], ...patch } as StagingCell } };
}

function details(record: StagingRecord, category: CategoryId, extra: Partial<Parameters<typeof RecordDetails>[0]> = {}) {
  const props = {
    selection: selection(record, category), record, loading: false, mappings: [] as CategoryMapping[], documentId: "doc-1",
    documentName: "SF1442.pdf", reviewEnabled: true, onViewSource: vi.fn(), onClose: vi.fn(), ...extra,
  };
  render(<RecordDetails {...props} />);
  return props;
}

describe("Record details", () => {
  const clause = full(bySection("DFARS Clauses")[0]);

  it("summarises the record and shows every extracted value in full", () => {
    const long = "A".repeat(1500);
    details(withCell(clause, "value", { value: long, raw_value: long }), "clauses");
    const summary = screen.getByTestId("details-summary");
    expect(summary).toHaveTextContent("FAR/DFARS Clauses · Clause");
    expect(summary).toHaveTextContent(field(clause, "record_id"));
    const values = screen.getAllByTestId("details-value").map((v) => v.textContent ?? "");
    expect(values.some((v) => v.includes(long))).toBe(true);
    // Each value names its canonical field.
    expect(screen.getAllByTestId("details-canonical").map((c) => c.textContent)).toContain("contract.data.value");
  });

  it("shows source evidence, says when exact highlighting is unavailable, and opens the source", () => {
    const props = details(clause, "clauses");
    const evidence = screen.getByTestId("details-evidence");
    const page = Object.values(clause.cells).find((c) => c.provenance?.source_page)?.provenance?.source_page;
    expect(evidence).toHaveTextContent(`Page${page}`);
    fireEvent.click(within(evidence).getByRole("button", { name: "View in source" }));
    expect(props.onViewSource).toHaveBeenCalledWith(expect.objectContaining({ pageNumber: page }));
    const request = sourceRequestFor(selection(clause, "clauses"), clause)!;
    if (request.exact) expect(screen.queryByTestId("inexact-source")).toBeNull();
    else expect(screen.getByTestId("inexact-source")).toHaveTextContent(`opens page ${page}`);
  });

  it("uses recorded coordinates and never makes them up", () => {
    const cellKey = Object.keys(clause.cells).find((k) => clause.cells[k].provenance?.source_page)!.replace("contract.data.", "");
    const withRegion = withCell(clause, cellKey, { provenance: { ...clause.cells[`contract.data.${cellKey}`].provenance!, source_bbox: [10, 20, 110, 40], highlight_text: null } });
    details(withRegion, "clauses");
    expect(screen.getByTestId("details-evidence")).toHaveTextContent("Region recorded (10, 20, 110, 40 pt)");
    expect(screen.queryByTestId("inexact-source")).toBeNull();
  });

  it("keeps validation, model confidence and human review apart", () => {
    const failed = withCell(clause, "effective_date", {
      validation: { status: "failed", checks: [{ check: "date_format", passed: false, message: "Not a date" }, { check: "required", passed: false, message: null }] },
    });
    details(failed, "clauses", { reviewEnabled: false });
    const validation = screen.getByTestId("details-validation");
    expect(validation).toHaveTextContent("Validation failed");
    expect(validation).toHaveTextContent("Missing required:");
    expect(validation).toHaveTextContent("Data-type issues:");
    expect(validation).toHaveTextContent("Not provided by the extraction");
    const review = screen.getByTestId("details-human-review");
    expect(review).toHaveTextContent("Review statusNot reviewed");
    expect(review).toHaveTextContent("ReviewerNot recorded");
    expect(review).toHaveTextContent("Review is read-only in this release");
  });

  it("says no Oracle mapping is configured, without inventing a destination", () => {
    details(clause, "clauses");
    expect(screen.getByTestId("details-oracle")).toHaveTextContent("No Oracle mapping configured. No verified Oracle import destination exists for this record type.");
  });

  it("shows a saved mapping's Oracle labels, technical attributes, values and versions", () => {
    const line = full(bySection("CLINs")[0]);
    const mapping = {
      profile: { id: 4, template_id: 9, name: "Lines", staging_profile_id: "contract_v3", version: 3, history: [], updated_by: "a", updated_at: "", notes: null,
        spec: { row_dataset: "contract_data", key_columns: [], mappings: [
          { column: "LineNumber", source: { kind: "field", dataset_id: "contract_data", field: "contract.data.record_id" } },
          { column: "LineAmount", source: { kind: "field", dataset_id: "line_items", field: "amount" }, transform: "number" },
          { column: "Unrelated", source: { kind: "none" } },
        ] } },
      template: { id: 9, object_name: "Contract Line", version: 2, columns: [{ position: 1, technical_name: "LineNumber", display_label: "Line Number", required: true }, { position: 2, technical_name: "LineAmount", display_label: "Line Amount", required: false }] },
      state: "validation_required", mapped: 2, columns: 2, errors: 1, category: "lines",
    } as unknown as CategoryMapping;
    details(line, "lines", { mappings: [mapping] });
    const oracle = screen.getByTestId("details-mapping");
    expect(oracle).toHaveTextContent("Contract Line");
    expect(oracle).toHaveTextContent("template v2 · “Lines” v3");
    expect(oracle).toHaveTextContent("Validation required");
    const rows = within(oracle).getAllByRole("row").map((r) => r.textContent);
    expect(rows).toContain("Line NumberLineNumber0001");
    expect(rows.find((r) => r?.startsWith("Line Amount"))).toContain("From line_items, matched at export");
  });

  it("says evidence is loading — not missing — until the full record arrives", () => {
    const compact = bySection("DFARS Clauses")[0];
    details(compact, "clauses", { record: null, loading: true });
    const evidence = screen.getByTestId("details-evidence");
    expect(evidence).toHaveTextContent("Loading source evidence…");
    expect(evidence).not.toHaveTextContent("No page recorded");
    expect(evidence).not.toHaveTextContent("No source page was recorded");
  });

  it("closes", () => {
    const props = details(clause, "clauses");
    fireEvent.click(screen.getByRole("button", { name: "Close record details" }));
    expect(props.onClose).toHaveBeenCalled();
  });
});

describe("Workspace drawer", () => {
  it("opens details on selection, keeps the row selected, and closes", async () => {
    const { getStagingRecord } = await import("@/lib/staging-workbook");
    vi.mocked(getStagingRecord).mockImplementation(async (_doc, _ds, id) => FULL[id] ?? DATA.records.find((r) => r.record_id === id) ?? null);
    render(<SmartWorkspace documentId="doc-1" workbook={SF1442} filename="SF1442.pdf" pageCount={60} />);
    fireEvent.click(tab(/FAR\/DFARS Clauses/));
    const row = screen.getAllByTestId("smart-row")[0];
    await act(async () => {
      fireEvent.click(row);
    });
    const panel = await screen.findByTestId("record-details");
    expect(panel).toHaveTextContent("FAR/DFARS Clauses");
    expect(screen.getAllByTestId("smart-row")[0].className).toContain("bg-primary");
    expect(getStagingRecord).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close record details" }));
    expect(screen.queryByTestId("record-details")).toBeNull();
    expect(screen.getByTestId("intelligence-panel")).toHaveTextContent("No record selected");
  });
});
