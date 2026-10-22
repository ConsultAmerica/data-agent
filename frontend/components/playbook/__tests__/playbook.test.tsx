import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentPlaybook, PlaybookPortfolio, PlaybookRule } from "@/lib/playbook";

const api = vi.hoisted(() => ({
  getDocumentPlaybook: vi.fn(),
  listPlaybookRules: vi.fn(),
  getPlaybookPortfolio: vi.fn(),
  createPlaybookRule: vi.fn(),
  updatePlaybookRule: vi.fn(),
  deletePlaybookRule: vi.fn(),
  resetPlaybookRule: vi.fn(),
  getRuleStandardText: vi.fn(),
}));

vi.mock("@/lib/playbook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/playbook")>()),
  ...api,
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Validation rules load their own data; they have their own tests.
vi.mock("@/components/playbook/validation-rules-section", () => ({ default: () => null }));

vi.mock("@/components/layout/PageHero", () => ({
  default: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

import DocumentPlaybookPanel from "../document-playbook-panel";
import PlaybookPage from "@/src/app/playbook/page";

const summary = { high: 1, medium: 0, low: 0, satisfied: 1, deviations: 1 };

function evaluation(overrides: Partial<DocumentPlaybook> = {}): DocumentPlaybook {
  return {
    document_id: "d1",
    applicable: true,
    is_dod: true,
    summary,
    findings: [
      {
        rule_id: "default:252.204-7012",
        clause_number: "252.204-7012",
        title: "Safeguarding Covered Defense Information",
        expectation: "required",
        severity: "high",
        status: "missing",
        rationale: "DoD contracts generally.",
        page: null,
        evidence: null,
      },
      {
        rule_id: "default:52.204-25",
        clause_number: "52.204-25",
        title: "Section 889",
        expectation: "required",
        severity: "high",
        status: "satisfied",
        rationale: "",
        page: 33,
        evidence: "52.204-25 cited",
      },
    ],
    ...overrides,
  };
}

const rules: PlaybookRule[] = [
  {
    rule_id: "default:52.204-21",
    clause_number: "52.204-21",
    title: "Basic Safeguarding",
    expectation: "required",
    severity: "medium",
    rationale: "",
    applies_to: "all",
    enabled: true,
    source: "default",
    category: "Cybersecurity & supply chain",
    agency: "",
    standard_text: "",
    fallback_text: "",
    extraction_patterns: [],
  },
  {
    rule_id: "default:52.217-9",
    clause_number: "52.217-9",
    title: "Option to Extend the Term",
    expectation: "review",
    severity: "medium",
    rationale: "",
    applies_to: "all",
    enabled: false,
    source: "override",
    category: "Options & contract term",
    agency: "",
    standard_text: "",
    fallback_text: "",
    extraction_patterns: [],
  },
  {
    rule_id: "custom:252.225-7048",
    clause_number: "252.225-7048",
    title: "Export-Controlled Items",
    expectation: "prohibited",
    severity: "high",
    rationale: "",
    applies_to: "dod",
    enabled: true,
    source: "custom",
    category: "",
    agency: "Navy",
    standard_text: "",
    fallback_text: "",
    extraction_patterns: [],
  },
];

const portfolio: PlaybookPortfolio = {
  totals: { documents: 1, with_deviations: 1, high: 1, medium: 0, low: 0 },
  documents: [
    {
      document_id: "d1",
      filename: "contract.pdf",
      document_type: "Government Contract",
      is_dod: true,
      summary,
      findings: [evaluation().findings[0]],
    },
  ],
};

beforeEach(() => {
  Object.values(api).forEach((mock) => mock.mockReset());
});

describe("DocumentPlaybookPanel", () => {
  it("lists deviations first and collapses satisfied rules", async () => {
    api.getDocumentPlaybook.mockResolvedValue(evaluation());
    render(<DocumentPlaybookPanel documentId="d1" />);
    expect(await screen.findByText("Required clause missing")).toBeTruthy();
    expect(screen.getByText(/DoD rules apply/)).toBeTruthy();
    expect(screen.getByText("1 satisfied rule")).toBeTruthy();
    expect(api.getDocumentPlaybook).toHaveBeenCalledWith("d1");
  });

  it("says not applicable when no clauses were detected", async () => {
    api.getDocumentPlaybook.mockResolvedValue(evaluation({ applicable: false, findings: [] }));
    render(<DocumentPlaybookPanel documentId="d1" />);
    expect(await screen.findByText(/Not applicable — no clauses detected/)).toBeTruthy();
  });
});

describe("PlaybookPage", () => {
  beforeEach(() => {
    api.listPlaybookRules.mockResolvedValue(rules);
    api.getPlaybookPortfolio.mockResolvedValue(portfolio);
    api.getRuleStandardText.mockResolvedValue({
      rule_id: "default:52.204-21",
      clause_number: "52.204-21",
      ingested: null,
      versions: [],
      custom_text: null,
    });
  });

  it("shows the clause library, inspector and portfolio deviations", async () => {
    render(<PlaybookPage />);
    expect(await screen.findByText("contract.pdf")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Clause Playbook & Compliance Rules" })).toBeTruthy();
    const index = screen.getByRole("navigation", { name: "Clause index" });
    expect(within(index).getByText("Cybersecurity & supply chain")).toBeTruthy();
    expect(within(index).getByText("Uncategorized")).toBeTruthy();
    expect(within(index).getByText("Mandatory")).toBeTruthy();
    expect(within(index).getByText("Conditional")).toBeTruthy();
    expect(within(index).getByText("Prohibited")).toBeTruthy();
    // The first rule is inspected by default; no ingested text → honest empty state.
    const inspector = screen.getByRole("region", { name: "Clause rule inspector" });
    expect(within(inspector).getByRole("heading", { name: /FAR 52\.204-21 — Basic Safeguarding/ })).toBeTruthy();
    expect(within(inspector).getByText("Medium liability")).toBeTruthy();
    expect(await within(inspector).findByText("Ingest FAR Part 52 / the DFARS XML to see verbatim text")).toBeTruthy();
    expect(api.getRuleStandardText).toHaveBeenCalledWith("default:52.204-21");
  });

  it("shows verbatim text only from an ingested record", async () => {
    api.getRuleStandardText.mockResolvedValue({
      rule_id: "default:52.204-21",
      clause_number: "52.204-21",
      ingested: {
        clause_number: "52.204-21",
        clause_key: "FAR-52.204-21",
        title: "Basic Safeguarding",
        clause_type: "Clause",
        version_date: "(Nov 2021)",
        prescription: null,
        document_id: "far1",
        filename: "far-part-52.html",
        source_text: "(a) Definitions. As used in this clause—",
      },
      versions: [
        { clause_number: "52.204-21", clause_key: "k", title: "", clause_type: null, version_date: "(Nov 2021)", prescription: null, document_id: "far1", filename: "a" },
        { clause_number: "52.204-21", clause_key: "k", title: "", clause_type: null, version_date: "(Jun 2016)", prescription: null, document_id: "far0", filename: "b" },
      ],
      custom_text: null,
    });
    render(<PlaybookPage />);
    expect((await screen.findByTestId("rule-verbatim-text")).textContent).toContain("(a) Definitions.");
    expect(screen.getByText(/Source: far-part-52.html/).closest("a")?.getAttribute("href")).toBe("/documents/far1");
    expect(screen.getByRole("link", { name: "Compare versions" }).getAttribute("href")).toBe(
      "/clauses/compare?clause=52.204-21",
    );
  });

  it("filters the index by DFARS, custom rules and search", async () => {
    render(<PlaybookPage />);
    await screen.findByText("contract.pdf");
    const index = () => screen.getByRole("navigation", { name: "Clause index" });
    fireEvent.click(screen.getByRole("button", { name: /DFARS clauses \(252\.\*\)/ }));
    expect(within(index()).getByText("252.225-7048")).toBeTruthy();
    expect(within(index()).queryByText("52.204-21")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Custom corporate playbook/ }));
    expect(within(index()).getByText("52.217-9")).toBeTruthy();
    expect(within(index()).queryByText("52.204-21")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search clauses and rules"), { target: { value: "export" } });
    expect(within(index()).getByText("252.225-7048")).toBeTruthy();
    expect(within(index()).queryByText("52.217-9")).toBeNull();
  });

  it("toggles a rule and resets an override", async () => {
    api.updatePlaybookRule.mockResolvedValue({ ...rules[0], enabled: false, source: "override" });
    api.resetPlaybookRule.mockResolvedValue(rules[1]);
    render(<PlaybookPage />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Disable 52.204-21" }));
    await waitFor(() => expect(api.updatePlaybookRule).toHaveBeenCalledWith("default:52.204-21", { enabled: false }));
    fireEvent.click(screen.getByText("52.217-9"));
    fireEvent.click(await screen.findByRole("button", { name: "Reset" }));
    await waitFor(() => expect(api.resetPlaybookRule).toHaveBeenCalledWith("default:52.217-9"));
  });

  it("adds a custom rule from the form", async () => {
    api.createPlaybookRule.mockResolvedValue({ ...rules[0], rule_id: "custom:x", source: "custom" });
    render(<PlaybookPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Add new clause / rule" }));
    const form = screen.getByRole("form", { name: "Add rule" });
    fireEvent.change(within(form).getByPlaceholderText("52.204-21"), { target: { value: "52.219-9" } });
    fireEvent.change(within(form).getByPlaceholderText("e.g. Navy, DLA"), { target: { value: "Navy" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add rule" }));
    await waitFor(() =>
      expect(api.createPlaybookRule).toHaveBeenCalledWith(
        expect.objectContaining({ clause_number: "52.219-9", expectation: "required", severity: "medium", agency: "Navy" }),
      ),
    );
  });

  it("validates extraction patterns live and saves them", async () => {
    api.updatePlaybookRule.mockResolvedValue({ ...rules[0], source: "override" });
    render(<PlaybookPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "AI extraction rules" }));
    fireEvent.click(screen.getByRole("button", { name: "Add pattern" }));
    fireEvent.change(screen.getByLabelText("Pattern 1 kind"), { target: { value: "regex" } });
    fireEvent.change(screen.getByLabelText("Pattern 1"), { target: { value: "safeguard(ing" } });
    expect(screen.getByRole("alert").textContent).toMatch(/Not a valid regular expression/);
    const save = screen.getByRole("button", { name: "Save patterns" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Pattern 1"), { target: { value: "safeguarding\\s+of" } });
    expect(screen.getByText("Valid regular expression.")).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/Paste a passage/), { target: { value: "Basic Safeguarding  of systems" } });
    expect(screen.getByText("Matches the sample.")).toBeTruthy();
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.updatePlaybookRule).toHaveBeenCalledWith("default:52.204-21", {
        extraction_patterns: [{ kind: "regex", pattern: "safeguarding\\s+of", note: "" }],
      }),
    );
  });

  it("edits the corporate fallback language", async () => {
    api.updatePlaybookRule.mockResolvedValue({ ...rules[0], source: "override" });
    render(<PlaybookPage />);
    fireEvent.click(await screen.findByRole("tab", { name: "Corporate fallback / acceptable deviations" }));
    fireEvent.click(screen.getByRole("button", { name: /Add corporate fallback/ }));
    fireEvent.change(screen.getByLabelText("Corporate fallback / acceptable deviation language"), {
      target: { value: "Accept the FAR text unmodified." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.updatePlaybookRule).toHaveBeenCalledWith("default:52.204-21", {
        fallback_text: "Accept the FAR text unmodified.",
      }),
    );
  });
});
