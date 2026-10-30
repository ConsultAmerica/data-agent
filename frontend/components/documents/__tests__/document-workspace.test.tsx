import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DocumentWorkspace from "@/components/documents/document-workspace";
import type { StagingCell, StagingDataset, StagingWorkbook } from "@/lib/staging-workbook";

// These tests cover the full data workspace (Advanced Grid); Smart View has its own.
beforeEach(() => window.localStorage.setItem("dx-workspace-mode", "advanced"));

let search = new URLSearchParams();
const replace = vi.fn();

vi.mock("@/lib/verification", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/verification")>()),
  getBusinessData: vi.fn(() => Promise.reject(new Error("not needed"))),
  getValidationSummary: vi.fn(() => Promise.reject(new Error("not needed"))),
}));
vi.mock("@/lib/original-structure", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/original-structure")>()),
  getOriginalStructure: vi.fn(() =>
    Promise.resolve({
      document_id: "d1", source_type: "pdf", pages: 1, sections: [], unplaced: [],
      stats: { sections: 0, fields: 0, blank_fields: 0, tables: 0, table_rows: 0, needs_review: 0, unplaced: 0 },
    }),
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  useSearchParams: () => search,
}));
vi.mock("@/lib/documents", () => ({
  getDocument: vi.fn(() =>
    Promise.resolve({
      document_id: "d1",
      original_filename: "part_52.html",
      status: "completed",
      content_type: "application/pdf",
      size_bytes: 1,
      checksum_sha256: null,
      page_count: 1,
      encrypted: false,
      uploaded_at: "2026-10-01T00:00:00Z",
      message: "",
    }),
  ),
  startProcessingJob: vi.fn(() => Promise.resolve({ id: 1, document_id: "d1", status: "queued" })),
  getDocumentHierarchy: vi.fn(() => Promise.resolve({ roots: [] })),
  getChildRelationships: vi.fn(() => Promise.resolve({ parent_document_id: "d1", children: [] })),
  getGlobalAuditLog: vi.fn(() => Promise.resolve({ entries: [], total: 0 })),
  getPageRender: vi.fn(() => new Promise(() => undefined)),
  getSourceStructure: vi.fn(() => Promise.resolve({ document_id: "d1", field_candidates: [], table_candidates: [] })),
  getDocumentPages: vi.fn(() => Promise.resolve([])),
}));
// The split pane's viewer: shows which page/value it was asked to open.
vi.mock("@/components/source-verification-panel", () => ({
  default: ({ request }: { request: { pageNumber: number; label?: string } | null }) => (
    <p data-testid="split-viewer-request">{request ? `page ${request.pageNumber}: ${request.label ?? ""}` : "page 1"}</p>
  ),
}));
vi.mock("@/lib/source-view", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/source-view")>()),
  getSourceView: vi.fn(async () => ({ viewer: "pdf", format: "pdf", verified: true, note: null })),
}));
vi.mock("@/components/staging/source-transcription", () => ({
  default: () => <p>Source transcription</p>,
}));
vi.mock("@/lib/staging-workbook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staging-workbook")>()),
  getStagingWorkbook: vi.fn(() => Promise.resolve(workbook())),
}));

function cell(field: string, label: string, value: string | null): StagingCell {
  return {
    canonical_field: field,
    display_label: label,
    value,
    raw_value: value,
    value_type: "text",
    provenance: null,
    validation: { status: "passed", checks: [] },
    review_status: value ? "Verified" : null,
    review_reasons: [],
    source_column: null,
  };
}

function farRecord(number: string, title: string, type: string, alternate: string | null = null) {
  return {
    record_id: `far_records:${number}:${alternate ?? ""}`,
    record_status: "Verified" as const,
    links_to_dataset: null,
    cells: {
      "far.record.far_number": cell("far.record.far_number", "FAR Number", number),
      "far.record.title": cell("far.record.title", "Title", title),
      "far.record.record_type": cell("far.record.record_type", "Record Type", type),
      "far.record.alternate": cell("far.record.alternate", "Alternate", alternate),
    },
  };
}

function dataset(id: string, name: string, role: StagingDataset["role"], records: StagingDataset["records"]): StagingDataset {
  const columns = Object.values(records[0]?.cells ?? {}).map((c) => ({
    canonical_field: c.canonical_field,
    key: c.canonical_field,
    display_label: c.display_label,
    value_type: "text" as const,
    expected: false,
  }));
  return { dataset_id: id, display_name: name, cardinality: "repeating", role, description: null, columns, records, identity_fields: [] };
}

function workbook(): StagingWorkbook {
  return {
    document_id: "d1",
    document_filename: "part_52.html",
    profile: {
      profile_id: "far_part_52",
      profile_version: 1,
      display_name: "FAR Part 52",
      description: "",
      document_families: [],
      export_capabilities: [],
      oracle_mapping_capability: "planned",
      views: [
        { view_id: "far_records", label: "FAR Clauses & Provisions", dataset_ids: ["far_records"], kind: "records" },
        { view_id: "oracle_output", label: "Oracle Output", dataset_ids: ["far_oracle_output"], kind: "records" },
        { view_id: "source", label: "Source", dataset_ids: ["far_source"], kind: "source" },
      ],
    },
    outcome: { status: "populated", title: "Extraction complete", message: "", record_count: 3 },
    datasets: [
      dataset("far_records", "FAR Clauses & Provisions", "business", [
        farRecord("52.202-1", "Definitions", "Clause"),
        farRecord("52.215-1", "Instructions to Offerors", "Provision"),
        farRecord("52.215-1", "Instructions to Offerors", "Provision", "Alternate I"),
      ]),
      dataset("far_oracle_output", "Oracle Output", "transform", [
        { record_id: "o1", record_status: null, links_to_dataset: null, cells: { "far.oracle.action": cell("far.oracle.action", "Action", "Sync") } },
      ]),
      dataset("far_source", "Source", "source", [
        { record_id: "s1", record_status: null, links_to_dataset: null, cells: { "far.source.item": cell("far.source.item", "Item", "Source Document") } },
      ]),
    ],
    qa_summary: { verified: 3, needs_review: 0, missing: 0, record_count: 3 },
    processing_metadata: {},
  } as unknown as StagingWorkbook;
}

describe("DocumentWorkspace with a profile-declared presentation", () => {
  beforeEach(() => {
    // These tests read the profile's own first view; Results is covered below.
    search = new URLSearchParams("view=far_records");
    replace.mockReset();
  });

  it("opens on Results, followed by only the profile's tabs", async () => {
    search = new URLSearchParams();
    render(<DocumentWorkspace documentId="d1" />);
    const tabs = within(await screen.findByRole("tablist", { name: "Document views" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Results", "FAR Clauses & Provisions", "Oracle Output", "Source"]);
    // Every document opens on Results; the profile's own tabs follow.
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    for (const generic of ["Overview", "Staging", "Canonical", "Transform", "QA"]) {
      expect(screen.queryByRole("tab", { name: generic })).toBeNull();
    }
    fireEvent.click(tabs[2]);
    expect(replace).toHaveBeenCalledWith("/documents/d1?view=oracle_output");
  });

  it("Export menu offers Default and Custom; Custom opens the import-file builder", async () => {
    render(<DocumentWorkspace documentId="d1" />);
    await screen.findAllByRole("tab");
    fireEvent.click(screen.getByTestId("export-menu-trigger"));
    const menu = screen.getByTestId("export-menu");
    const types = within(menu).getByRole("tablist", { name: "Export type" });
    expect(within(types).getByRole("tab", { name: "Default" }).getAttribute("aria-selected")).toBe("true");
    expect(within(menu).getByText(/Staging — Export All/i)).toBeTruthy();
    fireEvent.click(within(types).getByRole("tab", { name: "Custom" }));
    expect(within(menu).queryByText(/Staging — Export All/i)).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Open custom export/ }));
    expect(screen.getByRole("dialog", { name: "Custom export" })).toBeTruthy();
  });

  it("opens Custom export from Smart View too", async () => {
    window.localStorage.setItem("dx-workspace-mode", "smart");
    render(<DocumentWorkspace documentId="d1" />);
    await screen.findByTestId("smart-workspace");
    fireEvent.click(screen.getByTestId("export-menu-trigger"));
    const menu = screen.getByTestId("export-menu");
    fireEvent.click(within(within(menu).getByRole("tablist", { name: "Export type" })).getByRole("tab", { name: "Custom" }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Open custom export/ }));
    expect(screen.getByRole("dialog", { name: "Custom export" })).toBeTruthy();
  });

  it("opens on Original Structure, the first view, when no view was chosen", async () => {
    window.localStorage.removeItem("dx-workspace-mode");
    render(<DocumentWorkspace documentId="d1" />);
    await screen.findByTestId("original-structure");
    // Original Structure first, Summary last; Tables and Oracle only when used.
    const views = screen.getByRole("tablist", { name: "Document workspace" });
    expect(within(views).getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Original Structure",
      "Smart Review",
      "Advanced Grid",
      "Validation",
      "Oracle / Mapping",
      "History",
      "Summary",
    ]);
    expect(within(views).getByRole("tab", { name: "Original Structure" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("button", { name: /More views/ }));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([expect.stringContaining("Smart View")]);
  });

  it("Export menu: scope summary, Export Selected disabled until selection, Oracle toggle", async () => {
    render(<DocumentWorkspace documentId="d1" />);
    await screen.findAllByRole("tab");
    fireEvent.click(screen.getByTestId("export-menu-trigger"));
    const menu = screen.getByTestId("export-menu");
    expect(within(menu).getByText(/Staging — Export All/i)).toBeTruthy();
    expect(within(menu).getByText(/No staging cells selected/i)).toBeTruthy();
    expect(within(menu).getByText(/Metadata export/i)).toBeTruthy();
    for (const label of ["Excel", "CSV", "JSON"]) {
      expect((within(menu).getByRole("menuitem", { name: label }) as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getByTestId("export-menu-trigger"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select record 52.202-1" }));
    fireEvent.click(screen.getByTestId("export-menu-trigger"));
    const openMenu = screen.getByTestId("export-menu");
    expect(within(openMenu).getByText(/Selection:/)).toBeTruthy();
    expect(within(openMenu).getByText(/\d+ cell/)).toBeTruthy();
    expect((within(openMenu).getByRole("menuitem", { name: "Excel" }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByTestId("toggle-oracle-panel"));
    expect(screen.getByTestId("oracle-integration-panel")).toBeTruthy();
  });

  it("names a records tab after its dataset (a FAR Part's table is its FAR Data)", async () => {
    const staging = await import("@/lib/staging-workbook");
    const base = workbook();
    vi.mocked(staging.getStagingWorkbook).mockResolvedValueOnce({
      ...base,
      datasets: base.datasets.map((d) => (d.dataset_id === "far_records" ? { ...d, display_name: "FAR Data" } : d)),
    } as StagingWorkbook);
    render(<DocumentWorkspace documentId="d1" />);
    const tabs = within(await screen.findByRole("tablist", { name: "Document views" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Results", "FAR Data", "Oracle Output", "Source"]);
  });

  it("shows FAR records as a compact grid with alternates kept under their record", async () => {
    render(<DocumentWorkspace documentId="d1" />);
    const filters = await screen.findByRole("group", { name: "Filter by record type" });
    const labels = within(filters).getAllByRole("button").map((button) => button.textContent);
    // The alternate belongs to 52.215-1: two FAR records, no "Alternate" peer type.
    expect(labels).toEqual(["All 2", "Clause 1", "Provision 1"]);
    expect(screen.getByLabelText("Review status")).toBeTruthy();
    const row = screen.getByRole("row", { name: /52\.215-1/ });
    expect(within(row).getByText("Alternate I")).toBeTruthy();
    fireEvent.click(within(filters).getByRole("button", { name: /Clause/ }));
    expect(screen.queryByRole("row", { name: /52\.215-1/ })).toBeNull();
  });

  it("shows compact type/profile/status and returns to Documents with preserved filters", async () => {
    search = new URLSearchParams("return=filter%3Dreview%26q%3DSF1442");
    render(<DocumentWorkspace documentId="d1" />);
    await screen.findByRole("heading", { name: "part_52.html" });
    expect(screen.getByTestId("workspace-profile").textContent).toBe("FAR Part 52");
    expect(screen.getByTestId("workspace-type").textContent).toBeTruthy();
    const status = screen.getByTestId("workspace-status");
    expect(within(status).getByText("Complete")).toBeTruthy();
    expect(within(status).getByText(/Staging Verified/)).toBeTruthy();
    expect(screen.getByTestId("return-to-documents")).toHaveAttribute(
      "href",
      "/documents?filter=review&q=SF1442",
    );
    expect(screen.getByRole("button", { name: "Reprocess document" })).toBeTruthy();
  });

  it("preserves the return query when switching tabs", async () => {
    search = new URLSearchParams("return=family%3Dinvoice");
    render(<DocumentWorkspace documentId="d1" />);
    const tabs = within(await screen.findByRole("tablist", { name: "Document views" })).getAllByRole("tab");
    fireEvent.click(tabs[2]);
    expect(replace).toHaveBeenCalledWith("/documents/d1?view=oracle_output&return=family%3Dinvoice");
  });

  it("opens the source tab with the source datasets and transcription", async () => {
    search = new URLSearchParams("view=source");
    render(<DocumentWorkspace documentId="d1" />);
    expect(await screen.findByText("Source Document")).toBeTruthy();
    expect(screen.getByText("Source transcription")).toBeTruthy();
  });
});

describe("DocumentWorkspace for a contract", () => {
  function contractWorkbook(): StagingWorkbook {
    const base = workbook();
    const row = (id: string, section: string, type: string, title: string) => ({
      record_id: id,
      record_status: "Verified" as const,
      links_to_dataset: null,
      cells: {
        "contract.data.section": cell("contract.data.section", "Section", section),
        "contract.data.record_type": cell("contract.data.record_type", "Record Type", type),
        "contract.data.title": cell("contract.data.title", "Field / Title", title),
      },
    });
    const summary = (id: string, group: string, label: string, value: string) => ({
      record_id: id,
      record_status: null,
      links_to_dataset: null,
      cells: {
        "contract.overview.group": cell("contract.overview.group", "Category", group),
        "contract.overview.label": cell("contract.overview.label", "Field", label),
        "contract.overview.value": cell("contract.overview.value", "Value", value),
      },
    });
    return {
      ...base,
      profile: {
        ...base.profile,
        profile_id: "contract_v3",
        views: [
          { view_id: "contract_data", label: "Contract Data", dataset_ids: ["contract_data"], kind: "records" },
          { view_id: "contract_summary", label: "Contract Summary", dataset_ids: ["contract_overview"], kind: "records" },
        ],
      },
      datasets: [
        dataset("contract_data", "Contract Data", "business", [
          row("d1", "Overview", "Field", "1. SOLICITATION NO."),
          row("d2", "CLINs", "CLIN", "ALL SERVICES"),
          row("d3", "FAR Clauses", "Clause", "Gratuities"),
        ]),
        dataset("contract_overview", "Contract Summary", "business", [
          summary("s1", "Contract Identification", "Contract Number", "FA300224C0008"),
          summary("s2", "Document Statistics", "FAR Clauses", "124"),
        ]),
      ],
    } as StagingWorkbook;
  }

  beforeEach(async () => {
    search = new URLSearchParams("view=contract_data");
    const staging = await import("@/lib/staging-workbook");
    vi.mocked(staging.getStagingWorkbook).mockResolvedValue(contractWorkbook());
  });

  it("filters Contract Data by section", async () => {
    render(<DocumentWorkspace documentId="d1" />);
    const select = await screen.findByLabelText("Filter by section");
    fireEvent.change(select, { target: { value: "FAR Clauses" } });
    expect(screen.getByText("Gratuities")).toBeTruthy();
    expect(screen.queryByText("ALL SERVICES")).toBeNull();
  });

  it("shows the Contract Summary as one card per category", async () => {
    search = new URLSearchParams("view=contract_summary");
    render(<DocumentWorkspace documentId="d1" />);
    expect(await screen.findByRole("heading", { name: "Contract Identification" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Document Statistics" })).toBeTruthy();
    expect(screen.getByText("FA300224C0008")).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("split view keeps the document open on the left and a value's source jumps it to the page", async () => {
    window.localStorage.removeItem("dx-workspace-split");
    const staging = await import("@/lib/staging-workbook");
    const base = contractWorkbook();
    const gratuities = base.datasets[0].records[2].cells["contract.data.title"];
    gratuities.provenance = {
      source_document_id: "d1",
      source_filename: "award.pdf",
      source_type: "pdf",
      source_page: 7,
      source_bbox: null,
      evidence_text: "Gratuities",
      extraction_method: "text",
      source_locator: null,
      source_region_id: null,
      anchor_text: null,
      highlight_text: "Gratuities",
    };
    vi.mocked(staging.getStagingWorkbook).mockResolvedValue(base);
    render(<DocumentWorkspace documentId="d1" />);
    const toggle = await screen.findByTestId("toggle-split-view");
    expect(screen.queryByTestId("workspace-split-viewer")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem("dx-workspace-split")).toBe("on");
    // The format-aware viewer opens (asynchronously) at page 1.
    expect((await screen.findByTestId("split-viewer-request")).textContent).toMatch(/^page 1/);

    fireEvent.click(screen.getByRole("button", { name: "Gratuities" }));
    expect(screen.getByTestId("split-viewer-request").textContent).toMatch(/^page 7/);
    // The structured data stays put: no jump to the Source tab.
    expect(replace).not.toHaveBeenCalledWith(expect.stringContaining("view=source"));
    window.localStorage.removeItem("dx-workspace-split");
  });

  it("shows an agency tag (— when unknown) and a related-documents switcher only when links exist", async () => {
    const documents = await import("@/lib/documents");
    vi.mocked(documents.getDocumentHierarchy).mockClear();
    render(<DocumentWorkspace documentId="d1" />);
    expect((await screen.findByTestId("workspace-agency")).textContent).toBe("—");
    // The first render must have fetched its (empty) hierarchy before the
    // one-time answer below is queued, or it would take that answer itself.
    await waitFor(() => expect(documents.getDocumentHierarchy).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("related-documents-switcher")).toBeNull());

    vi.mocked(documents.getDocumentHierarchy).mockResolvedValueOnce({
      roots: [
        {
          document_id: "base",
          title: "Base award",
          document_number: "N40192-23-D-2803",
          document_type: null,
          relationship_type: null,
          relationship_status: null,
          children: [
            { document_id: "d1", title: "Mod 1", document_number: null, document_type: null, relationship_type: "modification", relationship_status: "confirmed", children: [] },
            { document_id: "m2", title: "Mod 2", document_number: "P00002", document_type: null, relationship_type: "modification", relationship_status: "confirmed", children: [] },
          ],
        },
      ],
    });
    render(<DocumentWorkspace documentId="d1" />);
    const switcher = await screen.findByTestId("related-documents-switcher");
    fireEvent.click(within(switcher).getByRole("button", { name: /Related documents \(2\)/ }));
    const items = within(switcher).getAllByRole("menuitem");
    expect(items.map((item) => item.getAttribute("href"))).toEqual(["/documents/base", "/documents/m2"]);
    expect(items[0].textContent).toMatch(/Base award.*Parent.*N40192-23-D-2803/);
  });

  it("selects Contract Summary lines for export without touching their review state", async () => {
    search = new URLSearchParams("view=contract_summary");
    render(<DocumentWorkspace documentId="d1" />);
    await screen.findByRole("heading", { name: "Contract Identification" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Contract Number" }));
    expect(screen.getByTestId("selection-toolbar").textContent).toMatch(/3 cells selected.*1 record.*3 fields/);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    const menu = screen.getByRole("menu");
    expect((within(menu).getByRole("menuitem", { name: "CSV" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("DocumentWorkspace combines small dataset tabs", () => {
  // The Summary tab (?view=staging; documents open on it).
  function rows(prefix: string, field: string, label: string, n: number) {
    return Array.from({ length: n }, (_, i) => ({
      record_id: `${prefix}:${i}`,
      record_status: "Verified" as const,
      links_to_dataset: null,
      cells: { [field]: cell(field, label, `${label} ${i + 1}`) },
    }));
  }

  function invoiceWorkbook(): StagingWorkbook {
    const single = (id: string, name: string, field: string, label: string) => ({
      ...dataset(id, name, "business", rows(id, field, label, 1)),
      cardinality: "single" as const,
    });
    return {
      ...workbook(),
      profile: { ...workbook().profile, profile_id: "invoice", display_name: "Invoice", views: [] },
      datasets: [
        single("invoice_summary", "Invoice Summary", "invoice.number", "Invoice Number"),
        single("supplier", "Supplier", "invoice.supplier.name", "Supplier Name"),
        dataset("invoice_lines", "Invoice Lines", "business", rows("lines", "invoice.line.description", "Description", 6)),
        dataset("taxes_charges", "Taxes / Charges", "business", rows("tax", "invoice.tax.name", "Tax", 2)),
        dataset("distributions", "Distributions", "business", []),
      ],
    } as unknown as StagingWorkbook;
  }

  beforeEach(async () => {
    search = new URLSearchParams("view=staging");
    const staging = await import("@/lib/staging-workbook");
    vi.mocked(staging.getStagingWorkbook).mockResolvedValue(invoiceWorkbook());
  });

  it("orders generic tabs Summary, Overview, Source, Canonical, Transform; Data and QA live under More", async () => {
    search = new URLSearchParams();
    render(<DocumentWorkspace documentId="d1" />);
    const views = within(await screen.findByRole("tablist", { name: "Document views" })).getAllByRole("tab");
    expect(views.map((tab) => tab.textContent)).toEqual(["Results", "Summary", "Overview", "Source", "Canonical", "Transform"]);
    expect(views[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "QA" }));
    expect(replace).toHaveBeenCalledWith("/documents/d1?view=qa");
  });

  it("puts datasets of 5 records or fewer on one tab, each as its own section; larger ones keep their tab", async () => {
    render(<DocumentWorkspace documentId="d1" />);
    const datasetTabs = within(await screen.findByRole("tablist", { name: "Datasets" })).getAllByRole("tab");
    // Empty datasets get no tab; the three small ones share "Details" where the first was.
    expect(datasetTabs.map((tab) => tab.textContent)).toEqual(["Details4", "Invoice Lines6"]);
    expect(datasetTabs[0].getAttribute("aria-selected")).toBe("true");
    for (const name of ["Invoice Summary", "Supplier", "Taxes / Charges"]) {
      expect(screen.getByRole("region", { name })).toBeTruthy();
    }
    fireEvent.click(datasetTabs[1]);
    expect(screen.queryByRole("region", { name: "Supplier" })).toBeNull();
    expect(screen.getByText("Description 6")).toBeTruthy();
  });

  it("searches across the combined sections", async () => {
    render(<DocumentWorkspace documentId="d1" />);
    fireEvent.change(await screen.findByLabelText("Search Details"), { target: { value: "Tax 2" } });
    expect(screen.getByText("Tax 2")).toBeTruthy();
    expect(screen.queryByText("Tax 1")).toBeNull();
  });
});
