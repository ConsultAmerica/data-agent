import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ResultsView, { deriveFields, derivePairs } from "@/components/documents/results-view";
import type { StagingCell, StagingDataset, StagingWorkbook } from "@/lib/staging-workbook";

vi.mock("@/lib/documents", () => ({
  getPageRender: vi.fn(() => new Promise(() => undefined)),
  getSourceStructure: vi.fn(() =>
    Promise.resolve({
      document_id: "d1",
      field_candidates: [
        { candidate_id: "c1", label_text: "Employee", raw_value: "Jane Doe", value_type_hint: "text",
          structural_relation: "same_line_separator", page: 1, label_bbox: [40, 78, 94, 91],
          value_bbox: [100, 78, 148, 91], acceptance: "accepted", quality_score: 0.9 },
        { candidate_id: "c2", label_text: "Noise", raw_value: "x", value_type_hint: null,
          structural_relation: "loose", page: 1, label_bbox: null, value_bbox: null, acceptance: "rejected", quality_score: 0.1 },
      ],
      table_candidates: [],
    }),
  ),
  getDocumentPages: vi.fn(() =>
    Promise.resolve([
      { document_id: "d1", page_number: 1, page_label: null, extraction_method: "native", final_text: "Gross Pay 2,000.00\nNet Pay 1,647.00",
        requires_ocr: false, ocr_attempted: false, ocr_succeeded: false, character_count: 30, word_count: 6, page_width: 612, page_height: 792 },
    ]),
  ),
}));

function cell(field: string, value: string | null, status: StagingCell["review_status"] = "Verified", page = 1): StagingCell {
  return {
    canonical_field: field,
    display_label: field,
    value,
    raw_value: value,
    value_type: "string",
    provenance: value === null ? null : {
      source_document_id: "d1", source_filename: "a.pdf", source_type: "pdf", source_page: page,
      source_bbox: [10, 20, 60, 30], evidence_text: value, extraction_method: "native", source_locator: null,
      source_region_id: null, anchor_text: null, highlight_text: null,
    },
    validation: { status: "passed", checks: [] },
    review_status: status,
    review_reasons: [],
  };
}

function dataset(partial: Partial<StagingDataset> & Pick<StagingDataset, "dataset_id" | "display_name" | "cardinality" | "columns" | "records">): StagingDataset {
  return { role: "business", description: null, identity_fields: [], ...partial } as StagingDataset;
}

const column = (key: string, label: string) => ({
  canonical_field: `x.${key}`, key, display_label: label, value_type: "string", expected: false,
});

function workbook(): StagingWorkbook {
  return {
    datasets: [
      dataset({
        dataset_id: "summary", display_name: "Document Summary", cardinality: "single",
        columns: [column("type", "Document Type"), column("pages", "Pages")],
        records: [{ record_id: "r", record_status: null, links_to_dataset: null,
                    cells: { "x.type": cell("x.type", "Pay Stub / Paycheck"), "x.pages": cell("x.pages", null) } }],
      }),
      dataset({
        dataset_id: "key_fields", display_name: "Key Fields", cardinality: "repeating",
        columns: [column("name", "Field"), column("value", "Value")],
        records: [
          { record_id: "k1", record_status: null, links_to_dataset: null,
            cells: { "x.name": cell("x.name", "Gross Pay"), "x.value": cell("x.value", "2,000.00") } },
          { record_id: "k2", record_status: null, links_to_dataset: null,
            cells: { "x.name": cell("x.name", "Employee"), "x.value": cell("x.value", "Jane Doe", "Needs Review") } },
        ],
      }),
      dataset({
        dataset_id: "lines", display_name: "Line Items", cardinality: "repeating",
        columns: [column("item", "Item"), column("amount", "Amount")],
        records: [{ record_id: "l1", record_status: null, links_to_dataset: null,
                    cells: { "x.item": cell("x.item", "Widget"), "x.amount": cell("x.amount", "10.00") } }],
      }),
      dataset({
        dataset_id: "qa", display_name: "QA", cardinality: "repeating", role: "qa",
        columns: [column("check", "Check")], records: [{ record_id: "q", record_status: null, links_to_dataset: null,
                                                         cells: { "x.check": cell("x.check", "ignored") } }],
      }),
    ],
  } as unknown as StagingWorkbook;
}

describe("Results view data", () => {
  it("lists single values and name/value rows as fields, other repeating data as tables", () => {
    const { fields, tables } = deriveFields(workbook());
    expect(fields.map((field) => [field.label, field.value])).toEqual([
      ["Document Type", "Pay Stub / Paycheck"],
      ["Gross Pay", "2,000.00"],
      ["Employee", "Jane Doe"],
    ]);
    expect(fields[1]).toMatchObject({ page: 1, bbox: [10, 20, 60, 30], status: "Verified" });
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({ title: "Line Items", headers: ["Item", "Amount"], rows: [["Widget", "10.00"]] });
  });

  it("merges layout pairs with key fields the layout pass missed, without duplicates or rejects", () => {
    const { fields } = deriveFields(workbook());
    const pairs = derivePairs(
      { document_id: "d1", field_candidates: [
        { candidate_id: "c1", label_text: "Employee", raw_value: "Jane Doe", value_type_hint: null, structural_relation: "",
          page: 1, label_bbox: null, value_bbox: [1, 2, 3, 4], acceptance: "accepted", quality_score: 0.8 },
        { candidate_id: "c2", label_text: "Noise", raw_value: "x", value_type_hint: null, structural_relation: "",
          page: 1, label_bbox: null, value_bbox: null, acceptance: "rejected", quality_score: 0.1 },
      ], table_candidates: [] },
      fields,
    );
    expect(pairs.map((pair) => [pair.label, pair.source])).toEqual([["Employee", "layout"], ["Gross Pay", "text"]]);
  });
});

describe("ResultsView", () => {
  it("shows summary cards, filters fields and outlines nothing until a value is chosen", async () => {
    render(<ResultsView documentId="d1" workbook={workbook()} typeLabel="Pay Stub / Paycheck" pageCount={1} />);
    expect(screen.getByText("Document type").nextSibling?.textContent).toBe("Pay Stub / Paycheck");
    expect(screen.getAllByTestId("results-field")).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Filter results"), { target: { value: "gross" } });
    expect(screen.getAllByTestId("results-field")).toHaveLength(1);
  });

  it("shows OCR text per page with its method", async () => {
    render(<ResultsView documentId="d1" workbook={workbook()} typeLabel="Pay Stub" pageCount={1} />);
    fireEvent.click(screen.getByRole("tab", { name: /OCR text/ }));
    const page = await screen.findByText("Page 1");
    const article = page.closest("article")!;
    expect(within(article).getByText("Native text")).toBeTruthy();
    expect(article.textContent).toContain("Net Pay 1,647.00");
  });

  it("lists key-value pairs from the layout and the key fields", async () => {
    render(<ResultsView documentId="d1" workbook={workbook()} typeLabel="Pay Stub" pageCount={1} />);
    fireEvent.click(screen.getByRole("tab", { name: /Key-value pairs/ }));
    await waitFor(() =>
      expect(screen.getAllByTestId("results-pair").map((row) => row.textContent)).toEqual([
        expect.stringContaining("Jane Doe"),
        expect.stringContaining("2,000.00"),
      ]),
    );
  });
});
