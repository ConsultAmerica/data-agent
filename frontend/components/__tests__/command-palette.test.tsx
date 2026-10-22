import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("@/lib/documents", () => ({
  searchDocuments: vi.fn(() =>
    Promise.resolve({
      total: 1,
      documents: [{ document_id: "d1", original_filename: "SF1442 Award.pdf", document_type: "Government Contract", counterparty: null }],
    }),
  ),
}));
vi.mock("@/lib/insights-search", () => ({
  emptyFilters: () => ({}),
  searchInsights: vi.fn(() =>
    Promise.resolve({
      results: [
        {
          document_id: "d1",
          document_name: "SF1442 Award.pdf",
          matched_clauses: [{ clause_number: "52.249-2", title: "Termination for Convenience", page: 10 }],
        },
      ],
    }),
  ),
}));
vi.mock("@/lib/obligations", () => ({
  dueLabel: () => "Undated",
  getPortfolioObligations: vi.fn(() =>
    Promise.resolve({
      obligations: [
        {
          obligation_id: "o1", document_id: "d1", document_name: "SF1442 Award.pdf", title: "Notice of termination",
          description: "", source_reference: "FAR 52.249-2", due_date: null, recurrence: null, trigger: null,
        },
        {
          obligation_id: "o2", document_id: "d1", document_name: "SF1442 Award.pdf", title: "File VETS-4212 report",
          description: "", source_reference: "FAR 52.222-37", due_date: null, recurrence: null, trigger: null,
        },
      ],
    }),
  ),
}));

import GlobalSearch, { highlight } from "@/components/global-search";

async function typeQuery(value: string) {
  fireEvent.change(screen.getByRole("combobox"), { target: { value } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250);
  });
}

describe("command palette", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    push.mockReset();
    window.localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it("shows commands when empty and documents, clauses and obligations for a query", async () => {
    render(<GlobalSearch open onClose={() => {}} />);
    expect(within(screen.getByRole("group", { name: "Commands" })).getByText("Review queue")).toBeTruthy();

    await typeQuery("termination");
    expect(within(screen.getByRole("group", { name: "Documents" })).getByText("SF1442 Award.pdf")).toBeTruthy();
    const clauses = within(screen.getByRole("group", { name: "Clauses" }));
    expect(clauses.getByText(/52\.249-2/)).toBeTruthy();
    const obligations = within(screen.getByRole("group", { name: "Obligations" }));
    expect(obligations.getAllByRole("option")).toHaveLength(1);
    expect(obligations.getByText("termination")).toBeTruthy(); // highlighted match
  });

  it("moves with the arrow keys, opens with Enter and remembers the search", async () => {
    const onClose = vi.fn();
    render(<GlobalSearch open onClose={onClose} />);
    await typeQuery("termination");
    const input = screen.getByRole("combobox");
    // First option: Ask Dataomatix; ArrowDown -> Search everything.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const selected = screen.getAllByRole("option").find((option) => option.getAttribute("aria-selected") === "true")!;
    expect(selected.textContent).toContain("Search everything");
    expect(input.getAttribute("aria-activedescendant")).toBe(selected.id);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" }); // wraps to the last option
    const last = screen.getAllByRole("option").at(-1)!;
    expect(last.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/obligations?document_id=d1");
    expect(onClose).toHaveBeenCalled();
    expect(JSON.parse(window.localStorage.getItem("da-recent-searches") ?? "[]")).toEqual(["termination"]);
  });

  it("Enter on the first option asks Dataomatix with the query; Esc closes", async () => {
    const onClose = vi.fn();
    render(<GlobalSearch open onClose={onClose} />);
    await typeQuery("cyber incident");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(push).toHaveBeenCalledWith("/ask?q=cyber%20incident");
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("lists recent searches when empty and reuses one on select", async () => {
    window.localStorage.setItem("da-recent-searches", JSON.stringify(["WAWF invoicing"]));
    render(<GlobalSearch open onClose={() => {}} />);
    const recent = within(screen.getByRole("group", { name: "Recent searches" }));
    fireEvent.click(recent.getByText("WAWF invoicing"));
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("WAWF invoicing");
  });

  it("highlights every query word", () => {
    render(<p>{highlight("Termination for Convenience", "conv term")}</p>);
    expect(screen.getAllByText(/Term|Conv/, { selector: "mark" })).toHaveLength(2);
  });
});
