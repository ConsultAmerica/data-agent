import { apiFetch, fetchWithRetry } from "@/lib/api";
import { downloadBlob } from "@/lib/export";

/** Mirrors backend app/api/oracle_templates.py and app/oracle_templates/. */

export interface TemplateColumn {
  position: number;
  technical_name: string;
  display_label: string | null;
  required: boolean | null;
  /** Documented by the template's attribute definitions or Oracle metadata; absent when the source doesn't say. */
  data_type?: string | null;
  declared_type?: string | null;
  max_length?: number | null;
  precision?: number | null;
  scale?: number | null;
  lookup_values?: string[] | null;
  lookup_type?: string | null;
  description?: string | null;
}

export type CatalogStatus = "verified" | "draft" | "unsupported" | "stale";
export type IntegrationMethod = "import_management" | "fbdi" | "rest" | "other";

/** Where a target sits in Oracle Fusion (backend oracle_templates/catalog.py). */
export interface CatalogEntry {
  application: string | null;
  integration_method: IntegrationMethod | null;
  integration_method_label: string | null;
  oracle_release: string | null;
  object_code: string | null;
  parent_object: string | null;
  user_keys: string[];
  description: string | null;
  /** uploaded_template | metadata_api */
  source: string;
  verified: boolean;
  verified_by: string | null;
  verified_at: string | null;
  status: CatalogStatus;
  status_label: string;
  status_reason: string | null;
}

export interface OracleTemplate {
  id: number;
  object_name: string;
  version: number;
  filename: string;
  file_format: string;
  sheet_name: string | null;
  technical_row: number;
  label_row: number | null;
  columns: TemplateColumn[];
  warnings: string[];
  environment: string | null;
  status: "active" | "retired";
  uploaded_by: string;
  uploaded_at: string;
  checksum_sha256: string;
  has_display_labels: boolean;
  profile_count: number;
  /** The upload matched a template already stored (identical bytes). */
  reused?: boolean;
  catalog?: CatalogEntry | null;
  required_columns?: string[];
}

export interface CatalogObject {
  template: OracleTemplate;
  versions: number[];
}

export interface OracleCatalog {
  /** False: no target is registered ("Oracle import template not configured"). */
  configured: boolean;
  message: string | null;
  applications: { application: string; objects: CatalogObject[] }[];
  application_names: string[];
  integration_methods: Record<string, string>;
  transformations: Record<string, string>;
  discovery: DiscoveryStatus;
}

export interface DiscoveryStatus {
  configured: boolean;
  provider: string;
  message: string;
}

export type Shape = "single" | "pair" | "column";
export type Transform =
  | "as_is" | "trim" | "upper" | "lower" | "title" | "date_iso" | "number" | "currency"
  | "default" | "lookup" | "conditional" | "split" | "concat";

export interface SourceRef {
  kind: "field" | "constant" | "none";
  dataset_id?: string | null;
  field?: string | null;
  shape?: Shape | null;
  pair_by?: "field_id" | "label" | null;
  pair_key?: string | null;
  constant?: string | null;
}

export interface ColumnMapping {
  column: string;
  source: SourceRef;
  transform?: Transform;
  method?: string | null;
  confidence?: number | null;
  /** The transformation's settings: {format}, {decimals, currency}, {value}, {map, fallback}, {when, value, then, else}, {part} or {separator, index}, {separator}. */
  options?: Record<string, unknown>;
  /** Further sources for "concat". */
  sources?: SourceRef[];
}

export interface MappingSpec {
  row_dataset: string | null;
  mappings: ColumnMapping[];
  key_columns: string[];
  parent?: { profile_id: number; links: [string, string][] } | null;
}

export type ProfileStatus = "draft" | "active" | "archived";

export interface MappingProfile {
  id: number;
  template_id: number;
  name: string;
  staging_profile_id: string | null;
  spec: MappingSpec;
  version: number;
  history: { version: number; actor: string; at: string; status?: string; name?: string }[];
  updated_by: string;
  updated_at: string;
  notes: string | null;
  status?: ProfileStatus;
  created_by?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  source_document_type?: string | null;
  /** The template version the profile is pinned to. */
  template_version?: number | null;
  /** A newer version of the target exists; the profile stays on its own until moved. */
  schema_update_available?: boolean;
}

export interface MappingChange {
  column: string;
  change: "added" | "removed" | "changed";
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface VersionCompare {
  profile_id: number;
  from_version: number;
  to_version: number;
  changes: MappingChange[];
  settings: string[];
}

export interface AuditEvent {
  action: string;
  profile_version: number | null;
  actor_name: string;
  created_at: string;
  detail: Record<string, unknown> | null;
}

export interface ClauseRecord {
  clause_id: string;
  title: string | null;
  regulation_family: "FAR" | "DFARS" | "Agency supplement" | "Other";
  contract_number: string | null;
  page: number | null;
  evidence: string | null;
  text: string | null;
  dataset_id: string;
  record_id: string;
  also_in: string[];
}

export interface SourceField {
  ref: SourceRef;
  group: string;
  label: string;
  document_label: string | null;
  sample: string;
  page: number | null;
  highlight: string | null;
  anchor: string | null;
  review_status: string | null;
  /** The document section it was read in. */
  section?: string | null;
  /** Extraction quality: passed | failed | not_checked (apart from the mapping's own validity). */
  quality?: string | null;
}

export interface Suggestion {
  column: string;
  source: SourceRef;
  method: string;
  confidence: number;
  reason: string;
  /** The target attribute is required. */
  required?: boolean;
  /** Always true: a suggestion is a proposal until a person accepts it. */
  needs_approval?: boolean;
}

export interface Issue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  column: string | null;
  row: number | null;
}

export interface PreviewCell {
  value: string;
  review_status: string | null;
  problem: string | null;
  page: number | null;
  highlight: string | null;
  /** The source value before its transformation. */
  source_value?: string | null;
}

export type ColumnState = "Valid" | "Warning" | "Error" | "Needs Review" | "Not Configured";

export interface Preview {
  template_id: number;
  headers: string[];
  display_labels: (string | null)[];
  rows: PreviewCell[][];
  total_rows: number;
  issues: Issue[];
  issue_counts: Record<"error" | "warning" | "info", number>;
  import_ready: boolean;
  unmapped_fields: SourceField[];
  column_states?: Record<string, ColumnState>;
  /** How each configured attribute's value is made, in words. */
  transforms?: Record<string, string>;
  schema_status?: CatalogStatus;
  parent?: { profile_id: number; name: string; headers: string[]; rows: PreviewCell[][]; total_rows: number } | null;
}

/** Same field? (pair rows by their key, others by dataset + field). */
export function sameSource(a: SourceRef, b: SourceRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "constant") return (a.constant ?? "") === (b.constant ?? "");
  if (a.kind === "none") return true;
  return a.dataset_id === b.dataset_id && a.field === b.field && (a.pair_key ?? null) === (b.pair_key ?? null);
}

export function sourceKey(ref: SourceRef): string {
  if (ref.kind !== "field") return ref.kind;
  return `${ref.dataset_id}|${ref.field}|${ref.pair_key ?? ""}`;
}

export async function listTemplates(includeRetired = false): Promise<OracleTemplate[]> {
  return apiFetch(`/api/oracle/templates${includeRetired ? "?include_retired=true" : ""}`);
}

export async function getTemplate(id: number): Promise<OracleTemplate> {
  return apiFetch(`/api/oracle/templates/${id}`);
}

export async function uploadTemplate(
  file: File,
  options: {
    objectName?: string; environment?: string; sheet?: string;
    application?: string; integrationMethod?: string; oracleRelease?: string; objectCode?: string; parentObject?: string; userKeys?: string;
  } = {},
): Promise<OracleTemplate> {
  const form = new FormData();
  form.append("file", file);
  if (options.objectName?.trim()) form.append("object_name", options.objectName.trim());
  if (options.environment?.trim()) form.append("environment", options.environment.trim());
  if (options.sheet?.trim()) form.append("sheet", options.sheet.trim());
  if (options.application?.trim()) form.append("application", options.application.trim());
  if (options.integrationMethod?.trim()) form.append("integration_method", options.integrationMethod.trim());
  if (options.oracleRelease?.trim()) form.append("oracle_release", options.oracleRelease.trim());
  if (options.objectCode?.trim()) form.append("object_code", options.objectCode.trim());
  if (options.parentObject?.trim()) form.append("parent_object", options.parentObject.trim());
  if (options.userKeys?.trim()) form.append("user_keys", options.userKeys.trim());
  return apiFetch("/api/oracle/templates", { method: "POST", body: form });
}

export async function getCatalog(): Promise<OracleCatalog> {
  return apiFetch("/api/oracle/catalog");
}

export interface CatalogInput {
  application: string;
  integration_method: IntegrationMethod;
  oracle_release?: string | null;
  object_code?: string | null;
  parent_object?: string | null;
  user_keys?: string[];
  description?: string | null;
}

export async function updateCatalog(templateId: number, body: CatalogInput): Promise<OracleTemplate> {
  return apiFetch(`/api/oracle/templates/${templateId}/catalog`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function verifyTemplate(templateId: number): Promise<OracleTemplate> {
  return apiFetch(`/api/oracle/templates/${templateId}/verify`, { method: "POST" });
}

export async function registerAttributes(templateId: number, file: File): Promise<OracleTemplate> {
  const form = new FormData();
  form.append("file", file);
  return apiFetch(`/api/oracle/templates/${templateId}/attributes`, { method: "POST", body: form });
}

export async function registerDiscovered(body: { resource: string; application: string; object_name?: string }): Promise<OracleTemplate> {
  return apiFetch("/api/oracle/discovery/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function profileAction(profileId: number, action: "activate" | "archive" | "duplicate"): Promise<MappingProfile> {
  return apiFetch(`/api/oracle/profiles/${profileId}/${action}`, { method: "POST" });
}

export async function compareVersions(profileId: number, fromVersion: number, toVersion: number): Promise<VersionCompare> {
  return apiFetch(`/api/oracle/profiles/${profileId}/compare?from_version=${fromVersion}&to_version=${toVersion}`);
}

export async function profileHistory(profileId: number): Promise<AuditEvent[]> {
  return apiFetch(`/api/oracle/profiles/${profileId}/history`);
}

export async function documentClauses(documentId: string): Promise<{ document_id: string; clauses: ClauseRecord[]; families: Record<string, number> }> {
  return apiFetch(`/api/documents/${documentId}/oracle/clauses`);
}

export async function retireTemplate(id: number): Promise<OracleTemplate> {
  return apiFetch(`/api/oracle/templates/${id}/retire`, { method: "POST" });
}

export async function listProfiles(templateId: number): Promise<MappingProfile[]> {
  return apiFetch(`/api/oracle/templates/${templateId}/profiles`);
}

export async function listAllProfiles(stagingProfileId?: string | null): Promise<MappingProfile[]> {
  const query = stagingProfileId ? `?staging_profile_id=${encodeURIComponent(stagingProfileId)}` : "";
  return apiFetch(`/api/oracle/profiles${query}`);
}

export async function saveProfile(
  templateId: number,
  profileId: number | null,
  body: { name: string; staging_profile_id?: string | null; spec: MappingSpec; notes?: string | null; source_document_type?: string | null },
): Promise<MappingProfile> {
  const init = { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  return profileId == null
    ? apiFetch(`/api/oracle/templates/${templateId}/profiles`, { method: "POST", ...init })
    : apiFetch(`/api/oracle/profiles/${profileId}`, { method: "PUT", ...init });
}

export async function documentFields(
  documentId: string,
): Promise<{ document_id: string; staging_profile_id: string | null; fields: SourceField[] }> {
  return apiFetch(`/api/documents/${documentId}/oracle/fields`);
}

export async function suggestMapping(
  documentId: string,
  templateId: number,
  body: { row_dataset?: string | null; parent_profile_id?: number | null } = {},
): Promise<{ template_id: number; row_dataset: string | null; suggestions: Suggestion[]; parent_links: [string, string][] }> {
  return apiFetch(`/api/documents/${documentId}/oracle/templates/${templateId}/suggest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function previewMapping(documentId: string, templateId: number, spec: MappingSpec): Promise<Preview> {
  return apiFetch(`/api/documents/${documentId}/oracle/templates/${templateId}/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ spec }),
  });
}

function fileName(response: Response, fallback: string): string {
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  return (encoded ? decodeURIComponent(encoded) : undefined) ?? /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallback;
}

async function download(url: string, body: object, fallback: string): Promise<{ importReady: boolean }> {
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = `Export failed (${response.status})`;
    try {
      const payload = await response.json();
      detail = typeof payload?.detail === "string" ? payload.detail : payload?.detail?.message ?? detail;
    } catch {
      // keep the status message
    }
    throw new Error(detail);
  }
  // The server's bytes as they are: no byte-order mark is added, so the
  // first header name stays exactly the template's.
  downloadBlob(await response.blob(), fileName(response, fallback), response.headers.get("Content-Type") ?? "text/csv");
  return { importReady: response.headers.get("X-Import-Ready") === "true" };
}

export async function exportCsv(
  documentId: string,
  templateId: number,
  spec: MappingSpec,
  force = false,
): Promise<{ importReady: boolean }> {
  return download(`/api/documents/${documentId}/oracle/templates/${templateId}/export`, { spec, force }, "import.csv");
}

export async function exportBundle(
  documentId: string,
  profileIds: number[],
  force = false,
): Promise<{ importReady: boolean }> {
  return download(`/api/documents/${documentId}/oracle/export-bundle`, { profile_ids: profileIds, force }, "oracle_import.zip");
}

export async function downloadOriginalTemplate(template: OracleTemplate): Promise<void> {
  const response = await fetchWithRetry(`/api/oracle/templates/${template.id}/original`, undefined);
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  downloadBlob(await response.blob(), template.filename, response.headers.get("Content-Type") ?? "application/octet-stream");
}
