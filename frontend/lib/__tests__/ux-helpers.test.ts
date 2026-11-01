import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

import type { AskResponse } from "@/lib/ask";
import { citationsByDocument } from "@/lib/clause-citations";
import { isLowRiskQueueField } from "@/lib/documents";
import { fieldToneClass, toneFromConfidence, toneFromStagingCell } from "@/lib/field-tone";
import { buildOracleChecklist, checklistPasses } from "@/lib/oracle-checklist";
import type { OraclePayloadPreview } from "@/lib/reviewed-export";
import type { StagingCell } from "@/lib/staging-workbook";
import type { ReviewQueueFieldItem } from "@/types/document";

function cell(overrides: Partial<StagingCell>): StagingCell {
  return {
    canonical_field: "contract.contract_number",
    display_label: "Contract number",
    value: "W912-24-C-0001",
    raw_value: null,
    value_type: "text",
    provenance: null,
    validation: { status: "passed", checks: [] },
    review_status: "Verified",
    review_reasons: [],
    ...overrides,
  };
}

describe("field tone", () => {
  it("bands confidence and lets a failed validation win", () => {
    expect(toneFromConfidence(0.9)).toBe("ok");
    expect(toneFromConfidence(70)).toBe("review");
    expect(toneFromConfidence(0.3)).toBe("failed");
    expect(toneFromConfidence(0.99, "high", true)).toBe("failed");
    expect(toneFromConfidence(null, "medium")).toBe("review");
    expect(toneFromConfidence(null)).toBeNull();
  });

  it("reads staging QA status, never tones empty values", () => {
    expect(toneFromStagingCell(cell({}))).toBe("ok");
    expect(toneFromStagingCell(cell({ review_status: "Needs Review" }))).toBe("review");
    expect(toneFromStagingCell(cell({ validation: { status: "failed", checks: [] } }))).toBe("failed");
    expect(toneFromStagingCell(cell({ value: null, review_status: "Missing" }))).toBeNull();
    expect(fieldToneClass("review", "cell")).toBe("field-tone field-tone-review field-tone-cell");
    expect(fieldToneClass(null)).toBe("");
  });
});

describe("isLowRiskQueueField", () => {
  const base = {
    reasons: [],
    decision_status: "ready",
    confidence: 0.9,
  } as unknown as ReviewQueueFieldItem;

  it("accepts only unflagged high-confidence values", () => {
    expect(isLowRiskQueueField(base)).toBe(true);
    expect(isLowRiskQueueField({ ...base, confidence: 91 })).toBe(true);
    expect(isLowRiskQueueField({ ...base, confidence: 0.8 })).toBe(false);
    expect(isLowRiskQueueField({ ...base, reasons: ["low_confidence"] })).toBe(false);
    expect(isLowRiskQueueField({ ...base, decision_status: "needs_review" })).toBe(false);
  });
});

describe("Oracle pre-send checklist", () => {
  const preview = {
    contract_header: {
      contract_number: "C-1",
      contractor_name: "Acme",
      award_date: "2026-01-01",
      v3_amount: "10.00",
    },
    authoritative_count: 4,
    skipped_count: 0,
    ready_to_send: true,
    actor: { can_send: true },
  } as unknown as OraclePayloadPreview;

  it("passes with alias header keys and fails on a missing one", () => {
    expect(checklistPasses(buildOracleChecklist(preview))).toBe(true);
    const missing = buildOracleChecklist({ ...preview, contract_header: { contract_number: "C-1" } });
    expect(missing.filter((item) => !item.passed).map((item) => item.id)).toEqual(["counterparty", "date", "amount"]);
    const noRole = buildOracleChecklist({ ...preview, actor: { can_send: false } });
    expect(noRole.find((item) => item.id === "role")?.passed).toBe(false);
  });

  it("says once why a document Oracle Procurement can't take is blocked, without header checks", () => {
    const reason = "This is FAR regulation text, not a contract, invoice or purchase order.";
    const items = buildOracleChecklist({ ...preview, oracle_scope: { applicable: false, family: "far_regulation", reason } });
    expect(items.map((item) => item.id)).toEqual(["role", "scope"]);
    expect(items.find((item) => item.id === "scope")).toMatchObject({ passed: false, detail: reason });
    expect(items.some((item) => item.group === "metadata")).toBe(false);
    expect(checklistPasses(items)).toBe(false);
  });
});

describe("citationsByDocument", () => {
  it("prefers the matched clause citation, then the first passage per document", () => {
    const response = {
      clause_matches: [
        { document_id: "a", clause_number: "252.204-7012", present: true, citation: 1 },
        { document_id: "b", clause_number: "252.204-7012", present: false, citation: null },
      ],
      passages: [
        { document_id: "a", citation: 2 },
        { document_id: "c", citation: 3 },
      ],
      citations: [
        { n: 1, document_id: "a", document_name: "a.pdf", page: 11, snippet: "252.204-7012 Safeguarding", href: "/documents/a?page=11" },
        { n: 2, document_id: "a", document_name: "a.pdf", page: 3, snippet: "other", href: "/documents/a?page=3" },
        { n: 3, document_id: "c", document_name: "c.pdf", page: 7, snippet: "cyber", href: "/documents/c?page=7" },
      ],
    } as unknown as AskResponse;
    const result = citationsByDocument(response);
    expect(result.get("a")).toEqual({ page: 11, href: "/documents/a?page=11", snippet: "252.204-7012 Safeguarding", clause: "252.204-7012" });
    expect(result.has("b")).toBe(false);
    expect(result.get("c")?.page).toBe(7);
  });
});
