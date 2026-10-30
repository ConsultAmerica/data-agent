import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SourceVerificationSection from "@/components/extraction/source-verification-section";
import { RecordSelectionProvider, fieldId, itemId, linkByEvidence, useRecordSelection } from "@/lib/record-selection";
import type { ExtractTargetsResult, ScalarTargetResult } from "@/types/document";

vi.mock("@/components/source-verification-panel", () => ({
  default: ({ request }: { request: { pageNumber: number; label?: string } | null }) => (
    <div data-testid="viewer">{request ? `page ${request.pageNumber}: ${request.label}` : "no selection"}</div>
  ),
}));
const { exportMock } = vi.hoisted(() => ({ exportMock: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/staging-workbook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staging-workbook")>()),
  downloadSelectedTargetRecords: exportMock,
}));

function scalar(key: string, value: string, page: number, section: string, box = true): ScalarTargetResult {
  return {
    target: key.replace(/_/g, " "), normalized_key: key, value, page, confidence: 0.95, confidence_band: "high",
    verified: true, extraction_method: "label_value", display_method: "", validation_status: "passed", review_status: "pending",
    evidence: { page_number: page, source_text: value, source_reference: `page ${page}`, section, ...(box ? { x0: 10, y0: 10, x1: 90, y1: 20 } : {}) },
  } as unknown as ScalarTargetResult;
}

const result = {
  document_id: "d1",
  scalars: [
    scalar("contract_number", "FA300224C0008", 1, "Section A"),
    scalar("issued_by", "FA3002 338 ESS CC", 1, "Section A", false),
    scalar("period_of_performance", "07/01/2025", 2, "Section F"),
  ],
  tables: [{ target: "CLINs", columns: ["Item", "Amount"], pages: [3, 4], rows: Array.from({ length: 60 }, (_, i) => ({ Item: String(i + 1).padStart(4, "0"), Amount: `$${i + 1}.00` })) }],
  unresolved_targets: [],
  warnings: [],
} as unknown as ExtractTargetsResult;

function renderSection(onViewSource = vi.fn()) {
  render(
    <RecordSelectionProvider scalars={result.scalars} tables={result.tables}>
      <SourceVerificationSection documentId="d1" documentName="contract.pdf" pageCount={10} result={result} sourceRequest={null} onViewSource={onViewSource} />
    </RecordSelectionProvider>,
  );
  return onViewSource;
}

beforeEach(() => {
  window.localStorage.clear();
  exportMock.mockClear();
});

describe("Source Verification selection", () => {
  it("selects everything, a part, a field, a table or a row, with mixed states shown", () => {
    renderSection();
    const all = screen.getByLabelText("Select all fields and table rows") as HTMLInputElement;
    fireEvent.click(all);
    expect(screen.getByTestId("selection-count")).toHaveTextContent("63 selected"); // 3 fields + 60 rows
    fireEvent.click(screen.getByLabelText("Select issued by"));
    expect(all.indeterminate).toBe(true);
    const part = screen.getByLabelText(/^Select all fields in/) as HTMLInputElement;
    expect(part.indeterminate || part.checked).toBe(true);
    fireEvent.click(screen.getByLabelText("Select row 2 of CLINs"));
    expect((screen.getByLabelText("Select all rows of CLINs") as HTMLInputElement).indeterminate).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Clear selection/ }));
    expect(screen.getByTestId("selection-count")).toHaveTextContent("0 selected");
  });

  it("exports only the selected records, in the chosen format", async () => {
    renderSection();
    fireEvent.click(screen.getByLabelText("Select contract number"));
    fireEvent.click(screen.getByLabelText("Select row 3 of CLINs"));
    fireEvent.change(screen.getByLabelText("Export format"), { target: { value: "csv" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Export selected/ }));
    });
    expect(exportMock).toHaveBeenCalledWith("d1", "csv", ["contract_number"], [{ table: "CLINs", index: 2 }], "contract.pdf");
    expect(window.localStorage.getItem("dx-selected-export-format")).toBe("csv");
  });

  it("opens a field's source page with its evidence, and says when no coordinates exist", () => {
    const onViewSource = renderSection();
    fireEvent.click(screen.getByText("FA300224C0008"));
    expect(onViewSource).toHaveBeenLastCalledWith(expect.objectContaining({ pageNumber: 1, region: [10, 10, 90, 20], label: "contract number" }));
    fireEvent.click(screen.getByText("FA3002 338 ESS CC"));
    expect(onViewSource).toHaveBeenLastCalledWith(expect.objectContaining({ pageNumber: 1, region: null }));
  });

  it("reviews the selection one record at a time without approving anything", () => {
    const onViewSource = renderSection();
    fireEvent.click(screen.getByLabelText("Select contract number"));
    fireEvent.click(screen.getByLabelText("Select row 1 of CLINs"));
    fireEvent.click(screen.getByRole("button", { name: /Review selected/ }));
    const bar = screen.getByTestId("review-selected-bar");
    expect(bar).toHaveTextContent("Reviewing 1 of 2");
    fireEvent.click(within(bar).getByRole("button", { name: "Next" }));
    expect(bar).toHaveTextContent("Reviewing 2 of 2");
    expect(onViewSource).toHaveBeenLastCalledWith(expect.objectContaining({ id: "row:CLINs#0", pageNumber: 3 }));
    expect(bar).toHaveTextContent("Nothing is approved here");
  });

  it("collapses, and keeps large tables light until asked for every row", () => {
    renderSection();
    expect(screen.getAllByTestId("ucf-table-row")).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: "Show all 60 rows" }));
    expect(screen.getAllByTestId("ucf-table-row")).toHaveLength(60);
    const toggle = screen.getByRole("button", { name: /Source verification/ });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("source-verification-body")).toBeNull();
  });
});

describe("selection shared with the Staging Workbook", () => {
  it("links a field and a workbook value only on unique page + value evidence", () => {
    const pairs = linkByEvidence(result.scalars, [
      { id: "summary:number", page: 1, value: "FA300224C0008" },
      { id: "summary:date-a", page: 2, value: "07/01/2025" },
      { id: "summary:date-b", page: 2, value: "07/01/2025" }, // two candidates: not linked
      { id: "other:number", page: 5, value: "FA300224C0008" }, // other page
    ]);
    expect(pairs).toEqual([[fieldId("contract_number"), itemId("summary:number")]]);
  });

  it("selecting either side selects both", () => {
    let api: ReturnType<typeof useRecordSelection> = null;
    function Probe() {
      api = useRecordSelection();
      return null;
    }
    render(
      <RecordSelectionProvider scalars={result.scalars} tables={result.tables}>
        <Probe />
      </RecordSelectionProvider>,
    );
    act(() => api!.setLinks("workbook", [[fieldId("contract_number"), itemId("summary:number")]]));
    act(() => api!.toggle([itemId("summary:number")], true));
    expect(api!.selected.has(fieldId("contract_number"))).toBe(true);
    expect(api!.recordCount).toBe(1); // one record, two views
    act(() => api!.toggle([fieldId("contract_number")], false));
    expect(api!.selected.size).toBe(0);
  });
});
