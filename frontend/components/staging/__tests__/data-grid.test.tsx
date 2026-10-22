import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import DocumentWorkspace from "@/components/documents/document-workspace";
import StagingDatasetTable from "@/components/staging/staging-dataset-table";
import { columnWidth, frozenColumnCount, MAX_COLUMN_WIDTH } from "@/lib/data-grid";
import { humanizeExample, humanizeMethod } from "@/lib/method-labels";
import type { StagingCell, StagingColumn, StagingDataset, StagingRecord, StagingWorkbook } from "@/lib/staging-workbook";

let search = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
  useSearchParams: () => search,
}));
vi.mock("@/lib/documents", () => ({
  getDocument: vi.fn(() =>
    Promise.resolve({
      document_id: "x1",
      original_filename: "FAR_Part_52_OKCXMLIMPDFN_PART2.xml",
      status: "completed",
      content_type: "application/xml",
      size_bytes: 1,
      checksum_sha256: null,
      page_count: 1,
      encrypted: false,
      uploaded_at: "2026-10-01T00:00:00Z",
      message: "",
    }),
  ),
  startProcessingJob: vi.fn(),
}));
vi.mock("@/components/staging/source-transcription", () => ({ default: () => <p>Source transcription</p> }));
vi.mock("@/lib/staging-workbook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staging-workbook")>()),
  getStagingWorkbook: vi.fn(() => Promise.resolve(xmlWorkbook())),
}));

const TITLE = "FAR 52.225-7 - Waiver of Buy American Statute for Civil Aircraft and Related Articles";
const TEXT = "Waiver of Buy American Statute for Civil Aircraft and Related Articles (Feb 2016)\n(a) ".repeat(12);

// The XML file's own column names, in its own order.
const XML_COLUMNS: [string, string][] = [
  ["col_001", "Action"], ["col_002", "Datepublished"], ["col_003", "Number"], ["col_004", "Title"],
  ["col_005", "Display Name"], ["col_006", "Intent"], ["col_007", "Language"], ["col_008", "Clause Type"],
  ["col_009", "Status"], ["col_010", "Description"], ["col_011", "Provision Yn"], ["col_012", "Global Yn"],
  ["col_013", "Lock Text Yn"], ["col_014", "Insert By Reference"], ["col_015", "Text"], ["col_016", "Start Date"],
  ["col_017", "Attribute Category"], ["col_018", "Attribute 1"],
];
const XML_VALUES = [
  "Sync", "2016-02-01", "52.225-7", TITLE, "Waiver of Buy American Statute for Civil Aircraft", "B", "US", "STANDARD",
  "APPROVED", "As prescribed in 25.1101(a)(2), insert the following provision:", "N", "Y", "Y", "N", TEXT, "2016-02-01",
  "FAR_PART_52", "52.225-7",
];

function cell(field: string, label: string, value: string | null): StagingCell {
  return {
    canonical_field: field, display_label: label, value, raw_value: value, value_type: "text", provenance: null,
    validation: { status: "passed", checks: [] }, review_status: value == null ? null : "Verified", review_reasons: [],
  };
}

function dataset(id: string, name: string, columns: [string, string][], rows: string[][]): StagingDataset {
  const cols: StagingColumn[] = columns.map(([key, label]) => ({ canonical_field: `${id}.${key}`, key, display_label: label, value_type: "text", expected: false }));
  return {
    dataset_id: id, display_name: name, cardinality: "repeating", role: "business", description: null, identity_fields: [],
    columns: cols,
    records: rows.map((values, index) => ({
      record_id: `${id}:${index}`, record_status: "Verified", links_to_dataset: null,
      cells: Object.fromEntries(cols.map((column, i) => [column.canonical_field, cell(column.canonical_field, column.display_label, values[i] ?? null)])),
    })),
  };
}

function clauses(count = 3): StagingDataset {
  return dataset("xml_records_1", "Clauses", XML_COLUMNS, Array.from({ length: count }, (_, i) => XML_VALUES.map((v, j) => (j === 2 ? `52.225-${7 + i}` : v))));
}

function xmlWorkbook(): StagingWorkbook {
  return {
    document_id: "x1",
    document_filename: "FAR_Part_52_OKCXMLIMPDFN_PART2.xml",
    profile: { profile_id: "xml_document", profile_version: 1, display_name: "XML Document", description: "", document_families: ["xml_data"], export_capabilities: [], oracle_mapping_capability: "none", views: [] },
    outcome: { status: "populated", title: "Extraction complete", message: "", record_count: 259 },
    datasets: [
      clauses(),
      dataset("key_fields", "Document Details", [["label", "Field"], ["value", "Value"]], []),
      { ...dataset("source_documents", "Source Documents", [["d", "Source Document"]], [["x.xml"]]), role: "source" },
    ],
    qa_summary: { verified: 3, needs_review: 0, missing: 0, record_count: 259 },
    processing_metadata: {},
  } as unknown as StagingWorkbook;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("column sizing and freezing", () => {
  const xml = clauses();
  const widths = xml.columns.map((column) => columnWidth(column, xml.records));

  it("sizes columns by their values: flags narrow, dates fit, prose capped", () => {
    const width = (label: string) => widths[XML_COLUMNS.findIndex(([, l]) => l === label)];
    expect(width("Action")).toBeLessThanOrEqual(100);
    expect(width("Intent")).toBeLessThanOrEqual(100);
    expect(width("Datepublished")).toBeGreaterThanOrEqual(115);
    expect(width("Datepublished")).toBeLessThanOrEqual(140);
    expect(width("Text")).toBe(MAX_COLUMN_WIDTH);
    expect(width("Title")).toBeGreaterThanOrEqual(250);
    // 8–12 useful columns fit a ~1870px content area before scrolling.
    let used = 0;
    let fit = 0;
    for (const w of widths) {
      if (used + w > 1870) break;
      used += w;
      fit += 1;
    }
    expect(fit).toBeGreaterThanOrEqual(8);
  });

  it("freezes through the identifier and title, by column name", () => {
    expect(frozenColumnCount(xml.columns, widths)).toBe(4); // Action, Datepublished, Number, Title
    const lines = dataset("line_items", "Line Items", [["a", "ITEM NO"], ["b", "SUPPLIES/SERVICES"], ["c", "QUANTITY"]], [["0001", "ALL SERVICES", "10"]]);
    expect(frozenColumnCount(lines.columns, [105, 300, 105])).toBe(2);
    const plain = dataset("other", "Other", [["a", "Alpha"], ["b", "Beta"]], [["x", "y"]]);
    expect(frozenColumnCount(plain.columns, [100, 100])).toBe(1);
  });
});

describe("compact data grid", () => {
  it("keeps the header sticky, freezes identifier columns and ellipsizes long values", () => {
    render(<StagingDatasetTable dataset={clauses()} />);
    const headers = screen.getAllByRole("columnheader");
    expect(headers.slice(0, 18).map((th) => th.textContent)).toEqual(XML_COLUMNS.map(([, label]) => label));
    for (const th of headers) expect(th.className).toContain("sticky");
    expect(headers[0].className).toContain("top-0");
    const row = screen.getAllByRole("row")[1];
    const cells = within(row).getAllByRole("cell");
    expect(cells.slice(0, 4).every((td) => td.className.includes("sticky"))).toBe(true);
    expect(cells[0].style.left).toBe("0px");
    expect(Number.parseInt(cells[3].style.left, 10)).toBeGreaterThan(0);
    expect(cells[4].className).not.toContain("sticky");
    const text = cells[14];
    expect(text.className).toContain("h-11");
    expect(text.querySelector("span")?.className).toContain("truncate");
    // The value itself is complete — only its display is one line.
    expect(text.textContent?.trim()).toBe(TEXT.replace(/\s+/g, " ").trim());
  });

  it("scrolls horizontally only inside a full-width grid", () => {
    render(<StagingDatasetTable dataset={clauses()} />);
    const grid = screen.getByTestId("data-grid");
    expect(grid.className).toContain("w-full");
    expect(grid.className).toContain("overflow-auto");
    const table = within(grid).getByRole("table");
    expect(table.style.minWidth).toBe("100%");
    expect(Number.parseInt(table.style.width, 10)).toBeGreaterThan(1900);
  });

  it("switches to record cards on narrow screens", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("max-width"), media: query, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    }));
    render(<StagingDatasetTable dataset={clauses()} />);
    expect(screen.getByTestId("record-cards")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getAllByRole("button", { name: "View details" })).toHaveLength(3);
  });

  it("keeps each source's own column names", () => {
    const lines = dataset("line_items", "Line Items",
      [["a", "ITEM NO"], ["b", "SUPPLIES/SERVICES"], ["c", "QUANTITY"], ["d", "UNIT"], ["e", "UNIT PRICE"], ["f", "AMOUNT"]],
      [["0001", "ALL SERVICES", "10", "Months", "142,035.17", "1,420,351.70"]]);
    render(<StagingDatasetTable dataset={lines} />);
    expect(screen.getAllByRole("columnheader").slice(0, 6).map((th) => th.textContent)).toEqual([
      "ITEM NO", "SUPPLIES/SERVICES", "QUANTITY", "UNIT", "UNIT PRICE", "AMOUNT",
    ]);
  });

  it(
    "supports column visibility and value search without changing selection contracts",
    () => {
      render(<StagingDatasetTable dataset={clauses()} documentId="x1" />);
      expect(screen.getByTestId("grid-toolbar")).toBeTruthy();
      expect(screen.getByRole("button", { name: /Text\. Sort ascending/i })).toBeTruthy();
      fireEvent.click(screen.getByTestId("column-visibility"));
      fireEvent.click(screen.getByLabelText("Show column Text"));
      expect(screen.queryByRole("button", { name: /Text\. Sort ascending/i })).toBeNull();
      expect(screen.getByRole("button", { name: /Number\. Sort ascending/i })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Show all columns" }));
      expect(screen.getByRole("button", { name: /Text\. Sort ascending/i })).toBeTruthy();

      fireEvent.change(screen.getByLabelText("Search values in this table"), {
        target: { value: "52.225-8" },
      });
      expect(screen.getAllByRole("row")).toHaveLength(2);
      fireEvent.click(screen.getAllByRole("checkbox", { name: /Select record/ })[0]);
      expect(screen.getByTestId("selection-toolbar").textContent).toMatch(/selected/);
    },
    15_000,
  );

  it("exposes always-visible sort controls, column resize handles, and wrap text", () => {
    render(<StagingDatasetTable dataset={clauses()} documentId="x1" />);
    const textSort = screen.getByRole("button", { name: /Text\. Sort ascending/i });
    expect(textSort.querySelector("svg")).toBeTruthy();
    expect(screen.getAllByRole("separator", { name: "Resize column Text" }).length).toBeGreaterThan(1);

    const textCell = () => {
      const row = screen.getAllByRole("row")[1];
      return within(row).getAllByRole("cell")[15]; // Text column (with leading checkbox)
    };
    expect(textCell().querySelector(".truncate")).toBeTruthy();

    const wrap = screen.getByTestId("wrap-cells");
    expect(wrap.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(wrap);
    expect(wrap.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("table").className).toContain("grid-cells-wrap");
    expect(textCell().querySelector(".truncate")).toBeNull();
    expect(textCell().querySelector(".whitespace-pre-wrap")).toBeTruthy();
  });
});

describe("document workspace", () => {
  it(
    "uses the full width, names the document by filename and opens on its summary",
    async () => {
      search = new URLSearchParams();
      const { unmount } = render(<DocumentWorkspace documentId="x1" />);
      // Documents open on the staged Summary; technical stages follow, Transform last.
      const views = await screen.findByRole("tablist", { name: "Document views" });
      const names = within(views).getAllByRole("tab").map((tab) => tab.textContent);
      expect(names).toEqual(["Summary", "Overview", "Source", "Canonical", "Transform"]);
      expect(within(views).getByRole("tab", { name: "Summary" }).getAttribute("aria-selected")).toBe("true");
      unmount();

      search = new URLSearchParams("view=staging");
      render(<DocumentWorkspace documentId="x1" />);
      const workspace = await screen.findByTestId("document-workspace");
      expect(workspace.className).toContain("w-full");
      expect(workspace.className).not.toMatch(/max-w-/);
      expect(screen.getByRole("heading", { level: 1, name: "FAR_Part_52_OKCXMLIMPDFN_PART2.xml" })).toBeTruthy();
      expect(screen.getByTestId("workspace-profile").textContent).toBe("XML Document");
      expect(screen.getByText(/3 clause records/)).toBeTruthy();
      expect(screen.queryByText(/invoice/i)).toBeNull();
      // Compact dataset tabs: only datasets with records.
      const tabs = within(screen.getByRole("tablist", { name: "Datasets" })).getAllByRole("tab");
      expect(tabs.map((tab) => tab.textContent)).toEqual(["Clauses3"]);
      fireEvent.change(screen.getByLabelText("Search Clauses"), { target: { value: "52.225-8" } });
      expect(screen.getAllByRole("row")).toHaveLength(2);
    },
    20_000,
  );
});

describe("method labels", () => {
  it("humanizes internal method ids", () => {
    expect(humanizeMethod("inline_regex")).toBe("Pattern Match");
    expect(humanizeMethod("field_probe+layout")).toBe("Field Detection");
    expect(humanizeMethod("structured_table")).toBe("Table Detection");
    expect(humanizeMethod("xml_element")).toBe("XML Element");
    expect(humanizeMethod("ocr")).toBe("OCR");
    expect(humanizeMethod("")).toBe("");
    expect(humanizeExample("'Action: Sync' on page 1 (inline_regex)")).toBe("'Action: Sync' on page 1 (Pattern Match)");
    expect(humanizeExample("Amount (USD) on page 2")).toBe("Amount (USD) on page 2");
    expect(humanizeExample("Total on page 2 (USD)")).toBe("Total on page 2 (USD)");
  });
});
