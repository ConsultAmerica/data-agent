import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/documents", () => ({
  reviewMetadataField: vi.fn(() => Promise.resolve({})),
  reviewMetadataFieldById: vi.fn(() => Promise.resolve({})),
  startProcessingJob: vi.fn(() => Promise.resolve({})),
  getReviewQueue: vi.fn(() => Promise.resolve([])),
  getReviewQueueFields: vi.fn(() => Promise.resolve([])),
  acceptAllMetadataFields: vi.fn(() => Promise.resolve({})),
  acceptReviewQueueFields: vi.fn(() => Promise.resolve({ accepted: [], failed: [] })),
  isLowRiskQueueField: vi.fn(() => false),
}));
vi.mock("@/lib/assignments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/assignments")>()),
  assignFields: vi.fn(),
  unassignFields: vi.fn(() => Promise.resolve({ unassigned: 1 })),
  getAssignees: vi.fn(() => Promise.resolve({ assignees: ["Dana Reyes"], current_actor: "Workspace User" })),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("@/lib/export", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/export")>()),
  downloadBlob: vi.fn(),
}));

import FieldReviewList from "@/components/review-queue/field-review-list";
import {
  DEFAULT_FILTERS,
  UNASSIGNED,
  matchesFilters,
  queueCsv,
  severity,
  urgencyOf,
} from "@/components/review-queue/queue-filters";
import * as assignments from "@/lib/assignments";
import { normalizeContractType, type ReviewQueueFieldDetail } from "@/lib/assignments";
import * as documents from "@/lib/documents";
import * as exporter from "@/lib/export";
import ReviewQueuePage from "@/src/app/review-queue/page";

const FAILED = {
  status: "failed",
  failed_rules: [{ rule: "data_type", label: "Data type", detail: null }],
  messages: ["Value does not look like a phone number."],
  suggested_value: null,
  blocking: true,
  override: null,
};

function item(overrides: Partial<ReviewQueueFieldDetail> = {}): ReviewQueueFieldDetail {
  return {
    document_id: "d1aaaaaa-0000-0000-0000-000000000000",
    original_filename: "award.pdf",
    metadata_field_id: 42,
    field_key: "v3_telephone_no",
    label: "Telephone",
    value: "671-339-8465",
    confidence: 0.55,
    review_status: "pending",
    extraction_source: "v3",
    reasons: ["low_confidence"],
    reason_labels: ["Low confidence"],
    priority: "high",
    decision_status: "needs_review",
    page_number: 2,
    assignee: null,
    due_date: null,
    uploaded_at: "2026-10-02T12:00:00Z",
    contract_type: null,
    source_snippet: null,
    ...overrides,
  };
}

describe("queue filters", () => {
  const today = "2026-10-22";

  it("normalizes contract types and keeps unknown strings raw", () => {
    expect(normalizeContractType("Firm-Fixed-Price")).toBe("FFP");
    expect(normalizeContractType("FFP")).toBe("FFP");
    expect(normalizeContractType("Time and Materials")).toBe("T&M");
    expect(normalizeContractType("Labor-Hour")).toBe("T&M");
    expect(normalizeContractType("Cost Plus Fixed Fee (CPFF)")).toBe("Cost-Plus");
    expect(normalizeContractType("Fixed Price Incentive")).toBe("Other");
    expect(normalizeContractType("Consulting agreement")).toBe("Consulting agreement");
    expect(normalizeContractType("  ")).toBeNull();
  });

  it("filters by confidence, reviewer, contract type, urgency and search", () => {
    const base = { ...DEFAULT_FILTERS };
    const low = item({ confidence: 0.5 });
    const mid = item({ confidence: 0.75 });
    expect(matchesFilters(mid, { ...base, confidence: "below80" }, today)).toBe(true);
    expect(matchesFilters(mid, { ...base, confidence: "below60" }, today)).toBe(false);
    expect(matchesFilters(low, { ...base, confidence: "below60" }, today)).toBe(true);

    const owned = item({ assignee: "Dana Reyes", due_date: "2026-10-20" });
    expect(matchesFilters(owned, { ...base, assignee: UNASSIGNED }, today)).toBe(false);
    expect(matchesFilters(low, { ...base, assignee: UNASSIGNED }, today)).toBe(true);
    expect(matchesFilters(owned, { ...base, assignee: "Dana Reyes" }, today)).toBe(true);
    expect(matchesFilters(owned, { ...base, urgency: "overdue" }, today)).toBe(true);
    expect(matchesFilters(low, { ...base, urgency: "none" }, today)).toBe(true);
    expect(urgencyOf({ due_date: "2026-10-29" }, today)).toBe("due7");
    expect(urgencyOf({ due_date: "2026-10-30" }, today)).toBe("later");

    expect(matchesFilters(item({ contract_type: "Firm Fixed Price" }), { ...base, contractType: "FFP" }, today)).toBe(true);
    expect(matchesFilters(low, { ...base, contractType: "FFP" }, today)).toBe(false);
    expect(matchesFilters(low, { ...base, query: "TELEPHONE" }, today)).toBe(true);
    expect(matchesFilters(low, { ...base, query: "339-8465" }, today)).toBe(true);
    expect(matchesFilters(low, { ...base, query: "award.pdf" }, today)).toBe(true);
    expect(matchesFilters(low, { ...base, query: "nothing" }, today)).toBe(false);
  });

  it("marks validation failures and conflicts as critical", () => {
    expect(severity(item({ reasons: ["validation_failed"], reason_labels: ["Validation failed"] }))).toBe("critical");
    expect(severity(item({ reasons: ["conflict"], reason_labels: ["Sources disagree"] }))).toBe("critical");
    expect(severity(item())).toBe("standard");
  });

  it("escapes CSV quotes and neutralizes formulas", () => {
    const csv = queueCsv([item({ value: '=HYPERLINK("x")', label: 'Say "hi", ok' })]);
    const [header, row] = csv.split("\n");
    expect(header.startsWith('"Document","Document ID"')).toBe(true);
    expect(row).toContain('"Say ""hi"", ok"');
    expect(row).toContain(`"'=HYPERLINK(""x"")"`);
    expect(queueCsv([item({ value: "-5" })])).toContain('"-5"');
  });
});

describe("FieldReviewList table, batch toolbar and drawer", () => {
  beforeEach(() => {
    vi.mocked(documents.reviewMetadataFieldById).mockClear();
    vi.mocked(documents.startProcessingJob).mockClear();
    vi.mocked(assignments.assignFields).mockReset();
    vi.mocked(exporter.downloadBlob).mockClear();
  });

  const rows = [
    item({ metadata_field_id: 1, label: "Award date", document_id: "doc-a", reasons: ["validation_failed"], reason_labels: ["Validation failed"] }),
    item({ metadata_field_id: 2, label: "PIID", document_id: "doc-a" }),
    item({ metadata_field_id: 3, label: "Telephone", document_id: "doc-b", assignee: "Lee", due_date: "2000-01-01" }),
  ];

  function renderList(extra: Partial<Parameters<typeof FieldReviewList>[0]> = {}) {
    return render(
      <FieldReviewList
        items={rows}
        reviewer="R"
        issueLabel={(i) => i.reason_labels[0]}
        onDecided={vi.fn()}
        knownAssignees={["Dana Reyes"]}
        currentActor="Workspace User"
        {...extra}
      />,
    );
  }

  it("accents critical rows and shows owner and overdue state", () => {
    renderList();
    const table = screen.getByRole("table", { name: "Values flagged for review" });
    const bodyRows = within(table).getAllByRole("row").slice(1);
    expect(bodyRows.map((row) => row.getAttribute("data-severity"))).toEqual(["critical", "standard", "standard"]);
    expect(within(bodyRows[2]).getByText("Lee")).toBeInTheDocument();
    expect(within(bodyRows[2]).getByText(/Overdue/)).toBeInTheDocument();
    expect(within(bodyRows[0]).getByText("Unassigned")).toBeInTheDocument();
  });

  it("shows batch actions on selection; re-runs once per document; exports CSV", async () => {
    renderList();
    expect(screen.queryByRole("button", { name: "Re-run extraction" })).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all shown" }));
    expect(screen.getByText("3 selected")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Re-run extraction" }));
    });
    expect(documents.startProcessingJob).toHaveBeenCalledTimes(2);
    expect(documents.startProcessingJob).toHaveBeenCalledWith("doc-a");
    expect(documents.startProcessingJob).toHaveBeenCalledWith("doc-b");
    expect(screen.getByText(/Re-run extraction started for 2 documents/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Export to CSV" }));
    expect(exporter.downloadBlob).toHaveBeenCalledTimes(1);
    const [csv, filename] = vi.mocked(exporter.downloadBlob).mock.calls[0];
    expect(filename).toBe("review-queue.csv");
    expect(String(csv).split("\n")).toHaveLength(4);
  });

  it("assigns the selection to a reviewer with a due date", async () => {
    const onAssigned = vi.fn();
    vi.mocked(assignments.assignFields).mockResolvedValue({
      assigned: [{ document_id: "doc-a", metadata_field_id: 2, field_key: "v3_telephone_no", assignee: "Dana Reyes", due_date: "2026-11-01", assigned_by: "W", assigned_at: "2026-10-22T10:00:00Z" }],
    });
    renderList({ onAssigned });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select PIID" }));
    fireEvent.click(screen.getByRole("button", { name: "Assign to reviewer" }));
    const dialog = screen.getByRole("dialog", { name: "Assign to reviewer" });
    const name = within(dialog).getByPlaceholderText("Reviewer name");
    expect(name).toHaveValue("Workspace User");
    fireEvent.change(name, { target: { value: "Dana Reyes" } });
    fireEvent.change(within(dialog).getByLabelText("Due date (optional)"), { target: { value: "2026-11-01" } });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Assign" }));
    });
    expect(assignments.assignFields).toHaveBeenCalledWith(
      [{ document_id: "doc-a", metadata_field_id: 2, field_key: "v3_telephone_no" }],
      "Dana Reyes",
      "2026-11-01",
    );
    expect(onAssigned).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Assign to reviewer" })).toBeNull();
    expect(screen.getByText("Assigned 1 value to Dana Reyes.")).toBeInTheDocument();
  });

  it("opens the quick-inspect drawer from a row, with the source snippet and Escape to close", () => {
    renderList({ items: [item({ source_snippet: "Telephone: 671-339-8465" })] });
    fireEvent.click(screen.getByText("award.pdf"));
    const dialog = screen.getByRole("dialog", { name: "Telephone" });
    expect(within(dialog).getByText("Telephone: 671-339-8465")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Close details" })).toHaveFocus();
    expect(within(dialog).getByRole("link", { name: /Open the full document/ })).toHaveAttribute(
      "href",
      "/documents/d1aaaaaa-0000-0000-0000-000000000000",
    );
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says when no source text is stored and links to the source", () => {
    renderList({ items: [item()] });
    fireEvent.click(screen.getByRole("button", { name: "Open details for Telephone" }));
    const dialog = screen.getByRole("dialog", { name: "Telephone" });
    expect(within(dialog).getByText("Original source text unavailable.")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "Open page 2 in source" })).toHaveAttribute(
      "href",
      "/documents/d1aaaaaa-0000-0000-0000-000000000000?view=source&page=2&hl=671-339-8465",
    );
  });

  it("never shows a validation message as the original text", () => {
    renderList({ items: [item({ source_snippet: null, validation: FAILED })] });
    fireEvent.click(screen.getByRole("button", { name: "Open details for Telephone" }));
    const original = within(screen.getByRole("dialog")).getByRole("region", { name: "Original text" });
    expect(within(original).getByText("Original source text unavailable.")).toBeInTheDocument();
    expect(within(original).queryByText(/validation/i)).toBeNull();
  });

  it("enables Save correction only for a changed, non-empty value and says why otherwise", () => {
    renderList({ items: [item()] });
    fireEvent.click(screen.getByRole("button", { name: "Open details for Telephone" }));
    const save = screen.getByRole("button", { name: "Save correction" });
    expect(save).toBeDisabled();
    expect(screen.getByTestId("save-help")).toHaveTextContent("Change the value to save a correction.");
    fireEvent.change(screen.getByLabelText("Corrected value for Telephone"), { target: { value: "   " } });
    expect(save).toBeDisabled();
    expect(screen.getByTestId("save-help")).toHaveTextContent("A corrected value can't be empty.");
    fireEvent.change(screen.getByLabelText("Corrected value for Telephone"), { target: { value: "671-339-8466" } });
    expect(save).toBeEnabled();
    // Approving now would approve the old value.
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByTestId("approve-help")).toHaveTextContent("Save or discard your correction before approving.");
  });

  it("saves a correction without approving it and shows the re-run validation", async () => {
    const onDecided = vi.fn();
    vi.mocked(documents.reviewMetadataFieldById).mockResolvedValueOnce({
      value: "671-339-8466",
      validation: { status: "passed", failed_rules: [], messages: [], blocking: false },
    } as never);
    renderList({ items: [item({ validation: FAILED })], onDecided });
    fireEvent.click(screen.getByRole("button", { name: "Open details for Telephone" }));
    fireEvent.change(screen.getByLabelText("Corrected value for Telephone"), { target: { value: "671-339-8466" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save correction" }));
    });
    expect(documents.reviewMetadataFieldById).toHaveBeenCalledWith(
      "d1aaaaaa-0000-0000-0000-000000000000",
      42,
      "correct",
      "R",
      "671-339-8466",
      undefined,
    );
    expect(onDecided).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Telephone" });
    expect(within(dialog).getByText("Correction saved. It is waiting for approval.")).toBeInTheDocument();
    expect(within(within(dialog).getByTestId("validation-section")).getByText("Passed")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("shows validation apart from the value and invents no suggested correction", () => {
    renderList({ items: [item({ validation: FAILED })] });
    fireEvent.click(screen.getByRole("button", { name: "Open details for Telephone" }));
    const section = screen.getByTestId("validation-section");
    expect(within(section).getByText("Failed")).toBeInTheDocument();
    expect(within(section).getByText("Data type")).toBeInTheDocument();
    expect(within(section).getByText("Value does not look like a phone number.")).toBeInTheDocument();
    expect(within(section).getByText("None available")).toBeInTheDocument();
    expect(within(section).getByText("Page 2")).toBeInTheDocument();
  });

  it("blocks an ordinary approval of a failed value and requires a reason to override", async () => {
    const onDecided = vi.fn();
    renderList({ items: [item({ validation: FAILED })], onDecided });
    expect(screen.getByRole("button", { name: "Approve Telephone" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Open details for Telephone" }));
    const dialog = screen.getByRole("dialog", { name: "Telephone" });
    expect(within(dialog).getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(within(dialog).getByTestId("approve-help")).toHaveTextContent("failed validation");
    expect(within(dialog).getByRole("button", { name: "Reject" })).toBeEnabled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Approve with override…" }));
    const confirm = within(dialog).getByRole("button", { name: "Approve with override" });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Why is this value correct/), { target: { value: "Printed this way on the award." } });
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(documents.reviewMetadataFieldById).toHaveBeenCalledWith(
      "d1aaaaaa-0000-0000-0000-000000000000",
      42,
      "accept",
      "R",
      undefined,
      "Printed this way on the award.",
    );
    expect(onDecided).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("leaves failed values out of Approve selected", () => {
    vi.useFakeTimers();
    try {
      renderList({ items: [item({ metadata_field_id: 1, label: "PIID", validation: FAILED }), item({ metadata_field_id: 2, label: "Telephone" })] });
      fireEvent.click(screen.getByRole("checkbox", { name: "Select PIID" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Select Telephone" }));
      fireEvent.click(screen.getByRole("button", { name: /Approve selected/ }));
      expect(screen.getByText(/1 selected value failed validation and was not approved/)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open details for PIID" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Open details for Telephone" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("approves from the drawer through the undo window", () => {
    vi.useFakeTimers();
    try {
      renderList({ items: [item()] });
      fireEvent.click(screen.getByRole("button", { name: "Open details for Telephone" }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByRole("button", { name: /Undo/ })).toBeInTheDocument();
      expect(documents.reviewMetadataFieldById).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ReviewQueuePage filters and saved chips", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(documents.getReviewQueueFields).mockResolvedValue([
      item({ metadata_field_id: 1, label: "Award date", confidence: 0.75, contract_type: "Firm Fixed Price" }),
      item({ metadata_field_id: 2, label: "PIID", confidence: 0.4, assignee: "Dana Reyes" }),
    ]);
  });
  afterEach(() => window.localStorage.clear());

  it("filters the table and saves, re-applies and removes a named filter", async () => {
    render(<ReviewQueuePage />);
    expect(await screen.findByRole("button", { name: "Open details for PIID" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Contract type"), { target: { value: "FFP" } });
    expect(screen.queryByRole("button", { name: "Open details for PIID" })).toBeNull();
    expect(screen.getByRole("button", { name: "Open details for Award date" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Contract type"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Assigned reviewer"), { target: { value: "Dana Reyes" } });
    expect(screen.queryByRole("button", { name: "Open details for Award date" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Save filter" }));
    fireEvent.change(screen.getByLabelText("Saved filter name"), { target: { value: "Dana's queue" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(JSON.parse(window.localStorage.getItem("dataomatix.review-queue.saved-filters") ?? "[]")[0].name).toBe(
      "Dana's queue",
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: "Open details for Award date" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dana's queue" }));
    expect(screen.getByLabelText("Assigned reviewer")).toHaveValue("Dana Reyes");
    expect(screen.queryByRole("button", { name: "Open details for Award date" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove saved filter Dana's queue" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Dana's queue" })).toBeNull());
  });
});
