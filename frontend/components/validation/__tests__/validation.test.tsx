import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentValidation, ValidationPortfolio, ValidationRule } from "@/lib/validation-rules";

const api = vi.hoisted(() => ({
  getDocumentValidation: vi.fn(),
  listValidationRules: vi.fn(),
  getValidationPortfolio: vi.fn(),
  createValidationRule: vi.fn(),
  updateValidationRule: vi.fn(),
  deleteValidationRule: vi.fn(),
  resetValidationRule: vi.fn(),
  testValidationRule: vi.fn(),
}));
const documents = vi.hoisted(() => ({ listDocuments: vi.fn() }));

vi.mock("@/lib/validation-rules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/validation-rules")>()),
  ...api,
}));
vi.mock("@/lib/documents", () => documents);
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import DocumentValidationPanel from "../document-validation-panel";
import ValidationRulesSection from "@/components/playbook/validation-rules-section";

const summary = { fail: 1, missing: 1, pass: 1, not_applicable: 0, high: 1, medium: 0, low: 0 };

function evaluation(overrides: Partial<DocumentValidation> = {}): DocumentValidation {
  return {
    document_id: "d1",
    applicable: true,
    summary,
    results: [
      {
        rule_id: "r1", name: "Funding gap over $10,000", rule_type: "funding_gap", severity: "high", status: "fail",
        detail: "Priced total $1,000,000.00 vs funded $975,000.00: gap $25,000.00, over the $10,000.00 limit.",
        value: "$25,000.00", page: null,
      },
      {
        rule_id: "r2", name: "UEI is 12 characters", rule_type: "regex", severity: "medium", status: "missing",
        detail: "Unique Entity ID (UEI) was not found in the extracted data, so it could not be checked.",
        value: null, page: null,
      },
      {
        rule_id: "r3", name: "Contracting Officer is named", rule_type: "required_field", severity: "low", status: "pass",
        detail: "Contracting Officer is present.", value: "DORIS CASTRO", page: 2,
      },
    ],
    ...overrides,
  };
}

function rule(overrides: Partial<ValidationRule> = {}): ValidationRule {
  return {
    rule_id: "template:uei-format", name: "UEI is 12 characters", rule_type: "regex",
    field_label: "Unique Entity ID (UEI)|UEI", pattern: "[A-Z0-9]{12}", threshold: null, severity: "medium",
    enabled: false, description: "", source: "template", ...overrides,
  };
}

const portfolio: ValidationPortfolio = {
  totals: { documents: 2, with_failures: 1, fail: 1, missing: 1, rules_enabled: 1 },
  documents: [
    { document_id: "d1", filename: "award.pdf", document_type: "Contract", summary, results: evaluation().results.slice(0, 2) },
  ],
};

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  documents.listDocuments.mockResolvedValue([{ document_id: "d1", original_filename: "award.pdf" }]);
});

describe("DocumentValidationPanel", () => {
  it("lists failures and misses first and collapses passed rules", async () => {
    api.getDocumentValidation.mockResolvedValue(evaluation());
    render(<DocumentValidationPanel documentId="d1" />);
    expect(await screen.findByText("1 failed")).toBeTruthy();
    expect(screen.getByText("1 missing")).toBeTruthy();
    expect(screen.getByText(/gap \$25,000\.00, over the \$10,000\.00 limit/)).toBeTruthy();
    expect(screen.getByText("1 passed or not checked")).toBeTruthy();
    expect(screen.getByRole("link", { name: "p. 2" }).getAttribute("href")).toBe("/documents/d1?view=source&page=2");
  });

  it("explains that nothing is checked until a rule is enabled", async () => {
    api.getDocumentValidation.mockResolvedValue(evaluation({ applicable: false, results: [] }));
    render(<DocumentValidationPanel documentId="d1" />);
    expect(await screen.findByText(/No validation rules are enabled/)).toBeTruthy();
  });
});

describe("ValidationRulesSection", () => {
  it("shows templates, enables one, and lists portfolio failures", async () => {
    const enabled = rule({ enabled: true, source: "override" });
    api.listValidationRules.mockResolvedValueOnce([rule()]).mockResolvedValue([enabled]);
    api.getValidationPortfolio.mockResolvedValue(portfolio);
    api.updateValidationRule.mockResolvedValue(enabled);
    render(<ValidationRulesSection />);
    expect(await screen.findByText("Unique Entity ID (UEI) matches [A-Z0-9]{12}")).toBeTruthy();
    // Nothing enabled yet: no failures are listed.
    expect(screen.getByText(/No validation rules are enabled/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable UEI is 12 characters" }));
    await waitFor(() => expect(api.updateValidationRule).toHaveBeenCalledWith("template:uei-format", { enabled: true }));
    expect(await screen.findByText("award.pdf")).toBeTruthy();
    expect(screen.getByText("Template (edited)")).toBeTruthy();
  });

  it("tests an unsaved rule against a document, then saves it", async () => {
    api.listValidationRules.mockResolvedValue([]);
    api.getValidationPortfolio.mockResolvedValue({ ...portfolio, documents: [] });
    api.testValidationRule.mockResolvedValue({
      rule_id: "preview", name: "Award cap", rule_type: "max_amount", severity: "high", status: "fail",
      detail: "Award Amount $600,000,000.00 exceeds $500,000,000.00.", value: "$600,000,000.00", page: 2,
    });
    api.createValidationRule.mockResolvedValue(rule({ rule_id: "custom:award-cap", source: "custom" }));
    render(<ValidationRulesSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Add validation rule" }));
    const form = screen.getByRole("form", { name: "Add validation rule" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Award cap" } });
    fireEvent.change(within(form).getByLabelText("Rule type"), { target: { value: "max_amount" } });
    fireEvent.change(within(form).getByLabelText(/^Field/), { target: { value: "Award Amount" } });
    fireEvent.change(within(form).getByLabelText("Maximum amount (USD)"), { target: { value: "500000000" } });
    await waitFor(() => expect(within(form).getByRole("option", { name: "award.pdf" })).toBeTruthy());
    fireEvent.change(within(form).getByLabelText("Test against document"), { target: { value: "d1" } });
    fireEvent.click(within(form).getByRole("button", { name: "Test" }));
    expect(await within(form).findByText(/exceeds \$500,000,000\.00/)).toBeTruthy();
    const [tested, documentId] = api.testValidationRule.mock.calls[0];
    expect(tested).toMatchObject({ rule_type: "max_amount", field_label: "Award Amount", threshold: 500000000, pattern: null });
    expect(documentId).toBe("d1");
    fireEvent.click(within(form).getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(api.createValidationRule).toHaveBeenCalled());
    expect(api.createValidationRule.mock.calls[0][0]).toMatchObject({ name: "Award cap", severity: "medium" });
  });

  it("keeps the form open with the server's message when a regex is rejected", async () => {
    api.listValidationRules.mockResolvedValue([]);
    api.getValidationPortfolio.mockResolvedValue({ ...portfolio, documents: [] });
    api.createValidationRule.mockRejectedValue(new Error("The pattern is not a valid regular expression: missing ]."));
    render(<ValidationRulesSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Add validation rule" }));
    const form = screen.getByRole("form", { name: "Add validation rule" });
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Bad" } });
    fireEvent.change(within(form).getByLabelText(/^Field/), { target: { value: "UEI" } });
    fireEvent.change(within(form).getByLabelText("Pattern"), { target: { value: "([A-Z" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add rule" }));
    expect(await within(form).findByText(/not a valid regular expression/)).toBeTruthy();
  });
});
