import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ActionCatalog from "@/components/actions/action-catalog";
import DocumentActionsMenu from "@/components/actions/document-actions-menu";
import type { ActionResult, DocumentAction } from "@/lib/document-actions";

let search = new URLSearchParams();
const replace = vi.fn();
const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, push }),
  useSearchParams: () => search,
}));
vi.mock("@/lib/documents", () => ({
  listDocuments: vi.fn(() =>
    Promise.resolve([
      { document_id: "d1", original_filename: "award.pdf", document_type: "Government Contract" },
      { document_id: "d2", original_filename: "memo.pdf", document_type: null },
    ]),
  ),
}));

const ACTIONS: DocumentAction[] = [
  {
    action_id: "executive_summary",
    title: "Executive summary",
    description: "Everything on one page.",
    category: "Summary",
    outputs: ["json", "csv", "md"],
    available: true,
    reason: null,
  },
  {
    action_id: "funding_reconciliation",
    title: "Funding reconciliation",
    description: "CLINs vs funding.",
    category: "Financial",
    outputs: ["json", "csv", "md"],
    available: false,
    reason: "No CLINs or funding lines were extracted.",
  },
];

const RESULT: ActionResult = {
  action_id: "executive_summary",
  title: "Executive summary",
  document_id: "d1",
  document_name: "award.pdf",
  generated_at: "2026-10-21T00:00:00Z",
  warnings: ["The clause playbook is not available."],
  sections: [
    {
      heading: "Contract identification",
      kind: "facts",
      facts: [
        { label: "Contract Number", value: "N4019223D2803", page: 1 },
        { label: "Agency / Office", value: null, page: null },
      ],
    },
    {
      heading: "Risks",
      kind: "table",
      columns: [
        { key: "risk", label: "Risk" },
        { key: "severity", label: "Severity" },
        { key: "page", label: "Page" },
      ],
      rows: [{ risk: "CLIN 0002 is unfunded", severity: "high", page: 3 }],
    },
  ],
};

const listDocumentActions = vi.fn<(documentId: string) => Promise<DocumentAction[]>>(() => Promise.resolve(ACTIONS));
const runDocumentAction = vi.fn<(documentId: string, actionId: string) => Promise<ActionResult>>(() => Promise.resolve(RESULT));
const downloadDocumentAction = vi.fn(() => Promise.resolve());

vi.mock("@/lib/document-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/document-actions")>()),
  listDocumentActions: (documentId: string) => listDocumentActions(documentId),
  runDocumentAction: (documentId: string, actionId: string) => runDocumentAction(documentId, actionId),
  downloadDocumentAction: (...args: unknown[]) => downloadDocumentAction(...(args as [])),
}));

beforeEach(() => {
  search = new URLSearchParams();
  replace.mockClear();
  push.mockClear();
  listDocumentActions.mockClear();
  runDocumentAction.mockClear();
  downloadDocumentAction.mockClear();
});

describe("ActionCatalog", () => {
  it("lists the catalog for the first document and disables unavailable actions with the reason", async () => {
    render(<ActionCatalog />);
    const cards = within(await screen.findByRole("list", { name: "Agent actions" }));
    await cards.findByText("Executive summary");
    expect(listDocumentActions).toHaveBeenCalledWith("d1");
    expect(cards.getByText("No CLINs or funding lines were extracted.")).toBeTruthy();
    const runButtons = cards.getAllByRole("button", { name: "Run" });
    expect((runButtons[1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("runs an action and renders facts, tables, page links and warnings", async () => {
    render(<ActionCatalog />);
    const cards = within(await screen.findByRole("list", { name: "Agent actions" }));
    fireEvent.click((await cards.findAllByRole("button", { name: "Run" }))[0]);
    expect(await screen.findByText("N4019223D2803")).toBeTruthy();
    expect(runDocumentAction).toHaveBeenCalledWith("d1", "executive_summary");
    expect(screen.getByText("Not extracted")).toBeTruthy();
    expect(screen.getByText("The clause playbook is not available.")).toBeTruthy();
    const risks = within(screen.getByRole("region", { name: "Risks" }));
    expect(risks.getByText("high").className).toContain("text-danger");
    expect(risks.getByRole("link", { name: "p. 3" }).getAttribute("href")).toBe("/documents/d1?view=source");

    fireEvent.click(screen.getByRole("button", { name: /Download CSV/ }));
    await waitFor(() => expect(downloadDocumentAction).toHaveBeenCalledWith("d1", "executive_summary", "csv", "award.pdf"));
  });

  it("auto-runs the action named in the URL for the named document", async () => {
    search = new URLSearchParams("document_id=d2&action=executive_summary");
    render(<ActionCatalog />);
    await waitFor(() => expect(runDocumentAction).toHaveBeenCalledWith("d2", "executive_summary"));
    expect(runDocumentAction).toHaveBeenCalledTimes(1);
  });

  it("switching documents reloads the catalog and updates the URL", async () => {
    render(<ActionCatalog />);
    const select = await screen.findByRole("combobox", { name: "Document" });
    await screen.findByText("Executive summary");
    fireEvent.change(select, { target: { value: "d2" } });
    await waitFor(() => expect(listDocumentActions).toHaveBeenCalledWith("d2"));
    expect(replace).toHaveBeenCalledWith("/actions?document_id=d2");
  });
});

describe("DocumentActionsMenu", () => {
  it("loads the catalog on open and navigates to the action", async () => {
    render(<DocumentActionsMenu documentId="d1" />);
    expect(listDocumentActions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Actions/ }));
    const menu = within(await screen.findByRole("menu", { name: "Document actions" }));
    fireEvent.click(await menu.findByRole("menuitem", { name: /Executive summary/ }));
    expect(push).toHaveBeenCalledWith("/actions?document_id=d1&action=executive_summary");
  });

  it("keeps unavailable actions disabled", async () => {
    render(<DocumentActionsMenu documentId="d1" />);
    fireEvent.click(screen.getByRole("button", { name: /Actions/ }));
    const item = await screen.findByRole("menuitem", { name: /Funding reconciliation/ });
    expect((item as HTMLButtonElement).disabled).toBe(true);
  });
});
