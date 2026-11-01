import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import MappingDesigner, { attributeMeta } from "@/components/mapping/mapping-designer";
import {
  getCatalog,
  getTemplate,
  listProfiles,
  previewMapping,
  profileAction,
  suggestMapping,
  type MappingProfile,
  type OracleTemplate,
  type Preview,
} from "@/lib/oracle-templates";

let params = new URLSearchParams("template=7&document=doc-1");
vi.mock("next/navigation", () => ({ useSearchParams: () => params }));
vi.mock("@/components/source-verification-panel", () => ({ default: () => <div data-testid="source-panel" /> }));
vi.mock("@/lib/documents", () => ({ getDocument: vi.fn(() => Promise.resolve({ original_filename: "Contract - FA30.pdf", page_count: 288 })) }));
vi.mock("@/lib/oracle-templates", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/oracle-templates")>()),
  getCatalog: vi.fn(),
  getTemplate: vi.fn(),
  documentFields: vi.fn(() => Promise.resolve({
    document_id: "doc-1", staging_profile_id: "contract_v3",
    fields: [
      { ref: { kind: "field", dataset_id: "contract_overview", field: "value", shape: "pair", pair_by: "label", pair_key: "Contract Number" },
        group: "Contract Summary", label: "Contract Number", document_label: "2. CONTRACT NUMBER", sample: "FA300224C0008", page: 1,
        highlight: null, anchor: null, review_status: "Verified", section: "Contract Summary", quality: "passed" },
      { ref: { kind: "field", dataset_id: "contract_overview", field: "value", shape: "pair", pair_by: "label", pair_key: "Award Amount" },
        group: "Contract Summary", label: "Award Amount", document_label: "20. AMOUNT", sample: "USD 24,131,140.28", page: 1,
        highlight: null, anchor: null, review_status: "Needs Review", section: "Contract Summary", quality: "failed" },
    ],
  })),
  listProfiles: vi.fn(),
  listAllProfiles: vi.fn(() => Promise.resolve([])),
  suggestMapping: vi.fn(),
  previewMapping: vi.fn(),
  profileAction: vi.fn(),
  profileHistory: vi.fn(() => Promise.resolve([])),
  compareVersions: vi.fn(),
  saveProfile: vi.fn(),
}));

const TEMPLATE: OracleTemplate = {
  id: 7, object_name: "Contract Header", version: 1, filename: "Contract.csv", file_format: "csv", sheet_name: null,
  technical_row: 0, label_row: 1, warnings: [], environment: null, status: "active", uploaded_by: "Admin", uploaded_at: "",
  checksum_sha256: "x", has_display_labels: true, profile_count: 0, required_columns: ["ContractNumber"],
  columns: [
    { position: 0, technical_name: "ContractNumber", display_label: "Contract Number", required: true, data_type: "string", max_length: 30 },
    { position: 1, technical_name: "EstimatedAmount", display_label: "Amount", required: null, data_type: "number", precision: 18, scale: 2 },
    { position: 2, technical_name: "ContractType", display_label: "Type", required: null, lookup_values: ["FFP", "CPFF"] },
  ],
  catalog: {
    application: "Enterprise Contracts", integration_method: "fbdi", integration_method_label: "File-Based Data Import (FBDI)",
    oracle_release: "25A", object_code: null, parent_object: null, user_keys: [], description: null, source: "uploaded_template",
    verified: false, verified_by: null, verified_at: null, status: "draft", status_label: "Draft", status_reason: "Not yet verified by an administrator.",
  },
};

const PREVIEW: Preview = {
  template_id: 7, headers: ["ContractNumber", "EstimatedAmount", "ContractType"], display_labels: ["Contract Number", "Amount", "Type"],
  rows: [[
    { value: "FA300224C0008", review_status: "Verified", problem: null, page: 1, highlight: null, source_value: "FA300224C0008" },
    { value: "24131140.28", review_status: "Needs Review", problem: null, page: 1, highlight: null, source_value: "USD 24,131,140.28" },
    { value: "", review_status: null, problem: null, page: null, highlight: null, source_value: null },
  ]],
  total_rows: 1, issues: [], issue_counts: { error: 0, warning: 1, info: 0 }, import_ready: true, unmapped_fields: [],
  column_states: { ContractNumber: "Valid", EstimatedAmount: "Needs Review", ContractType: "Not Configured" },
  transforms: { ContractNumber: "Direct", EstimatedAmount: "Currency normalization to 2 decimals" },
  schema_status: "draft", parent: null,
};

function profile(extra: Partial<MappingProfile> = {}): MappingProfile {
  return {
    id: 3, template_id: 7, name: "FA30 Federal Contract → Oracle Enterprise Contracts", staging_profile_id: "contract_v3",
    spec: { row_dataset: null, key_columns: [], parent: null, mappings: [
      { column: "ContractNumber", source: { kind: "field", dataset_id: "contract_overview", field: "value", shape: "pair", pair_by: "label", pair_key: "Contract Number" } },
      { column: "EstimatedAmount", transform: "currency", options: { decimals: 2 },
        source: { kind: "field", dataset_id: "contract_overview", field: "value", shape: "pair", pair_by: "label", pair_key: "Award Amount" } },
    ] },
    version: 2, history: [{ version: 1, actor: "A", at: "" }, { version: 2, actor: "A", at: "" }], updated_by: "A", updated_at: "", notes: null,
    status: "draft", created_by: "A", ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  params = new URLSearchParams("template=7&document=doc-1");
  vi.mocked(getTemplate).mockResolvedValue(TEMPLATE);
  vi.mocked(previewMapping).mockResolvedValue(PREVIEW);
  vi.mocked(listProfiles).mockResolvedValue([]);
  vi.mocked(suggestMapping).mockResolvedValue({
    template_id: 7, row_dataset: null, parent_links: [],
    suggestions: [{ column: "ContractNumber", source: { kind: "field", dataset_id: "contract_overview", field: "value", shape: "pair", pair_by: "label", pair_key: "Contract Number" },
      method: "label", confidence: 0.85, reason: "Oracle label matches", required: true, needs_approval: true }],
  });
});

describe("Mapping designer — Oracle Fusion mapping workspace", () => {
  it("describes target attributes by their documented type, length and lookup", () => {
    expect(attributeMeta(TEMPLATE.columns[0])).toBe("string · max 30");
    expect(attributeMeta(TEMPLATE.columns[1])).toBe("number(18,2)");
    expect(attributeMeta(TEMPLATE.columns[2])).toBe("lookup: FFP, CPFF");
  });

  it("shows a suggestion as a proposal to accept or reject, never as approved", async () => {
    render(<MappingDesigner />);
    const actions = await screen.findByTestId("suggestion-actions");
    expect(screen.getByTestId("target-status")).toHaveTextContent("Draft target");
    expect(screen.getByTestId("target-status-note")).toHaveTextContent("only a verified target is import-ready");
    fireEvent.click(within(actions).getByRole("button", { name: /Reject the suggestion for ContractNumber/ }));
    await waitFor(() => expect(screen.queryByTestId("suggestion-actions")).toBeNull());
    expect(within(screen.getAllByTestId("mapping-row")[0]).getByRole("button", { name: /Not mapped/ })).toBeInTheDocument();
  });

  it("shows each attribute's validation state, its transformation and the mapped values preview", async () => {
    vi.mocked(listProfiles).mockResolvedValue([profile()]);
    render(<MappingDesigner />);
    const states = await screen.findAllByTestId("column-state");
    expect(states.map((s) => s.textContent)).toEqual(["Valid", "Needs Review", "Not Configured"]);
    expect(screen.getAllByTestId("attribute-meta")[0]).toHaveTextContent("string · max 30");
    // The currency transformation's settings, and the value it came from.
    expect(screen.getByTestId("transform-options")).toBeInTheDocument();
    expect(screen.getByText("from USD 24,131,140.28")).toBeInTheDocument();
    const mapped = within(screen.getByTestId("mapped-values")).getAllByRole("row").slice(1);
    expect(mapped.map((row) => [...row.querySelectorAll("td")].slice(0, 3).map((c) => c.textContent))).toEqual([
      ["FA300224C0008", "ContractNumber", "FA300224C0008"], ["USD 24,131,140.28", "EstimatedAmount", "24131140.28"],
    ]);
    expect(screen.getByTestId("profile-status")).toHaveTextContent("Draft · v2");
  });

  it("activates a saved draft profile for use", async () => {
    vi.mocked(getTemplate).mockResolvedValue({
      ...TEMPLATE,
      catalog: { ...TEMPLATE.catalog!, verified: true, status: "verified", status_label: "Verified", status_reason: null },
    });
    vi.mocked(listProfiles).mockResolvedValue([profile()]);
    vi.mocked(profileAction).mockResolvedValue(profile({ status: "active", approved_by: "Reviewer" }));
    render(<MappingDesigner />);
    fireEvent.click(await screen.findByRole("button", { name: /Activate/ }));
    await waitFor(() => expect(profileAction).toHaveBeenCalledWith(3, "activate"));
    expect(await screen.findByText(/approved and active/)).toBeInTheDocument();
    expect(screen.getByTestId("profile-status")).toHaveTextContent("Active · v2");
  });

  it("holds Activate until the target is verified, and links to setting the target up", async () => {
    vi.mocked(getTemplate).mockResolvedValue({
      ...TEMPLATE,
      catalog: { ...TEMPLATE.catalog!, application: null, integration_method: null, status_reason: "Its Oracle application and integration method aren't set." },
    });
    vi.mocked(listProfiles).mockResolvedValue([profile()]);
    render(<MappingDesigner />);
    const activate = await screen.findByRole("button", { name: /Activate/ });
    expect(activate).toBeDisabled();
    expect(activate).toHaveAttribute("title", expect.stringContaining("aren't set"));
    expect(screen.getByTestId("set-up-target")).toHaveTextContent("Set up the target");
    expect(screen.getByTestId("set-up-target")).toHaveAttribute("href", "/mapping?template=7");
    expect(profileAction).not.toHaveBeenCalled();
  });

  it("asks for a target when none is chosen, and says when none is configured", async () => {
    params = new URLSearchParams("document=doc-1");
    vi.mocked(getCatalog).mockResolvedValue({
      configured: false, message: "Oracle import template not configured", applications: [], application_names: [],
      integration_methods: {}, transformations: {}, discovery: { configured: false, provider: "none", message: "" },
    });
    render(<MappingDesigner />);
    expect(await screen.findByTestId("not-configured")).toHaveTextContent("Oracle import template not configured");
  });

  it("lists registered targets by application to map to", async () => {
    params = new URLSearchParams("document=doc-1");
    vi.mocked(getCatalog).mockResolvedValue({
      configured: true, message: null, application_names: [], integration_methods: {}, transformations: {},
      discovery: { configured: false, provider: "none", message: "" },
      applications: [{ application: "Enterprise Contracts", objects: [{ template: TEMPLATE, versions: [1] }] }],
    });
    render(<MappingDesigner />);
    const picker = await screen.findByTestId("target-picker");
    await within(picker).findByText(/Contract Header/);
    expect(within(picker).getByRole("link", { name: "Map fields" })).toHaveAttribute("href", "/mapping/designer?template=7&document=doc-1");
    expect(within(picker).getByText(/1 required/)).toBeInTheDocument();
  });
});
