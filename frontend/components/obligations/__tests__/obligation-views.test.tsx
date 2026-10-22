import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DueBadge } from "@/components/obligations/obligation-card";
import ObligationsPage from "@/src/app/obligations/page";
import {
  daysUntil,
  getPortfolioObligations,
  localToday,
  riskOf,
  updateObligationTracking,
  type Obligation,
  type ObligationsResult,
} from "@/lib/obligations";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/obligations",
}));
vi.mock("@/lib/obligations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/obligations")>()),
  getPortfolioObligations: vi.fn(),
  updateObligationTracking: vi.fn(),
}));
vi.mock("@/lib/assignments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assignments")>()),
  getAssignees: vi.fn(() => Promise.resolve({ assignees: ["Kim"], current_actor: "Workspace User" })),
}));

function shiftDays(days: number): string {
  const date = new Date(`${localToday()}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function obligation(id: string, extra: Partial<Obligation> = {}): Obligation {
  return {
    obligation_id: id,
    obligation_key: id,
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
    workflow_status: "upcoming",
    assignee: null,
    subtasks: [],
    ...extra,
  };
}

function result(items: Obligation[]): ObligationsResult {
  const counts = { overdue: 0, due_soon: 0, upcoming: 0, ongoing: 0, undated: 0, total: items.length };
  for (const item of items) counts[item.status] += 1;
  return { obligations: items, counts, by_category: [{ name: "reporting", count: items.length }] };
}

const ITEMS = [
  obligation("a", { title: "Deliver CLIN 0001", status: "due_soon", due_date: shiftDays(3), assignee: "Kim Lee",
    subtasks: [{ title: "Pack", done: true }, { title: "Ship", done: false }] }),
  obligation("b", { title: "Submit ISR", status: "upcoming", due_date: shiftDays(20), workflow_status: "in_review" }),
  obligation("c", { title: "Maintain SAM", status: "ongoing", workflow_status: "completed" }),
  obligation("d", { title: "Option decision", status: "upcoming", due_date: shiftDays(90), document_id: "d2", document_name: "other.pdf" }),
];

describe("obligation risk and due badge", () => {
  it("derives risk from the due date only", () => {
    const today = "2026-10-22";
    expect(riskOf({ due_date: "2026-10-01" }, today)).toBe("high");
    expect(riskOf({ due_date: "2026-10-29" }, today)).toBe("high");
    expect(riskOf({ due_date: "2026-11-15" }, today)).toBe("medium");
    expect(riskOf({ due_date: "2027-01-01" }, today)).toBe("low");
    expect(riskOf({ due_date: null }, today)).toBeNull();
    expect(daysUntil("2026-10-25", today)).toBe(3);
  });

  it("is red with fewer than 7 days left", () => {
    const { rerender, container } = render(<DueBadge item={obligation("x", { due_date: shiftDays(3) })} />);
    expect(container.querySelector("[data-urgent]")?.getAttribute("data-urgent")).toBe("true");
    rerender(<DueBadge item={obligation("x", { due_date: shiftDays(10) })} />);
    expect(container.querySelector("[data-urgent]")?.getAttribute("data-urgent")).toBe("false");
    rerender(<DueBadge item={obligation("x", { due_date: shiftDays(-2) })} />);
    expect(screen.getByText(/Overdue/)).toBeTruthy();
  });
});

describe("Obligations tracker views", () => {
  beforeEach(() => {
    vi.mocked(getPortfolioObligations).mockResolvedValue(result(ITEMS.map((item) => ({ ...item }))));
    vi.mocked(updateObligationTracking).mockReset();
  });

  it("groups cards into kanban columns with owner initials and sub-task progress", async () => {
    render(<ObligationsPage />);
    await screen.findByText("Deliver CLIN 0001");
    fireEvent.click(screen.getByRole("button", { name: "Kanban" }));
    const upcoming = screen.getByRole("region", { name: "Upcoming deliverables" });
    const review = screen.getByRole("region", { name: "In review" });
    const done = screen.getByRole("region", { name: "Completed / archived" });
    expect(within(upcoming).getByText("Deliver CLIN 0001")).toBeTruthy();
    expect(within(upcoming).getByLabelText("Owner Kim Lee").textContent).toBe("KL");
    expect(within(upcoming).getByRole("img", { name: "1 of 2 sub-tasks done" })).toBeTruthy();
    expect(within(review).getByText("Submit ISR")).toBeTruthy();
    expect(within(done).getByText("Maintain SAM")).toBeTruthy();
    expect(within(upcoming).getByRole("link", { name: "contract.pdf" }).getAttribute("href")).toBe("/documents/d1");
  });

  it("moves a card by status select optimistically and persists it", async () => {
    vi.mocked(updateObligationTracking).mockResolvedValue({
      document_id: "d1", obligation_key: "a", workflow_status: "pending_co", assignee: "Kim Lee",
      subtasks: ITEMS[0].subtasks!, tracking_updated_at: null, tracking_updated_by: null,
    });
    render(<ObligationsPage />);
    await screen.findByText("Deliver CLIN 0001");
    fireEvent.click(screen.getByRole("button", { name: "Kanban" }));
    fireEvent.change(screen.getByLabelText("Status for Deliver CLIN 0001"), { target: { value: "pending_co" } });
    expect(within(screen.getByRole("region", { name: "Pending CO approval" })).getByText("Deliver CLIN 0001")).toBeTruthy();
    expect(updateObligationTracking).toHaveBeenCalledWith("d1", "a", { workflow_status: "pending_co" });
  });

  it("rolls back a failed change and says so", async () => {
    vi.mocked(updateObligationTracking).mockRejectedValue(new Error("Server unavailable"));
    render(<ObligationsPage />);
    await screen.findByText("Deliver CLIN 0001");
    fireEvent.click(screen.getByRole("button", { name: "Kanban" }));
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Status for Deliver CLIN 0001"), { target: { value: "completed" } });
    });
    await waitFor(() =>
      expect(within(screen.getByRole("region", { name: "Upcoming deliverables" })).getByText("Deliver CLIN 0001")).toBeTruthy(),
    );
    expect(screen.getByText(/Not saved: Server unavailable/)).toBeTruthy();
  });

  it("drops a dragged card into another column", async () => {
    vi.mocked(updateObligationTracking).mockReturnValue(new Promise(() => undefined));
    render(<ObligationsPage />);
    await screen.findByText("Deliver CLIN 0001");
    fireEvent.click(screen.getByRole("button", { name: "Kanban" }));
    const target = screen.getByRole("region", { name: "In review" });
    fireEvent.drop(target, { dataTransfer: { getData: () => "a" } });
    expect(within(target).getByText("Deliver CLIN 0001")).toBeTruthy();
    expect(updateObligationTracking).toHaveBeenCalledWith("d1", "a", { workflow_status: "in_review" });
  });

  it("adds and toggles sub-tasks and sets the owner", async () => {
    vi.mocked(updateObligationTracking).mockReturnValue(new Promise(() => undefined));
    render(<ObligationsPage />);
    await screen.findByText("Deliver CLIN 0001");
    fireEvent.click(screen.getByRole("button", { name: "Kanban" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit owner and sub-tasks for Submit ISR" }));
    fireEvent.change(screen.getByLabelText("New sub-task for Submit ISR"), { target: { value: "Pull data" } });
    fireEvent.click(screen.getByRole("button", { name: "Add sub-task" }));
    expect(updateObligationTracking).toHaveBeenLastCalledWith("d1", "b", { subtasks: [{ title: "Pull data", done: false }] });
    fireEvent.click(screen.getByRole("checkbox", { name: "Pull data" }));
    expect(updateObligationTracking).toHaveBeenLastCalledWith("d1", "b", { subtasks: [{ title: "Pull data", done: true }] });
    fireEvent.change(screen.getByLabelText("Owner for Submit ISR"), { target: { value: "Kim" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(updateObligationTracking).toHaveBeenLastCalledWith("d1", "b", { assignee: "Kim" });
  });

  it("filters by owner, workflow status and risk", async () => {
    render(<ObligationsPage />);
    await screen.findByText("Deliver CLIN 0001");
    fireEvent.change(screen.getByLabelText("Risk (by due date)"), { target: { value: "high" } });
    expect(screen.getByText("Deliver CLIN 0001")).toBeTruthy();
    expect(screen.queryByText("Submit ISR")).toBeNull();
    fireEvent.change(screen.getByLabelText("Risk (by due date)"), { target: { value: "medium" } });
    expect(screen.getByText("Submit ISR")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Risk (by due date)"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "__unassigned__" } });
    expect(screen.queryByText("Deliver CLIN 0001")).toBeNull();
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Workflow status"), { target: { value: "completed" } });
    expect(screen.getByText("Maintain SAM")).toBeTruthy();
    expect(screen.queryByText("Submit ISR")).toBeNull();
  });

  it("shows a month calendar and lists undated obligations separately", async () => {
    render(<ObligationsPage />);
    await screen.findByText("Deliver CLIN 0001");
    fireEvent.click(screen.getByRole("button", { name: "Calendar" }));
    const grid = screen.getByRole("grid");
    const due = ITEMS[0].due_date!;
    if (due.slice(0, 7) === localToday().slice(0, 7)) {
      fireEvent.click(within(grid).getByRole("button", { name: "Deliver CLIN 0001" }));
      expect(screen.getByRole("article", { name: "Deliver CLIN 0001" })).toBeTruthy();
    }
    const undated = screen.getByRole("region", { name: "Undated obligations" });
    expect(within(undated).getByText("Maintain SAM")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByRole("grid")).toBeTruthy();
  });
});
