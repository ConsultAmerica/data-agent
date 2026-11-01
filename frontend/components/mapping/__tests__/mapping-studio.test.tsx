import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MappingStudioPage from "@/src/app/mapping/page";
import { searchDocuments } from "@/lib/documents";
import { getCatalog, listTemplates, uploadTemplate, verifyTemplate, type OracleCatalog, type OracleTemplate } from "@/lib/oracle-templates";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock("@/lib/documents", () => ({ searchDocuments: vi.fn() }));
vi.mock("@/lib/oracle-templates", () => ({
  listTemplates: vi.fn(),
  uploadTemplate: vi.fn(),
  retireTemplate: vi.fn(),
  downloadOriginalTemplate: vi.fn(),
  getCatalog: vi.fn(),
  updateCatalog: vi.fn(),
  verifyTemplate: vi.fn(),
  registerAttributes: vi.fn(),
  registerDiscovered: vi.fn(),
}));

function catalogEntry(status: "verified" | "draft", extra = {}) {
  return {
    application: "Enterprise Contracts", integration_method: "fbdi" as const, integration_method_label: "File-Based Data Import (FBDI)",
    oracle_release: "25A", object_code: null, parent_object: null, user_keys: [], description: null, source: "uploaded_template",
    verified: status === "verified", verified_by: status === "verified" ? "Dev Admin" : null, verified_at: null,
    status, status_label: status === "verified" ? "Verified" : "Draft", status_reason: status === "verified" ? null : "Not yet verified by an administrator.",
    ...extra,
  };
}

const CATALOG: OracleCatalog = {
  configured: true, message: null, applications: [], application_names: [], integration_methods: {}, transformations: {},
  discovery: { configured: false, provider: "none", message: "No Oracle environment is configured for metadata discovery." },
};

function template(extra: Partial<OracleTemplate> = {}): OracleTemplate {
  return {
    id: 1, object_name: "Contract", version: 2, filename: "Contract.csv", file_format: "csv", sheet_name: null,
    technical_row: 0, label_row: 1,
    columns: [
      { position: 0, technical_name: "ContractNumber", display_label: "Number", required: true },
      { position: 1, technical_name: "CurrencyCode", display_label: "Currency", required: null },
    ],
    warnings: [], environment: "TEST", status: "active", uploaded_by: "Dev Admin", uploaded_at: "2026-10-28T10:00:00Z",
    checksum_sha256: "x", has_display_labels: true, profile_count: 1, ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listTemplates).mockResolvedValue([template()]);
  vi.mocked(getCatalog).mockResolvedValue(CATALOG);
  vi.mocked(searchDocuments).mockResolvedValue({
    total: 1,
    documents: [{
      document_id: "doc-9", original_filename: "SF1442 Award.pdf", document_type: null, status: "completed",
      confidence: null, uploaded_at: "", page_count: 33, fields_extracted: 1, last_updated: "",
      staging_status: "staged", type_label: "SF 1442 Contract Award",
    }],
  });
});

describe("Mapping Studio — Template Manager", () => {
  it("lists templates and shows the detected technical names, labels and required marks in order", async () => {
    render(<MappingStudioPage />);
    const detail = await screen.findByTestId("template-detail");
    expect(within(detail).getByText(/labels on row 2/)).toBeInTheDocument();
    const rows = within(screen.getByTestId("template-columns")).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual(["1ContractNumberNumberRequired", "2CurrencyCodeCurrencyNot marked"]);
  });

  it("uploads a template and says when identical bytes were already stored", async () => {
    vi.mocked(uploadTemplate).mockResolvedValue(template({ reused: true }));
    render(<MappingStudioPage />);
    await screen.findByTestId("template-detail");
    const file = new File(["ContractNumber\n"], "Contract.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("Template file"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: /^Upload$/ }));
    expect(await screen.findByText(/already stored as Contract v2/)).toBeInTheDocument();
    expect(vi.mocked(uploadTemplate).mock.calls[0][0]).toBe(file);
  });

  it("opens the designer for a chosen extracted document", async () => {
    render(<MappingStudioPage />);
    await screen.findByTestId("template-detail");
    fireEvent.click(within(screen.getByTestId("template-list")).getByRole("button", { name: "Map a document" }));
    fireEvent.click(await screen.findByRole("button", { name: /SF1442 Award\.pdf/ }));
    expect(push).toHaveBeenCalledWith("/mapping/designer?template=1&document=doc-9");
  });

  it("groups targets by Oracle application with their status, and verifies a draft", async () => {
    vi.mocked(listTemplates).mockResolvedValue([
      template({ catalog: catalogEntry("draft"), columns: [
        { position: 0, technical_name: "ContractNumber", display_label: "Number", required: true, data_type: "string", max_length: 30 },
        { position: 1, technical_name: "CurrencyCode", display_label: "Currency", required: null, data_type: "string", lookup_values: ["USD", "EUR"] },
      ] }),
      template({ id: 2, object_name: "Supplier", catalog: null }),
    ]);
    vi.mocked(verifyTemplate).mockResolvedValue(template({ catalog: catalogEntry("verified") }));
    render(<MappingStudioPage />);
    const list = await screen.findByTestId("template-list");
    expect(within(list).getAllByTestId("application-group").map((g) => g.textContent)).toEqual(["Enterprise Contracts", "Not classified"]);
    expect(within(list).getAllByTestId("catalog-status")[0]).toHaveTextContent("Draft");
    const panel = screen.getByTestId("catalog-panel");
    expect(panel).toHaveTextContent("Enterprise Contracts · File-Based Data Import (FBDI) · 25A");
    // Documented attributes: type, length and lookup values.
    const rows = within(screen.getByTestId("template-columns")).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("string · 30");
    expect(rows[1]).toHaveTextContent("USD, EUR");
    fireEvent.click(within(panel).getByRole("button", { name: /Verify/ }));
    expect(verifyTemplate).toHaveBeenCalledWith(1);
  });

  it("says no Oracle import template is configured, and whether metadata discovery is", async () => {
    vi.mocked(listTemplates).mockResolvedValue([]);
    render(<MappingStudioPage />);
    expect(await screen.findByTestId("not-configured")).toHaveTextContent("Oracle import template not configured");
    expect(await screen.findByTestId("discovery-card")).toHaveTextContent("No Oracle environment is configured");
    expect(screen.queryByLabelText("REST resource")).toBeNull();
  });

  it("registers a template with its Oracle application and integration method", async () => {
    vi.mocked(uploadTemplate).mockResolvedValue(template());
    render(<MappingStudioPage />);
    await screen.findByTestId("template-detail");
    fireEvent.change(screen.getByLabelText("Template file"), { target: { files: [new File(["A,B\n"], "Contract.csv")] } });
    fireEvent.change(screen.getByLabelText("Oracle application"), { target: { value: "Procurement" } });
    fireEvent.change(screen.getByLabelText("Integration method"), { target: { value: "fbdi" } });
    fireEvent.click(screen.getByRole("button", { name: /^Upload$/ }));
    await screen.findByText(/columns detected/);
    expect(vi.mocked(uploadTemplate).mock.calls[0][1]).toMatchObject({ application: "Procurement", integrationMethod: "fbdi" });
  });
});
