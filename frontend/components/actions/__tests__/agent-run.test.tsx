import { act, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AgentRun, { ACTION_STEPS } from "@/components/actions/agent-run";
import type { ActionResult } from "@/lib/document-actions";

const result = {
  action_id: "funding_reconciliation",
  title: "Funding reconciliation",
  document_id: "d1",
  document_name: "award.pdf",
  generated_at: "2026-10-21T10:00:00Z",
  sections: [{ heading: "Totals", kind: "facts", facts: [{ label: "Priced", value: "$1", page: 2 }] }],
  warnings: ["No funding lines"],
} as unknown as ActionResult;

function renderRun(state: "running" | "completed" | "failed", extra: Partial<Parameters<typeof AgentRun>[0]> = {}) {
  return render(
    <AgentRun
      actionId="funding_reconciliation"
      title="Funding reconciliation"
      documentName="award.pdf"
      state={state}
      result={state === "completed" ? result : null}
      startedAt={new Date("2026-10-21T10:00:00Z")}
      downloading={null}
      onDownload={() => {}}
      {...extra}
    />,
  );
}

const stepItems = () => within(screen.getByRole("list", { name: /steps/ })).getAllByRole("listitem");

describe("AgentRun", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ticks through the working stages but never claims the last one while running", () => {
    renderRun("running");
    const steps = ACTION_STEPS.funding_reconciliation;
    act(() => vi.advanceTimersByTime(10_000));
    const items = stepItems();
    expect(items).toHaveLength(steps.length + 1);
    expect(items[steps.length - 2].textContent).toContain("done");
    expect(items[steps.length - 1].textContent).toContain("running");
    expect(screen.getByText("Running")).toBeTruthy();
  });

  it("completes every stage and offers both files", () => {
    renderRun("completed");
    const items = stepItems();
    expect(items.filter((item) => item.textContent?.includes("done"))).toHaveLength(ACTION_STEPS.funding_reconciliation.length);
    expect(items.at(-1)?.textContent).toContain("current");
    expect(screen.getByRole("button", { name: /Download CSV: award-funding_reconciliation.csv/ })).toBeTruthy();
    expect(screen.getByText(/1 section · 1 item · 1 warning/)).toBeTruthy();
    expect(screen.getByText("Completed")).toBeTruthy();
  });

  it("marks the current stage failed with the error", () => {
    renderRun("failed", { error: "Server error" });
    expect(stepItems()[0].textContent).toContain("failed");
    expect(screen.getByText("Server error")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
  });
});
