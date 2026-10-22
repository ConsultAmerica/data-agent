import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import InsightsSearch from "@/components/search/insights-search";
import { askQuestion, type AskResponse } from "@/lib/ask";
import {
  highlightParts,
  paramsFromQuery,
  queryFromParams,
  resultsCsv,
  searchInsights,
  type InsightsResponse,
} from "@/lib/insights-search";

const replace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push: vi.fn() }),
  useSearchParams: () => searchParams,
  usePathname: () => "/search",
}));
vi.mock("@/lib/ask", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ask")>();
  return { ...actual, askQuestion: vi.fn() };
});
vi.mock("@/lib/insights-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/insights-search")>();
  return { ...actual, searchInsights: vi.fn() };
});

const SNIPPET = "SECTION I 252.204-7012 Safeguarding Covered Defense Information and Cyber Incident Reporting";

const RESPONSE: InsightsResponse = {
  query: "cyber",
  total: 2,
  took_ms: 12,
  terms: ["252.204-7012", "cyber"],
  facets: {
    document_types: [
      { value: "SF 1442 Contract Award", count: 1 },
      { value: "FAR Part 51", count: 1 },
    ],
    families: [{ value: "Government Contract", count: 1 }],
    statuses: [{ value: "review_required", count: 2 }],
    clause_families: [{ value: "DFARS", count: 1 }],
    years: [{ value: "2026", count: 2 }],
  },
  results: [
    {
      document_id: "c1",
      document_name: "award.pdf",
      document_type: "SF 1442 Contract Award",
      family_label: "Government Contract",
      status: "review_required",
      uploaded_at: "2026-10-21T00:00:00",
      score: 1,
      facts: [{ label: "Contract Number", value: "N4019223D2803", page: 1 }],
      passages: [{ page: 11, snippet: SNIPPET, highlights: [[SNIPPET.indexOf("252"), SNIPPET.indexOf("252") + 12], [SNIPPET.indexOf("Cyber"), SNIPPET.indexOf("Cyber") + 5]], href: "/documents/c1?view=source&page=11&hl=x" }],
      matched_clauses: [{ clause_number: "252.204-7012", title: "Safeguarding Covered Defense Information", page: 11 }],
    },
    {
      document_id: "p51",
      document_name: "part-51.pdf",
      document_type: "FAR Part 51",
      family_label: "FAR Regulation",
      status: "review_required",
      uploaded_at: "2026-10-20T00:00:00",
      score: 0.2,
      facts: [],
      passages: [],
      matched_clauses: [],
    },
  ],
};

const ANSWER = {
  question: "cyber",
  scope: { document_id: null, document_name: null, document_count: 2 },
  answer: "DFARS 252.204-7012 appears in award.pdf [1].",
  answer_type: "clauses",
  facts: [],
  clause_matches: [],
  obligations: [],
  passages: [],
  citations: [{ n: 1, document_id: "c1", document_name: "award.pdf", page: 11, snippet: "252.204-7012", href: "/documents/c1?view=source&page=11" }],
  documents: [],
  suggestions: [],
  engine: "grounded-retrieval",
} as unknown as AskResponse;

beforeEach(() => {
  replace.mockReset();
  searchParams = new URLSearchParams("q=cyber");
  vi.mocked(searchInsights).mockReset().mockResolvedValue(RESPONSE);
  vi.mocked(askQuestion).mockReset().mockResolvedValue(ANSWER);
  window.localStorage.clear();
});

describe("insights search helpers", () => {
  it("splits snippets on highlight offsets", () => {
    const parts = highlightParts("abc def ghi", [[4, 7]]);
    expect(parts).toEqual([
      { text: "abc ", mark: false },
      { text: "def", mark: true },
      { text: " ghi", mark: false },
    ]);
  });

  it("round-trips the URL state", () => {
    const query = queryFromParams(new URLSearchParams("q=wawf&type=SF+1442&status=failed&from=2026-01-01&sort=newest&page=3"));
    expect(query.filters.document_types).toEqual(["SF 1442"]);
    expect(query.page).toBe(3);
    expect(queryFromParams(paramsFromQuery(query))).toEqual(query);
  });

  it("exports selected results as CSV with quoted cells", () => {
    const csv = resultsCsv([RESPONSE.results[0]], "http://x");
    const [header, row] = csv.split("\r\n");
    expect(header).toBe("Document,Type,Profile,Status,Relevance,Facts,Top passage,Page,Link");
    expect(row).toContain("award.pdf,SF 1442 Contract Award,Government Contract,Needs review,100,Contract Number: N4019223D2803");
    expect(row).toContain("http://x/documents/c1");
  });
});

describe("InsightsSearch", () => {
  it("renders results with highlighted passages, facts and clause chips", async () => {
    render(<InsightsSearch />);
    const card = (await screen.findByText("award.pdf")).closest("article")!;
    const marks = [...card.querySelectorAll("mark")].map((mark) => mark.textContent);
    expect(marks).toEqual(["252.204-7012", "Cyber"]);
    expect(within(card).getByText("N4019223D2803")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "p. 11 →" }).getAttribute("href")).toBe("/documents/c1?view=source&page=11&hl=x");
    expect(within(card).getByRole("list", { name: "Matching clauses" }).textContent).toContain("252.204-7012");
    expect(screen.getByText(/12 ms/)).toBeTruthy();
    expect(vi.mocked(searchInsights).mock.calls[0][0].q).toBe("cyber");
  });

  it("shows the cited AI answer with citation chips", async () => {
    render(<InsightsSearch />);
    const chip = await screen.findByRole("link", { name: "Citation 1" });
    expect(chip.getAttribute("href")).toBe("/documents/c1?view=source&page=11");
    expect(screen.getByText(/Answer from Ask Dataomatix · cited/)).toBeTruthy();
    expect(askQuestion).toHaveBeenCalledWith("cyber");
  });

  it("toggling a facet updates the URL, and the new URL refetches with the filter", async () => {
    const { rerender } = render(<InsightsSearch />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /FAR Part 51/ }));
    expect(replace).toHaveBeenCalledWith("/search?q=cyber&type=FAR+Part+51");
    searchParams = new URLSearchParams("q=cyber&type=FAR+Part+51");
    rerender(<InsightsSearch />);
    await waitFor(() => expect(searchInsights).toHaveBeenCalledTimes(2));
    expect(vi.mocked(searchInsights).mock.calls[1][0].filters.document_types).toEqual(["FAR Part 51"]);
  });

  it("saves, applies and deletes a view", async () => {
    render(<InsightsSearch />);
    await screen.findByText("award.pdf");
    fireEvent.change(screen.getByLabelText("Saved view name"), { target: { value: "Cyber" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(JSON.parse(window.localStorage.getItem("da-insights-saved-views")!)[0]).toMatchObject({ name: "Cyber", q: "cyber" });
    fireEvent.click(screen.getByRole("button", { name: "Cyber" }));
    expect(replace).toHaveBeenLastCalledWith("/search?q=cyber");
    fireEvent.click(screen.getByRole("button", { name: "Delete saved view Cyber" }));
    expect(window.localStorage.getItem("da-insights-saved-views")).toBe("[]");
  });

  it("bulk bar exports selected results and compares exactly two", async () => {
    const createObjectURL = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    render(<InsightsSearch />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select award.pdf" }));
    fireEvent.click(screen.getByRole("button", { name: /Export 1 result \(CSV\)/ }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("link", { name: /Compare 2/ })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select part-51.pdf" }));
    expect(screen.getByRole("link", { name: /Compare 2/ }).getAttribute("href")).toBe("/compare?left=c1&right=p51");
  });

  it("example chips run a search", async () => {
    render(<InsightsSearch />);
    fireEvent.click(await screen.findByRole("button", { name: "invoicing through WAWF" }));
    expect(replace).toHaveBeenCalledWith("/search?q=invoicing+through+WAWF");
  });
});
