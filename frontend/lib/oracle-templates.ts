import { apiFetch, fetchWithRetry } from "@/lib/api";
import { downloadBlob } from "@/lib/export";

/** Mirrors backend app/api/oracle_templates.py and app/oracle_templates/. */

export interface TemplateColumn {
  position: number;
  technical_name: string;
  display_label: string | null;
  required: boolean | null;
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
}

export type Shape = "single" | "pair" | "column";
export type Transform = "as_is" | "trim" | "upper" | "date_iso" | "number";

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
}

export interface MappingSpec {
  row_dataset: string | null;
  mappings: ColumnMapping[];
  key_columns: string[];
  parent?: { profile_id: number; links: [string, string][] } | null;
}

export interface MappingProfile {
  id: number;
  template_id: number;
  name: string;
  staging_profile_id: string | null;
  spec: MappingSpec;
  version: number;
  history: { version: number; actor: string; at: string }[];
  updated_by: string;
  updated_at: string;
  notes: string | null;
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
}

export interface Suggestion {
  column: string;
  source: SourceRef;
  method: string;
  confidence: number;
  reason: string;
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
}

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
  options: { objectName?: string; environment?: string; sheet?: string } = {},
): Promise<OracleTemplate> {
  const form = new FormData();
  form.append("file", file);
  if (options.objectName?.trim()) form.append("object_name", options.objectName.trim());
  if (options.environment?.trim()) form.append("environment", options.environment.trim());
  if (options.sheet?.trim()) form.append("sheet", options.sheet.trim());
  return apiFetch("/api/oracle/templates", { method: "POST", body: form });
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
  body: { name: string; staging_profile_id?: string | null; spec: MappingSpec; notes?: string | null },
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
