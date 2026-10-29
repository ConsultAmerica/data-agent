import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import PdfPageViewer from "@/components/pdf-page-viewer";
import SourceVerificationPanel from "@/components/source-verification-panel";
import DelimitedViewer from "@/components/viewers/delimited-viewer";
import DocumentViewer from "@/components/viewers/document-viewer";
import SpreadsheetViewer from "@/components/viewers/spreadsheet-viewer";
import WordViewer from "@/components/viewers/word-viewer";
import XmlViewer from "@/components/viewers/xml-viewer";
import JsonSourceTree from "@/components/smart-view/json-source-tree";
import { columnLetter, parseCellRef, resolveLocation, type SheetContent, type SourceView } from "@/lib/source-view";

// Increment 6B: the format-aware viewer framework.

const { getPageRender, getDocumentPages, getSourceView, getSourceSheet } = vi.hoisted(() => ({
  getPageRender: vi.fn(),
  getDocumentPages: vi.fn(),
  getSourceView: vi.fn(),
  getSourceSheet: vi.fn(),
}));

vi.mock("@/lib/documents", () => ({ getPageRender, getDocumentPages }));
vi.mock("@/lib/source-view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/source-view")>()),
  getSourceView,
  getSourceSheet,
}));

const pageRender = (page = 1, highlight: { x0: number; y0: number; x1: number; y1: number } | null = null) => ({
  page_number: page, image_data_url: "data:image/png;base64,AAAA", page_width: 600, page_height: 800, highlight,
});

beforeEach(() => {
  vi.clearAllMocks();
  getPageRender.mockImplementation(async (_id: string, page: number) => pageRender(page));
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
});

// ---------------------------------------------------------------- evidence locations

describe("resolveLocation", () => {
  it("is exact only for recorded regions, cells, rows and paths", () => {
    expect(resolveLocation({ pageNumber: 3, region: [1, 2, 3, 4] }, "pdf").precision).toBe("exact");
    expect(resolveLocation({ pageNumber: 3, highlightText: "Total" }, "pdf")).toMatchObject({ precision: "approximate", location: { kind: "page", page: 3, text: "Total" } });
    expect(resolveLocation({ pageNumber: 2, locator: { sheet_name: "Pricing", cell_ref: "D2" } as never }, "spreadsheet", ["Notes", "Pricing"]))
      .toMatchObject({ precision: "exact", location: { kind: "sheet_cell", sheetIndex: 1, cell: "D2" } });
    expect(resolveLocation({ pageNumber: 2, highlightText: "1250" }, "spreadsheet", ["A", "Pricing"]).description).toContain("Sheet “Pricing”; no cell was recorded");
    expect(resolveLocation({ locator: { dom_path: "/Invoice/Line[2]/@id" } as never }, "xml")).toMatchObject({ precision: "exact", location: { kind: "xml_path" } });
    expect(resolveLocation({ highlightText: "x" }, "xml").precision).toBe("unavailable");
    expect(resolveLocation(null, "pdf").description).toBe("No source location was recorded for this value.");
  });

  it("converts cell references both ways", () => {
    expect([1, 26, 27, 703].map(columnLetter)).toEqual(["A", "Z", "AA", "AAA"]);
    expect(parseCellRef("$AB$12")).toEqual({ column: 28, row: 12 });
    expect(parseCellRef("12B")).toBeNull();
  });
});

// ---------------------------------------------------------------- routing

describe("DocumentViewer routing", () => {
  const xml: SourceView = { viewer: "xml", format: "xml", verified: true, note: null, root: { name: "a", prefix: null, namespace: null, path: "/a", attributes: [], text: "hi", children: [] }, namespaces: [] };

  it("opens each format in its viewer", async () => {
    getSourceView.mockResolvedValue(xml);
    render(<DocumentViewer documentId="d1" documentName="a.xml" pageCount={1} request={null} />);
    expect(await screen.findByTestId("xml-viewer")).toBeInTheDocument();
    expect(screen.getByTestId("document-viewer").getAttribute("data-viewer")).toBe("xml");
    // Page text stays one click away.
    fireEvent.click(screen.getByRole("tab", { name: "Page text" }));
    await waitFor(() => expect(getPageRender).toHaveBeenCalled());
  });

  it("uses the page viewer for PDFs and when the source view can't be loaded", async () => {
    getSourceView.mockResolvedValue({ viewer: "pdf", format: "pdf", verified: true, note: null });
    const { unmount } = render(<DocumentViewer documentId="d2" documentName="a.pdf" pageCount={3} request={{ pageNumber: 2 }} />);
    await waitFor(() => expect(getPageRender).toHaveBeenCalledWith("d2", 2, expect.anything()));
    unmount();
    getSourceView.mockRejectedValue(new Error("offline"));
    render(<DocumentViewer documentId="d3" documentName="a.pdf" pageCount={3} request={null} />);
    await waitFor(() => expect(screen.getByTestId("document-viewer").getAttribute("data-viewer")).toBe("pdf"));
  });

  it("explains an unsupported or mismatched file instead of guessing", async () => {
    getSourceView.mockResolvedValue({ viewer: "unsupported", format: "xlsx", verified: false, note: "The stored file doesn't match its type." });
    render(<DocumentViewer documentId="d4" documentName="x.xlsx" pageCount={1} request={null} />);
    expect(await screen.findByText("This document can't be previewed.")).toBeInTheDocument();
    expect(screen.getByText("The stored file doesn't match its type.")).toBeInTheDocument();
    expect(getPageRender).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- PDF / image

describe("PDF and image viewer", () => {
  it("changes page with the keyboard, zooms, fits the page and rotates", async () => {
    render(<SourceVerificationPanel documentId="p1" documentName="c.pdf" pageCount={3} request={{ pageNumber: 1 }} />);
    const region = await screen.findByRole("region", { name: /c\.pdf, page 1 of 3/ });
    fireEvent.keyDown(region, { key: "PageDown" });
    await waitFor(() => expect(getPageRender).toHaveBeenCalledWith("p1", 2, expect.anything()));
    fireEvent.keyDown(screen.getByRole("region", { name: /page 2 of 3/ }), { key: "ArrowLeft" });
    await waitFor(() => expect(screen.getByRole("region", { name: /page 1 of 3/ })).toBeInTheDocument());
    await screen.findByRole("img", { name: "Page 1" });
    fireEvent.keyDown(screen.getByRole("region", { name: /page 1 of 3/ }), { key: "+" });
    expect(screen.getByText("110%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fit page" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("region", { name: /page 1 of 3/ }), { key: "r" });
    expect(screen.getByRole("img", { name: "Page 1" }).parentElement!.style.transform).toContain("rotate(90deg)");
  });

  it("draws the recorded region in page coordinates, so it stays aligned at any zoom or rotation", () => {
    const highlight = { x0: 60, y0: 200, x1: 300, y1: 240 };
    const { rerender, container } = render(<PdfPageViewer render={pageRender(1, highlight)} loading={false} error="" zoom={1} rotation={0} />);
    const box = () => container.querySelector<HTMLElement>("[data-evidence-highlight]")!;
    const position = () => [box().style.left, box().style.top, box().style.width, box().style.height];
    expect(position()).toEqual(["10%", "25%", "40%", "5%"]);
    rerender(<PdfPageViewer render={pageRender(1, highlight)} loading={false} error="" zoom={2} rotation={90} />);
    // Same fractions of the page, inside the rotated page box.
    expect(position()).toEqual(["10%", "25%", "40%", "5%"]);
    expect(box().parentElement!.style.transform).toContain("rotate(90deg)");
  });
});

// ---------------------------------------------------------------- spreadsheet

function sheet(index: number, cells: SheetContent["cells"], extra: Partial<SheetContent> = {}): SheetContent {
  const maxRow = Math.max(1, ...cells.map((c) => c.row));
  const maxCol = Math.max(1, ...cells.map((c) => c.column));
  return { index, name: index === 0 ? "Pricing" : "Notes", max_row: maxRow, max_column: maxCol, frozen: null, merged: [], cells, truncated: false, ...extra };
}

const pricing = sheet(0, [
  { ref: "A1", row: 1, column: 1, formula: null, value: "CLIN", type: "s" },
  { ref: "A2", row: 2, column: 1, formula: null, value: "0001", type: "s" },
  { ref: "D2", row: 2, column: 4, formula: "=B2*C2", value: "1250", type: "f" },
  { ref: "D3", row: 3, column: 4, formula: "=B3*C3", value: null, type: "f" },
], { merged: ["A5:B5"], frozen: "A2" });
const workbookView: SourceView = {
  viewer: "spreadsheet", format: "xlsm", verified: true, note: null, formulas_available: true, macros_note: "Macros in this workbook are never loaded or run.",
  sheets: [{ index: 0, name: "Pricing", max_row: 3, max_column: 4, frozen: "A2" }, { index: 1, name: "Notes", max_row: 1, max_column: 1, frozen: null }],
};

describe("Spreadsheet viewer", () => {
  beforeEach(() => {
    getSourceSheet.mockImplementation(async (_d: string, index: number) => (index === 0 ? pricing : sheet(1, [{ ref: "A1", row: 1, column: 1, formula: null, value: "Second", type: "s" }])));
  });

  it("shows formulas and cached values separately, and says when no value was stored", async () => {
    render(<SpreadsheetViewer documentId="x1" view={workbookView} resolved={null} label={null} />);
    expect(await screen.findByText("Macros in this workbook are never loaded or run.")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("gridcell", { name: /D2: 1250, formula =B2\*C2/ }));
    const details = screen.getByTestId("cell-details");
    expect(details).toHaveTextContent("Pricing!D2");
    expect(details).toHaveTextContent("Formula=B2*C2");
    expect(details).toHaveTextContent("Cached value1250");
    fireEvent.click(screen.getByRole("gridcell", { name: /^D3, formula/ }));
    expect(screen.getByTestId("cell-details")).toHaveTextContent("None stored in the file");
    // Leading zeros stay as written.
    expect(screen.getByRole("gridcell", { name: "A2: 0001" })).toHaveTextContent("0001");
  });

  it("navigates sheets and selects cells by search and Go to", async () => {
    render(<SpreadsheetViewer documentId="x2" view={workbookView} resolved={null} label={null} />);
    await screen.findByRole("grid", { name: "Sheet Pricing" });
    fireEvent.change(screen.getByLabelText("Search cells"), { target: { value: "=B2" } });
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByTestId("cell-details")).toHaveTextContent("Pricing!D2");
    fireEvent.change(screen.getByLabelText("Go to cell"), { target: { value: "a2" } });
    fireEvent.submit(screen.getByLabelText("Go to cell").closest("form")!);
    expect(screen.getByTestId("cell-details")).toHaveTextContent("Pricing!A2");
    fireEvent.click(screen.getByRole("tab", { name: "Notes" }));
    expect(await screen.findByRole("grid", { name: "Sheet Notes" })).toBeInTheDocument();
    expect(getSourceSheet).toHaveBeenCalledWith("x2", 1);
  });

  it("opens a recorded cell exactly, and a value by matching text — saying which", async () => {
    const exact = resolveLocation({ pageNumber: 1, locator: { sheet_name: "Pricing", cell_ref: "D2" } as never }, "spreadsheet", ["Pricing", "Notes"]);
    const { unmount } = render(<SpreadsheetViewer documentId="x3" view={workbookView} resolved={exact} label="Amount" />);
    await waitFor(() => expect(screen.getByTestId("cell-details")).toHaveTextContent("Pricing!D2"));
    expect(screen.getByTestId("evidence-banner").getAttribute("data-precision")).toBe("exact");
    unmount();
    const approximate = resolveLocation({ pageNumber: 1, highlightText: "0001" }, "spreadsheet", ["Pricing", "Notes"]);
    render(<SpreadsheetViewer documentId="x4" view={workbookView} resolved={approximate} label="CLIN" />);
    await waitFor(() => expect(screen.getByTestId("cell-details")).toHaveTextContent("Pricing!A2"));
    expect(screen.getByTestId("evidence-banner")).toHaveTextContent("no cell was recorded, so the cell is found by matching the value");
  });

  it("draws only the visible rows of a large sheet", async () => {
    const big = sheet(0, Array.from({ length: 20_000 }, (_, i) => ({ ref: `A${i + 1}`, row: i + 1, column: 1, formula: null, value: `v${i + 1}`, type: "s" })));
    getSourceSheet.mockResolvedValue(big);
    render(<SpreadsheetViewer documentId="x5" view={{ ...workbookView, sheets: [workbookView.sheets![0]] }} resolved={null} label={null} />);
    await screen.findByRole("grid", { name: "Sheet Pricing" });
    expect(screen.getAllByRole("row").length).toBeLessThan(120);
    expect(screen.getByRole("grid").getAttribute("aria-rowcount")).toBe("20000");
  });
});

// ---------------------------------------------------------------- delimited

describe("Delimited viewer", () => {
  const view: SourceView = {
    viewer: "delimited", format: "csv", verified: true, note: null, encoding: "cp1252", encoding_guessed: true, delimiter: "semicolon",
    has_header: true, header_detected: true, warnings: ["The encoding (cp1252) was guessed; check accented characters and symbols."],
    rows: [["CLIN", "Description"], ["0001", "Labor; senior"], ["0002", "Zürich travel"]],
  };

  it("shows how the file was read, keeps text exactly, and finds the evidence row", async () => {
    const resolved = resolveLocation({ highlightText: "Zürich travel" }, "delimited");
    render(<DelimitedViewer view={view} resolved={resolved} label="Description" />);
    const provenance = screen.getByTestId("delimited-provenance");
    expect(provenance).toHaveTextContent("Encoding: Windows-1252 (guessed)");
    expect(provenance).toHaveTextContent("Delimiter: Semicolon");
    expect(screen.getByTestId("delimited-warnings")).toHaveTextContent("was guessed");
    await waitFor(() => expect(screen.getAllByTestId("smart-row")).toHaveLength(2));
    expect(screen.getAllByTestId("smart-row")[0]).toHaveTextContent("0001");
    expect(screen.getAllByTestId("smart-row")[0]).toHaveTextContent("Labor; senior");
    expect(screen.getAllByTestId("smart-row")[1].className).toContain("bg-primary");
    // Treat the first row as data instead.
    fireEvent.click(screen.getByLabelText(/First row is the header/));
    expect(screen.getAllByTestId("smart-row")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------- JSON

describe("JSON explorer", () => {
  const data = { invoice: { number: "INV-7", lines: [{ sku: "A1", amount: 10 }, { sku: "B2", amount: 12.5 }] } };

  it("searches keys and values, copies paths, and shows arrays of objects as a table", async () => {
    render(<JsonSourceTree documentId="j1" data={data} />);
    fireEvent.change(screen.getByLabelText("Search JSON"), { target: { value: "sku" } });
    expect(screen.getByText(/4 matches|2 matches/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("B2")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Copy path invoice.lines[1].amount" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("invoice.lines[1].amount");
    fireEvent.click(screen.getByRole("button", { name: "Show invoice.lines as a table" }));
    expect(within(screen.getByTestId("json-table")).getAllByRole("row")).toHaveLength(3);
  });

  it("opens the evidence value's path", async () => {
    render(<JsonSourceTree documentId="j2" data={data} highlight="12.5" resolved={resolveLocation({ highlightText: "12.5" }, "json")} />);
    await waitFor(() => expect(screen.getByTestId("json-match")).toHaveTextContent("12.5"));
    expect(screen.getByTestId("json-breadcrumb")).toHaveTextContent("invoice › lines › [1] › amount");
  });
});

// ---------------------------------------------------------------- XML

describe("XML explorer", () => {
  const view: SourceView = {
    viewer: "xml", format: "xml", verified: true, note: null,
    namespaces: [{ prefix: "inv", uri: "urn:example:invoice" }, { prefix: "cac", uri: "urn:example:common" }],
    root: {
      name: "Invoice", prefix: "inv", namespace: "urn:example:invoice", path: "/Invoice", text: null,
      attributes: [{ name: "currency", namespace: null, value: "USD", path: "/Invoice/@currency" }],
      children: [
        { name: "Number", prefix: "inv", namespace: "urn:example:invoice", path: "/Invoice/Number", attributes: [], text: "INV-7", children: [] },
        { name: "Line", prefix: "cac", namespace: "urn:example:common", path: "/Invoice/Line[1]", text: null, attributes: [{ name: "id", namespace: null, value: "1", path: "/Invoice/Line[1]/@id" }],
          children: [{ name: "Amount", prefix: "cac", namespace: "urn:example:common", path: "/Invoice/Line[1]/Amount", attributes: [], text: "10.00", children: [] }] },
        { name: "Line", prefix: "cac", namespace: "urn:example:common", path: "/Invoice/Line[2]", text: null, attributes: [{ name: "id", namespace: null, value: "2", path: "/Invoice/Line[2]/@id" }],
          children: [{ name: "Amount", prefix: "cac", namespace: "urn:example:common", path: "/Invoice/Line[2]/Amount", attributes: [], text: "12.50", children: [] }] },
      ],
    },
  };

  it("shows namespaces and qualified names, and opens a recorded path", async () => {
    const resolved = resolveLocation({ locator: { dom_path: "/Invoice/Line[2]/Amount" } as never }, "xml");
    render(<XmlViewer view={view} resolved={resolved} label="Amount" />);
    expect(screen.getByTestId("xml-namespaces")).toHaveTextContent("invurn:example:invoice");
    await waitFor(() => expect(screen.getByTestId("xml-target")).toHaveTextContent("12.50"));
    expect(screen.getByTestId("xml-target").getAttribute("data-path")).toBe("/Invoice/Line[2]/Amount");
    expect(screen.getAllByText("cac:Line")).toHaveLength(2);
  });

  it("highlights a recorded attribute and reports a path that isn't in the file", async () => {
    const { unmount } = render(<XmlViewer view={view} resolved={resolveLocation({ locator: { dom_path: "/Invoice/Line[1]/@id" } as never }, "xml")} label={null} />);
    await waitFor(() => expect(screen.getByTestId("xml-target")).toHaveTextContent("id=“1”"));
    unmount();
    render(<XmlViewer view={view} resolved={resolveLocation({ locator: { dom_path: "/Invoice/Missing" } as never }, "xml")} label={null} />);
    expect(screen.getByTestId("evidence-banner").getAttribute("data-precision")).toBe("unavailable");
  });

  it("searches, copies node paths and tables repeated elements", () => {
    render(<XmlViewer view={view} resolved={null} label={null} />);
    fireEvent.change(screen.getByLabelText("Search XML"), { target: { value: "12.50" } });
    expect(screen.getByText("1 match")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy path /Invoice/Number" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("/Invoice/Number");
  });
});

// ---------------------------------------------------------------- Word

describe("Word viewer", () => {
  const view: SourceView = {
    viewer: "word", format: "docx", verified: true, note: null,
    metadata: { title: "Statement of Work", author: null, created: null, modified: null },
    blocks: [
      { type: "heading", level: 1, text: "1. Scope", section: ["1. Scope"], index: 0 },
      { type: "paragraph", text: "Deliver <script>alert(1)</script> services.", parts: [{ text: "Deliver <script>alert(1)</script> services." }], section: ["1. Scope"], style: null, index: 1 },
      { type: "list_item", level: 0, text: "First deliverable", parts: [{ text: "First deliverable" }], section: ["1. Scope"], index: 2 },
      { type: "heading", level: 2, text: "1.1 Schedule", section: ["1. Scope", "1.1 Schedule"], index: 3 },
      { type: "table", rows: [["CLIN", "Amount"], ["0001", "100.00"]], section: ["1. Scope", "1.1 Schedule"], index: 4 },
      { type: "paragraph", text: "See the terms", parts: [{ text: "See " }, { text: "the terms", href: "https://example.com/terms" }], section: ["1. Scope", "1.1 Schedule"], style: null, index: 5 },
    ],
  };

  it("renders structure as text — never markup or live links — with an outline", () => {
    const { container } = render(<WordViewer view={view} resolved={null} label={null} />);
    expect(screen.getByRole("heading", { level: 1, name: "1. Scope" })).toBeInTheDocument();
    expect(screen.getByText("Deliver <script>alert(1)</script> services.")).toBeInTheDocument();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("https://example.com/terms")).toBeInTheDocument();
    expect(within(screen.getByTestId("word-outline")).getAllByRole("button").map((b) => b.textContent)).toEqual(["1. Scope", "1.1 Schedule"]);
    expect(screen.getByRole("cell", { name: "0001" })).toBeInTheDocument();
  });

  it("finds the evidence paragraph in its section and searches the document", () => {
    const resolved = resolveLocation({ highlightText: "100.00", locator: { section_path: ["1. Scope", "1.1 Schedule"] } as never }, "word");
    const { container } = render(<WordViewer view={view} resolved={resolved} label="Amount" />);
    expect(container.querySelector('[data-block="4"]')!.className).toContain("ring-warning");
    fireEvent.change(screen.getByLabelText("Search the document"), { target: { value: "deliver" } });
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------- missing evidence

describe("Missing evidence", () => {
  it("says so instead of highlighting anything", async () => {
    getSourceView.mockResolvedValue({ viewer: "json", format: "json", verified: true, note: null, data: { a: 1 } });
    render(<DocumentViewer documentId="m1" documentName="a.json" pageCount={1} request={{ pageNumber: 1, highlightText: "not in the file" }} />);
    expect(await screen.findByText("“not in the file” is not a value in this file.")).toBeInTheDocument();
    expect(screen.getByTestId("evidence-banner")).toHaveTextContent("The value wasn't found in this view.");
    expect(screen.queryByTestId("json-match")).toBeNull();
    await act(async () => {});
  });
});
