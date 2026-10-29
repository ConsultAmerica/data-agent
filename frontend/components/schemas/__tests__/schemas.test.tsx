import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SchemaDesigner from "@/components/schemas/schema-designer";
import SchemaForm from "@/components/schemas/schema-form";
import SchemaLibraryPage from "@/src/app/schemas/page";
import { searchDocuments } from "@/lib/documents";
import {
  createSchema,
  discoverFields,
  getSchema,
  getVersion,
  listSchemas,
  mergeDefinition,
  saveVersion,
  transition,
  type Definition,
  type Form,
  type SchemaDetail,
  type VersionDetail,
} from "@/lib/doc-schemas";

const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/documents", () => ({ searchDocuments: vi.fn() }));
vi.mock("@/lib/doc-schemas", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/doc-schemas")>()),
  listSchemas: vi.fn(), getSchema: vi.fn(), getVersion: vi.fn(), saveVersion: vi.fn(), transition: vi.fn(),
  createSchema: vi.fn(), discoverFields: vi.fn(), previewForm: vi.fn(), effectiveByVersion: vi.fn(),
  exportSchema: vi.fn(), newDraft: vi.fn(), duplicateSchema: vi.fn(), extendSchema: vi.fn(), archiveSchema: vi.fn(), importSchema: vi.fn(),
}));

const PARENT: Definition = {
  groups: [{ group_id: "header", label: "Header", kind: "section", fields: [
    { field_id: "contract.number", label: "Contract Number", type: "identifier", order: 0 },
    { field_id: "contract.currency", label: "Currency", type: "text", order: 10 },
  ], children: [] }],
  rules: [], overrides: {},
};

function version(extra: Partial<VersionDetail> = {}): VersionDetail {
  return {
    schema_id: 7,
    version: { id: 70, version: "1.0", status: "draft", parent_version_id: null, parent: null, author: "Dev", created_at: "", updated_at: "", published_at: null, published_by: null, change_summary: null, documents: 0 },
    definition: structuredClone(PARENT), effective: structuredClone(PARENT), inherited_field_ids: [], problems: [], editable: true,
    ...extra,
  };
}

function schema(extra: Partial<SchemaDetail> = {}): SchemaDetail {
  return {
    id: 7, schema_key: "acme", name: "Acme Order", category: "contracts", description: null, is_system: false, profile_id: null, family: null,
    archived: false, latest: version().version, published: null, versions: 1, documents: 0, parent: null,
    all_versions: [version().version], events: [{ action: "create", actor: "Dev", version_id: 70, detail: null, at: "2026-10-29T10:00:00Z" }],
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSchema).mockResolvedValue(schema());
  vi.mocked(getVersion).mockResolvedValue(version());
  vi.mocked(saveVersion).mockImplementation(async (_s, _v, body) => version({ definition: body.definition }));
  vi.mocked(searchDocuments).mockResolvedValue({ documents: [], total: 0 });
});

describe("mergeDefinition", () => {
  it("applies overrides to inherited fields and appends own fields without touching the parent", () => {
    const own: Definition = {
      groups: [{ group_id: "header", label: "Header", kind: "section", fields: [{ field_id: "x.note", label: "Note", type: "text", order: 5 }], children: [] }],
      rules: [], overrides: { "contract.currency": { label: "Billing Currency", visible: false } },
    };
    const merged = mergeDefinition(PARENT, own);
    expect(merged.groups[0].fields.map((f) => [f.field_id, f.label])).toEqual([
      ["contract.number", "Contract Number"], ["x.note", "Note"], ["contract.currency", "Billing Currency"],
    ]);
    expect(PARENT.groups[0].fields[1].label).toBe("Currency");
  });
});

describe("SchemaForm", () => {
  const form: Form = {
    found: 1, not_found: 1,
    issues: [{ severity: "error", rule_id: "r", field_id: "contract.currency", message: "Currency is required.", row: null }],
    groups: [
      { group_id: "header", label: "Header", kind: "section", description: null, columns: [], rows: [], total_rows: 0, page_size: 25, children: [],
        fields: [
          { field_id: "contract.number", label: "Contract Number", type: "identifier", required: true, description: null, instructions: null,
            value: { value: "FA30", status: "found", review_status: "Verified", page: 1, highlight: "FA30", document_label: "2. CONTRACT NUMBER", method: null } },
          { field_id: "contract.currency", label: "Currency", type: "text", required: false, description: null, instructions: null,
            value: { value: "", status: "not_found", review_status: null, page: null, highlight: null, document_label: null, method: null } },
        ] },
      { group_id: "lines", label: "Lines", kind: "repeating", description: null, fields: [], children: [], page_size: 5, total_rows: 7,
        columns: [{ field_id: "line.no", label: "CLIN", type: "identifier", required: false, description: null, instructions: null,
          value: { value: "", status: "not_found", review_status: null, page: null, highlight: null, document_label: null, method: null } }],
        rows: Array.from({ length: 7 }, (_, i) => ({ row_id: `r${i}`, children: [], cells: { "line.no": { value: `000${i + 1}`, status: "found", review_status: null, page: null, highlight: null, document_label: null, method: null } } })) },
    ],
  };

  it("renders groups as tabs, values with evidence, issues, and paginated tables", () => {
    const onEvidence = vi.fn();
    render(<SchemaForm form={form} onEvidence={onEvidence} />);
    expect(screen.getByTestId("schema-form-issues")).toHaveTextContent("Currency is required.");
    fireEvent.click(screen.getByRole("button", { name: /FA30/ }));
    expect(onEvidence).toHaveBeenCalledWith(form.groups[0].fields[0].value, "Contract Number");
    fireEvent.click(screen.getByRole("tab", { name: /Lines/ }));
    expect(screen.getAllByRole("row")).toHaveLength(6); // header + 5 rows on page 1
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("0007")).toBeInTheDocument();
  });

  it("makes each field card selectable, by click or keyboard, and marks the selected one", () => {
    const onSelectField = vi.fn();
    const onEvidence = vi.fn();
    const { rerender } = render(<SchemaForm form={form} onEvidence={onEvidence} onSelectField={onSelectField} />);
    const card = screen.getByRole("button", { name: "Contract Number: FA30, page 1. Show details and source." });
    expect(card).toHaveAttribute("aria-pressed", "false");
    expect(within(card).getByText("p. 1 ›")).toBeInTheDocument();
    fireEvent.click(card);
    expect(onSelectField).toHaveBeenCalledWith(form.groups[0].fields[0]);
    // The card is the control; the value inside is not a second button.
    expect(onEvidence).not.toHaveBeenCalled();

    const missing = screen.getByRole("button", { name: "Currency: not found. Show details and source." });
    fireEvent.keyDown(missing, { key: "Enter" });
    expect(onSelectField).toHaveBeenLastCalledWith(form.groups[0].fields[1]);

    rerender(<SchemaForm form={form} onEvidence={onEvidence} onSelectField={onSelectField} selectedFieldId="contract.number" />);
    expect(screen.getByRole("button", { name: /^Contract Number: FA30/ })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("FieldDetails", () => {
  it("shows the value, how it was found and its source page, or says no page was recorded", async () => {
    const { default: FieldDetails } = await import("@/components/smart-view/field-details");
    const onViewSource = vi.fn();
    const [found, missing] = [
      { field_id: "contract.number", label: "Contract Number", type: "identifier", required: true, description: null, instructions: null,
        value: { value: "FA30", status: "found", review_status: "Verified", page: 1, highlight: "FA30", document_label: "2. CONTRACT NUMBER", method: null } },
      { field_id: "contract.currency", label: "Currency", type: "text", required: false, description: null, instructions: null,
        value: { value: "", status: "not_found", review_status: null, page: null, highlight: null, document_label: null, method: null } },
    ] as Form["groups"][number]["fields"];
    const { rerender } = render(<FieldDetails field={found} documentId="doc-1" onViewSource={onViewSource} onClose={vi.fn()} />);
    const panel = screen.getByTestId("field-details");
    expect(within(panel).getByText("FA30")).toBeInTheDocument();
    expect(within(panel).getByText("Found in the document")).toBeInTheDocument();
    expect(within(panel).getByText("2. CONTRACT NUMBER")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "View in source" }));
    expect(onViewSource).toHaveBeenCalledWith(expect.objectContaining({ pageNumber: 1, highlightText: "FA30", label: "Contract Number" }));

    rerender(<FieldDetails field={missing} documentId="doc-1" onViewSource={onViewSource} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "View in source" })).toBeNull();
    expect(screen.getByText(/No source page was recorded/)).toBeInTheDocument();
  });
});

describe("SchemaDesigner", () => {
  it("adds a field from the palette and autosaves the draft", async () => {
    render(<SchemaDesigner schemaId={7} />);
    await screen.findByTestId("schema-canvas");
    fireEvent.click(within(screen.getByTestId("field-palette")).getByRole("button", { name: /Currency/ }));
    expect(screen.getAllByTestId("schema-field")).toHaveLength(3);
    expect(screen.getByTestId("field-properties")).toBeInTheDocument();
    expect(screen.getByTestId("save-state")).toHaveTextContent("Unsaved changes");
    await waitFor(() => expect(saveVersion).toHaveBeenCalled(), { timeout: 3000 });
    const saved = vi.mocked(saveVersion).mock.calls[0][2].definition;
    expect(saved.groups[0].fields.map((f) => f.type)).toEqual(["identifier", "text", "currency"]);
  });

  it("edits an inherited field's label as an override and hides instead of deleting it", async () => {
    vi.mocked(getVersion).mockResolvedValue(version({
      version: { ...version().version, parent_version_id: 5, parent: "Base 1.0" },
      definition: { groups: [], rules: [], overrides: {} }, inherited_field_ids: ["contract.number", "contract.currency"],
    }));
    const { effectiveByVersion } = await import("@/lib/doc-schemas");
    vi.mocked(effectiveByVersion).mockResolvedValue(structuredClone(PARENT));
    render(<SchemaDesigner schemaId={7} />);
    const label = await screen.findByLabelText("Label for contract.currency");
    fireEvent.change(label, { target: { value: "Billing Currency" } });
    fireEvent.click(screen.getByRole("button", { name: "Hide Contract Number" }));
    await waitFor(() => expect(saveVersion).toHaveBeenCalled(), { timeout: 3000 });
    const saved = vi.mocked(saveVersion).mock.calls.at(-1)![2].definition;
    expect(saved.groups).toEqual([]);
    expect(saved.overrides).toEqual({ "contract.currency": { label: "Billing Currency" }, "contract.number": { visible: false } });
  });

  it("builds a validation rule", async () => {
    render(<SchemaDesigner schemaId={7} />);
    await screen.findByTestId("schema-canvas");
    fireEvent.click(screen.getByRole("tab", { name: /Rules/ }));
    fireEvent.change(screen.getByLabelText("Rule kind"), { target: { value: "pattern" } });
    const fields = screen.getByLabelText("Rule fields") as HTMLSelectElement;
    fields.options[0].selected = true;
    fireEvent.change(fields);
    fireEvent.change(screen.getByLabelText("Rule parameter"), { target: { value: "[A-Z0-9-]+" } });
    fireEvent.click(screen.getByRole("button", { name: /Add rule/ }));
    const listed = within(screen.getByTestId("rules-editor")).getAllByRole("listitem");
    expect(listed[0]).toHaveTextContent("Matches pattern");
    expect(listed[0]).toHaveTextContent("contract.number");
  });

  it("is read-only for a published version and offers a new draft and publishing workflow", async () => {
    vi.mocked(getVersion).mockResolvedValue(version({ editable: false, version: { ...version().version, status: "published" } }));
    render(<SchemaDesigner schemaId={7} />);
    await screen.findByTestId("schema-canvas");
    expect(screen.getByTestId("save-state")).toHaveTextContent("Read-only version");
    expect(screen.getByRole("button", { name: "Edit as new draft" })).toBeInTheDocument();
    expect((screen.getByLabelText("Label for contract.number") as HTMLInputElement).readOnly).toBe(true);
  });

  it("publishes a draft", async () => {
    vi.mocked(transition).mockResolvedValue(version({ version: { ...version().version, status: "published" }, editable: false }));
    render(<SchemaDesigner schemaId={7} />);
    await screen.findByTestId("schema-canvas");
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(transition).toHaveBeenCalledWith(7, 70, "publish"));
  });
});

describe("Schema library", () => {
  it("lists schemas and creates one from approved discovery suggestions", async () => {
    vi.mocked(listSchemas).mockResolvedValue([schema({ is_system: true, name: "Invoice", published: version().version })]);
    vi.mocked(searchDocuments).mockResolvedValue({ total: 1, documents: [{ document_id: "d1", original_filename: "inv.pdf", document_type: null,
      status: "completed", confidence: null, uploaded_at: "", page_count: 1, fields_extracted: 3, last_updated: "", staging_status: "staged",
      type_label: "Invoice", category: "financial" }] });
    vi.mocked(discoverFields).mockResolvedValue({
      found: 1, category: 1, tables: 0,
      definition: { rules: [], overrides: {}, groups: [
        { group_id: "summary", label: "Summary", kind: "section", children: [], fields: [{ field_id: "doc.invoice_number", label: "Invoice Number", type: "identifier" }] },
        { group_id: "expected_for_type", label: "Expected", kind: "section", children: [], fields: [{ field_id: "invoice.due", label: "Due Date", type: "date" }] },
      ] },
      suggestions: [
        { field_id: "doc.invoice_number", group_id: "summary", label: "Invoice Number", raw_label: "Invoice No", type: "identifier", origin: "found", value: "INV-1", page: 1, evidence: "Printed as 'Invoice No'" },
        { field_id: "invoice.due", group_id: "expected_for_type", label: "Due Date", raw_label: null, type: "date", origin: "category", value: null, page: null, evidence: "Expected for this document type; not found" },
      ],
    });
    vi.mocked(createSchema).mockResolvedValue(schema({ id: 9 }));
    render(<SchemaLibraryPage />);
    expect(await within(await screen.findByTestId("schema-table")).findByText("Invoice")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /New schema/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Analyze a document/ }));
    fireEvent.click(await within(await screen.findByTestId("discover-documents")).findByText("inv.pdf"));
    const review = await screen.findByTestId("discovery-review");
    expect(within(review).getByText("found")).toBeInTheDocument();
    expect((within(review).getByLabelText("Keep Due Date") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(createSchema).toHaveBeenCalled());
    const body = vi.mocked(createSchema).mock.calls[0][0];
    expect(body.definition!.groups.map((g) => g.group_id)).toEqual(["summary"]);
    expect(push).toHaveBeenCalledWith("/schemas/9");
  });
});
