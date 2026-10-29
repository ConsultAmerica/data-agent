import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import CustomExportDialog, { fieldCatalogue } from "@/components/documents/custom-export-dialog";
import type { StagingCell, StagingDataset, StagingWorkbook } from "@/lib/staging-workbook";

const download = vi.fn(async () => undefined);
// The server preview: pending unless a test answers it.
const preview = vi.fn((..._args: unknown[]) => new Promise<unknown>(() => undefined));
vi.mock("@/lib/staging-workbook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staging-workbook")>()),
  downloadCustomExport: (...args: unknown[]) => download(...(args as [])),
  previewCustomExport: (...args: unknown[]) => preview(...args),
}));

function cell(field: string, value: string | null): StagingCell {
  return {
    canonical_field: field, display_label: field, value, raw_value: value, value_type: "string",
    provenance: null, validation: { status: "passed", checks: [] }, review_status: "Verified", review_reasons: [],
  };
}

const column = (key: string, label: string, prefix = "x") => ({
  canonical_field: `${prefix}.${key}`, key, display_label: label, value_type: "string", expected: false,
});

function dataset(partial: Partial<StagingDataset> & Pick<StagingDataset, "dataset_id" | "display_name" | "cardinality" | "columns" | "records">): StagingDataset {
  return { role: "business", description: null, identity_fields: [], ...partial } as StagingDataset;
}

function workbook(): StagingWorkbook {
  return {
    document_filename: "passport.pdf",
    profile: { profile_id: "passport", display_name: "Passport" },
    datasets: [
      dataset({
        dataset_id: "passport_data", display_name: "Passport Data", cardinality: "repeating",
        columns: [column("field", "Field", "p"), column("printed", "Printed", "p"), column("source_bbox", "Box", "p")],
        records: [
          { record_id: "field:surname", record_status: null, links_to_dataset: null,
            cells: { "p.field": cell("p.field", "Surname"), "p.printed": cell("p.printed", "ERIKSSON") } },
          { record_id: "field:given_names", record_status: null, links_to_dataset: null,
            cells: { "p.field": cell("p.field", "Given Names"), "p.printed": cell("p.printed", "ANNA MARIA") } },
        ],
      }),
      dataset({
        dataset_id: "checks", display_name: "Checks", cardinality: "repeating",
        columns: [column("check", "Check", "c"), column("result", "Result", "c")],
        records: [
          { record_id: "c1", record_status: null, links_to_dataset: null, cells: { "c.check": cell("c.check", "Composite"), "c.result": cell("c.result", "PASS") } },
          { record_id: "c2", record_status: null, links_to_dataset: null, cells: { "c.check": cell("c.check", "Birth"), "c.result": cell("c.result", "PASS") } },
        ],
      }),
      dataset({
        dataset_id: "qa", display_name: "QA", cardinality: "repeating", role: "qa",
        columns: [column("check", "Check", "q")], records: [{ record_id: "q", record_status: null, links_to_dataset: null, cells: {} }],
      }),
    ],
  } as unknown as StagingWorkbook;
}

describe("custom export field catalogue", () => {
  it("pivots label/value lists into fields, lists tables, skips QA and technical columns", () => {
    const { options, tables } = fieldCatalogue(workbook());
    const pairs = options.filter((option) => option.kind === "pair");
    expect(pairs.map((option) => [option.label, option.sample])).toEqual([["Surname", "ERIKSSON"], ["Given Names", "ANNA MARIA"]]);
    expect(pairs[0].source).toEqual({ dataset_id: "passport_data", field: "p.printed", record_id: "field:surname" });
    expect(tables.map((table) => table.dataset_id)).toEqual(["checks"]);
    expect(options.some((option) => option.label === "Box")).toBe(false);
    expect(options.some((option) => option.group === "QA")).toBe(false);
  });
});

describe("CustomExportDialog", () => {
  beforeEach(() => {
    download.mockClear();
    window.localStorage.clear();
  });

  function open() {
    render(<CustomExportDialog documentId="d1" workbook={workbook()} filename="passport.pdf" onClose={vi.fn()} onDownloaded={vi.fn()} />);
  }

  it("starts from structured fields, one per label, not the key/value scan's flattened lines", () => {
    const base = workbook();
    const summary = dataset({
      dataset_id: "summary", display_name: "Summary", cardinality: "single",
      columns: [column("number", "Invoice Number", "s"), column("date", "Invoice Date", "s")],
      records: [{ record_id: "s", record_status: null, links_to_dataset: null,
        cells: { "s.number": cell("s.number", "INV-1"), "s.date": cell("s.date", "2026-09-01") } }],
    });
    const again = dataset({
      dataset_id: "header", display_name: "Header", cardinality: "single",
      columns: [column("number", "Invoice Number", "h")],
      records: [{ record_id: "h", record_status: null, links_to_dataset: null, cells: { "h.number": cell("h.number", "INV-1") } }],
    });
    render(
      <CustomExportDialog documentId="d1" workbook={{ ...base, datasets: [summary, again, ...base.datasets] }}
        filename="invoice.pdf" onClose={vi.fn()} onDownloaded={vi.fn()} />,
    );
    const labels = screen.getAllByTestId("custom-export-column").map((_, index) =>
      (screen.getByLabelText(`Column ${index + 1} label`) as HTMLInputElement).value);
    expect(labels).toEqual(["Invoice Number", "Invoice Date"]);
  });

  it("renames and combines fields, previews them, and downloads the mapping by id", async () => {
    open();
    const columns = screen.getAllByTestId("custom-export-column");
    expect(columns).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Column 1 label"), { target: { value: "FullName" } });
    fireEvent.change(screen.getByLabelText("Combine another field into FullName"), {
      target: { value: "pair:passport_data:field:given_names" },
    });
    fireEvent.change(screen.getByLabelText("Separator for FullName"), { target: { value: ", " } });
    fireEvent.click(screen.getByLabelText("Remove Given Names"));
    expect(within(screen.getByTestId("custom-export-preview")).getByText("ERIKSSON, ANNA MARIA")).toBeTruthy();

    fireEvent.click(screen.getByRole("radio", { name: "CSV" }));
    fireEvent.click(screen.getByTestId("custom-export-download"));
    await waitFor(() => expect(download).toHaveBeenCalled());
    expect(download.mock.calls[0]).toEqual([
      "d1",
      {
        format: "csv",
        include_header: true,
        file_name: null,
        columns: [{
          label: "FullName",
          separator: ", ",
          transform: "as_is",
          sources: [
            { dataset_id: "passport_data", field: "p.printed", record_id: "field:surname" },
            { dataset_id: "passport_data", field: "p.printed", record_id: "field:given_names" },
          ],
        }],
      },
      "passport.pdf",
    ]);
  });

  it("blocks duplicate labels, which an importer can't map", () => {
    open();
    fireEvent.change(screen.getByLabelText("Column 2 label"), { target: { value: "Surname" } });
    expect(screen.getByRole("alert").textContent).toMatch(/unique/);
    expect((screen.getByTestId("custom-export-download") as HTMLButtonElement).disabled).toBe(true);
  });

  it("switches to one row per table record and saves the mapping as a reusable template", () => {
    open();
    fireEvent.change(screen.getByRole("combobox", { name: /Rows/ }), { target: { value: "checks" } });
    expect(screen.getAllByTestId("custom-export-column")).toHaveLength(4);
    expect(within(screen.getByTestId("custom-export-preview")).getAllByRole("row")).toHaveLength(3); // header + 2

    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "ERP import" } });
    fireEvent.click(screen.getByRole("button", { name: /Save template/ }));
    const saved = JSON.parse(window.localStorage.getItem("dataomatix.customExport.v1.passport") ?? "[]");
    expect(saved[0].name).toBe("ERP import");
    expect(saved[0].version).toBe(1);
    expect(saved[0].columns[0].refs[0]).toEqual({ dataset_id: "passport_data", field: "p.printed", kind: "pair", pair_name: "Surname" });

    fireEvent.click(screen.getByLabelText("Remove Surname"));
    fireEvent.change(screen.getByLabelText("Apply a saved template"), { target: { value: "ERP import" } });
    expect(screen.getAllByTestId("custom-export-column")).toHaveLength(4);
    expect(screen.getByRole("status").textContent).toMatch(/Applied "ERP import"/);
  });

  it("previews the rows exactly as the server will export them, with the file's row count", async () => {
    preview.mockResolvedValueOnce({ headers: ["Surname", "Given Names"], rows: [["ERIKSSON", "ANNA MARIA"]], total_rows: 500, row_dataset: "lines" });
    open();
    await waitFor(() => expect(screen.getByTestId("custom-export-preview-caption").textContent).toBe("Preview · first 1 of 500 rows in the file"));
    expect(preview.mock.calls[0][0]).toBe("d1");
  });

  it("sends a column's format and updates a template as a new version", async () => {
    open();
    fireEvent.change(screen.getByLabelText("Format of Surname"), { target: { value: "upper" } });
    fireEvent.change(screen.getByLabelText("Template name"), { target: { value: "ERP import" } });
    fireEvent.click(screen.getByRole("button", { name: /Save template/ }));
    // Saving again under the same name: an update, version 2.
    fireEvent.click(screen.getByRole("button", { name: /Update template/ }));
    const saved = JSON.parse(window.localStorage.getItem("dataomatix.customExport.v1.passport") ?? "[]");
    expect(saved).toHaveLength(1);
    expect(saved[0].version).toBe(2);
    expect(saved[0].columns[0].transform).toBe("upper");
    expect(screen.getByRole("status").textContent).toMatch(/version 2/);
    fireEvent.click(screen.getByTestId("custom-export-download"));
    await waitFor(() => expect(download).toHaveBeenCalled());
    const manifest = (download.mock.calls[0] as unknown[])[1] as { columns: { transform: string }[] };
    expect(manifest.columns[0].transform).toBe("upper");
  });
});
