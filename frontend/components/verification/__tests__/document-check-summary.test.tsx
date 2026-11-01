import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DocumentCheckSummary from "@/components/verification/document-check-summary";
import type { DocumentValidation, ProcessingStage } from "@/lib/document-validation";

const { getMock, revalidateMock, retryMock, decideMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  revalidateMock: vi.fn(),
  retryMock: vi.fn(() => Promise.resolve({ id: 8, status: "queued", retry_count: 1 })),
  decideMock: vi.fn(() => Promise.resolve({})),
}));

vi.mock("@/lib/document-validation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/document-validation")>()),
  getDocumentValidation: getMock,
  revalidateDocument: revalidateMock,
  retryJob: retryMock,
}));
vi.mock("@/lib/classification", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/classification")>()),
  decideClassification: decideMock,
}));

const STAGES: ProcessingStage[] = [
  { key: "uploading", label: "Uploading", status: "done", detail: "" },
  { key: "file_verified", label: "File Verified", status: "done", detail: "Verified" },
  { key: "classifying", label: "Classifying", status: "done", detail: "" },
  { key: "extracting", label: "Extracting", status: "done", detail: "1 of 1 pages read" },
  { key: "validating", label: "Validating", status: "done", detail: "" },
  { key: "ready_for_review", label: "Ready for Review", status: "done", detail: "" },
];

function report(overrides: Partial<DocumentValidation> = {}): DocumentValidation {
  return {
    document_id: "d1",
    generated_at: "2026-10-31T00:00:00Z",
    processing: { stages: STAGES, completed: 6, total: 6, failed: false, job_durations_ms: {} },
    file: {
      status: "verified",
      facts: {},
      checks: [
        { code: "signature", label: "File type and signature", status: "passed", detail: "PDF signature matches" },
        { code: "form_fields", label: "Fillable form fields", status: "info", detail: "6 form box(es), 6 filled" },
      ],
    },
    classification: {
      family: "government_contract", family_label: "Government Contract", subtype: "SF 33 Solicitation / Award",
      confidence: 0.92, status: "classified", review_status: "Not reviewed", decided: false, review_required: false,
      evidence: ['Standard Form identifier "SOLICITATION, OFFER AND AWARD"'],
      candidates: [], suggested: null,
    },
    labels: {
      total: 6, resolved: 6, by_source: { form: 6 }, unresolved: [], rewritten_count: 1,
      rewritten: [{ record_key: "k2", printed: "2 Enter the Contract Number", display: "Contract Number", item_number: "2", meaning: "Contract Number", value: "FA300224C0008", page: 1 }],
    },
    association: { fields: { confirmed: 0, matched: 2, needs_review: 0, unresolved: 0 }, needs_review: [], issues: [], issue_count: 0 },
    completeness: {
      status: "complete",
      measures: [
        { key: "pages", label: "Pages processed", source: 1, represented: 1, status: "complete", detail: "1 of 1 pages read", missing: [], missing_count: 0 },
        { key: "form_fields", label: "Filled form fields", source: 6, represented: 6, status: "complete", detail: "6 form boxes in the file, 6 filled", missing: [], missing_count: 0 },
      ],
      gaps: [], review: [],
    },
    consistency: {
      status: "consistent", rows: 8,
      checks: [{ key: "field_values", label: "Extracted values", status: "consistent", expected: 6, found: 6, examples: [] }],
    },
    entities: { contracts: ["FA300224C0008"] },
    readiness: {
      state: "ready", label: "Ready for Mapping", note: "Source-data readiness only.",
      checks: [{ key: "identifiers", label: "Source identifiers", status: "passed", detail: "Contract Number FA300224C0008" }],
    },
    summary: { state: "ready", headline: "Ready for review" },
    timings_ms: { total_ms: 420 },
    ...overrides,
  };
}

beforeEach(() => {
  getMock.mockReset();
  revalidateMock.mockReset();
  retryMock.mockClear();
  decideMock.mockClear();
});

describe("DocumentCheckSummary", () => {
  it("shows the six processing stages and the document's checks in one compact strip", async () => {
    getMock.mockResolvedValue(report());
    render(<DocumentCheckSummary documentId="d1" />);

    const stages = await screen.findByTestId("processing-stages");
    expect(within(stages).getAllByRole("listitem").map((li) => li.textContent?.replace("→", "").trim())).toEqual([
      "Uploading", "File Verified", "Classifying", "Extracting", "Validating", "Ready for Review",
    ]);
    expect(screen.getByTestId("stage-ready_for_review")).toHaveAttribute("data-status", "done");
    expect(screen.getByTestId("mapping-readiness")).toHaveTextContent("Ready for Mapping");
    expect(screen.getByTestId("file-status")).toHaveTextContent("File verified");
    expect(screen.getByTestId("type-status")).toHaveTextContent("Government Contract · 92%");
    expect(screen.getByTestId("coverage-status")).toHaveTextContent("Coverage complete · 6/6 form fields");
    expect(screen.getByTestId("label-status")).toHaveTextContent("6/6 labels");
    expect(screen.getByTestId("excel-status")).toHaveTextContent("Excel matches the tab");
    // Details stay closed until asked for.
    expect(screen.queryByTestId("document-check-details")).toBeNull();

    fireEvent.click(screen.getByTestId("document-check-toggle"));
    const details = screen.getByTestId("document-check-details");
    expect(within(details).getByTestId("details-labels")).toHaveTextContent("“2 Enter the Contract Number” → 2 · Contract Number");
    expect(within(details).getByTestId("details-completeness")).toHaveTextContent("Filled form fields: 6 of 6");
    expect(within(details).getByTestId("details-readiness")).toHaveTextContent("Mapping stays open while fields are in review");
  });

  it("names the cause of a failed stage and retries it", async () => {
    const failed = STAGES.map((s) => (s.key === "extracting"
      ? { ...s, status: "failed" as const, detail: "OCR engine crashed",
          failure: { job_id: 7, job_type: "processing", stage: "rendering_ocr", reason: "extraction_failed", retryable: true, message: "OCR engine crashed", retry_count: 0 } }
      : s.key === "validating" || s.key === "ready_for_review" ? { ...s, status: "pending" as const } : s));
    getMock.mockResolvedValue(report({
      processing: { stages: failed, completed: 3, total: 6, failed: true, job_durations_ms: {} },
      readiness: null, completeness: null, consistency: null, labels: null, association: null,
    }));
    render(<DocumentCheckSummary documentId="d1" />);

    const alert = await screen.findByTestId("processing-failure");
    expect(alert).toHaveTextContent("Reading the pages failed: OCR engine crashed");
    expect(screen.getByTestId("stage-extracting")).toHaveAttribute("data-status", "failed");
    fireEvent.click(screen.getByTestId("retry-processing"));
    await waitFor(() => expect(retryMock).toHaveBeenCalledWith(7));
  });

  it("doesn't offer a retry when retrying can't help", async () => {
    const failed = STAGES.map((s) => (s.key === "file_verified"
      ? { ...s, status: "failed" as const, detail: "The PDF is password-protected",
          failure: { job_id: 3, job_type: "processing", stage: "verifying_file", reason: "file_invalid", retryable: false, message: "The PDF is password-protected", retry_count: 0 } }
      : s));
    getMock.mockResolvedValue(report({ processing: { stages: failed, completed: 1, total: 6, failed: true, job_durations_ms: {} } }));
    render(<DocumentCheckSummary documentId="d1" />);

    expect(await screen.findByTestId("processing-failure")).toHaveTextContent("The file failed verification: The PDF is password-protected");
    expect(screen.queryByTestId("retry-processing")).toBeNull();
  });

  it("doesn't force a low-confidence type and confirms a suggested one, then revalidates", async () => {
    const changed = vi.fn();
    getMock.mockResolvedValue(report({
      classification: {
        ...report().classification!, family: "generic_business", family_label: "Generic Business Document", confidence: 0,
        status: "review_required", review_required: true,
        suggested: { family: "government_contract", family_label: "Government Contract", score: 0.9 },
      },
      readiness: { state: "review_required", label: "Review Required", note: "", checks: [] },
    }));
    revalidateMock.mockResolvedValue(report());
    render(<DocumentCheckSummary documentId="d1" onClassificationChanged={changed} />);

    expect(await screen.findByTestId("type-status")).toHaveTextContent("Generic Business Document · 0% · review");
    expect(screen.getByTestId("mapping-readiness")).toHaveTextContent("Review Required");
    fireEvent.click(screen.getByTestId("document-check-toggle"));
    expect(screen.getByTestId("details-type")).toHaveTextContent("the type isn't forced");
    fireEvent.click(screen.getByTestId("confirm-suggested-type"));
    await waitFor(() => expect(decideMock).toHaveBeenCalledWith("d1", expect.objectContaining({ action: "override", family: "government_contract", apply: true })));
    await waitFor(() => expect(revalidateMock).toHaveBeenCalledWith("d1"));
    expect(changed).toHaveBeenCalled();
    expect(await screen.findByTestId("type-status")).toHaveTextContent("Government Contract · 92%");
  });

  it("shows coverage gaps and a tab / Excel difference instead of claiming completeness", async () => {
    getMock.mockResolvedValue(report({
      completeness: {
        status: "gaps",
        measures: [{ key: "form_fields", label: "Filled form fields", source: 52, represented: 51, status: "gaps", detail: "", missing: [{ page: 1, label: "15A Offeror Code", value: "98S99" }], missing_count: 1 }],
        gaps: [{ key: "form_fields", label: "Filled form fields", source: 52, represented: 51, status: "gaps", detail: "", missing: [{ page: 1, label: "15A Offeror Code", value: "98S99" }], missing_count: 1 }],
        review: [],
      },
      consistency: { status: "inconsistent", rows: 10, checks: [{ key: "tables", label: "Table titles, columns, rows and cells", status: "inconsistent", expected: 2, found: 1, examples: [{ what: "tables", tab: 2, excel: 1 }] }] },
    }));
    render(<DocumentCheckSummary documentId="d1" />);

    expect(await screen.findByTestId("coverage-status")).toHaveTextContent("1 coverage gap · 51/52 form fields");
    expect(screen.getByTestId("excel-status")).toHaveTextContent("Excel differs from the tab");
    fireEvent.click(screen.getByTestId("document-check-toggle"));
    expect(screen.getByTestId("details-completeness")).toHaveTextContent("Not represented: page 1, label 15A Offeror Code, value 98S99");
  });
});
