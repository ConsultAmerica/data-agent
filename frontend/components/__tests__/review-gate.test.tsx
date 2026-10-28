import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ReviewFieldList from "@/components/review-field-list";
import { resetReviewGateCache } from "@/lib/review-gate";
import type { MetadataField } from "@/types/document";

const field: MetadataField = {
  id: 7,
  field_group: "Legal",
  field_key: "governing_law",
  label: "Governing Law",
  value: "Delaware",
  confidence: 0.95,
  extraction_method: "label_value",
  extraction_source: "contract",
  evidence: { page_number: 1, source_text: "Governing Law: Delaware", source_reference: "page 1" },
  verified: true,
  review_status: "pending",
  original_value: "Delaware",
  extracted_value: "Delaware",
};

function renderList() {
  return render(
    <ReviewFieldList
      documentId="d1"
      fields={[field]}
      activeFieldId={null}
      onSelectField={vi.fn()}
      onReviewField={vi.fn()}
      onAcceptAll={vi.fn()}
      reviewingFieldId={null}
      acceptingAll={false}
    />,
  );
}

function stubReady(enabled: boolean) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ metadata_review_mutations_enabled: enabled }))),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetReviewGateCache();
});

describe("review gate in the UI", () => {
  it("disables review actions and explains why when the backend gate is closed", async () => {
    stubReady(false);
    renderList();
    expect(await screen.findByTestId("review-read-only")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Accept low-risk pending/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: /^Accept$/ })).toBeDisabled();
    });
  });

  it("leaves review actions enabled when the gate is open", async () => {
    stubReady(true);
    renderList();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByTestId("review-read-only")).toBeNull();
    expect(screen.getByRole("button", { name: /^Accept$/ })).not.toBeDisabled();
  });
});
