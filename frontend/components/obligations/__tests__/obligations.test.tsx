import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DocumentObligationsPanel from "@/components/obligations/document-obligations-panel";
import ObligationsPage from "@/src/app/obligations/page";
import { dueLabel, getDocumentObligations, getPortfolioObligations, obligationsCsv, type Obligation, type ObligationsResult } from "@/lib/obligations";

let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => searchParams,
  usePathname: () => "/obligations",
}));
vi.mock("@/lib/obligations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/obligations")>()),
  getPortfolioObligations: vi.fn(),
  getDocumentObligations: vi.fn(),
  updateObligationTracking: vi.fn(),
}));
vi.mock("@/lib/assignments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assignments")>()),
  getAssignees: vi.fn(() => Promise.resolve({ assignees: ["Kim"], current_actor: "Workspace User" })),
}));

function obligation(id: string, extra: Partial<Obligation> = {}): Obligation {
  return {
    obligation_id: id,
    document_id: "d1",
    document_name: "contract.pdf",
    title: `Obligation ${id}`,
    description: "Description",
    category: "reporting",
    responsible_party: "contractor",
    due_date: null,
    recurrence: null,
    trigger: null,
    status: "undated",
    source_type: "clause",
    source_reference: "FAR 52.222-37",
    page: 9,
    evidence: "evidence",
    confidence: 0.8,
    ...extra,
  };
}

function result(items: Obligation[]): ObligationsResult {
  const counts = { overdue: 0, due_soon: 0, upcoming: 0, ongoing: 0, undated: 0, total: items.length };
  for (const item of items) counts[item.status] += 1;
  const categories = new Map<string, number>();
  for (const item of items) categories.set(item.category, (categories.get(item.category) ?? 0) + 1);
  return { obligations: items, counts, by_category: [...categories].map(([name, count]) => ({ name, count })) };
}

const ITEMS = [
  obligation("a", { title: "Deliver CLIN 0001", category: "deliverable", status: "overdue", due_date: "2026-10-01", source_type: "schedule", source_reference: "CLIN 0001" }),
  obligation("b", { title: "Report cyber incidents to DoD", category: "notification", status: "ongoing", recurrence: "per occurrence", trigger: "within 72 hours of discovery" }),
  obligation("c", { title: "Base period ends", category: "performance", status: "upcoming", due_date: "2030-04-14", document_id: "d2", document_name: "other.pdf" }),
];

describe("ObligationsPage", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams();
    vi.mocked(getPortfolioObligations).mockResolvedValue(result(ITEMS));
  });

  it("lists obligations with status counts and filters by status tile", async () => {
    render(<ObligationsPage />);
    expect(await screen.findByText("Deliver CLIN 0001")).toBeTruthy();
    expect(screen.getByText("Report cyber incidents to DoD")).toBeTruthy();
    const tiles = within(screen.getByRole("group", { name: "Obligations by status" }));
    fireEvent.click(tiles.getByRole("button", { name: /Overdue/ }));
    expect(screen.getByText("Deliver CLIN 0001")).toBeTruthy();
    expect(screen.queryByText("Base period ends")).toBeNull();
  });

  it("scopes to the document in the query string and searches", async () => {
    searchParams = new URLSearchParams("document_id=d2");
    render(<ObligationsPage />);
    expect(await screen.findByText("Base period ends")).toBeTruthy();
    expect(screen.queryByText("Deliver CLIN 0001")).toBeNull();
    fireEvent.change(screen.getByLabelText("Document"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Search obligations"), { target: { value: "72 hours" } });
    expect(screen.getByText("Report cyber incidents to DoD")).toBeTruthy();
    expect(screen.queryByText("Base period ends")).toBeNull();
  });

  it("shows an empty state when nothing was found", async () => {
    vi.mocked(getPortfolioObligations).mockResolvedValue(result([]));
    render(<ObligationsPage />);
    expect(await screen.findByText("No obligations yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Start an extraction" }).getAttribute("href")).toBe("/extraction/new");
  });
});

describe("DocumentObligationsPanel", () => {
  it("shows the most urgent items and links to the full tracker", async () => {
    vi.mocked(getDocumentObligations).mockResolvedValue({ document_id: "d1", ...result(ITEMS) });
    render(<DocumentObligationsPanel documentId="d1" />);
    expect(await screen.findByText("Deliver CLIN 0001")).toBeTruthy();
    expect(screen.getByText(/1 overdue or due within 30 days/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /View all/ }).getAttribute("href")).toBe("/obligations?document_id=d1");
  });
});

describe("obligation helpers", () => {
  it("labels due dates and cadences, and escapes CSV", () => {
    expect(dueLabel({ due_date: null, recurrence: "annually", trigger: null })).toBe("Annually");
    expect(dueLabel({ due_date: null, recurrence: null, trigger: null })).toBe("—");
    const csv = obligationsCsv([obligation("x", { title: 'Say "hi", then go' })]);
    expect(csv.split("\n")[1].startsWith('"Say ""hi"", then go"')).toBe(true);
  });
});
