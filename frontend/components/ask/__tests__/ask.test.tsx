import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import AskWorkspace from "@/components/ask/ask-workspace";
import { askQuestion, splitCitations, type AskResponse } from "@/lib/ask";
import { listDocuments } from "@/lib/documents";
import { createSavedQuery, listSavedQueries } from "@/lib/playbook";
import type { DocumentSummary } from "@/types/document";

const replace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => searchParams,
}));
vi.mock("@/lib/documents", () => ({ listDocuments: vi.fn() }));
vi.mock("@/lib/playbook", () => ({ listSavedQueries: vi.fn(), createSavedQuery: vi.fn() }));
vi.mock("@/lib/ask", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ask")>();
  return { ...actual, askQuestion: vi.fn() };
});

function doc(id: string, name: string): DocumentSummary {
  return { document_id: id, original_filename: name } as DocumentSummary;
}

const RESPONSE: AskResponse = {
  question: "Who is the contractor?",
  scope: { document_id: null, document_name: null, document_count: 2 },
  answer: "The contractor is CHUGACH CONSOLIDATED SOLUTIONS, LLC [1]. The contract cites DFARS 252.204-7012 [2].",
  answer_type: "fields",
  facts: [
    {
      document_id: "c1",
      document_name: "award.pdf",
      label: "Contractor",
      value: "CHUGACH CONSOLIDATED SOLUTIONS, LLC",
      page: 2,
      citation: 1,
    },
  ],
  clause_matches: [
    {
      document_id: "c1",
      document_name: "award.pdf",
      clause_number: "252.204-7012",
      title: "Safeguarding Covered Defense Information",
      present: true,
      page: 11,
      citation: 2,
    },
    {
      document_id: "c2",
      document_name: "other.pdf",
      clause_number: "252.204-7012",
      title: null,
      present: false,
      page: null,
      citation: null,
    },
  ],
  obligations: [],
  passages: [
    {
      document_id: "c1",
      document_name: "award.pdf",
      page: 2,
      text: "The contractor shall perform the work.",
      score: 3.2,
      citation: 1,
    },
  ],
  citations: [
    {
      n: 1,
      document_id: "c1",
      document_name: "award.pdf",
      page: 2,
      snippet: "Contractor: CHUGACH CONSOLIDATED SOLUTIONS, LLC",
      href: "/documents/c1?view=source&page=2&hl=CHUGACH",
    },
    {
      n: 2,
      document_id: "c1",
      document_name: "award.pdf",
      page: 11,
      snippet: "252.204-7012 Safeguarding Covered Defense Information",
      href: "/documents/c1?view=source&page=11&hl=252.204-7012",
    },
  ],
  documents: [{ document_id: "c1", document_name: "award.pdf", hits: 3 }],
  suggestions: ["What is the award amount?"],
  engine: "grounded-retrieval",
};

beforeEach(() => {
  searchParams = new URLSearchParams();
  replace.mockReset();
  vi.mocked(askQuestion).mockReset();
  vi.mocked(listDocuments).mockResolvedValue([doc("c1", "award.pdf"), doc("c2", "other.pdf")]);
  vi.mocked(listSavedQueries).mockResolvedValue([]);
  vi.mocked(createSavedQuery).mockReset();
});

async function submit(question: string) {
  fireEvent.change(screen.getByLabelText("Question"), { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
}

describe("splitCitations", () => {
  it("separates text from citation markers", () => {
    expect(splitCitations("A [1][2] b.")).toEqual([
      { kind: "text", text: "A " },
      { kind: "cite", n: 1 },
      { kind: "cite", n: 2 },
      { kind: "text", text: " b." },
    ]);
  });
});

describe("AskWorkspace", () => {
  it("renders the answer with clickable citation chips that highlight the citation", async () => {
    vi.mocked(askQuestion).mockResolvedValue(RESPONSE);
    render(<AskWorkspace />);
    await submit("Who is the contractor?");

    const answer = await screen.findByTestId("ask-answer-text");
    expect(answer.textContent).toContain("CHUGACH CONSOLIDATED SOLUTIONS");
    // The pill links straight to the cited page and highlights its citation.
    const chip = within(answer).getByRole("link", { name: /^Citation 2:/ });
    expect(chip.getAttribute("href")).toBe("/documents/c1?view=source&page=11&hl=252.204-7012");
    expect(chip.textContent).toContain("p.11");
    fireEvent.mouseEnter(chip);
    const rows = screen.getAllByTestId("ask-citation");
    expect(rows[1].getAttribute("data-active")).toBe("true");
    expect(rows[0].getAttribute("data-active")).toBeNull();
    expect(within(rows[1]).getByRole("link", { name: /Open page/ }).getAttribute("href")).toBe(
      "/documents/c1?view=source&page=11&hl=252.204-7012",
    );
  });

  it("renders facts, clause matches and passages", async () => {
    vi.mocked(askQuestion).mockResolvedValue(RESPONSE);
    render(<AskWorkspace />);
    await submit("Who is the contractor?");

    await screen.findByTestId("ask-answer");
    expect(screen.getByText("Facts")).toBeTruthy();
    expect(screen.getByText("Clause matches")).toBeTruthy();
    expect(screen.getByText("Present")).toBeTruthy();
    expect(screen.getByText("Not found")).toBeTruthy();
    const passage = screen.getByTestId("ask-passage");
    expect(within(passage).getByText("contractor", { selector: "strong" })).toBeTruthy();
    expect(screen.getByTestId("ask-footer").textContent).toContain("Grounded in 1 document");
  });

  it("submits a prompt chip as a question", async () => {
    vi.mocked(askQuestion).mockResolvedValue(RESPONSE);
    render(<AskWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "List DFARS clauses" }));
    await screen.findByTestId("ask-answer");
    expect(askQuestion).toHaveBeenCalledWith("List DFARS clauses", null);
    expect(replace).toHaveBeenCalledWith("/ask?q=List+DFARS+clauses");
  });

  it("passes the selected document as the scope", async () => {
    vi.mocked(askQuestion).mockResolvedValue(RESPONSE);
    render(<AskWorkspace />);
    await screen.findByRole("option", { name: "other.pdf" });
    fireEvent.change(screen.getByLabelText("Question scope"), { target: { value: "c2" } });
    await submit("When does the period of performance end?");
    await screen.findByTestId("ask-answer");
    expect(askQuestion).toHaveBeenCalledWith("When does the period of performance end?", "c2");
  });

  it("auto-runs ?q= with the ?document_id= scope", async () => {
    searchParams = new URLSearchParams("q=List%20DFARS%20clauses&document_id=c1");
    vi.mocked(askQuestion).mockResolvedValue(RESPONSE);
    render(<AskWorkspace />);
    await screen.findByTestId("ask-answer");
    expect(askQuestion).toHaveBeenCalledTimes(1);
    expect(askQuestion).toHaveBeenCalledWith("List DFARS clauses", "c1");
  });

  it("shows an error with Retry that re-asks the same question", async () => {
    vi.mocked(askQuestion).mockRejectedValueOnce(new Error("Backend unreachable")).mockResolvedValueOnce(RESPONSE);
    render(<AskWorkspace />);
    await submit("Who is the contractor?");
    expect(await screen.findByText("Backend unreachable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    await screen.findByTestId("ask-answer");
    expect(askQuestion).toHaveBeenCalledTimes(2);
    expect(vi.mocked(askQuestion).mock.calls[1]).toEqual(["Who is the contractor?", null]);
  });

  it("shows a friendly empty state with suggestions when nothing answers", async () => {
    vi.mocked(askQuestion).mockResolvedValue({
      ...RESPONSE,
      answer: "",
      answer_type: "none",
      facts: [],
      clause_matches: [],
      passages: [],
      citations: [],
      documents: [],
      suggestions: ["List DFARS clauses"],
    });
    render(<AskWorkspace />);
    await submit("zzzz");
    const empty = await screen.findByTestId("ask-empty");
    expect(within(empty).getByRole("button", { name: "List DFARS clauses" })).toBeTruthy();
    expect(within(empty).getByRole("link", { name: /Upload a document/ }).getAttribute("href")).toBe("/extraction/new");
  });
});

describe("AskWorkspace grounding and saved prompts", () => {
  it("flags an answer that comes back without citations", async () => {
    vi.mocked(askQuestion).mockResolvedValue({ ...RESPONSE, citations: [] });
    render(<AskWorkspace />);
    await submit("Who is the contractor?");
    expect(await screen.findByTestId("ask-ungrounded")).toHaveTextContent(/No source citations/);
    expect(screen.queryByText("Cited from source pages")).toBeNull();
  });

  it("offers the team's saved prompts and saves a question to the playbook", async () => {
    vi.mocked(listSavedQueries).mockResolvedValue([
      {
        id: "s1",
        name: "Cyber clause check",
        kind: "ask",
        query: "Which contracts include DFARS 252.204-7012?",
        description: "",
        created_by: "",
        created_at: null,
        updated_at: null,
      },
    ]);
    vi.mocked(askQuestion).mockResolvedValue(RESPONSE);
    vi.mocked(createSavedQuery).mockResolvedValue({} as never);
    render(<AskWorkspace />);

    const team = await screen.findByTestId("ask-team-prompts");
    fireEvent.click(within(team).getByRole("button", { name: "Cyber clause check" }));
    expect(askQuestion).toHaveBeenCalledWith("Which contracts include DFARS 252.204-7012?", null);

    fireEvent.click(await screen.findByRole("button", { name: /Save to playbook/ }));
    expect(createSavedQuery).toHaveBeenCalledWith({
      name: "Which contracts include DFARS 252.204-7012?",
      kind: "ask",
      query: "Which contracts include DFARS 252.204-7012?",
    });
    expect(await screen.findByText(/Saved to/)).toBeTruthy();
  });
});
