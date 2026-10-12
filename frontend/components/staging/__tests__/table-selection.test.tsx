import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import FarRecordsView from "@/components/staging/far-records-view";
import StagingDatasetTable from "@/components/staging/staging-dataset-table";
import { FAR_COLUMNS } from "@/lib/far-records";
import type { StagingCell, StagingDataset, StagingRecord } from "@/lib/staging-workbook";
import {
  EMPTY_SELECTION,
  onlyCell,
  rangeBlock,
  selectionCounts,
  selectionManifest,
  setCells,
  toggleBlock,
  toggleCell,
} from "@/lib/table-selection";

const fetchWithRetry = vi.fn();
const downloadBlob = vi.fn();

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchWithRetry: (...args: unknown[]) => fetchWithRetry(...args),
}));
vi.mock("@/lib/export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/export")>()),
  downloadBlob: (...args: unknown[]) => downloadBlob(...args),
}));

function cell(field: string, label: string, value: string | null): StagingCell {
  return {
    canonical_field: field,
    display_label: label,
    value,
    raw_value: value,
    value_type: "text",
    provenance: null,
    validation: { status: "passed", checks: [] },
    review_status: value ? "Verified" : null,
    review_reasons: [],
  };
}

/** A dataset with the given columns ([field, label]) and rows of values. */
function table(datasetId: string, columns: [string, string][], rows: string[][]): StagingDataset {
  return {
    dataset_id: datasetId,
    display_name: datasetId,
    cardinality: "repeating",
    role: "business",
    description: null,
    columns: columns.map(([field, label]) => ({ canonical_field: field, key: field.split(".").pop() ?? field, display_label: label, value_type: "text", expected: false })),
    records: rows.map((values, index) => ({
      record_id: `${datasetId}:${index}`,
      record_status: "Verified",
      links_to_dataset: null,
      cells: Object.fromEntries(columns.map(([field, label], c) => [field, cell(field, label, values[c] ?? null)])),
    })),
    identity_fields: [columns[0][0]],
  };
}

const CLINS = table(
  "line_items",
  [
    ["contract.line.item_number", "ITEM NO"],
    ["contract.line.description", "SUPPLIES/SERVICES"],
    ["contract.line.quantity", "QUANTITY"],
    ["contract.line.unit", "UNIT"],
    ["contract.line.unit_price", "UNIT PRICE"],
    ["contract.line.amount", "AMOUNT"],
  ],
  [
    ["0001", "Engineering", "12", "MO", "$1,000.00", "$12,000.00"],
    ["0002", "Travel", "1", "LOT", "$500.00", "$500.00"],
    ["0003", "Training", "4", "EA", "$250.00", "$1,000.00"],
    ["0004", "Licenses", "10", "EA", "$90.00", "$900.00"],
    ["0005", "Support", "12", "MO", "$300.00", "$3,600.00"],
  ],
);

function toolbarText(): string {
  return screen.getByTestId("selection-toolbar").textContent ?? "";
}

function bodyCell(rowName: RegExp, column: number): HTMLElement {
  // column 0 is the row checkbox
  return within(screen.getByRole("row", { name: rowName })).getAllByRole("cell")[column + 1];
}

function rowsWithText(text: string): HTMLElement {
  return screen.getAllByRole("row").find((row) => row.textContent?.includes(text)) as HTMLElement;
}

beforeEach(() => {
  fetchWithRetry.mockReset();
  downloadBlob.mockReset();
});

describe("selection model", () => {
  it("adds, toggles, replaces, ranges and counts by stable ids", () => {
    let s = toggleCell(EMPTY_SELECTION, "r1", "title");
    s = toggleCell(s, "r3", "text");
    expect(selectionCounts(s)).toEqual({ cells: 2, records: 2, fields: 2 });
    expect(selectionCounts(toggleCell(s, "r1", "title"))).toEqual({ cells: 1, records: 1, fields: 1 });
    expect(selectionManifest(onlyCell(s, "r2", "number"))).toEqual([{ record_id: "r2", fields: ["number"] }]);
    // Clicking the only selected cell again clears it.
    expect(onlyCell(onlyCell(EMPTY_SELECTION, "r2", "n"), "r2", "n").size).toBe(0);
    const block = rangeBlock(["r1", "r2", "r3"], ["a", "b", "c"], { recordId: "r3", field: "c" }, { recordId: "r2", field: "b" });
    expect(block).toEqual({ recordIds: ["r2", "r3"], fields: ["b", "c"] });
    const all = setCells(EMPTY_SELECTION, ["r1", "r2"], ["a", "b"], true);
    expect(selectionCounts(toggleBlock(all, ["r1", "r2"], ["a", "b"]))).toEqual({ cells: 0, records: 0, fields: 0 });
  });
});

describe("StagingDatasetTable selection (contract CLINs)", () => {
  function renderTable(dataset = CLINS) {
    return render(<StagingDatasetTable dataset={dataset} documentId="doc-1" pageSize={2} filename="contract.pdf" />);
  }

  it("a click toggles one cell; further clicks add non-adjacent cells; clicking again removes", () => {
    renderTable();
    expect(screen.queryByTestId("selection-toolbar")).toBeNull();
    fireEvent.click(bodyCell(/0001/, 1));
    expect(toolbarText()).toMatch(/1 cell selected.*1 record.*1 field/);
    expect(bodyCell(/0001/, 1).getAttribute("aria-selected")).toBe("true");
    expect(bodyCell(/0001/, 1).className).toContain("cell-selected");
    fireEvent.click(bodyCell(/0002/, 5), { ctrlKey: true });
    fireEvent.click(bodyCell(/0002/, 3));
    expect(toolbarText()).toMatch(/3 cells selected.*2 records.*3 fields/);
    fireEvent.click(bodyCell(/0002/, 3));
    expect(toolbarText()).toMatch(/2 cells selected/);
  }, 15_000); // many clicks on a full grid: slow when the whole suite runs in parallel

  it("every cell has its own small checkbox, which toggles just that cell", () => {
    renderTable();
    const box = screen.getByRole("checkbox", { name: "Select SUPPLIES/SERVICES of 0001" }) as HTMLInputElement;
    expect(box.className).toContain("cell-check");
    expect(box.className).toContain("h-3 w-3");
    fireEvent.click(box);
    expect(box.checked).toBe(true);
    expect(toolbarText()).toMatch(/1 cell selected/);
    fireEvent.click(box);
    expect(screen.queryByTestId("selection-toolbar")).toBeNull();
  });

  it("row and column checkboxes are indeterminate when partly selected", () => {
    renderTable();
    fireEvent.click(bodyCell(/0001/, 1));
    const row = screen.getByRole("checkbox", { name: "Select record 0001" }) as HTMLInputElement;
    const column = screen.getByRole("checkbox", { name: "Select column SUPPLIES/SERVICES" }) as HTMLInputElement;
    expect([row.checked, row.indeterminate]).toEqual([false, true]);
    expect([column.checked, column.indeterminate]).toEqual([false, true]);
    fireEvent.click(row);
    expect([row.checked, row.indeterminate]).toEqual([true, false]);
  });

  it("a partial row exports only its chosen cells", () => {
    renderTable();
    fireEvent.click(bodyCell(/0001/, 0));
    fireEvent.click(bodyCell(/0001/, 5));
    expect(toolbarText()).toMatch(/2 cells selected.*1 record.*2 fields/);
  });

  it("Shift+click selects the rectangle between two cells", () => {
    renderTable();
    fireEvent.click(bodyCell(/0001/, 1));
    fireEvent.click(bodyCell(/0002/, 3), { shiftKey: true });
    expect(toolbarText()).toMatch(/6 cells selected.*2 records.*3 fields/);
  });

  it("a row checkbox selects every field of that record; several rows add up", () => {
    renderTable();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select record 0001" }));
    expect(toolbarText()).toMatch(/6 cells selected.*1 record.*6 fields/);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select record 0002" }));
    expect(toolbarText()).toMatch(/12 cells selected.*2 records/);
  });

  it("a column header selects the field across the whole filtered dataset, not just the page", () => {
    renderTable();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select column AMOUNT" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select column ITEM NO" }));
    expect(toolbarText()).toMatch(/10 cells selected.*5 records.*2 fields/);
  });

  it("Select visible takes only the current page; selection survives pagination and horizontal scroll", () => {
    renderTable();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select record 0001" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select record 0003" }));
    expect(toolbarText()).toMatch(/2 records/);
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect((screen.getByRole("checkbox", { name: "Select record 0001" }) as HTMLInputElement).checked).toBe(true);
    // Scrolling the grid sideways changes nothing about the selection.
    fireEvent.scroll(screen.getByTestId("data-grid"), { target: { scrollLeft: 400 } });
    expect(toolbarText()).toMatch(/12 cells selected/);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByTestId("selection-toolbar")).toBeNull();
  });

  it("Select visible (after a cell click) selects every field of the rows on this page only", () => {
    renderTable();
    fireEvent.click(bodyCell(/0001/, 0));
    fireEvent.click(screen.getByRole("button", { name: "Select visible" }));
    expect(toolbarText()).toMatch(/12 cells selected.*2 records.*6 fields/);
  });

  it("the top checkbox selects the visible page; Select all N results is explicit", () => {
    renderTable();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all 2 records on this page" }));
    expect(toolbarText()).toMatch(/12 cells selected.*2 records/);
    fireEvent.click(screen.getByRole("button", { name: "Select all 5 results" }));
    expect(toolbarText()).toMatch(/30 cells selected.*5 records/);
    expect(screen.queryByRole("button", { name: /Select all 5 results/ })).toBeNull();
  });

  it("Select all results follows the review filter", () => {
    const dataset = { ...CLINS, records: CLINS.records.map((r, i) => ({ ...r, record_status: i < 3 ? ("Needs Review" as const) : ("Verified" as const) })) };
    renderTable(dataset);
    fireEvent.change(screen.getByLabelText("Review status"), { target: { value: "Needs Review" } });
    fireEvent.click(bodyCell(/0001/, 0));
    fireEvent.click(screen.getByRole("button", { name: "Select all 3 results" }));
    expect(toolbarText()).toMatch(/18 cells selected.*3 records/);
  });

  it("selection never changes a record's review status", () => {
    const dataset = { ...CLINS, records: CLINS.records.map((r, i) => ({ ...r, record_status: i === 0 ? ("Needs Review" as const) : ("Verified" as const) })) };
    renderTable(dataset);
    const row = screen.getByRole("row", { name: /0001/ });
    expect(within(row).getByText("Staging Needs Review")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select record 0001" }));
    expect(within(row).getByText("Staging Needs Review")).toBeTruthy();
    expect(within(row).queryByText("Staging Verified")).toBeNull();
  });

  it("Export Selected posts ids only — never values — and downloads the server's file", async () => {
    fetchWithRetry.mockResolvedValue(
      new Response("﻿ITEM NO,AMOUNT\r\n0002,$500.00\r\n", {
        status: 200,
        headers: { "Content-Type": "text/csv", "Content-Disposition": `attachment; filename="contract_line_items_selected.csv"` },
      }),
    );
    renderTable();
    fireEvent.click(bodyCell(/0002/, 5));
    fireEvent.click(screen.getByRole("button", { name: /Export Selected/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "CSV" }));
    });
    const [path, init] = fetchWithRetry.mock.calls[0];
    expect(path).toBe("/api/documents/doc-1/staging-workbook/datasets/line_items/export-selected");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      format: "csv",
      selection: [{ record_id: "line_items:1", fields: ["contract.line.amount"] }],
    });
    expect(init.body).not.toContain("$500.00");
    expect(downloadBlob).toHaveBeenCalledWith(expect.any(String), "contract_line_items_selected.csv", expect.stringContaining("text/csv"));
  });

  it("shows the server's refusal", async () => {
    fetchWithRetry.mockResolvedValue(new Response(JSON.stringify({ detail: "1 record(s) are not in this document's Line Items" }), { status: 422 }));
    renderTable();
    fireEvent.click(bodyCell(/0001/, 0));
    fireEvent.click(screen.getByRole("button", { name: /Export Selected/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Excel" }));
    });
    expect(await screen.findByText(/not in this document/)).toBeTruthy();
  });

  it.each([
    ["invoice_lines", [["invoice.line.description", "Description"], ["invoice.line.quantity", "Quantity"], ["invoice.line.uom", "UOM"], ["invoice.line.unit_price", "Unit Price"], ["invoice.line.amount", "Line Amount"]]],
    ["courses", [["transcript.course.code", "Course Code"], ["transcript.course.title", "Course Title"], ["transcript.course.credits", "Credits"], ["transcript.course.grade", "Grade"]]],
    ["xml_records", [["xml.action", "Action"], ["xml.date_published", "Date Published"], ["xml.number", "Number"], ["xml.title", "Title"], ["xml.display_name", "Display Name"]]],
  ] as [string, [string, string][]][])("works on any profile's table: %s", (datasetId, columns) => {
    const dataset = table(datasetId, columns, [columns.map((_, i) => `a${i}`), columns.map((_, i) => `b${i}`)]);
    render(<StagingDatasetTable dataset={dataset} documentId="doc-2" />);
    const [field, label] = columns[columns.length - 1];
    fireEvent.click(screen.getByRole("checkbox", { name: `Select column ${label}` }));
    expect(toolbarText()).toMatch(/2 cells selected.*2 records.*1 field/);
    expect(screen.getAllByRole("columnheader").some((th) => th.textContent === label)).toBe(true);
    expect(field).toContain(".");
  });
});

// --- FAR grid: filters, search, pagination, alternates ------------------------------------

function farRecord(id: string, values: Record<string, string>): StagingRecord {
  return {
    record_id: id,
    record_status: "Verified",
    links_to_dataset: null,
    cells: Object.fromEntries(
      FAR_COLUMNS.map((column) => [`far.record.${column.key}`, cell(`far.record.${column.key}`, column.label, values[column.key] ?? null)]),
    ),
  };
}

function farDataset(): StagingDataset {
  const records: StagingRecord[] = [
    farRecord("r0", { far_number: "49.000", title: "Scope of part", record_type: "Section", section_text: "This part..." }),
    farRecord("r1", { far_number: "49.001", title: "Definitions", record_type: "Section", section_text: "As used..." }),
    farRecord("r2", { far_number: "52.249-2", title: "Termination for Convenience", record_type: "Clause", clause_text: "(a) termination ..." }),
    farRecord("r3", { far_number: "52.249-2", title: "Termination for Convenience", record_type: "Clause", alternate: "Alternate I", clause_text: "Alt text" }),
    ...Array.from({ length: 120 }, (_, i) =>
      farRecord(`x${i}`, { far_number: `49.${String(200 + i)}`, title: `Filler ${i}`, record_type: "Section", section_text: "..." }),
    ),
  ];
  return {
    dataset_id: "far_records",
    display_name: "FAR Clauses & Provisions",
    cardinality: "repeating",
    role: "business",
    description: null,
    columns: FAR_COLUMNS.map((column) => ({ canonical_field: `far.record.${column.key}`, key: column.key, display_label: column.label, value_type: "text", expected: false })),
    records,
    identity_fields: ["far.record.far_number"],
  };
}

describe("FarRecordsView selection", () => {
  function renderFar() {
    return render(<FarRecordsView documentId="doc-far" dataset={farDataset()} filename="Part-49.pdf" partHeading="Part 49 - Termination of Contracts" />);
  }

  it("type filter + search: a column header selects the matching records only", () => {
    renderFar();
    fireEvent.click(screen.getByRole("button", { name: /^Clause/ }));
    fireEvent.change(screen.getByLabelText("Search FAR records"), { target: { value: "termination" } });
    for (const label of ["FAR Number", "Title", "Clause Text"]) {
      fireEvent.click(screen.getByRole("checkbox", { name: `Select column ${label}` }));
    }
    // One grid row (the clause) holding its alternate: 2 records × 3 fields.
    expect(toolbarText()).toMatch(/6 cells selected.*2 records.*3 fields/);
  }, 20_000);

  it("selection survives pagination and filter changes; Select visible is this page only", () => {
    renderFar();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select record 49.001" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select record 49.319" }));
    expect(toolbarText()).toMatch(/2 records/);
    fireEvent.click(screen.getByRole("button", { name: /^Clause/ }));
    expect(toolbarText()).toMatch(/2 records/);
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect((screen.getByRole("checkbox", { name: "Select record 49.001" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(bodyCell(/^49\.000/, 0));
    fireEvent.click(screen.getByRole("button", { name: "Select visible" }));
    // The first page: 100 grid rows, one of them carrying an alternate.
    expect(toolbarText()).toMatch(/101 records/);
    // All results: every page.
    fireEvent.click(screen.getByRole("button", { name: "Select all 123 results" }));
    expect(toolbarText()).toMatch(/124 records/);
  }, 60_000);

  it("a cell click selects that cell, not the row; the record opens from Details", () => {
    renderFar();
    const row = rowsWithText("49.001");
    fireEvent.click(within(row).getAllByRole("cell")[2]);
    expect(toolbarText()).toMatch(/1 cell selected/);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Details" }));
    expect(screen.getByRole("dialog", { name: "49.001 details" })).toBeTruthy();
  });
});

// --- single-record field list (Rule Summary, invoice / contract summaries) -------------------

describe("StagingFieldList selection", () => {
  const summary: StagingDataset = {
    ...table(
      "rule_summary",
      [
        ["rule.heading", "Heading"],
        ["rule.reference", "Reference"],
        ["rule.effective_date", "Effective Date"],
      ],
      [["Federal Acquisition Regulation — Trade Agreements Thresholds", "FAC 2026-01 | FAR Case 2025-007", "March 13, 2026"]],
    ),
    cardinality: "single",
    identity_fields: [],
  };

  it("selects fields of the one record; the header box is tri-state; export sends those fields", async () => {
    const StagingFieldList = (await import("@/components/staging/staging-field-list")).default;
    fetchWithRetry.mockResolvedValue(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }));
    render(<StagingFieldList dataset={summary} documentId="doc-rule" />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select field Heading" }));
    fireEvent.click(screen.getByText("Effective Date"));
    expect(toolbarText()).toMatch(/2 cells selected.*1 record.*2 fields/);
    const all = screen.getByRole("checkbox", { name: "Select all 3 fields" }) as HTMLInputElement;
    expect([all.checked, all.indeterminate]).toEqual([false, true]);
    fireEvent.click(screen.getByRole("button", { name: /Export Selected/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "JSON" }));
    });
    const body = JSON.parse(fetchWithRetry.mock.calls[0][1].body);
    expect(body).toEqual({
      format: "json",
      selection: [{ record_id: "rule_summary:0", fields: ["rule.heading", "rule.effective_date"] }],
    });
  });

  it("an empty summary (no record found) offers no selection", async () => {
    const StagingFieldList = (await import("@/components/staging/staging-field-list")).default;
    const empty = { ...summary, records: [{ ...summary.records[0], record_id: "rule_summary:empty" }] };
    render(<StagingFieldList dataset={empty} documentId="doc-rule" />);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
