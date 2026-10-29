import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MappingStudioPage from "@/src/app/mapping/page";
import { searchDocuments } from "@/lib/documents";
import { listTemplates, uploadTemplate, type OracleTemplate } from "@/lib/oracle-templates";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock("@/lib/documents", () => ({ searchDocuments: vi.fn() }));
vi.mock("@/lib/oracle-templates", () => ({
  listTemplates: vi.fn(),
  uploadTemplate: vi.fn(),
  retireTemplate: vi.fn(),
  downloadOriginalTemplate: vi.fn(),
}));

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
});
