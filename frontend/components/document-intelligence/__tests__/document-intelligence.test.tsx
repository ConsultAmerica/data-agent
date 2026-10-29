import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DocumentIntelligenceCard from "@/components/document-intelligence/document-intelligence-card";
import { ViewerErrorBoundary } from "@/components/viewers/viewer-error-boundary";
import { formatCalendarDate, type DocumentIntelligence } from "@/lib/document-intelligence";

// Increment 6B.1: document intelligence card, calendar dates, viewer
// error boundary.

const { getDocumentIntelligence } = vi.hoisted(() => ({ getDocumentIntelligence: vi.fn() }));

vi.mock("@/lib/document-intelligence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/document-intelligence")>()),
  getDocumentIntelligence,
}));
vi.mock("@/components/classification/classification-tag", () => ({
  default: () => <button type="button">Confirm or change type</button>,
}));

function intelligence(extra: Partial<DocumentIntelligence> = {}): DocumentIntelligence {
  return {
    document_id: "doc-1",
    file_format: "pdf",
    classification: {
      category: "identity", category_label: "Identity Documents", document_type: "passport", document_type_label: "Passport",
      subtype: null, secondary_categories: [], confidence: 0.95, confidence_level: "high", status: "classified",
      evidence: ["Machine-readable zone found"], method: "structure", engine_version: "cls-1", decided: false, decided_by: null,
      requires_confirmation: false,
    },
    date_candidates: [
      { date_type: "expiration_date", kind: "expiry", original_text: "P<USA…", normalized_date: "2032-04-15", interpretations: [], source: "mrz",
        page: 1, evidence_text: "P<USA…", confidence: 0.99, validation_status: "valid", review_status: "not_reviewed", option_period: false },
    ],
    lifecycle_dates: {
      start: null,
      expiration: { date_type: "expiration_date", kind: "expiry", original_text: "15 APR 2032", normalized_date: "2032-04-15", interpretations: [],
        source: "mrz", page: 1, evidence_text: "P<USA…", confidence: 0.99, validation_status: "valid", review_status: "not_reviewed", option_period: false },
      renewal: null,
      payment_due: null,
    },
    lifecycle: { status: "active", label: "Active", reasons: ["Ends on 2032-04-15."], days_remaining: 2000, review_required: [],
      evaluated_on: "2026-10-29", warning_days: 30, timezone: "UTC" },
    review_required: [],
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("DocumentIntelligenceCard", () => {
  it("shows category / type, lifecycle, dates with their source, and opens the date's evidence", async () => {
    getDocumentIntelligence.mockResolvedValue(intelligence());
    const onViewSource = vi.fn();
    render(<DocumentIntelligenceCard documentId="doc-1" onViewSource={onViewSource} />);
    await waitFor(() => expect(screen.getByTestId("document-intelligence")).toHaveTextContent("Identity Documents / Passport"));
    const card = screen.getByTestId("document-intelligence");
    expect(screen.getByTestId("lifecycle-badge")).toHaveTextContent("Active");
    const expiration = screen.getAllByTestId("intelligence-date").find((row) => row.textContent?.includes("Expiration"))!;
    expect(expiration).toHaveTextContent("Machine-readable zone · p. 1");
    expect(within(card).getByText("Not stated")).toBeInTheDocument(); // no start date: not invented
    fireEvent.click(within(expiration).getByRole("button", { name: "View in source" }));
    expect(onViewSource).toHaveBeenCalledWith(expect.objectContaining({ pageNumber: 1, highlightText: "15 APR 2032" }));
    expect(screen.getByRole("button", { name: "Confirm or change type" })).toBeInTheDocument();
  });

  it("flags an ambiguous date with both readings and lists what needs review", async () => {
    const ambiguous = { ...intelligence().lifecycle_dates.expiration!, original_text: "03/04/2031", normalized_date: null,
      interpretations: ["2031-03-04", "2031-04-03"], validation_status: "ambiguous" as const, source: "text" };
    getDocumentIntelligence.mockResolvedValue(intelligence({
      lifecycle_dates: { start: null, expiration: ambiguous, renewal: null, payment_due: null },
      lifecycle: { ...intelligence().lifecycle, status: "needs_review", label: "Needs Review", reasons: [] },
      review_required: ["The end date “03/04/2031” is ambiguous (could be 2031-03-04 or 2031-04-03); confirm it in Metadata review."],
    }));
    render(<DocumentIntelligenceCard documentId="doc-1" />);
    expect(await screen.findByText("“03/04/2031” (ambiguous)")).toBeInTheDocument();
    expect(screen.getByText(/Could be/)).toHaveTextContent(`Could be ${formatCalendarDate("2031-03-04")} or ${formatCalendarDate("2031-04-03")}`);
    expect(screen.getByTestId("intelligence-review")).toHaveTextContent("confirm it in Metadata review");
    expect(screen.getByTestId("lifecycle-badge")).toHaveTextContent("Needs Review");
  });

  it("marks approved dates, and refetches with a 60 or 90-day warning period", async () => {
    const approved = { ...intelligence().lifecycle_dates.expiration!, source: "metadata_review", review_status: "approved" as const };
    getDocumentIntelligence.mockResolvedValue(intelligence({ lifecycle_dates: { start: null, expiration: approved, renewal: null, payment_due: null } }));
    render(<DocumentIntelligenceCard documentId="doc-1" />);
    expect(await screen.findByText("Approved")).toBeInTheDocument();
    expect(screen.getByText(/Approved in Metadata review/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Expiring-soon warning period"), { target: { value: "60" } });
    await waitFor(() => expect(getDocumentIntelligence).toHaveBeenLastCalledWith("doc-1", 60));
  });

  it("says an invoice's due date is a payment date, not an expiry", async () => {
    const due = { ...intelligence().lifecycle_dates.expiration!, date_type: "payment_due_date", kind: "due", normalized_date: "2026-10-01", source: "text" };
    getDocumentIntelligence.mockResolvedValue(intelligence({
      classification: { ...intelligence().classification, category_label: "Financial", document_type_label: "Invoice" },
      lifecycle_dates: { start: null, expiration: null, renewal: null, payment_due: due },
      lifecycle: { ...intelligence().lifecycle, status: "not_applicable", label: "Not Applicable", days_remaining: null,
        reasons: ["This type of document doesn't expire.", "Its payment due date (2026-10-01) is a payment date, not an expiry."] },
    }));
    render(<DocumentIntelligenceCard documentId="doc-1" />);
    expect(await screen.findByText(/is a payment date, not an expiry/)).toBeInTheDocument();
    expect(screen.getByTestId("lifecycle-badge")).toHaveTextContent("Not Applicable");
    expect(screen.getAllByTestId("intelligence-date").some((row) => row.textContent?.startsWith("Payment due"))).toBe(true);
  });
});

describe("Calendar dates", () => {
  it("formats a calendar date as the same day in every timezone", () => {
    expect(formatCalendarDate("2026-01-31")).toContain("31");
    expect(formatCalendarDate(null)).toBe("—");
  });
});

describe("ViewerErrorBoundary", () => {
  it("falls back to page text when a viewer throws, and resets for another document", async () => {
    const Broken = () => {
      throw new Error("bad sheet");
    };
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { rerender } = render(
      <ViewerErrorBoundary fallback={<p>page text</p>} resetKey="a"><Broken /></ViewerErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("This view couldn't be shown (bad sheet)");
    expect(screen.getByText("page text")).toBeInTheDocument();
    rerender(<ViewerErrorBoundary fallback={<p>page text</p>} resetKey="b"><p>sheet</p></ViewerErrorBoundary>);
    await act(async () => {});
    expect(screen.getByText("sheet")).toBeInTheDocument();
    spy.mockRestore();
  });
});
