import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ReviewFieldList from "@/components/review-field-list";
import type { MetadataField } from "@/types/document";

function field(overrides: Partial<MetadataField> = {}): MetadataField {
  return {
    id: 101,
    field_group: "Legal",
    field_key: "governing_law",
    label: "Governing Law",
    value: "State of Delaware",
    confidence: 0.9,
    extraction_method: "label_value",
    extraction_source: "contract",
    evidence: {
      page_number: 1,
      source_text: "Governing Law: State of Delaware",
      source_reference: "page 1",
    },
    verified: false,
    review_status: "pending",
    original_value: "State of Delaware",
    extracted_value: "State of Delaware",
    ...overrides,
  };
}

describe("ReviewFieldList RC2-05B", () => {
  it("shows extracted vs effective values and Metadata status labels", () => {
    render(
      <ReviewFieldList
        documentId="d1"
        fields={[
          field({
            review_status: "edited",
            value: "New York",
            extracted_value: "State of Delaware",
            original_value: "State of Delaware",
          }),
        ]}
        activeFieldId={null}
        onSelectField={vi.fn()}
        onReviewField={vi.fn()}
        onAcceptAll={vi.fn()}
        reviewingFieldId={null}
        acceptingAll={false}
      />,
    );

    expect(screen.getByTestId("metadata-review-list").textContent).toMatch(/Metadata review/);
    expect(screen.getByText("State of Delaware")).toBeTruthy();
    expect(screen.getByText("New York")).toBeTruthy();
    expect(screen.getByText("Metadata Edited")).toBeTruthy();
    expect(screen.getByText(/not the same as Staging Verified/i)).toBeTruthy();
  });

  it("renders duplicate field_keys as distinct rows with extraction source", () => {
    render(
      <ReviewFieldList
        documentId="d1"
        fields={[
          field({ id: 11, value: "Delaware", extraction_source: "contract" }),
          field({
            id: 12,
            value: "New York",
            extraction_source: "v3",
            extracted_value: "New York",
            original_value: "New York",
          }),
        ]}
        activeFieldId={12}
        onSelectField={vi.fn()}
        onReviewField={vi.fn()}
        onAcceptAll={vi.fn()}
        reviewingFieldId={null}
        acceptingAll={false}
      />,
    );

    expect(screen.getByText(/Contract analysis/i)).toBeTruthy();
    expect(screen.getByText(/All fields \(V3\)/i)).toBeTruthy();
    expect(screen.getByText("Delaware")).toBeTruthy();
    expect(screen.getAllByText("New York").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Governing Law")).toHaveLength(2);
    expect(screen.getByText(/· #11/)).toBeTruthy();
    expect(screen.getByText(/· #12/)).toBeTruthy();
  });

  it("accept targets the exact MetadataField object (by id)", async () => {
    const onReview = vi.fn(async () => undefined);
    const target = field({
      id: 55,
      evidence: { page_number: 0, source_text: "", source_reference: "" },
    });
    render(
      <ReviewFieldList
        documentId="d1"
        fields={[target]}
        activeFieldId={null}
        onSelectField={vi.fn()}
        onReviewField={onReview}
        onAcceptAll={vi.fn()}
        reviewingFieldId={null}
        acceptingAll={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(onReview).toHaveBeenCalledWith(target, "accept"));

    fireEvent.click(screen.getByRole("button", { name: "Field actions" }));
    fireEvent.click(screen.getByRole("button", { name: "View Source" }));
    expect(screen.getByText(/Source evidence is unavailable/i)).toBeTruthy();
  });

  it("supports edit with validation and keyboard save", async () => {
    const onReview = vi.fn(async () => undefined);
    const target = field();
    render(
      <ReviewFieldList
        documentId="d1"
        fields={[target]}
        activeFieldId={null}
        onSelectField={vi.fn()}
        onReviewField={onReview}
        onAcceptAll={vi.fn()}
        reviewingFieldId={null}
        acceptingAll={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Field actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const input = screen.getByLabelText("Corrected value for Governing Law");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(/corrected value is required/i)).toBeTruthy();

    fireEvent.change(input, { target: { value: "California" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(onReview).toHaveBeenCalledWith(target, "edit", "California"),
    );
  });

  it("rejects from the actions menu by field identity", async () => {
    const onReview = vi.fn(async () => undefined);
    const target = field({ id: 77 });
    render(
      <ReviewFieldList
        documentId="d1"
        fields={[target]}
        activeFieldId={null}
        onSelectField={vi.fn()}
        onReviewField={onReview}
        onAcceptAll={vi.fn()}
        reviewingFieldId={null}
        acceptingAll={false}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Field actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(onReview).toHaveBeenCalledWith(target, "reject"));
  });
});
