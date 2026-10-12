import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DocumentsHome from "@/components/documents/documents-home";
import { deleteDocuments, getDocumentStatusCounts, searchDocuments, startProcessingJob } from "@/lib/documents";
import { downloadExport, getStagingProfile } from "@/lib/staging-workbook";
import type { DocumentSummary } from "@/types/document";

const push = vi.fn();
const replace = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => searchParams,
}));
vi.mock("@/lib/documents", () => ({
  searchDocuments: vi.fn(),
  getDocumentStatusCounts: vi.fn(),
  deleteDocuments: vi.fn(),
  startProcessingJob: vi.fn(),
}));
vi.mock("@/lib/staging-workbook", () => ({
  getStagingProfile: vi.fn(),
  downloadExport: vi.fn(),
}));

function doc(id: string, name: string, extra: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    document_id: id,
    original_filename: name,
    document_type: null,
    status: "completed",
    confidence: null,
    uploaded_at: "2026-10-01T10:00:00Z",
    page_count: 1,
    fields_extracted: 12,
    last_updated: "2026-10-02T10:00:00Z",
    staging_status: "staged",
    ...extra,
  };
}

let rows: DocumentSummary[];
let total: number;

beforeEach(() => {
  vi.clearAllMocks();
  searchParams = new URLSearchParams();
  rows = [
    doc("d1", "05_multipage_stress.pdf", { profile_id: "invoice", profile_label: "Invoice", type_label: "Invoice" }),
    doc("d2", "04_international_eur.pdf", { profile_id: "invoice", profile_label: "Invoice", type_label: "Invoice" }),
    doc("d3", "SF1442 Award_N4019223D2803.pdf", {
      profile_id: "contract_v3",
      profile_label: "Government Contract",
      type_label: "SF 1442 Contract Award",
      status: "review_required",
      fields_extracted: 40,
    }),
    doc("d4", "invoice_copy.pdf", {
      staging_status: "not_staged",
      profile_id: null,
      profile_label: null,
      type_label: null,
      status: "failed",
      fields_extracted: 0,
    }),
  ];
  total = 3209;
  vi.mocked(searchDocuments).mockImplementation(async () => ({ documents: rows, total }));
  vi.mocked(getDocumentStatusCounts).mockImplementation(async () => ({
    total,
    by_status: { review_required: 428, completed: 22, failed: 10, processing: 3 },
  }));
  vi.mocked(deleteDocuments).mockImplementation(async (ids: string[]) => {
    rows = rows.filter((row) => !ids.includes(row.document_id));
    total -= ids.length;
    return { deleted: ids, not_found: [], forbidden: [], storage_errors: [] };
  });
  vi.mocked(startProcessingJob).mockResolvedValue({
    id: 1,
    document_id: "d1",
    status: "queued",
    stage: "queued",
  } as never);
});

function row(name: string) {
  return screen.getByText(name).closest("tr") as HTMLElement;
}

describe("Documents repository (RC2-02)", { timeout: 15_000 }, () => {
  it("renders persisted Type/Profile, never a filename guess, in a wide workspace", async () => {
    render(<DocumentsHome />);
    await screen.findByText("05_multipage_stress.pdf");
    expect(screen.getByTestId("documents-home").className).not.toMatch(/max-w-/);
    expect(screen.getByRole("heading", { name: "Documents" })).toBeTruthy();
    expect(screen.getByText("Manage, review and export documents")).toBeTruthy();
    expect(screen.getByRole("link", { name: /upload document/i })).toHaveAttribute("href", "/extraction/new");
    expect(within(row("05_multipage_stress.pdf")).getAllByText("Invoice").length).toBeGreaterThan(0);
    expect(within(row("SF1442 Award_N4019223D2803.pdf")).getByText("SF 1442 Contract Award")).toBeTruthy();
    expect(within(row("invoice_copy.pdf")).queryByText("Invoice")).toBeNull();
    expect(within(row("invoice_copy.pdf")).getByText("Not staged")).toBeTruthy();
    expect(screen.queryByText(/invoice@1|contract_v3/)).toBeNull();
  });

  it("shows summary metrics and toolbar controls", async () => {
    render(<DocumentsHome />);
    await screen.findByText("05_multipage_stress.pdf");
    const summary = screen.getByTestId("documents-summary");
    expect(within(summary).getByText("3,209")).toBeTruthy();
    expect(within(summary).getByText("428")).toBeTruthy();
    expect(screen.getByTestId("documents-toolbar")).toBeTruthy();
    expect(screen.getByLabelText("Document Type")).toBeTruthy();
    expect(screen.getByLabelText("Profile")).toBeTruthy();
    expect(screen.getByLabelText("Status")).toBeTruthy();
    expect(screen.getByLabelText("Sort")).toBeTruthy();
  });

  it("searches and sorts through the API", async () => {
    render(<DocumentsHome />);
    await screen.findByText("05_multipage_stress.pdf");
    fireEvent.change(screen.getByPlaceholderText(/search by document name/i), {
      target: { value: "SF1442" },
    });
    await waitFor(() =>
      expect(searchDocuments).toHaveBeenCalledWith(
        expect.objectContaining({ q: "SF1442", sortBy: "uploaded_at", sortDir: "desc" }),
      ),
    );
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: "uploaded_at:asc" } });
    await waitFor(() =>
      expect(searchDocuments).toHaveBeenCalledWith(
        expect.objectContaining({ sortBy: "uploaded_at", sortDir: "asc" }),
      ),
    );
  });

  it("filters by profile and clears filters", async () => {
    render(<DocumentsHome />);
    await screen.findByText("05_multipage_stress.pdf");
    fireEvent.change(screen.getByLabelText("Profile"), { target: { value: "invoice" } });
    await waitFor(() =>
      expect(searchDocuments).toHaveBeenCalledWith(expect.objectContaining({ profileId: "invoice" })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear Filters" }));
    await waitFor(() =>
      expect(searchDocuments).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: undefined, q: undefined }),
      ),
    );
  });

  it("supports row selection, select visible, and bulk reprocess with partial failure reporting", async () => {
    vi.mocked(startProcessingJob)
      .mockResolvedValueOnce({ id: 1, document_id: "d1", status: "queued" } as never)
      .mockRejectedValueOnce(new Error("forbidden"));
    render(<DocumentsHome />);
    await screen.findByText("05_multipage_stress.pdf");
    fireEvent.click(screen.getByLabelText("Select 05_multipage_stress.pdf"));
    fireEvent.click(screen.getByLabelText("Select 04_international_eur.pdf"));
    const bar = screen.getByRole("region", { name: "Selection" });
    expect(within(bar).getByText("2 selected")).toBeTruthy();
    fireEvent.click(within(bar).getByRole("button", { name: "Select visible" }));
    expect(within(bar).getByText("4 selected")).toBeTruthy();
    fireEvent.click(within(bar).getByRole("button", { name: "Reprocess selected" }));
    await waitFor(() => expect(startProcessingJob).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/Reprocess started/));
    expect(screen.getByRole("status").textContent).toMatch(/failed/);
  });

  it(
    "asks before deleting and refreshes the list and counts afterwards",
    async () => {
      render(<DocumentsHome />);
      await screen.findByText("05_multipage_stress.pdf");
      fireEvent.click(screen.getByRole("button", { name: "Actions for 05_multipage_stress.pdf" }));
      expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
        "Open",
        "Review",
        "Export",
        "Reprocess",
        "Delete",
      ]);
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      expect(deleteDocuments).not.toHaveBeenCalled();
      const dialog = screen.getByRole("dialog", { name: "Delete document?" });
      expect(within(dialog).getByText("05_multipage_stress.pdf")).toBeTruthy();
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      expect(screen.queryByRole("dialog")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Actions for 05_multipage_stress.pdf" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete Document" }));
      await waitFor(() => expect(screen.queryByText("05_multipage_stress.pdf")).toBeNull());
      expect(deleteDocuments).toHaveBeenCalledWith(["d1"]);
      expect(await screen.findByText("3,208")).toBeTruthy();
      expect(screen.getByRole("status").textContent).toContain("1 document deleted");
    },
    15_000,
  );
  it("deletes a multi-selection behind the same confirmation", async () => {
    render(<DocumentsHome />);
    await screen.findByText("05_multipage_stress.pdf");
    fireEvent.click(screen.getByLabelText("Select 05_multipage_stress.pdf"));
    fireEvent.click(screen.getByLabelText("Select 04_international_eur.pdf"));
    fireEvent.click(within(screen.getByRole("region", { name: "Selection" })).getByRole("button", { name: "Delete selected" }));
    const dialog = screen.getByRole("dialog", { name: "Delete 2 documents?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete 2 Documents" }));
    await waitFor(() => expect(screen.queryByText("04_international_eur.pdf")).toBeNull());
    expect(deleteDocuments).toHaveBeenCalledWith(["d1", "d2"]);
  });

  it("opens review from the action menu and exports when staged", async () => {
    const capability = {
      capability_id: "x",
      label: "Invoice Workbook",
      format: "xlsx" as const,
      href: "/x",
      dataset_id: null,
    };
    vi.mocked(getStagingProfile).mockResolvedValue({
      profile_id: "invoice",
      profile_version: 1,
      display_name: "Invoice",
      description: "",
      document_families: [],
      export_capabilities: [capability],
      oracle_mapping_capability: "none",
    });
    render(<DocumentsHome />);
    await screen.findByText("05_multipage_stress.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Actions for 05_multipage_stress.pdf" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Review" }));
    expect(push).toHaveBeenCalledWith(expect.stringMatching(/^\/documents\/d1\/review/));
    fireEvent.click(screen.getByRole("button", { name: "Actions for 05_multipage_stress.pdf" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Export" }));
    await waitFor(() => expect(downloadExport).toHaveBeenCalledWith(capability, "05_multipage_stress"));
    fireEvent.click(screen.getByRole("button", { name: "Actions for invoice_copy.pdf" }));
    expect((screen.getByRole("menuitem", { name: "Export" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an empty state when there are no matches", async () => {
    vi.mocked(searchDocuments).mockResolvedValue({ documents: [], total: 0 });
    render(<DocumentsHome />);
    expect(await screen.findByTestId("documents-empty")).toBeTruthy();
    expect(screen.getByText(/no documents yet|no documents match/i)).toBeTruthy();
  });

  it("paginates through the API and shows loading skeleton while fetching", async () => {
    let resolveSearch!: (value: { documents: DocumentSummary[]; total: number }) => void;
    vi.mocked(searchDocuments).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSearch = resolve;
        }),
    );
    render(<DocumentsHome />);
    expect(screen.getByTestId("documents-skeleton")).toBeTruthy();
    resolveSearch({ documents: rows, total });
    await screen.findByText("05_multipage_stress.pdf");
    expect(screen.getByText("1–25 of 3,209")).toBeTruthy();

    vi.mocked(searchDocuments).mockImplementation(async (params) => ({
      documents: rows,
      total: params?.offset === 25 ? 3209 : total,
    }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() =>
      expect(searchDocuments).toHaveBeenCalledWith(expect.objectContaining({ offset: 25, limit: 25 })),
    );
  });

  it("blocks reprocess while a document is already processing", async () => {
    rows = [doc("p1", "busy.pdf", { status: "processing", staging_status: "staged", profile_id: "invoice", profile_label: "Invoice", type_label: "Invoice" })];
    total = 1;
    render(<DocumentsHome />);
    await screen.findByText("busy.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Actions for busy.pdf" }));
    expect((screen.getByRole("menuitem", { name: "Reprocess" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
