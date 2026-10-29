import { apiFetch, fetchWithRetry } from "@/lib/api";
import { downloadBlob } from "@/lib/export";
import type { SourceRef } from "@/lib/oracle-templates";

/** Mirrors backend app/doc_schemas/ and app/api/doc_schemas.py. */

export type FieldType =
  | "text" | "number" | "currency" | "date" | "boolean" | "dropdown" | "email" | "address"
  | "identifier" | "signature" | "attachment" | "calculated";
export type GroupKind = "section" | "repeating" | "object";
export type RuleKind =
  | "required" | "pattern" | "range" | "allowed_values" | "date_order" | "sum_matches" | "conditional_required";
export type Normalization = "none" | "trim" | "upper" | "lower" | "date_iso" | "number";
export type VersionStatus = "draft" | "in_review" | "published" | "deprecated" | "archived";

export interface SchemaField {
  field_id: string;
  label: string;
  description?: string | null;
  type: FieldType;
  required?: boolean;
  default?: string | null;
  allowed_values?: string[];
  instructions?: string | null;
  normalization?: Normalization;
  confidence_threshold?: number | null;
  visible?: boolean;
  evidence_required?: boolean;
  source?: SourceRef | null;
  calculation?: { op: "sum" | "add" | "subtract" | "multiply"; args: string[] } | null;
  order?: number;
}

export interface SchemaGroup {
  group_id: string;
  label: string;
  kind: GroupKind;
  description?: string | null;
  source_dataset?: string | null;
  key_field?: string | null;
  parent_key_field?: string | null;
  page_size?: number;
  visible?: boolean;
  fields: SchemaField[];
  children: SchemaGroup[];
}

export interface SchemaRule {
  rule_id: string;
  kind: RuleKind;
  fields: string[];
  params: Record<string, string | number | boolean | string[] | null>;
  message?: string | null;
  severity: "error" | "warning";
}

export type FieldOverride = Partial<Pick<SchemaField,
  "label" | "description" | "instructions" | "visible" | "order" | "required" | "allowed_values" |
  "confidence_threshold" | "normalization">>;

export interface Definition {
  groups: SchemaGroup[];
  rules: SchemaRule[];
  overrides: Record<string, FieldOverride>;
}

export interface VersionSummary {
  id: number;
  version: string;
  status: VersionStatus;
  parent_version_id: number | null;
  parent: string | null;
  author: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  published_by: string | null;
  change_summary: string | null;
  documents: number;
}

export interface SchemaSummary {
  id: number;
  schema_key: string;
  name: string;
  category: string;
  description: string | null;
  is_system: boolean;
  profile_id: string | null;
  family: string | null;
  archived: boolean;
  latest: VersionSummary | null;
  published: VersionSummary | null;
  versions: number;
  documents: number;
  parent: string | null;
}

export interface SchemaDetail extends SchemaSummary {
  all_versions: VersionSummary[];
  events: { action: string; actor: string; version_id: number | null; detail: unknown; at: string }[];
}

export interface VersionDetail {
  schema_id: number;
  version: VersionSummary;
  definition: Definition;
  effective: Definition;
  inherited_field_ids: string[];
  problems: string[];
  editable: boolean;
}

export interface FormValue {
  value: string;
  status: "found" | "matched_by_label" | "calculated" | "default" | "not_found";
  review_status: string | null;
  page: number | null;
  highlight: string | null;
  document_label: string | null;
  method: string | null;
}

export interface FormField {
  field_id: string;
  label: string;
  type: string;
  required: boolean;
  description: string | null;
  instructions: string | null;
  value: FormValue;
}

export interface FormRow {
  row_id: string;
  cells: Record<string, FormValue>;
  children: FormGroup[];
}

export interface FormGroup {
  group_id: string;
  label: string;
  kind: GroupKind;
  description: string | null;
  fields: FormField[];
  columns: FormField[];
  rows: FormRow[];
  total_rows: number;
  page_size: number;
  children: FormGroup[];
}

export interface FormIssue {
  severity: "error" | "warning";
  rule_id: string | null;
  field_id: string | null;
  message: string;
  row: number | null;
}

export interface Form {
  groups: FormGroup[];
  issues: FormIssue[];
  found: number;
  not_found: number;
}

export interface DocumentForm {
  document_id: string;
  schema_id: number;
  schema_name: string;
  version_id: number;
  version: string;
  version_status: VersionStatus;
  assignment_kind: string;
  newer_version: { version_id: number; version: string } | null;
  form: Form;
}

export interface DiscoverySuggestion {
  field_id: string;
  group_id: string;
  label: string;
  raw_label: string | null;
  type: FieldType;
  origin: "found" | "category" | "not_found";
  value: string | null;
  page: number | null;
  evidence: string | null;
}

export interface Discovery {
  definition: Definition;
  suggestions: DiscoverySuggestion[];
  found: number;
  category: number;
  tables: number;
}

export interface SchemaDiff {
  from: string | null;
  to: string;
  changes: { field_id: string; change: string; label?: string; from?: string; to?: string | boolean }[];
  breaking: { field_id: string; change: string; label?: string }[];
  mappings_to_review: { profile_id: number; name: string; columns: { column: string; field_id: string }[] }[];
}

export const STATUS_LABEL: Record<VersionStatus, string> = {
  draft: "Draft",
  in_review: "In review",
  published: "Published",
  deprecated: "Deprecated",
  archived: "Archived",
};

export const STATUS_TONE: Record<VersionStatus, string> = {
  draft: "bg-surface-soft text-text-secondary",
  in_review: "bg-warning/10 text-warning",
  published: "bg-success/10 text-success",
  deprecated: "bg-surface-soft text-text-muted",
  archived: "bg-surface-soft text-text-muted",
};

const json = (body: unknown) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const listSchemas = (params: { q?: string; category?: string; status?: string } = {}) => {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString();
  return apiFetch<SchemaSummary[]>(`/api/schemas${query ? `?${query}` : ""}`);
};
export const getSchema = (id: number) => apiFetch<SchemaDetail>(`/api/schemas/${id}`);
export const getVersion = (id: number, versionId: number) => apiFetch<VersionDetail>(`/api/schemas/${id}/versions/${versionId}`);
export const createSchema = (body: { name: string; category?: string; description?: string; parent_version_id?: number | null; definition?: Definition }) =>
  apiFetch<SchemaDetail>("/api/schemas", { method: "POST", ...json(body) });
export const saveVersion = (id: number, versionId: number, body: { definition: Definition; change_summary?: string | null; name?: string; description?: string; category?: string }) =>
  apiFetch<VersionDetail>(`/api/schemas/${id}/versions/${versionId}`, { method: "PUT", ...json(body) });
export const newDraft = (id: number, major = false) =>
  apiFetch<VersionDetail>(`/api/schemas/${id}/drafts`, { method: "POST", ...json({ major }) });
export const transition = (id: number, versionId: number, action: "submit" | "withdraw" | "publish" | "deprecate") =>
  apiFetch<VersionDetail>(`/api/schemas/${id}/versions/${versionId}/${action}`, { method: "POST" });
export const archiveSchema = (id: number) => apiFetch<SchemaDetail>(`/api/schemas/${id}/archive`, { method: "POST" });
export const duplicateSchema = (id: number, name: string) =>
  apiFetch<SchemaDetail>(`/api/schemas/${id}/duplicate`, { method: "POST", ...json({ name }) });
export const extendSchema = (id: number, name: string) =>
  apiFetch<SchemaDetail>(`/api/schemas/${id}/extend`, { method: "POST", ...json({ name }) });
export const versionDiff = (id: number, versionId: number, against: number) =>
  apiFetch<SchemaDiff>(`/api/schemas/${id}/versions/${versionId}/diff?against=${against}`);
export const importSchema = (payload: unknown) =>
  apiFetch<SchemaDetail>("/api/schemas/import", { method: "POST", ...json(payload) });
export const documentForm = (documentId: string) => apiFetch<DocumentForm>(`/api/documents/${documentId}/schema-form`);
export const previewForm = (documentId: string, definition: Definition, parentVersionId: number | null) =>
  apiFetch<Form>(`/api/documents/${documentId}/schema-form/preview`, {
    method: "POST", ...json({ definition, parent_version_id: parentVersionId }),
  });
export const assignSchema = (documentId: string, versionId: number, note?: string) =>
  apiFetch<DocumentForm>(`/api/documents/${documentId}/schema-assignment`, { method: "POST", ...json({ version_id: versionId, note }) });
export const assignmentDiff = (documentId: string, versionId: number) =>
  apiFetch<SchemaDiff>(`/api/documents/${documentId}/schema-assignment/diff?version_id=${versionId}`);
export const discoverFields = (documentId: string) =>
  apiFetch<Discovery>(`/api/documents/${documentId}/schema-discovery`, { method: "POST" });

export async function exportSchema(id: number, versionId: number, flatten = false): Promise<void> {
  const response = await fetchWithRetry(`/api/schemas/${id}/versions/${versionId}/export${flatten ? "?flatten=true" : ""}`, undefined);
  if (!response.ok) throw new Error(`Export failed (${response.status})`);
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "schema.json";
  downloadBlob(await response.blob(), name, "application/json");
}

export function emptyDefinition(): Definition {
  return { groups: [], rules: [], overrides: {} };
}

const OVERRIDABLE = ["label", "description", "instructions", "visible", "order", "required", "allowed_values",
  "confidence_threshold", "normalization"] as const;

/** Client copy of backend ``merge`` (app/doc_schemas/definition.py) for the
 * live preview: the parent's effective definition with this schema's
 * overrides applied and its own groups / fields / rules added. */
export function mergeDefinition(parent: Definition | null, own: Definition): Definition {
  if (!parent) return { groups: structuredClone(own.groups), rules: structuredClone(own.rules), overrides: {} };
  const groups = structuredClone(parent.groups);
  const byId = new Map<string, SchemaGroup>();
  const walk = (list: SchemaGroup[]) => list.forEach((g) => { byId.set(g.group_id, g); walk(g.children); });
  walk(groups);
  for (const group of own.groups) {
    const target = byId.get(group.group_id);
    if (target) {
      target.fields.push(...structuredClone(group.fields));
      target.children.push(...structuredClone(group.children));
    } else {
      groups.push(structuredClone(group));
    }
  }
  const apply = (list: SchemaGroup[]) =>
    list.forEach((group) => {
      group.fields = group.fields
        .map((field) => {
          const override = own.overrides[field.field_id];
          if (!override) return field;
          const changes = Object.fromEntries(
            Object.entries(override).filter(([key, value]) => value !== undefined && value !== null && (OVERRIDABLE as readonly string[]).includes(key)),
          );
          return { ...field, ...changes };
        })
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      apply(group.children);
    });
  apply(groups);
  return { groups, rules: [...structuredClone(parent.rules), ...structuredClone(own.rules)], overrides: {} };
}

/** "contract_no" → "Contract Number" (client copy of backend ``humanize``). */
export function humanize(raw: string): string {
  const abbreviations: Record<string, string> = {
    no: "Number", num: "Number", nm: "Name", dt: "Date", eff: "Effective", exp: "Expiration", amt: "Amount",
    qty: "Quantity", uom: "Unit of Measure", po: "Purchase Order", desc: "Description", addr: "Address", id: "ID",
  };
  const words = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
  return words.map((w) => abbreviations[w.toLowerCase()] ?? (w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(" ") || raw;
}

export function slugId(label: string, prefix = "custom"): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "field";
  return `${prefix}.${/^[a-z]/.test(base) ? base : `f_${base}`}`;
}
export const effectiveByVersion = (versionId: number) => apiFetch<Definition>(`/api/schemas/versions/${versionId}/effective`);
