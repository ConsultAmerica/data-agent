import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import FieldsTable from "@/components/extraction/fields-table";
import { buildFieldRows } from "@/components/extraction/field-row";
import type { ScalarTargetResult } from "@/types/document";
import { REVIEW_READ_ONLY_MESSAGE } from "@/lib/review-gate";

const gate = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/review-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/review-gate")>()),
  useReviewMutationsEnabled: () => gate.enabled,
}));

function scalar(overrides: Partial<ScalarTargetResult> = {}): ScalarTargetResult {
  return {
    target: "contract_number",
    normalized_key: "contract_number",
    value: "W912DR-26-C-0042",
    page: 1,
    confidence: 0.9,
    confidence_band: "high",
    verified: true,
    extraction_method: "source_evidence",
    display_method: "",
    evidence: {
      page_number: 1,
      source_text: "Contract Number: W912DR-26-C-0042",
      source_reference: "Page 1",
    },
    ...overrides,
  };
}

function expandRow(id: string) {
  const row = document.getElementById(`field-row-${id}`);
  const toggle = row!.querySelector("button")!;
  fireEvent.click(toggle);
}

describe("FieldsTable", () => {
  afterEach(() => {
    gate.enabled = true;
  });

  it("disables Edit, Accept and Reject with an explanation while review is read-only", () => {
    gate.enabled = false;
    const rows = buildFieldRows([scalar({ verified: false })], [], new Map());
    render(
      <FieldsTable
        title="Fields"
        rows={rows}
        onSaveCorrection={vi.fn()}
        onMarkVerified={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expandRow("contract_number");
    for (const name of ["Edit", "Accept", "Reject"]) {
      const button = screen.getByRole("button", { name: new RegExp(`^${name}`) });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute("title", REVIEW_READ_ONLY_MESSAGE);
    }
    expect(screen.getByTestId("review-locked")).toHaveTextContent("Read-only in this release");
  });

  it("renders a compact collapsed card with label, value, confidence, method, and page", () => {
    const rows = buildFieldRows([scalar()], [], new Map());
    render(<FieldsTable title="Fields" rows={rows} />);

    expect(screen.getByText("Contract Number")).toBeInTheDocument();
    expect(screen.getByText("W912DR-26-C-0042")).toBeInTheDocument();
    expect(screen.getByText(/high 0\.90/i)).toBeInTheDocument();
    expect(screen.getByText("source_evidence")).toBeInTheDocument();
    expect(screen.getByText(/page 1/i)).toBeInTheDocument();
  });

  it("renders 100+ fields without dropping rows", () => {
    const scalars = Array.from({ length: 120 }, (_, i) =>
      scalar({ target: `field_${i}`, normalized_key: `field_${i}` }),
    );
    const rows = buildFieldRows(scalars, [], new Map());
    render(<FieldsTable title="Fields" rows={rows} onViewSource={vi.fn()} />);

    expect(screen.getAllByText("View Source")).toHaveLength(120);
  });

  it("distinguishes missing and empty fields with placeholder text instead of blank cells", () => {
    const rows = buildFieldRows(
      [scalar({ target: "a", normalized_key: "a", value: "" })],
      [{ key: "d", label: "Missing Field" }],
      new Map(),
    );
    render(<FieldsTable title="Fields" rows={rows} />);

    expect(screen.getByText("No value captured")).toBeInTheDocument();
    expect(screen.getByText("Not found in document")).toBeInTheDocument();
    expect(screen.getByText("Missing Field")).toBeInTheDocument();
  });

  it("does not show a View Source action for a not-found field (no evidence)", () => {
    const rows = buildFieldRows([], [{ key: "missing_field", label: "Missing Field" }], new Map());
    render(<FieldsTable title="Fields" rows={rows} />);

    const row = document.getElementById("field-row-missing_field");
    expect(row).not.toBeNull();
    expect(row!.textContent).not.toContain("View Source");
  });

  it("renders a Native result with its real page number and method, unmodified", () => {
    const rows = buildFieldRows(
      [scalar({ display_method: "Native", extraction_method: "source_evidence" })],
      [],
      new Map(),
    );
    render(<FieldsTable title="Fields" rows={rows} />);

    expect(screen.getByText("Native")).toBeInTheDocument();
  });

  it("renders an OCR result using the backend's OCR display label", () => {
    const rows = buildFieldRows(
      [
        scalar({
          display_method: "OCR",
          extraction_method: "source_evidence",
          evidence: { page_number: 2, source_text: "OCR'd text", source_reference: "Page 2" },
        }),
      ],
      [],
      new Map(),
    );
    render(<FieldsTable title="Fields" rows={rows} />);

    expect(screen.getByText("OCR")).toBeInTheDocument();
    expect(screen.getByText(/page 2/i)).toBeInTheDocument();
  });

  it("renders an AI Fallback result distinctly from Native/OCR results", () => {
    const rows = buildFieldRows(
      [scalar({ extraction_method: "ai", display_method: "" })],
      [],
      new Map(),
    );
    render(<FieldsTable title="Fields" rows={rows} />);

    expect(screen.getByText("AI Fallback")).toBeInTheDocument();
  });

  it("fires onViewSource with the field's page, highlight text, and stable row id", () => {
    const onViewSource = vi.fn();
    const rows = buildFieldRows([scalar()], [], new Map());
    render(<FieldsTable title="Fields" rows={rows} onViewSource={onViewSource} />);

    fireEvent.click(screen.getByText("View Source"));

    expect(onViewSource).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "contract_number",
        pageNumber: 1,
        label: "Contract Number",
        value: "W912DR-26-C-0042",
      }),
    );
  });

  it("keeps the clicked result visually selected and auto-expands its compact evidence panel", () => {
    const rows = buildFieldRows(
      [scalar(), scalar({ target: "vendor_name", normalized_key: "vendor_name" })],
      [],
      new Map(),
    );
    const { rerender } = render(<FieldsTable title="Fields" rows={rows} selectedId={null} />);

    expect(screen.queryByText("Source evidence")).not.toBeInTheDocument();

    rerender(<FieldsTable title="Fields" rows={rows} selectedId="contract_number" />);

    const selectedRow = document.getElementById("field-row-contract_number");
    expect(selectedRow).toHaveClass("bg-primary/5");

    expect(screen.getByText("Source evidence")).toBeInTheDocument();
    expect(screen.getByText("“Contract Number: W912DR-26-C-0042”")).toBeInTheDocument();

    const vendorRow = document.getElementById("field-row-vendor_name");
    expect(vendorRow).not.toHaveClass("bg-primary/5");
  });

  it("expands only the clicked result when its row body is clicked (independent of selection)", () => {
    const rows = buildFieldRows(
      [scalar(), scalar({ target: "vendor_name", normalized_key: "vendor_name" })],
      [],
      new Map(),
    );
    render(<FieldsTable title="Fields" rows={rows} />);

    expandRow("vendor_name");

    expect(screen.getByText("Source evidence")).toBeInTheDocument();
    expect(screen.getByText("Validation")).toBeInTheDocument();
    // Collapsing the same row hides the panel again.
    expandRow("vendor_name");
    expect(screen.queryByText("Source evidence")).not.toBeInTheDocument();
  });

  it("truncates a long evidence snippet instead of dumping the full page text", () => {
    const longText = "A".repeat(500);
    const rows = buildFieldRows(
      [scalar({ evidence: { page_number: 1, source_text: longText, source_reference: "Page 1" } })],
      [],
      new Map(),
    );
    render(<FieldsTable title="Fields" rows={rows} selectedId="contract_number" />);

    const snippet = screen.getByText(/^“A+…”$/);
    expect(snippet.textContent!.length).toBeLessThan(longText.length);
  });

  it("saves a correction through the expanded edit workflow", async () => {
    const onSaveCorrection = vi.fn().mockResolvedValue(undefined);
    const rows = buildFieldRows([scalar()], [], new Map());
    render(<FieldsTable title="Fields" rows={rows} onSaveCorrection={onSaveCorrection} />);

    expandRow("contract_number");
    fireEvent.click(screen.getByText("Edit"));
    const input = screen.getByDisplayValue("W912DR-26-C-0042");
    fireEvent.change(input, { target: { value: "W912DR-26-C-0043" } });
    fireEvent.click(screen.getByText("Save"));

    expect(onSaveCorrection).toHaveBeenCalledWith(
      expect.objectContaining({ id: "contract_number" }),
      "W912DR-26-C-0043",
    );
  });

  it("shows an edited-value indicator and the original extraction once a correction exists", () => {
    const correction = {
      id: 1,
      document_id: "doc-1",
      normalized_key: "contract_number",
      action: "edit" as const,
      original_value: "W912DR-26-C-0042",
      corrected_value: "W912DR-26-C-0043",
      evidence_snapshot: null,
      changed_by: null,
      created_at: new Date().toISOString(),
    };
    const rows = buildFieldRows(
      [scalar()],
      [],
      new Map([["contract_number", correction]]),
    );
    render(<FieldsTable title="Fields" rows={rows} />);

    expect(screen.getByText("W912DR-26-C-0043")).toBeInTheDocument();
    expect(screen.getByText("Edited")).toBeInTheDocument();

    expandRow("contract_number");
    expect(screen.getByText("Original extraction")).toBeInTheDocument();
    expect(screen.getByText("W912DR-26-C-0042")).toBeInTheDocument();
  });

  it("marks a result verified without changing its value", async () => {
    const onMarkVerified = vi.fn().mockResolvedValue(undefined);
    const rows = buildFieldRows([scalar()], [], new Map());
    render(<FieldsTable title="Fields" rows={rows} onMarkVerified={onMarkVerified} />);

    expandRow("contract_number");
    fireEvent.click(screen.getByText("Accept"));

    expect(onMarkVerified).toHaveBeenCalledWith(
      expect.objectContaining({ id: "contract_number", value: "W912DR-26-C-0042" }),
    );
  });

  it("shows retrieval, confidence signals, and validation checks when expanded", () => {
    const rows = buildFieldRows(
      [
        scalar({
          retrieval: {
            target_key: "contract_number",
            candidate_pages: [
              { page: 1, score: 0.94 },
              { page: 4, score: 0.41 },
            ],
            selected_pages: [1],
            deterministic_status: "resolved",
            ai_fallback_required: false,
          },
          confidence_detail: {
            score: 0.91,
            band: "high",
            signals: {
              exact_label_match: true,
              label_proximity: "strong",
              native_text: true,
              format_validation: true,
              source_grounded: true,
              corroborating_occurrences: 2,
              ambiguity: false,
              ai_fallback: false,
            },
          },
          validation: {
            status: "passed",
            checks: [
              { type: "data_type", status: "passed" },
              { type: "format", status: "passed" },
              { type: "source_presence", status: "passed" },
            ],
            warnings: [],
          },
        }),
      ],
      [],
      new Map(),
    );
    render(<FieldsTable title="Fields" rows={rows} />);
    expandRow("contract_number");

    expect(screen.getByText("Retrieval")).toBeInTheDocument();
    expect(screen.getByText(/Selected pages/i)).toBeInTheDocument();
    expect(screen.getByText("Confidence signals")).toBeInTheDocument();
    expect(screen.getByText("Exact label")).toBeInTheDocument();
    expect(screen.getByText("Validation checks")).toBeInTheDocument();
    expect(screen.getByText(/source presence/i)).toBeInTheDocument();
    expect(screen.getByText(/Validation passed/i)).toBeInTheDocument();
  });
});
