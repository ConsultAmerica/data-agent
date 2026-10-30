import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cellSourceRequest } from "@/components/staging/review-status";
import StagingWorkbook from "@/components/staging/staging-workbook";
import { ApiError } from "@/lib/api";
import {
  downloadSelectedFieldsExport,
  getStagingWorkbook,
  type CellProvenance,
  type StagingCell,
  type StagingDataset,
  type StagingWorkbook as Workbook,
} from "@/lib/staging-workbook";

vi.mock("@/lib/original-structure", () => ({
  getOriginalStructure: vi.fn(() => new Promise(() => {})),
}));
vi.mock("@/lib/staging-workbook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/staging-workbook")>()),
  getStagingWorkbook: vi.fn(),
  downloadSelectedFieldsExport: vi.fn(),
}));

const getWorkbook = vi.mocked(getStagingWorkbook);
const exportFields = vi.mocked(downloadSelectedFieldsExport);

function provenance(overrides: Partial<CellProvenance> = {}): CellProvenance {
  return {
    source_document_id: "doc-1",
    source_filename: "Contract.pdf",
    source_type: "pdf",
    source_page: 3,
    source_bbox: null,
    evidence_text: "10301   RD-541330-SB   0.00",
    extraction_method: "table",
    source_locator: null,
    source_region_id: "clin:2",
    anchor_text: "10301",
    highlight_text: null,
    ...overrides,
  };
}

function cell(
  canonical_field: string,
  display_label: string,
  value: StagingCell["value"],
  review_status: StagingCell["review_status"],
  prov: CellProvenance | null = provenance(),
): StagingCell {
  return {
    canonical_field,
    display_label,
    value,
    raw_value: value == null ? null : String(value),
    value_type: typeof value === "number" ? "money" : "text",
    provenance: value == null ? null : prov,
    validation: { status: "passed", checks: [] },
    review_status,
    review_reasons: review_status === "Missing" ? ["No source-supported value was found for this field."] : [],
  };
}

function dataset(overrides: Partial<StagingDataset> & Pick<StagingDataset, "dataset_id" | "display_name">): StagingDataset {
  return {
    cardinality: "repeating",
    role: "business",
    description: null,
    columns: [],
    records: [],
    identity_fields: [],
    ...overrides,
  };
}

function contractWorkbook(overrides: Partial<Workbook> = {}): Workbook {
  const summaryCells = {
    "contract.contract_number": cell(
      "contract.contract_number",
      "Contract Number",
      "47QRCA25DSF07",
      "Verified",
      provenance({
        source_page: 2,
        evidence_text: "CONTRACT NUMBER -> 47QRCA25DSF07",
        anchor_text: "CONTRACT NUMBER",
        highlight_text: "47QRCA25DSF07",
        source_bbox: [10, 20, 110, 32],
      }),
    ),
    "contract.naics": cell("contract.naics", "NAICS", null, "Missing"),
  };
  return {
    document_id: "doc-1",
    document_filename: "Contract.pdf",
    profile: {
      profile_id: "contract_v3",
      profile_version: 1,
      display_name: "Contract",
      description: "",
      document_families: ["government_contract"],
      export_capabilities: [
        {
          capability_id: "professional_excel",
          label: "Professional Excel (V3 workbook)",
          format: "xlsx",
          href: "/api/documents/doc-1/v3/export.xlsx",
          dataset_id: null,
        },
      ],
      oracle_mapping_capability: "planned",
    },
    outcome: {
      status: "populated",
      title: "Extraction complete",
      message: "2 source-supported record(s) staged.",
      details: [],
      record_count: 2,
      needs_review_count: 0,
    },
    datasets: [
      dataset({
        dataset_id: "contract_summary",
        display_name: "Contract Summary",
        cardinality: "single",
        columns: Object.values(summaryCells).map((c) => ({
          canonical_field: c.canonical_field,
          key: c.canonical_field,
          display_label: c.display_label,
          value_type: "text",
          expected: true,
        })),
        records: [{ record_id: "contract_summary", cells: summaryCells, record_status: "Verified", links_to_dataset: null }],
      }),
      dataset({
        dataset_id: "clins",
        display_name: "CLINs",
        columns: [
          { canonical_field: "contract.clin.clin", key: "clin", display_label: "CLIN", value_type: "code", expected: true },
          { canonical_field: "contract.clin.max_amount", key: "max_amount", display_label: "Max Amount", value_type: "money", expected: false },
        ],
        records: [
          {
            record_id: "clin:2",
            cells: {
              "contract.clin.clin": cell("contract.clin.clin", "CLIN", "10301", "Needs Review"),
              "contract.clin.max_amount": cell(
                "contract.clin.max_amount",
                "Max Amount",
                0,
                "Needs Review",
                provenance({ highlight_text: "0.00" }),
              ),
            },
            record_status: "Needs Review",
            links_to_dataset: null,
          },
        ],
      }),
      dataset({ dataset_id: "source_documents", display_name: "Source Documents", role: "source" }),
    ],
    qa_summary: { verified: 1, needs_review: 2, missing: 1, record_count: 2 },
    processing_metadata: {
      document_family: "government_contract",
      document_family_label: "Government Contract",
      resolution_reasons: [],
      resolved_at: null,
      page_count: 92,
      source_type: "pdf",
      transcription_available: true,
    },
    ...overrides,
  };
}

// Content tests open the Summary tab (the first tab before Original Structure).
beforeEach(() => {
  window.sessionStorage.clear();
  window.sessionStorage.setItem("dx-presentation-tab:doc-1", "summary");
});

describe("StagingWorkbook load failures", () => {
  beforeEach(() => {
    getWorkbook.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("offers to drop a rejected saved key on 401, then loads without it", async () => {
    window.localStorage.setItem("data-agent-access-token", "stale-key");
    getWorkbook
      .mockRejectedValueOnce(new ApiError("Invalid bearer credential.", 401))
      .mockRejectedValueOnce(new ApiError("Not found", 404));
    render(<StagingWorkbook documentId="doc-1" />);
    expect(
      await screen.findByText("The access key saved in this browser is no longer valid."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /api keys/i })).toBeNull();
    expect(getWorkbook).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Remove saved key and retry" }));
    await waitFor(() => expect(getWorkbook).toHaveBeenCalledTimes(2));
    expect(window.localStorage.getItem("data-agent-access-token")).toBeNull();
  });

  it("explains a too-narrow saved key on 403", async () => {
    getWorkbook.mockRejectedValue(new ApiError("Forbidden", 403));
    render(<StagingWorkbook documentId="doc-1" />);
    expect(
      await screen.findByText("The access key saved in this browser can't open this workbook."),
    ).toBeInTheDocument();
    expect(getWorkbook).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying through a Render cold start instead of giving up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getWorkbook
      .mockRejectedValueOnce(new ApiError("Bad Gateway", 502))
      .mockRejectedValueOnce(new Error("Cannot reach the Dataomatix API"))
      .mockRejectedValueOnce(new ApiError("Service Unavailable", 503))
      .mockRejectedValueOnce(new ApiError("Service Unavailable", 503))
      .mockResolvedValue(contractWorkbook());
    render(<StagingWorkbook documentId="doc-1" />);
    await vi.advanceTimersByTimeAsync(40_000);
    await vi.waitFor(() => expect(getWorkbook.mock.calls.length).toBeGreaterThanOrEqual(5));
    expect(screen.queryByText("Unable to load the staging workbook.")).toBeNull();
  });

  it("fails fast on 404", async () => {
    getWorkbook.mockRejectedValue(new ApiError("Document not found", 404));
    render(<StagingWorkbook documentId="doc-1" />);
    expect(await screen.findByText("Unable to load the staging workbook.")).toBeInTheDocument();
    expect(getWorkbook).toHaveBeenCalledTimes(1);
  });
});

describe("StagingWorkbook rendering", () => {
  beforeEach(() => {
    getWorkbook.mockReset();
  });

  it("shows Source Verification under the Staging Workbook / Source tabs, above the workbook sections", async () => {
    getWorkbook.mockResolvedValue(contractWorkbook());
    render(<StagingWorkbook documentId="doc-1" sourceVerification={<div data-testid="source-verification-slot">viewer</div>} />);
    const slot = await screen.findByTestId("source-verification-slot");
    const viewTabs = screen.getByRole("tablist", { name: "Workbook views" });
    const sections = screen.getByRole("tablist", { name: "Document sections" });
    // tabs → Source Verification → the workbook's sections (Statement of Work …)
    expect(viewTabs.compareDocumentPosition(slot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.compareDocumentPosition(sections) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The Source view has its own viewer: no second one.
    fireEvent.click(within(viewTabs).getByRole("tab", { name: "Source" }));
    expect(screen.queryByTestId("source-verification-slot")).toBeNull();
    fireEvent.click(within(viewTabs).getByRole("tab", { name: "Staging Workbook" }));
    expect(await screen.findByTestId("source-verification-slot")).toBeInTheDocument();
  });

  it("renders business groups from the profile's datasets, omitting blank fields", async () => {
    getWorkbook.mockResolvedValue(contractWorkbook());
    render(<StagingWorkbook documentId="doc-1" />);

    fireEvent.click(await screen.findByRole("tab", { name: "Summary" }));
    expect(screen.getByRole("tab", { name: "Line Items" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Government Contract" })).toBeInTheDocument();
    expect(screen.getByText("47QRCA25DSF07")).toBeInTheDocument();
    // NAICS has no value: not rendered as a "—" row.
    expect(screen.queryByText("NAICS")).toBeNull();
    expect(screen.queryByText("—")).toBeNull();
    for (const technical of ["Location", "Method", "Status"]) {
      expect(screen.queryByRole("columnheader", { name: technical })).toBeNull();
    }
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("composes contracts into Contract Details, Contract Data and Clauses from source-adaptive datasets", async () => {
    const detail = (id: string, label: string, value: string, section: string, sourceLabel = label) => ({
      record_id: `detail:${id}`,
      cells: {
        "contract.detail.label": cell("contract.detail.label", "Field", label, null, null),
        "contract.detail.value": cell("contract.detail.value", "Value", value, "Verified", provenance({ source_page: 1 })),
        "contract.detail.section": cell("contract.detail.section", "Section", section, null, null),
        "contract.detail.source_label": cell("contract.detail.source_label", "Source Label", sourceLabel, null, null),
        "contract.detail.field_id": cell("contract.detail.field_id", "Field ID", id, null, null),
      },
      record_status: "Verified" as const,
      links_to_dataset: null,
    });
    const col = (canonical_field: string, display_label: string, expected = false) => ({
      canonical_field,
      key: canonical_field.split(".").pop()!,
      display_label,
      value_type: "text",
      expected,
    });
    const base = contractWorkbook();
    getWorkbook.mockResolvedValue({
      ...base,
      datasets: [
        dataset({
          dataset_id: "contract_details",
          display_name: "Contract Details",
          columns: [
            col("contract.detail.label", "Field"),
            col("contract.detail.value", "Value"),
            col("contract.detail.section", "Section"),
            col("contract.detail.source_label", "Source Label"),
            col("contract.detail.field_id", "Field ID"),
          ],
          records: [
            detail("contract.issued_by_code", "7. ISSUED BY — CODE", "N40192", "Issuing Office"),
            detail("contract.solicitation_number", "1. SOLICITATION NO.", "N4019221R28000019", "Solicitation & Award"),
            detail("contract.bonds_required", "Performance and Payment Bonds Required", "Yes", "Performance"),
          ],
        }),
        dataset({
          dataset_id: "line_items",
          display_name: "Line Items",
          columns: [
            col("contract.line.item_number", "ITEM NO", true),
            col("contract.line.quantity", "MAX QUANTITY"),
            col("contract.line.amount", "MAX AMOUNT"),
          ],
          records: [
            {
              record_id: "line_items:0:0001",
              cells: {
                "contract.line.item_number": cell("contract.line.item_number", "ITEM NO", "0001", "Verified"),
                "contract.line.quantity": cell("contract.line.quantity", "MAX QUANTITY", "600,000,000", "Verified"),
                "contract.line.amount": cell("contract.line.amount", "MAX AMOUNT", "$600,000,000.00 NTE", "Verified"),
              },
              record_status: "Verified",
              links_to_dataset: null,
            },
          ],
        }),
        dataset({
          dataset_id: "contract_clauses",
          display_name: "Clauses",
          grid_fields: [
            "contract.contract_clause.clause_number",
            "contract.contract_clause.title",
            "contract.contract_clause.date",
            "contract.contract_clause.incorporation_type",
          ],
          compact: true,
          columns: [
            col("contract.contract_clause.clause_number", "Clause Number", true),
            col("contract.contract_clause.title", "Title", true),
            col("contract.contract_clause.date", "Date"),
            col("contract.contract_clause.incorporation_type", "Incorporation Type"),
            col("contract.contract_clause.text", "Clause Text"),
          ],
          records: [
            {
              record_id: "clause:0:52.211-10",
              cells: {
                "contract.contract_clause.clause_number": cell("contract.contract_clause.clause_number", "Clause Number", "52.211-10", "Verified"),
                "contract.contract_clause.title": cell("contract.contract_clause.title", "Title", "COMMENCEMENT, PROSECUTION, AND COMPLETION OF WORK", "Verified"),
                "contract.contract_clause.date": cell("contract.contract_clause.date", "Date", "APR 1984", "Verified"),
                "contract.contract_clause.incorporation_type": cell("contract.contract_clause.incorporation_type", "Incorporation Type", "Incorporated in Full Text", "Verified"),
              },
              record_status: "Verified",
              links_to_dataset: null,
            },
          ],
        }),
        dataset({
          dataset_id: "clause_transformation",
          display_name: "Clause Transformation",
          columns: [col("contract.clause_transform.number", "Number"), col("contract.clause_transform.lock_text_yn", "Lock Text Yn")],
          records: [
            {
              record_id: "transform:0:52.211-10",
              cells: {
                "contract.clause_transform.number": cell("contract.clause_transform.number", "Number", "52.211-10", "Verified"),
                "contract.clause_transform.lock_text_yn": cell("contract.clause_transform.lock_text_yn", "Lock Text Yn", null, null),
              },
              record_status: "Verified",
              links_to_dataset: null,
            },
          ],
        }),
      ],
    });
    render(<StagingWorkbook documentId="doc-1" />);

    const tabs = (await screen.findAllByRole("tab")).map((tab) => tab.getAttribute("aria-label"));
    expect(tabs).toEqual(expect.arrayContaining(["Summary", "Line Items", "Clauses"]));
    expect(tabs).not.toContain("Contract Summary");
    const sectionTabs = within(screen.getByRole("tablist", { name: "Document sections" })).getAllByRole("tab").map((tab) => tab.textContent);
    expect(sectionTabs[0]).toBe("Original File");
    expect(sectionTabs.at(-1)).toBe("Summary");
    fireEvent.click(screen.getByRole("tab", { name: "Summary" }));
    // Sections follow the professional order; labels are the source's own.
    const headings = screen.getAllByRole("heading", { level: 4 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Solicitation & Award", "Issuing Office", "Performance"]);
    expect(screen.getByText("1. SOLICITATION NO.")).toBeInTheDocument();
    expect(screen.getByText("7. ISSUED BY — CODE")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Line Items" }));
    const headers = screen.getAllByRole("columnheader").map((th) => th.textContent?.trim()).filter(Boolean); // not the selection column
    expect(headers).toEqual(["ITEM NO", "MAX QUANTITY", "MAX AMOUNT"]);

    fireEvent.click(screen.getByRole("tab", { name: "Clauses" }));
    expect(screen.getAllByRole("columnheader").map((th) => th.textContent?.trim()).filter(Boolean)).toEqual([
      "Clause Number",
      "Title",
      "Date",
      "Incorporation Type",
    ]);
    expect(screen.getByText("Incorporated in Full Text")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Transformation View" }));
    expect(screen.getAllByRole("columnheader").map((th) => th.textContent?.trim()).filter(Boolean)).toEqual(["Number", "Lock Text Yn"]);
  });

  it("renders a different profile from metadata alone", async () => {
    getWorkbook.mockResolvedValue(
      contractWorkbook({
        profile: {
          ...contractWorkbook().profile,
          profile_id: "generic_business_document",
          display_name: "Generic Business Document",
        },
        processing_metadata: {
          ...contractWorkbook().processing_metadata,
          document_family_label: "Unknown / General Document",
        },
        datasets: [
          dataset({
            dataset_id: "key_fields",
            display_name: "Key Fields",
            columns: [
              { canonical_field: "document.field.name", key: "name", display_label: "Field", value_type: "text", expected: false },
              { canonical_field: "document.field.value", key: "value", display_label: "Value", value_type: "text", expected: true },
            ],
            records: [
              {
                record_id: "field:1",
                cells: {
                  "document.field.name": cell("document.field.name", "Field", "Email", "Verified"),
                  "document.field.value": cell("document.field.value", "Value", "billing@example.com", "Verified"),
                },
                record_status: "Verified",
                links_to_dataset: null,
              },
            ],
          }),
        ],
      }),
    );
    render(<StagingWorkbook documentId="doc-1" />);

    expect(await screen.findByRole("tab", { name: "Summary" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /Key Fields|CLINs/ })).toBeNull();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByText("billing@example.com")).toBeInTheDocument();
  });

  it("opens a value's details, then source verification with that CELL's provenance", async () => {
    getWorkbook.mockResolvedValue(contractWorkbook());
    const onOpenSource = vi.fn();
    render(<StagingWorkbook documentId="doc-1" onOpenSource={onOpenSource} />);

    fireEvent.click(await screen.findByRole("tab", { name: "Line Items" }));
    fireEvent.click(screen.getByRole("button", { name: "0.00" }));
    expect(screen.getByRole("dialog", { name: "Evidence" })).toHaveTextContent("Max Amount");
    fireEvent.click(screen.getByRole("button", { name: "View in Document" }));

    expect(onOpenSource).toHaveBeenCalledWith(
      expect.objectContaining({
        pageNumber: 3,
        highlightText: "0.00",
        anchorText: "10301",
        label: "Max Amount",
        reviewStatus: "Needs Review",
      }),
    );
  });

  it("explains a PDF Portfolio and shows its source documents instead of a blank workbook", async () => {
    const base = contractWorkbook();
    getWorkbook.mockResolvedValue({
      ...base,
      outcome: {
        status: "special_source",
        title: "PDF Portfolio: embedded documents need extraction",
        message: "This file is an Adobe PDF Portfolio.",
        details: ["SF1442 Award.pdf"],
        record_count: 0,
        needs_review_count: 0,
      },
      datasets: [
        dataset({
          dataset_id: "source_documents",
          display_name: "Source Documents",
          role: "source",
          columns: [{ canonical_field: "source.extraction_status", key: "s", display_label: "Extraction Status", value_type: "text", expected: false }],
          records: [
            {
              record_id: "source:1",
              cells: {
                "source.extraction_status": cell("source.extraction_status", "Extraction Status", "Not extracted (embedded file)", null, null),
              },
              record_status: null,
              links_to_dataset: null,
            },
          ],
        }),
      ],
    });
    render(<StagingWorkbook documentId="doc-1" />);

    expect(await screen.findByText("PDF Portfolio: embedded documents need extraction")).toBeInTheDocument();
    expect(screen.getByText("Not extracted (embedded file)")).toBeInTheDocument();
    expect(getWorkbook).toHaveBeenCalledTimes(1);
  });

  it("keeps every staged dataset in a collapsed technical view", async () => {
    getWorkbook.mockResolvedValue(contractWorkbook());
    render(<StagingWorkbook documentId="doc-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Raw staging data" }));
    for (const id of ["contract_summary", "clins", "source_documents"]) {
      expect(screen.getByRole("button", { name: id })).toBeInTheDocument();
    }
    expect(screen.getByRole("columnheader", { name: "Method" })).toBeInTheDocument();
  });
});

describe("cellSourceRequest", () => {
  it("carries the cell's anchor, highlight and region", () => {
    const request = cellSourceRequest(
      cell("contract.contract_number", "Contract Number", "47QRCA25DSF07", "Verified", provenance({
        source_page: 2,
        anchor_text: "CONTRACT NUMBER",
        highlight_text: "47QRCA25DSF07",
        source_bbox: [1, 2, 3, 4],
      })),
      "id-1",
    );
    expect(request).toMatchObject({
      pageNumber: 2,
      anchorText: "CONTRACT NUMBER",
      highlightText: "47QRCA25DSF07",
      region: [1, 2, 3, 4],
    });
  });

  it("is null for values without a source page (system facts)", () => {
    expect(
      cellSourceRequest(
        cell("document.page_count", "Pages", 3, "Verified", provenance({ source_type: "system", source_page: null })),
        "id-2",
      ),
    ).toBeNull();
  });
});


describe("Generic presentation", () => {
  beforeEach(() => getWorkbook.mockReset());

  function genericWorkbook(): Workbook {
    const base = contractWorkbook();
    const keyCell = cell("document.field.value", "Value", "516522", "Verified");
    return {
      ...base,
      profile: { ...base.profile, profile_id: "generic_business_document", profile_version: 2, display_name: "Generic" },
      datasets: [
        dataset({
          dataset_id: "document_summary",
          display_name: "Document Summary",
          cardinality: "single",
          columns: [{ canonical_field: "document.document_type", key: "document_type", display_label: "Document Type", value_type: "text", expected: true }],
          records: [
            {
              record_id: "s",
              cells: { "document.document_type": cell("document.document_type", "Document Type", "Certificate", "Verified") },
              record_status: "Verified",
              links_to_dataset: null,
            },
          ],
        }),
        dataset({
          dataset_id: "key_fields",
          display_name: "Key Fields",
          records: [{ record_id: "k", cells: { "document.field.value": keyCell }, record_status: "Verified", links_to_dataset: null }],
        }),
        dataset({ dataset_id: "contacts", display_name: "Contacts" }),
        dataset({ dataset_id: "line_items", display_name: "Line Items" }),
        dataset({ dataset_id: "other_tables", display_name: "Other Tables" }),
        dataset({ dataset_id: "all_fields", display_name: "All Fields" }),
      ],
    };
  }

  it("shows business groups only and hides empty and technical datasets", async () => {
    getWorkbook.mockResolvedValue(genericWorkbook());
    render(<StagingWorkbook documentId="doc-1" />);
    const tabs = await screen.findByRole("tablist", { name: "Document sections" });
    const labels = Array.from(tabs.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Original File", "Summary"]);
    expect(screen.getByText("Certificate")).toBeInTheDocument();
  });

  it("names the source view Source", async () => {
    getWorkbook.mockResolvedValue(genericWorkbook());
    render(<StagingWorkbook documentId="doc-1" />);
    expect(await screen.findByRole("tab", { name: "Source" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Source & Transcript" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Key Fields" })).toBeNull();
  });
});

describe("Academic transcript presentation", () => {
  beforeEach(() => getWorkbook.mockReset());

  const F = {
    name: "transcript.field.name",
    value: "transcript.field.value",
    category: "transcript.field.category",
    sourceLabel: "transcript.field.source_label",
    fieldId: "transcript.field.field_id",
  };

  function fieldRow(id: string, name: string, value: string, category: string, fieldId: string, sourceLabel: string) {
    const prov = provenance({
      source_filename: "transcript.png",
      source_type: "image",
      source_page: 1,
      evidence_text: `${sourceLabel} : ${value}`,
      extraction_method: "ocr:label_value",
      highlight_text: value,
      source_bbox: [10, 20, 90, 30],
      ocr_confidence: 0.93,
    });
    return {
      record_id: id,
      cells: {
        [F.name]: cell(F.name, "Field", name, "Verified", prov),
        [F.value]: cell(F.value, "Value", value, "Verified", prov),
        [F.category]: cell(F.category, "Category", category, null, null),
        [F.sourceLabel]: cell(F.sourceLabel, "Source Label", sourceLabel, null, null),
        [F.fieldId]: cell(F.fieldId, "Field ID", fieldId, null, null),
      },
      record_status: "Verified" as const,
      links_to_dataset: null,
    };
  }

  function transcriptWorkbook(): Workbook {
    const base = contractWorkbook();
    // Field-style columns whose display labels are canonical ids, as the
    // profile emits them — they must never reach the screen.
    const fieldColumns = [F.name, F.value, F.category, F.sourceLabel, F.fieldId].map((id) => ({
      canonical_field: id,
      key: id,
      display_label: id,
      value_type: "text",
      expected: false,
    }));
    const student = [
      fieldRow("f1", "Student Name", "Jordan Example", "Student Information", "transcript.student.name", "Name"),
      fieldRow(
        "f2",
        "Program / Degree",
        "Bachelor of Science in Computer Science",
        "Program Information",
        "transcript.program.program",
        "Program / Degree Name",
      ),
    ];
    const gpa = fieldRow("s1", "Cumulative GPA", "3.72", "Academic Summary", "transcript.summary.cumulative_gpa", "CGPA");
    const other = [
      fieldRow("o1", "Institution Phone", "+1 555 0100", "Institution Information", "transcript.institution.phone", "Tel"),
      fieldRow("o2", "Total Marks", "326", "Other Information", "transcript.other.field", "Total Marks"),
      fieldRow("o3", "Signatory", "Registrar", "Certification", "transcript.certification.entry", "Registrar"),
    ];
    const accreditation = fieldRow(
      "x1",
      "Accrediting Body",
      "Commission for University Education",
      "Accreditation",
      "transcript.other.field",
      "Accredited by",
    );
    const courseProv = provenance({
      source_page: 1,
      evidence_text: "I   ENG101   English Composition   3   A-",
      extraction_method: "ocr:course_table",
    });
    const course = {
      record_id: "c1",
      cells: {
        "transcript.course.code": cell("transcript.course.code", "Course Code", "ENG101", "Verified", courseProv),
        "transcript.course.title": cell("transcript.course.title", "Course Title", "English Composition", "Verified", courseProv),
        "transcript.course.grade": cell("transcript.course.grade", "Grade", "A-", "Verified", courseProv),
        "transcript.course.extra_1": cell("transcript.course.extra_1", "Additional Value", null, null),
      },
      record_status: "Verified" as const,
      links_to_dataset: null,
    };
    return {
      ...base,
      document_filename: "transcript.png",
      profile: { ...base.profile, profile_id: "academic_transcript", profile_version: 1, display_name: "Academic Transcript" },
      processing_metadata: {
        ...base.processing_metadata,
        document_family: "academic_transcript",
        document_family_label: "Academic Transcript",
      },
      datasets: [
        dataset({ dataset_id: "student_program", display_name: "Student & Program", columns: fieldColumns, records: student }),
        dataset({
          dataset_id: "academic_record",
          display_name: "Academic Record",
          columns: ["code", "title", "grade", "extra_1"].map((slot) => ({
            canonical_field: `transcript.course.${slot}`,
            key: slot,
            display_label:
              slot === "code" ? "Course Code" : slot === "title" ? "Course Title" : slot === "grade" ? "Grade" : "Additional Value",
            value_type: "text",
            expected: false,
          })),
          records: [course],
        }),
        dataset({ dataset_id: "academic_summary", display_name: "Academic Summary", columns: fieldColumns, records: [gpa] }),
        dataset({ dataset_id: "other_information", display_name: "Other Information", columns: fieldColumns, records: other }),
        dataset({
          dataset_id: "all_fields",
          display_name: "All Fields",
          columns: fieldColumns,
          records: [...student, gpa, ...other, accreditation].map((r) => ({ ...r, record_id: `all:${r.record_id}` })),
        }),
        dataset({ dataset_id: "qa_review", display_name: "Review", role: "qa" }),
      ],
    };
  }

  it("uses the document identity as heading, never a course title", async () => {
    getWorkbook.mockResolvedValue(transcriptWorkbook());
    render(<StagingWorkbook documentId="doc-1" />);
    expect(await screen.findByRole("heading", { name: "Academic Transcript" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "English Composition" })).toBeNull();
  });

  it("keeps a Summary of document-level details (the last tab) and no Other Information tab", async () => {
    getWorkbook.mockResolvedValue(transcriptWorkbook());
    render(<StagingWorkbook documentId="doc-1" />);
    const sections = await screen.findByRole("tablist", { name: "Document sections" });
    const labels = Array.from(sections.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Original File", "Student & Program", "Academic Record", "Academic Summary", "Summary"]);
    expect(screen.getByRole("tab", { name: "Staging Workbook" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Source" })).toBeInTheDocument();
  });

  it("shows institution, certification and accreditation as Summary cards without Category or ID columns", async () => {
    getWorkbook.mockResolvedValue(transcriptWorkbook());
    render(<StagingWorkbook documentId="doc-1" />);
    fireEvent.click(await screen.findByRole("tab", { name: "Summary" }));
    for (const title of ["Institution", "Certification", "Accreditation"]) {
      expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    }
    expect(screen.getByText("Commission for University Education")).toBeInTheDocument();
    // Total Marks belongs to Academic Summary, not Other Information.
    expect(screen.queryByText("Total Marks")).toBeNull();
    expect(document.querySelectorAll("th")).toHaveLength(0);
    expect(document.body).not.toHaveTextContent(/transcript\.(field|student|other)\./);
  });

  it("collects summary values, including those routed from other information", async () => {
    getWorkbook.mockResolvedValue(transcriptWorkbook());
    render(<StagingWorkbook documentId="doc-1" />);
    fireEvent.click(await screen.findByRole("tab", { name: "Academic Summary" }));
    expect(screen.getByText("Cumulative GPA")).toBeInTheDocument();
    expect(screen.getByText("Total Marks")).toBeInTheDocument();
  });

  it("opens a value's evidence with humanized technical details", async () => {
    getWorkbook.mockResolvedValue(transcriptWorkbook());
    render(<StagingWorkbook documentId="doc-1" />);
    fireEvent.click(await screen.findByRole("tab", { name: "Student & Program" }));
    fireEvent.click(screen.getByRole("button", { name: "Jordan Example" }));
    const dialog = screen.getByRole("dialog", { name: "Evidence" });
    expect(dialog).toHaveTextContent("Source Evidence");
    expect(dialog).toHaveTextContent("Page 1");
    expect(dialog).toHaveTextContent("Name : Jordan Example");
    expect(dialog).toHaveTextContent("OCR · Label / value pair");
    expect(dialog).toHaveTextContent("Source label");
    expect(dialog).toHaveTextContent("transcript.student.name");
    expect(dialog).not.toHaveTextContent("label_value");
    expect(screen.getByRole("button", { name: "View in Document" })).toBeInTheDocument();
  });

  it("shows only the academic record's printed columns, never empty fallbacks", async () => {
    getWorkbook.mockResolvedValue(transcriptWorkbook());
    render(<StagingWorkbook documentId="doc-1" />);
    fireEvent.click(await screen.findByRole("tab", { name: /Academic Record/ }));
    const headers = Array.from(document.querySelectorAll("thead th")).map((th) => th.textContent).filter(Boolean); // not the selection column
    expect(headers).toEqual(["Course Code", "Course Title", "Grade"]);
  });
});

describe("Invoice presentation", () => {
  beforeEach(() => getWorkbook.mockReset());

  function col(canonical_field: string, display_label: string, expected = false) {
    const key = canonical_field.split(".").pop() as string;
    return { canonical_field, key, display_label, value_type: "text", expected };
  }

  function invoiceWorkbook(): Workbook {
    const base = contractWorkbook();
    const ocr = provenance({ source_type: "image", source_page: 1, ocr_confidence: null });
    const line = (id: string, values: Record<string, string>, status: "Verified" | "Needs Review" = "Verified") => ({
      record_id: id,
      cells: Object.fromEntries(
        Object.entries(values).map(([field, value]) => [`invoice.line.${field}`, cell(`invoice.line.${field}`, field, value, status, ocr)]),
      ),
      record_status: status,
      links_to_dataset: null,
    });
    const dueDate = cell("invoice.header.due_date", "Due Date", "October 12, 2024", "Needs Review", ocr);
    dueDate.review_reasons = ["OCR confidence for this value is unavailable — confirm against the source image."];
    return {
      ...base,
      profile: { ...base.profile, profile_id: "invoice", profile_version: 1, display_name: "Invoice" },
      processing_metadata: { ...base.processing_metadata, document_family: "invoice", document_family_label: "Invoice" },
      datasets: [
        dataset({
          dataset_id: "invoice_summary",
          display_name: "Invoice Summary",
          cardinality: "single",
          columns: [
            col("invoice.header.invoice_number", "Invoice Number", true),
            col("invoice.header.due_date", "Due Date", true),
            col("invoice.header.payment_terms", "Payment Terms", true),
          ],
          records: [
            {
              record_id: "summary",
              cells: {
                "invoice.header.invoice_number": cell("invoice.header.invoice_number", "Invoice Number", "INV-1042", "Verified", ocr),
                "invoice.header.due_date": dueDate,
                "invoice.header.payment_terms": cell("invoice.header.payment_terms", "Payment Terms", null, "Missing"),
              },
              record_status: "Needs Review",
              links_to_dataset: null,
            },
          ],
        }),
        dataset({
          dataset_id: "supplier",
          display_name: "Supplier",
          cardinality: "single",
          columns: [col("invoice.supplier.name", "Supplier Name"), col("invoice.supplier.tax_id", "Tax ID"), col("invoice.supplier.email", "Email")],
          records: [
            {
              record_id: "supplier",
              cells: {
                "invoice.supplier.name": cell("invoice.supplier.name", "Supplier Name", "Green Leaf Landscaping", "Verified", ocr),
                "invoice.supplier.tax_id": cell("invoice.supplier.tax_id", "Tax ID", null, null),
                "invoice.supplier.email": cell("invoice.supplier.email", "Email", "  ", null),
              },
              record_status: "Verified",
              links_to_dataset: null,
            },
          ],
        }),
        dataset({
          dataset_id: "invoice_lines",
          display_name: "Invoice Lines",
          columns: [
            col("invoice.line.line_number", "Line"),
            col("invoice.line.description", "Description"),
            col("invoice.line.quantity", "Quantity"),
            col("invoice.line.uom", "UOM"),
            col("invoice.line.unit_price", "Unit Price"),
            col("invoice.line.amount", "Line Amount", true),
            col("invoice.line.source_table", "Table"),
          ],
          records: [
            line("l1", { description: "Lawn mowing", quantity: "4", unit_price: "$50.00", amount: "$200.00", source_table: "Table 1 (page 1)" }),
            line("l2", { description: "Hedge trimming", quantity: "2", unit_price: "$75.00", amount: "$150.00", source_table: "Table 1 (page 1)" }),
            line("l3", { unit_price: "Tax (10%)", amount: "$35.00", source_table: "Table 1 (page 1)" }, "Needs Review"),
          ],
        }),
        dataset({
          dataset_id: "totals",
          display_name: "Totals",
          cardinality: "single",
          columns: [col("invoice.total.subtotal", "Subtotal"), col("invoice.total.tax", "Tax"), col("invoice.total.invoice_amount", "Invoice Total")],
          records: [
            {
              record_id: "totals",
              cells: {
                "invoice.total.subtotal": cell("invoice.total.subtotal", "Subtotal", "$350.00", "Verified", ocr),
                "invoice.total.tax": cell("invoice.total.tax", "Tax", "$35.00", "Verified", ocr),
                "invoice.total.invoice_amount": cell("invoice.total.invoice_amount", "Invoice Total", "$385.00", "Verified", ocr),
              },
              record_status: "Verified",
              links_to_dataset: null,
            },
          ],
        }),
        dataset({ dataset_id: "taxes_charges", display_name: "Taxes / Charges" }),
        dataset({ dataset_id: "source_documents", display_name: "Source Documents", role: "source" }),
      ],
    };
  }

  it("shows invoice groups in business order", async () => {
    getWorkbook.mockResolvedValue(invoiceWorkbook());
    render(<StagingWorkbook documentId="doc-1" />);
    const nav = await screen.findByRole("tablist", { name: "Document sections" });
    const labels = Array.from(nav.querySelectorAll("[role='tab']")).map((tab) => tab.getAttribute("aria-label"));
    expect(labels).toEqual(["Original File", "Parties", "Line Items", "Charges & Totals", "Summary"]);
    // The chosen tab survives a review action that reloads the workbook.
    fireEvent.click(screen.getByRole("tab", { name: "Line Items" }));
    cleanup();
    render(<StagingWorkbook documentId="doc-1" />);
    expect(await screen.findByRole("tab", { name: "Line Items" })).toHaveAttribute("aria-selected", "true");
  });

  it("omits blank fields and replaces per-row OCR warnings with a review indicator", async () => {
    getWorkbook.mockResolvedValue(invoiceWorkbook());
    render(<StagingWorkbook documentId="doc-1" />);
    expect(await screen.findByText("INV-1042")).toBeInTheDocument();
    expect(screen.queryByText("Payment Terms")).toBeNull();
    expect(screen.queryByText(/OCR confidence/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Needs Review/ }));
    expect(screen.getByRole("dialog", { name: "Evidence" })).toHaveTextContent("OCR confidence for this value is unavailable");

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("tab", { name: "Parties" }));
    expect(within(screen.getByRole("region", { name: "Supplier" })).getByText("Green Leaf Landscaping")).toBeInTheDocument();
    expect(screen.queryByText("Tax ID")).toBeNull();
    expect(screen.queryByText("Email")).toBeNull();
  });

  it("shows only populated line columns, never the table origin", async () => {
    getWorkbook.mockResolvedValue(invoiceWorkbook());
    render(<StagingWorkbook documentId="doc-1" />);
    fireEvent.click(await screen.findByRole("tab", { name: "Line Items" }));
    const headers = Array.from(document.querySelectorAll("thead th")).map((th) => th.textContent).filter(Boolean); // not the selection column
    expect(headers).toEqual(["Description", "Qty", "Unit Price", "Amount"]);
    expect(screen.queryByText("Table 1 (page 1)")).toBeNull();
    expect(screen.queryByText("Tax (10%)")).toBeNull();
  });

  it("reads charges and totals as an invoice summary, each concept once", async () => {
    getWorkbook.mockResolvedValue(invoiceWorkbook());
    render(<StagingWorkbook documentId="doc-1" />);
    fireEvent.click(await screen.findByRole("tab", { name: "Charges & Totals" }));
    const rows = Array.from(document.querySelectorAll("dl > div")).map((row) => row.querySelector("dt")?.textContent);
    expect(rows).toEqual(["Subtotal", "Tax (10%)", "Total"]);
    expect(screen.getByText("$385.00")).toBeInTheDocument();
  });

  it("selects values in label / value lists across tabs and exports them by id", async () => {
    exportFields.mockReset();
    exportFields.mockResolvedValue();
    getWorkbook.mockResolvedValue(invoiceWorkbook());
    render(<StagingWorkbook documentId="doc-1" />);
    fireEvent.click(await screen.findByRole("tab", { name: "Parties" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all values in Supplier" }));
    fireEvent.click(screen.getByRole("tab", { name: "Charges & Totals" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Total" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Tax (10%)" }));
    expect(screen.getByTestId("selection-toolbar")).toHaveTextContent("3 values selected");

    fireEvent.click(screen.getByRole("button", { name: /Export Selected/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "CSV" }));
    await waitFor(() => expect(exportFields).toHaveBeenCalledTimes(1));
    // Ids only, in display order (Parties before Charges & Totals; Tax above Total).
    expect(exportFields.mock.calls[0][2]).toEqual([
      { dataset_id: "supplier", record_id: "supplier", field: "invoice.supplier.name" },
      { dataset_id: "invoice_lines", record_id: "l3", field: "invoice.line.amount" },
      { dataset_id: "totals", record_id: "totals", field: "invoice.total.invoice_amount" },
    ]);

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.queryByTestId("selection-toolbar")).toBeNull();
  });
});

describe("FAR staging navigation", () => {
  beforeEach(() => getWorkbook.mockReset());

  it("never shows technical FAR datasets as business tabs", async () => {
    const base = contractWorkbook();
    getWorkbook.mockResolvedValue({
      ...base,
      profile: { ...base.profile, profile_id: "far_part_52", profile_version: 1, display_name: "FAR Part 52" },
      datasets: [
        dataset({ dataset_id: "far_sections", display_name: "FAR Sections", records: [] }),
        dataset({ dataset_id: "far_clauses", display_name: "Clauses & Provisions", records: [] }),
        dataset({ dataset_id: "far_canonical", display_name: "Canonical Model", records: [] }),
        dataset({ dataset_id: "far_oracle_output_map", display_name: "Oracle Output Map", records: [] }),
        dataset({ dataset_id: "all_fields", display_name: "All Fields", records: [] }),
        dataset({ dataset_id: "source_documents", display_name: "Source Documents", role: "source", records: [] }),
        dataset({ dataset_id: "qa_review", display_name: "QA Review", role: "qa", records: [] }),
      ],
    });
    render(<StagingWorkbook documentId="doc-1" />);
    expect(await screen.findByText(/No business information was found/)).toBeInTheDocument();
    for (const label of ["FAR Sections", "Canonical Model", "Oracle Output Map", "Source Documents", "QA Review", "All Fields"]) {
      expect(screen.queryByRole("tab", { name: label })).toBeNull();
    }
    expect(screen.getByRole("tab", { name: "Source" })).toBeInTheDocument();
  });
});
