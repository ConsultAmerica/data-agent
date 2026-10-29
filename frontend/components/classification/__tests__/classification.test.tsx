import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ClassificationPanel from "@/components/classification/classification-panel";
import ClassificationReviewPage from "@/src/app/classification/page";
import {
  classificationQueue,
  decideClassification,
  getClassification,
  listDocumentTypes,
  type ClassificationState,
} from "@/lib/classification";

let reviewEnabled = true;
vi.mock("@/lib/review-gate", () => ({ useReviewMutationsEnabled: () => reviewEnabled }));
vi.mock("@/components/source-verification-panel", () => ({ default: () => <div data-testid="source-viewer" /> }));
vi.mock("@/lib/classification", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/classification")>()),
  getClassification: vi.fn(),
  decideClassification: vi.fn(),
  reclassify: vi.fn(),
  listDocumentTypes: vi.fn(),
  classificationQueue: vi.fn(),
}));

function state(extra: Partial<ClassificationState> = {}): ClassificationState {
  return {
    document_id: "doc-1", family: "government_contract", family_label: "Government Contract",
    category: "contracts", category_label: "Contracts & Awards", subtype: "SF 1442 Contract Award",
    subtypes: ["SF 1442 Contract Award", "SF 33 Solicitation / Award", "DoD / UCF Contract"],
    profile_id: "contract_v3", profile_label: "Government Contract", confidence: 0.72, confidence_level: "medium",
    status: "review_recommended", method: "keyword classifier",
    evidence: ['Standard Form identifier "SF1442" on the first pages', 'Keywords found: "clin", "far "'],
    candidates: [
      { family: "government_contract", label: "Government Contract", category: "contracts", category_label: "Contracts & Awards",
        profile_id: "contract_v3", subtype: "SF 1442 Contract Award", score: 0.72, evidence: [], sources: ["keywords"] },
      { family: "procurement", label: "Procurement Document", category: "procurement", category_label: "Procurement",
        profile_id: "generic_business_document", subtype: null, score: 0.33, evidence: ["Keywords found: \"rfp\""], sources: ["keywords"] },
    ],
    thresholds: { high: 0.85, low: 0.6 }, engine_version: "cls-1", decided: false, decided_by: null,
    predicted: null, history: [
      { id: 1, kind: "prediction", family: "government_contract", family_label: "Government Contract",
        subtype: "SF 1442 Contract Award", confidence: 0.72, status: "review_recommended", method: "keyword classifier",
        actor_name: null, reason: null, created_at: "2026-10-29T10:00:00Z" },
    ],
    staged_profile_id: "contract_v3", needs_restage: false, mappings_to_review: [],
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reviewEnabled = true;
  vi.mocked(getClassification).mockResolvedValue(state());
  vi.mocked(listDocumentTypes).mockResolvedValue([
    { category: "contracts", label: "Contracts & Awards", types: [
      { family: "government_contract", label: "Government Contract", profile_id: "contract_v3", profile_label: "Government Contract",
        subtypes: ["SF 1442 Contract Award", "SF 33 Solicitation / Award", "DoD / UCF Contract"], datasets: [] },
    ] },
    { category: "financial", label: "Financial", types: [
      { family: "invoice", label: "Invoice", profile_id: "invoice", profile_label: "Invoice",
        subtypes: ["Standard Invoice", "PO-Referenced Invoice"], datasets: [{ dataset_id: "lines", display_name: "Invoice Lines", cardinality: "repeating", fields: 6 }] },
    ] },
  ]);
  vi.mocked(decideClassification).mockImplementation(async (_id, decision) =>
    state({ status: "confirmed", decided: true, decided_by: "Dev Admin", subtype: decision.subtype ?? "SF 1442 Contract Award" }),
  );
});

describe("ClassificationPanel", () => {
  it("shows the detected type, an uncalibrated confidence, real evidence and alternatives", async () => {
    render(<ClassificationPanel documentId="doc-1" />);
    expect(await screen.findByTestId("classification-type")).toHaveTextContent("Government Contract — SF 1442 Contract Award");
    expect(screen.getByTestId("classification-status")).toHaveTextContent("Review recommended");
    expect(screen.getByTitle(/not a calibrated probability/)).toHaveTextContent("Medium (72%)");
    expect(screen.getByTestId("classification-evidence")).toHaveTextContent('Standard Form identifier "SF1442"');
    expect(within(screen.getByTestId("classification-alternatives")).getByText(/Procurement Document/)).toBeInTheDocument();
  });

  it("confirms the classification", async () => {
    const onChanged = vi.fn();
    render(<ClassificationPanel documentId="doc-1" onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: /Confirm classification/ }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(decideClassification).toHaveBeenCalledWith("doc-1", { action: "confirm" });
    expect(screen.getByTestId("classification-status")).toHaveTextContent("Confirmed");
  });

  it("changes the type and subtype, and re-extracts with the chosen schema", async () => {
    render(<ClassificationPanel documentId="doc-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Change document type" }));
    fireEvent.change(screen.getByLabelText("Document type"), { target: { value: "invoice" } });
    fireEvent.change(screen.getByLabelText("Subtype"), { target: { value: "PO-Referenced Invoice" } });
    expect(screen.getByText(/Schema: Invoice · Invoice Lines/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "It is an invoice" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and re-extract" }));
    await waitFor(() => expect(decideClassification).toHaveBeenCalled());
    expect(vi.mocked(decideClassification).mock.calls[0][1]).toEqual({
      action: "override", family: "invoice", custom_label: null, subtype: "PO-Referenced Invoice", reason: "It is an invoice",
    });
  });

  it("creates a new category from an unknown document", async () => {
    vi.mocked(getClassification).mockResolvedValue(state({
      family: "unknown", family_label: "Unknown / General Document", subtype: null, subtypes: [], confidence: 0,
      confidence_level: "low", status: "review_required", candidates: [],
    }));
    render(<ClassificationPanel documentId="doc-1" />);
    expect(await screen.findByText(/general schema is used until a person confirms/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Confirm classification/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Change document type" }));
    fireEvent.change(screen.getByLabelText("Document type"), { target: { value: "__new__" } });
    fireEvent.change(screen.getByPlaceholderText(/Board Meeting Minutes/), { target: { value: "Board Minutes" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and re-extract" }));
    await waitFor(() => expect(decideClassification).toHaveBeenCalled());
    expect(vi.mocked(decideClassification).mock.calls[0][1]).toMatchObject({ action: "override", family: null, custom_label: "Board Minutes" });
  });

  it("is read-only when review changes are disabled", async () => {
    reviewEnabled = false;
    render(<ClassificationPanel documentId="doc-1" />);
    expect(await screen.findByText(/changes are disabled/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change document type" })).not.toBeInTheDocument();
  });
});

describe("Classification review queue", () => {
  it("lists documents needing review and opens the document with the panel", async () => {
    vi.mocked(classificationQueue).mockResolvedValue([
      { document_id: "doc-1", original_filename: "notes.pdf", page_count: 2, family_label: "Unknown / General Document",
        subtype: null, category_label: "Other Documents", confidence: 0, status: "review_required",
        top_alternatives: [state().candidates[1]], classified_at: "2026-10-29T10:00:00Z" },
    ]);
    render(<ClassificationReviewPage />);
    const queue = await screen.findByTestId("classification-queue");
    expect(within(queue).getByText("Classification review required")).toBeInTheDocument();
    expect(within(queue).getByText(/or Procurement Document 33%/)).toBeInTheDocument();
    fireEvent.click(within(queue).getByText("notes.pdf"));
    expect(await screen.findByTestId("source-viewer")).toBeInTheDocument();
    expect(await screen.findByTestId("classification-panel")).toBeInTheDocument();
  });
});
