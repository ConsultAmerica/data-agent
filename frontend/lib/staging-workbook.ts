import { apiFetch, fetchWithRetry } from "@/lib/api";
import { downloadBlob } from "@/lib/export";

/** Mirrors backend app/staging/models.py. The UI renders any profile from
 * this shape alone — it never branches on a profile id. */

export type ReviewStatus = "Verified" | "Needs Review" | "Missing";

export interface SourceLocator {
  dom_path: string | null;
  element_id: string | null;
  section_path: string[];
  table_index: number | null;
  row_index: number | null;
  column_index: number | null;
  sheet_name: string | null;
  cell_ref: string | null;
}

export interface CellProvenance {
  source_document_id: string;
  source_filename: string;
  source_type: "pdf" | "image" | "html" | "xml" | "docx" | "xlsx" | "text" | "system";
  source_page: number | null;
  source_bbox: [number, number, number, number] | null;
  evidence_text: string | null;
  extraction_method: string | null;
  source_locator: SourceLocator | null;
  source_region_id: string | null;
  anchor_text: string | null;
  highlight_text: string | null;
  /** OCR-read values only: lowest word confidence, and whether the OCR
   * passes disagreed. Absent for native text and HTML. */
  ocr_confidence?: number | null;
  ocr_gate?: boolean;
  ocr_contested?: boolean;
}

export interface ValidationCheck {
  check: string;
  passed: boolean;
  message: string | null;
}

/** Original table column a staged value came from (backend SourceColumn). */
export interface SourceColumn {
  raw_header: string | null;
  column_index: number;
  structural_role: string | null;
  structural_roles: string[];
}

export interface SourceColumnValue extends SourceColumn {
  raw_value: string;
  provenance: CellProvenance | null;
}

export interface StagingCell {
  canonical_field: string;
  display_label: string;
  value: string | number | boolean | null;
  raw_value: string | null;
  value_type: string;
  provenance: CellProvenance | null;
  validation: { status: "passed" | "failed" | "not_checked"; checks: ValidationCheck[] };
  review_status: ReviewStatus | null;
  review_reasons: string[];
  source_column?: SourceColumn | null;
}

export interface StagingRecord {
  record_id: string;
  cells: Record<string, StagingCell>;
  record_status: ReviewStatus | null;
  links_to_dataset: string | null;
  source_columns?: SourceColumnValue[];
  /** Grid payload only: fields whose long text is a preview; the full
   * value loads with the record (getStagingRecord). */
  truncated_fields?: string[];
}

export interface StagingColumn {
  canonical_field: string;
  key: string;
  display_label: string;
  value_type: string;
  expected: boolean;
}

export interface StagingDataset {
  dataset_id: string;
  display_name: string;
  cardinality: "single" | "repeating";
  /** transform: the same records shaped for a target system (e.g. Oracle
   * Output) — never counted as extracted records again. */
  role: "business" | "transform" | "source" | "qa";
  description: string | null;
  columns: StagingColumn[];
  records: StagingRecord[];
  identity_fields: string[];
  /** Columns a compact grid shows; the rest are in the record detail view.
   * Empty = every column. */
  grid_fields?: string[];
  /** Records carry only their grid cells (no provenance); the full record
   * is fetched with getStagingRecord. */
  compact?: boolean;
  /** Grid rows carry complete values; the grid shows long text in full. */
  full_text?: boolean;
  /** Columns the source itself prints (kept even when empty). */
  source_columns?: string[];
}

export interface ExportCapability {
  capability_id: string;
  label: string;
  format: "xlsx" | "csv" | "json" | "xml";
  href: string;
  dataset_id: string | null;
}

export interface ProfileDescriptor {
  profile_id: string;
  profile_version: number;
  display_name: string;
  description: string;
  document_families: string[];
  export_capabilities: ExportCapability[];
  oracle_mapping_capability: "planned" | "available" | "none";
  /** The tabs this document is presented in. Empty = the generic tabs. */
  views?: ProfileView[];
}

/** One tab of a profile's presentation; "source" also shows the
 * document's own transcription. */
export interface ProfileView {
  view_id: string;
  label: string;
  dataset_ids: string[];
  kind: "records" | "source";
}

export type OutcomeStatus =
  | "populated"
  | "needs_review"
  | "no_supported_fields"
  | "special_source"
  | "failed"
  | "pending";

export interface ExtractionOutcome {
  status: OutcomeStatus;
  title: string;
  message: string;
  details: string[];
  record_count: number;
  needs_review_count: number;
}

export interface QaSummary {
  verified: number;
  needs_review: number;
  missing: number;
  record_count: number;
}

export interface ProcessingMetadata {
  document_family: string | null;
  document_family_label: string | null;
  resolution_reasons: string[];
  resolved_at: string | null;
  page_count: number | null;
  source_type: CellProvenance["source_type"] | null;
  transcription_available: boolean;
}

export interface StagingWorkbook {
  document_id: string;
  document_filename: string;
  profile: ProfileDescriptor;
  outcome: ExtractionOutcome;
  datasets: StagingDataset[];
  qa_summary: QaSummary;
  processing_metadata: ProcessingMetadata;
}

export async function getStagingWorkbook(documentId: string): Promise<StagingWorkbook> {
  return apiFetch<StagingWorkbook>(`/api/documents/${documentId}/staging-workbook`);
}

/** The document's profile (presentation, exports) without the workbook. */
export async function getStagingProfile(documentId: string): Promise<ProfileDescriptor> {
  return apiFetch<ProfileDescriptor>(`/api/documents/${documentId}/staging-profile`);
}

/** Every cell (with provenance and checks) of one record — the detail view
 * of a compact grid row. */
export async function getStagingRecord(
  documentId: string,
  datasetId: string,
  recordId: string,
): Promise<StagingRecord> {
  return apiFetch<StagingRecord>(
    `/api/documents/${documentId}/staging-workbook/datasets/${encodeURIComponent(datasetId)}/records/${encodeURIComponent(recordId)}`,
  );
}

const EXPORT_MIME: Record<ExportCapability["format"], string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv;charset=utf-8;",
  json: "application/json",
  xml: "application/xml",
};

export async function downloadExport(
  capability: ExportCapability,
  fallbackName: string,
): Promise<void> {
  const response = await fetchWithRetry(capability.href, undefined);
  if (!response.ok) {
    throw new Error(`${capability.label} failed (${response.status})`);
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  // The exact (UTF-8) name when the server sends one, else the ASCII one.
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const filename =
    (encoded ? decodeURIComponent(encoded) : undefined) ??
    /filename="([^"]+)"/.exec(disposition)?.[1] ??
    // "part_52.html" -> "part_52.csv", never "part_52.html.csv".
    `${fallbackName.replace(/\.(pdf|html?|xml|docx?|xlsx?|csv|txt|rtf|json|pptx?|png|jpe?g|tiff?)$/i, "")}.${capability.format}`;
  if (capability.format === "csv") {
    downloadBlob(await response.text(), filename, "text/csv;charset=utf-8;");
    return;
  }
  downloadBlob(await response.blob(), filename, EXPORT_MIME[capability.format]);
}

/** Mirrors backend app/source_structure/models.py (the subset the HTML
 * evidence view reads). */
export interface StructureTableCell {
  row_index: number;
  column_index: number;
  text: string;
  source_locator: SourceLocator | null;
}

export interface StructureTable {
  candidate_id: string;
  headers: string[];
  rows: StructureTableCell[][];
  source_locator: SourceLocator | null;
  detection_method: string;
}

export interface StructureField {
  raw_label: string;
  raw_value: string;
  label_text: string;
  structural_relation: string;
  evidence_text: string;
  source_locator: SourceLocator | null;
}

export interface StructureRegion {
  region_id: string;
  region_type: string;
  text: string;
  source_locator: SourceLocator | null;
}

export interface RegionContext {
  region: StructureRegion | null;
  field: StructureField | null;
  table: StructureTable | null;
  row_index: number | null;
  column_index: number | null;
}

export async function getRegionContext(
  documentId: string,
  regionId: string,
): Promise<RegionContext> {
  return apiFetch<RegionContext>(
    `/api/documents/${documentId}/source-structure/regions/${encodeURIComponent(regionId)}`,
  );
}

export type SelectedExportFormat = "xlsx" | "csv" | "json";

export const SELECTED_EXPORT_FORMATS: { format: SelectedExportFormat; label: string }[] = [
  { format: "xlsx", label: "Excel" },
  { format: "csv", label: "CSV" },
  { format: "json", label: "JSON" },
];

/** Export Selected: the manifest names records and fields by id only; the
 * server reads the values from the persisted staging workbook. */
export async function downloadSelectedExport(
  documentId: string,
  datasetId: string,
  format: SelectedExportFormat,
  selection: { record_id: string; fields: string[] }[],
  fallbackName: string,
): Promise<void> {
  await postSelectedExport(
    `/api/documents/${documentId}/staging-workbook/datasets/${encodeURIComponent(datasetId)}/export-selected`,
    { format, selection },
    format,
    `${fallbackName.replace(/\.[A-Za-z0-9]{2,5}$/, "")}_${datasetId}_selected.${format}`,
  );
}

/** One selected value, by id: which dataset, record and field. */
export interface SelectedFieldRef {
  dataset_id: string;
  record_id: string;
  field: string;
}

/** Export Selected for label / value lists (Supplier, Charges & Totals …),
 * whose values come from several datasets: one Section | Field | Value
 * table, in the order given. Ids only, as for a grid. */
export async function downloadSelectedFieldsExport(
  documentId: string,
  format: SelectedExportFormat,
  fields: SelectedFieldRef[],
  fallbackName: string,
): Promise<void> {
  await postSelectedExport(
    `/api/documents/${documentId}/staging-workbook/export-selected-fields`,
    { format, fields },
    format,
    `${fallbackName.replace(/\.[A-Za-z0-9]{2,5}$/, "")}_selected_fields.${format}`,
  );
}

/** Custom export (backend app/staging/custom_export.py): output columns,
 * each a label and one or more source fields by id. A source with a
 * record_id is one value; without, a column of one repeating dataset (the
 * file then has a row per record). Values are read on the server. */
export interface CustomExportSource {
  dataset_id: string;
  field: string;
  record_id: string | null;
}

export interface CustomExportColumn {
  label: string;
  sources: CustomExportSource[];
  separator: string;
}

export interface CustomExportManifest {
  format: SelectedExportFormat;
  columns: CustomExportColumn[];
  include_header: boolean;
  file_name: string | null;
}

export async function downloadCustomExport(
  documentId: string,
  manifest: CustomExportManifest,
  fallbackName: string,
): Promise<void> {
  await postSelectedExport(
    `/api/documents/${documentId}/staging-workbook/export-custom`,
    manifest,
    manifest.format,
    `${manifest.file_name || `${fallbackName.replace(/\.[A-Za-z0-9]{2,5}$/, "")}_custom`}.${manifest.format}`,
  );
}

async function postSelectedExport(
  url: string,
  body: object,
  format: SelectedExportFormat,
  fallbackFilename: string,
): Promise<void> {
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = `Export failed (${response.status})`;
    try {
      const payload = await response.json();
      if (typeof payload?.detail === "string") detail = payload.detail;
    } catch {
      // keep the status message
    }
    throw new Error(detail);
  }
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const filename =
    (encoded ? decodeURIComponent(encoded) : undefined) ??
    /filename="([^"]+)"/.exec(disposition)?.[1] ??
    fallbackFilename;
  if (format === "csv") {
    downloadBlob(await response.text(), filename, EXPORT_MIME.csv);
    return;
  }
  downloadBlob(await response.blob(), filename, EXPORT_MIME[format]);
}
