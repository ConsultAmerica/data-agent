import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AskResponse } from "@/lib/ask";
import type { DocumentSummary } from "@/types/document";

const mocks = vi.hoisted(() => ({
  askQuestion: vi.fn(),
  searchDocuments: vi.fn(),
  listSavedQueries: vi.fn(),
  listIngestedClauses: vi.fn(),
  getPortfolio: vi.fn(),
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/ask", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ask")>()),
  askQuestion: mocks.askQuestion,
}));
vi.mock("@/lib/documents", () => ({ searchDocuments: mocks.searchDocuments }));
vi.mock("@/lib/portfolio", () => ({ getPortfolio: mocks.getPortfolio }));
vi.mock("@/lib/playbook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/playbook")>()),
  listSavedQueries: mocks.listSavedQueries,
  listIngestedClauses: mocks.listIngestedClauses,
}));
vi.mock("@/components/playbook/save-query-button", () => ({
  default: ({ query }: { query: string }) => <span data-testid="save-query">{query}</span>,
}));
vi.mock("@/components/layout/PageHero", () => ({
  default: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

import ClausesPage from "../page";

const response: AskResponse = {
  question: "",
  scope: { document_id: null, document_name: null, document_count: 2 },
  answer: "252.204-7012 is cited in contract-a [1].",
  answer_type: "clauses",
  facts: [],
  clause_matches: [
    {
      document_id: "a",
      document_name: "contract-a.pdf",
      clause_number: "252.204-7012",
      title: null,
      present: true,
      page: 11,
      citation: 1,
    },
  ],
  obligations: [],
  passages: [],
  citations: [
    { n: 1, document_id: "a", document_name: "contract-a.pdf", page: 11, snippet: "252.204-7012 Safeguarding", href: "/documents/a?page=11" },
  ],
  documents: [{ document_id: "a", document_name: "contract-a.pdf", hits: 1 }],
  suggestions: [],
  engine: "grounded",
};

const doc = {
  document_id: "a",
  original_filename: "contract-a.pdf",
  document_type: "Government Contract",
  status: "ready",
  confidence: 0.9,
  uploaded_at: "2026-10-01",
  page_count: 20,
  fields_extracted: 10,
  last_updated: "2026-10-01",
} as unknown as DocumentSummary;

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.getPortfolio.mockResolvedValue({ clauses: { top: [] } });
  mocks.listSavedQueries.mockResolvedValue([]);
  mocks.listIngestedClauses.mockResolvedValue([]);
  mocks.askQuestion.mockResolvedValue(response);
  mocks.searchDocuments.mockResolvedValue({ documents: [doc], total: 1 });
});

describe("FAR / DFARS page", () => {
  it("runs a preset through the grounded Ask engine and lists cited contracts", async () => {
    render(<ClausesPage />);
    expect(
      screen.getByPlaceholderText(
        "Ask FAR/DFARS or check cross-references (e.g. 'Which contracts include DFARS 252.204-7012?')",
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "CMMC cybersecurity requirements" }));

    await waitFor(() =>
      expect(mocks.askQuestion).toHaveBeenCalledWith(
        "Which contracts include DFARS 252.204-7012, 252.204-7019, 252.204-7020 or 252.204-7021?",
      ),
    );
    // Clause numbers are searched individually; a whole question rarely matches document text.
    expect(mocks.searchDocuments.mock.calls.map(([params]) => params.q)).toEqual([
      "252.204-7012",
      "252.204-7019",
      "252.204-7020",
      "252.204-7021",
    ]);
    expect((await screen.findByTestId("ask-answer-text")).textContent).toContain("252.204-7012 is cited");
    const pill = await screen.findByTestId("clause-cite-pill");
    expect(pill.getAttribute("href")).toBe("/documents/a?page=11");
    // The same document from several searches is listed once.
    expect(screen.getAllByText("contract-a")).toHaveLength(1);
    expect(screen.getByTestId("save-query").textContent).toContain("252.204-7021");
  });

  it("keeps the documents when the answer fails, and shows the comparator empty state", async () => {
    mocks.askQuestion.mockRejectedValue(new Error("Ask engine unavailable"));
    render(<ClausesPage />);
    fireEvent.change(screen.getByLabelText("Ask FAR/DFARS or check cross-references"), {
      target: { value: "liquidated damages" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("Ask engine unavailable")).toBeTruthy();
    expect(await screen.findByText("contract-a")).toBeTruthy();
    expect(mocks.searchDocuments).toHaveBeenCalledWith({ q: "liquidated damages", limit: 30 });
    expect(await screen.findByText("No FAR or DFARS regulation text ingested yet")).toBeTruthy();
  });
});
