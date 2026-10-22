import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents", () => ({
  reviewMetadataField: vi.fn(() => Promise.resolve({})),
  reviewMetadataFieldById: vi.fn(() => Promise.resolve({})),
  startProcessingJob: vi.fn(() => Promise.resolve({})),
}));

import ConfidenceMeter, { normalizeConfidence } from "@/components/ui/confidence-meter";
import FieldReviewList, { UNDO_WINDOW_MS, inspectHref } from "@/components/review-queue/field-review-list";
import * as documents from "@/lib/documents";
import { useTableDensity } from "@/lib/table-density";
import type { ReviewQueueFieldItem } from "@/types/document";

function item(overrides: Partial<ReviewQueueFieldItem> = {}): ReviewQueueFieldItem {
  return {
    document_id: "d1",
    original_filename: "award.pdf",
    metadata_field_id: 42,
    field_key: "v3_telephone_no",
    label: "Telephone",
    value: "671-339-8465",
    confidence: 0.55,
    review_status: "pending",
    extraction_source: "v3",
    reasons: ["low_confidence"],
    reason_labels: ["Low confidence"],
    priority: "high",
    decision_status: "needs_review",
    page_number: 2,
    ...overrides,
  };
}

describe("ConfidenceMeter", () => {
  it("bands by the confidence policy and normalizes 0-100", () => {
    const { rerender } = render(<ConfidenceMeter value={0.85} />);
    expect(screen.getByRole("meter")).toHaveAttribute("data-band", "high");
    expect(screen.getByRole("meter")).toHaveAccessibleName("Confidence 85%");
    rerender(<ConfidenceMeter value={84} />);
    expect(screen.getByRole("meter")).toHaveAttribute("data-band", "medium");
    rerender(<ConfidenceMeter value={0.59} />);
    expect(screen.getByRole("meter")).toHaveAttribute("data-band", "low");
    expect(screen.getByRole("meter")).toHaveAttribute("aria-valuenow", "59");
    expect(normalizeConfidence(150)).toBe(1);
    expect(normalizeConfidence(Number.NaN)).toBe(0);
  });
});

describe("useTableDensity", () => {
  it("remembers the choice per table family", () => {
    const { result } = renderHook(() => useTableDensity("test-scope"));
    expect(result.current[0]).toBe("comfortable");
    act(() => result.current[1]("compact"));
    expect(result.current[0]).toBe("compact");
    const other = renderHook(() => useTableDensity("other-scope"));
    expect(other.result.current[0]).toBe("comfortable");
    act(() => result.current[1]("comfortable"));
  });
});

describe("FieldReviewList", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(documents.reviewMetadataFieldById).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  function renderList(onDecided = vi.fn()) {
    const view = render(
      <FieldReviewList items={[item()]} reviewer="Dataomatix" issueLabel={(i) => i.reason_labels[0]} onDecided={onDecided} />,
    );
    return { ...view, onDecided };
  }

  it("approves by field id only after the undo window", async () => {
    const { onDecided } = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Approve Telephone" }));
    // Hidden at once, with an Undo, but not saved yet.
    expect(screen.queryByRole("button", { name: "Reject Telephone" })).toBeNull();
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(documents.reviewMetadataFieldById).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    expect(documents.reviewMetadataFieldById).toHaveBeenCalledWith("d1", 42, "accept", "Dataomatix");
    expect(onDecided).toHaveBeenCalledTimes(1);
  });

  it("undo cancels the decision and restores the row", async () => {
    renderList();
    fireEvent.click(screen.getByRole("button", { name: "Reject Telephone" }));
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
    });
    expect(documents.reviewMetadataFieldById).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Approve Telephone" })).toBeInTheDocument();
  });

  it("leaving the page saves decisions still in their undo window", async () => {
    const { unmount } = renderList();
    fireEvent.click(screen.getByRole("button", { name: "Reject Telephone" }));
    await act(async () => {
      unmount();
    });
    expect(documents.reviewMetadataFieldById).toHaveBeenCalledWith("d1", 42, "reject", "Dataomatix");
  });

  it("shows the confidence meter and inspects the value on its source page", () => {
    renderList();
    expect(screen.getByRole("meter")).toHaveAccessibleName("Confidence 55%");
    expect(screen.getByRole("link", { name: "Inspect Telephone in the source" })).toHaveAttribute(
      "href",
      "/documents/d1?view=source&page=2&hl=671-339-8465",
    );
    expect(inspectHref(item({ page_number: null }))).toBe("/documents/d1/review");
  });
});

describe("FieldReviewList batch actions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(documents.reviewMetadataFieldById).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  const items = [
    item({ metadata_field_id: 1, label: "Award date", confidence: 0.92 }),
    item({ metadata_field_id: 2, label: "PIID", confidence: 0.9 }),
    item({ metadata_field_id: 3, label: "Telephone", confidence: 0.4 }),
  ];

  it("selects high-confidence rows and approves them together with one undo", async () => {
    const onDecided = vi.fn();
    render(<FieldReviewList items={items} reviewer="R" issueLabel={(i) => i.reason_labels[0]} onDecided={onDecided} />);
    fireEvent.click(screen.getByRole("button", { name: /Select high confidence \(2\)/ }));
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve selected" }));

    // Both rows hide at once behind a single batch Undo; the low one stays.
    expect(screen.getByText("2 values")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve Award date" })).toBeNull();
    expect(screen.getByRole("button", { name: "Approve Telephone" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Undo/ })).toHaveLength(1);

    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS);
    });
    expect(documents.reviewMetadataFieldById).toHaveBeenCalledTimes(2);
    expect(documents.reviewMetadataFieldById).toHaveBeenCalledWith("d1", 1, "accept", "R");
    expect(documents.reviewMetadataFieldById).toHaveBeenCalledWith("d1", 2, "accept", "R");
    expect(onDecided).toHaveBeenCalledTimes(2);
  });

  it("undo restores a whole rejected batch", async () => {
    render(<FieldReviewList items={items} reviewer="R" issueLabel={(i) => i.reason_labels[0]} onDecided={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select PIID" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Telephone" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject selected" }));
    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));
    await act(async () => {
      vi.advanceTimersByTime(UNDO_WINDOW_MS * 2);
    });
    expect(documents.reviewMetadataFieldById).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Reject PIID" })).toBeInTheDocument();
    // The batch actions show only while something is selected.
    expect(screen.queryByRole("button", { name: "Approve selected" })).toBeNull();
  });
});
