import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ConfidenceReviewSection from "@/components/marketing/confidence-review-section";
import PlaybookPreview from "@/components/marketing/playbook-preview";
import { buildPayload, payloadXml } from "@/components/sample/payload-inspector";

describe("ConfidenceReviewSection band filter", () => {
  it("previews the sample values in the picked band", () => {
    render(<ConfidenceReviewSection />);
    // Low is selected first: the sample's routed values.
    const summary = () => screen.getByText(/sample values are/).textContent;
    expect(summary()).toBe("3 of 20 sample values are low; 3 go to the review queue.");
    fireEvent.click(screen.getByRole("button", { name: /High/ }));
    expect(screen.getByRole("button", { name: /High/ }).getAttribute("aria-pressed")).toBe("true");
    expect(summary()).toMatch(/of 20 sample values are high; none are routed to review\./);
    expect(screen.getByText(/CONTRACT NUMBER · W91ZZZ26C0042/)).toBeTruthy();
  });

  it("shows an example audit entry with before and after", () => {
    render(<ConfidenceReviewSection />);
    expect(screen.getByText("What one audit entry records")).toBeTruthy();
    expect(screen.getByText(/→ Sample Contracting Activity/)).toBeTruthy();
  });
});

describe("PlaybookPreview", () => {
  it("checks starter rules against the sample's cited clauses", () => {
    render(<PlaybookPreview />);
    expect(screen.getByText("Present: satisfied")).toBeTruthy(); // 52.204-21
    expect(screen.getByText("Missing: deviation")).toBeTruthy(); // 252.204-7019
  });

  it("adds a prohibited rule and flags it when the clause is cited", () => {
    render(<PlaybookPreview />);
    fireEvent.change(screen.getByLabelText("Clause number"), { target: { value: "DFARS 252.232-7003" } });
    fireEvent.change(screen.getByLabelText("Expectation"), { target: { value: "prohibited" } });
    fireEvent.click(screen.getByRole("button", { name: /Add rule/ }));
    expect(screen.getByText("Present: deviation")).toBeTruthy();
  });

  it("rejects a value that isn't a clause number", () => {
    render(<PlaybookPreview />);
    fireEvent.change(screen.getByLabelText("Clause number"), { target: { value: "cyber" } });
    fireEvent.click(screen.getByRole("button", { name: /Add rule/ }));
    expect(screen.getByText(/Enter a FAR or DFARS clause number/)).toBeTruthy();
  });
});

describe("staging payload", () => {
  const fields = [
    { id: "a", label: "CONTRACT NUMBER", value: "W91", confidence: 0.85, page: 1, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 }, status: "accepted" as const },
    { id: "b", label: "ISSUED BY", value: null, confidence: 0.5, page: 1, bbox: null, status: "pending" as const },
    { id: "c", label: "SIGNATURE", value: "x", confidence: 0.35, page: 1, bbox: null, status: "rejected" as const },
  ];

  it("stages only reviewed values and explains every skip", () => {
    const payload = buildPayload("sample.pdf", fields);
    expect(payload.staged.map((field) => field.field_id)).toEqual(["a"]);
    expect(payload.staged[0].source).toEqual({ page: 1, bbox: [1, 2, 3, 4] });
    expect(payload.skipped).toEqual([
      { field_id: "b", label: "ISSUED BY", reason: "awaiting reviewer decision" },
      { field_id: "c", label: "SIGNATURE", reason: "rejected by reviewer" },
    ]);
  });

  it("escapes XML", () => {
    const xml = payloadXml(buildPayload("a&b.pdf", [{ ...fields[0], value: "<W91>" }]));
    expect(xml).toContain('document="a&amp;b.pdf"');
    expect(xml).toContain("<Value>&lt;W91&gt;</Value>");
  });
});
