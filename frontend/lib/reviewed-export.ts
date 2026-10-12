import { apiFetch, fetchWithRetry } from "@/lib/api";
import { downloadBlob, downloadCsv, downloadJson, toCsv } from "@/lib/export";
import type { ScalarTargetResult, TargetCorrection } from "@/types/document";

/** Reviewed-value export row — mirrors backend `field_to_export_record`. */
export interface ReviewedExportField {
  field: string;
  field_key?: string;
  field_group?: string;
  extracted_value: string;
  value: string;
  review_status: string;
  confidence: number | null;
  validation: { status: string };
  source: { page: number | null };
  authoritative?: boolean;
}

export interface DocumentExportResponse {
  document_id: string;
  document_filename: string;
  generated_at: string;
  authoritative_only: boolean;
  field_count: number;
  fields: ReviewedExportField[];
  skipped: Array<{
    field: string;
    field_key: string;
    review_status: string;
    reason: string;
  }>;
}

export interface OraclePayloadPreview {
  document_id: string;
  source_document: string;
  erp_target: string;
  mode: string;
  dry_run: boolean;
  send_allowed: boolean;
  generated_at: string;
  excluded_statuses: string[];
  contract_header: Record<string, string>;
  fields: ReviewedExportField[];
  skipped: Array<{
    field: string;
    field_key: string;
    review_status: string;
    reason: string;
  }>;
  authoritative_count: number;
  skipped_count: number;
  ready_to_send: boolean;
  actor?: {
    actor_id?: string;
    actor_type?: string;
    actor_role?: string;
    can_send?: boolean;
  };
}

const CSV_HEADERS = [
  "field",
  "value",
  "extracted_value",
  "review_status",
  "confidence",
  "validation_status",
  "source_page",
];

export function scalarToExportField(
  scalar: ScalarTargetResult,
  correction?: TargetCorrection | null,
  displayLabel?: string,
): ReviewedExportField {
  const extracted =
    scalar.extracted_value != null && String(scalar.extracted_value) !== ""
      ? String(scalar.extracted_value)
      : String(scalar.value ?? "");

  let effective = String(scalar.value ?? "");
  let reviewStatus = scalar.review_status ?? "pending";

  if (correction?.action === "edit") {
    effective = String(correction.corrected_value ?? effective);
    reviewStatus = "edited";
  } else if (correction?.action === "verify") {
    reviewStatus = "accepted";
  } else if (correction?.action === "reject") {
    reviewStatus = "rejected";
  }

  return {
    // scalar.target is the internal discovery candidate key (e.g.
    // "kv_pricing_arrangement"), not a display label — callers that have
    // the resolved display label (FieldRow.label) must pass it here so
    // exports never fall back to a raw kv_* string.
    field: displayLabel || scalar.target,
    field_key: scalar.normalized_key,
    extracted_value: extracted,
    value: effective,
    review_status: reviewStatus,
    confidence: scalar.confidence ?? null,
    validation: {
      status:
        scalar.validation?.status ??
        scalar.validation_status ??
        "passed",
    },
    source: {
      page: scalar.page ?? scalar.evidence?.page_number ?? null,
    },
    authoritative: reviewStatus === "accepted" || reviewStatus === "edited",
  };
}

export function exportFieldsToCsvRows(
  fields: ReviewedExportField[],
): Record<string, unknown>[] {
  return fields.map((row) => ({
    field: row.field,
    value: row.value,
    extracted_value: row.extracted_value,
    review_status: row.review_status,
    confidence: row.confidence ?? "",
    validation_status: row.validation.status,
    source_page: row.source.page ?? "",
  }));
}

export function downloadReviewedJson(
  filename: string,
  fields: ReviewedExportField[],
) {
  downloadJson(filename, fields);
}

export function downloadReviewedCsv(
  filename: string,
  fields: ReviewedExportField[],
) {
  downloadCsv(filename, CSV_HEADERS, exportFieldsToCsvRows(fields));
}

export function reviewedCsvString(fields: ReviewedExportField[]): string {
  return toCsv(CSV_HEADERS, exportFieldsToCsvRows(fields));
}

export async function getDocumentExport(
  documentId: string,
  options?: { authoritativeOnly?: boolean },
): Promise<DocumentExportResponse> {
  const query = options?.authoritativeOnly ? "?authoritative_only=true" : "";
  return apiFetch<DocumentExportResponse>(
    `/api/documents/${documentId}/export${query}`,
  );
}

export async function downloadDocumentExportCsv(
  documentId: string,
  filename: string,
  options?: { authoritativeOnly?: boolean },
): Promise<void> {
  const query = options?.authoritativeOnly ? "?authoritative_only=true" : "";
  const response = await fetchWithRetry(
    `/api/documents/${documentId}/export.csv${query}`,
    undefined,
  );
  if (!response.ok) {
    throw new Error(`Export CSV failed (${response.status})`);
  }
  const text = await response.text();
  downloadBlob(text, filename, "text/csv;charset=utf-8;");
}

export async function downloadDocumentExportLineItemsCsv(
  documentId: string,
  filename: string,
  options?: { tableKey?: string },
): Promise<void> {
  const query = options?.tableKey
    ? `?table_key=${encodeURIComponent(options.tableKey)}`
    : "";
  const response = await fetchWithRetry(
    `/api/documents/${documentId}/export/line-items.csv${query}`,
    undefined,
  );
  if (!response.ok) {
    throw new Error(`Export Line Items CSV failed (${response.status})`);
  }
  const text = await response.text();
  downloadBlob(text, filename, "text/csv;charset=utf-8;");
}

export async function downloadDocumentExportXlsx(
  documentId: string,
  filename: string,
  options?: { authoritativeOnly?: boolean },
): Promise<void> {
  const query = options?.authoritativeOnly ? "?authoritative_only=true" : "";
  const response = await fetchWithRetry(
    `/api/documents/${documentId}/export.xlsx${query}`,
    undefined,
  );
  if (!response.ok) {
    throw new Error(`Export Excel failed (${response.status})`);
  }
  const blob = await response.blob();
  downloadBlob(
    blob,
    filename.endsWith(".xlsx") ? filename : `${filename}.xlsx`,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
}

export async function getOraclePayloadPreview(
  documentId: string,
): Promise<OraclePayloadPreview> {
  return apiFetch<OraclePayloadPreview>(
    `/api/documents/${documentId}/oracle-payload`,
  );
}

export interface OracleSendResult {
  document_id: string;
  integration_audit_id: number;
  status: string;
  dry_run: boolean;
  request_snapshot?: Record<string, unknown>;
  response_snapshot?: {
    status?: string;
    code?: string;
    message?: string;
    accepted_fields?: number;
  };
  actor?: {
    actor_id?: string;
    actor_type?: string;
    actor_role?: string;
  };
}

export interface IntegrationAuditEntry {
  id: number;
  integration: string;
  action: string;
  status: string;
  actor_id: string | null;
  actor_type: string | null;
  actor_role: string | null;
  changed_by: string | null;
  request_id: string | null;
  request_snapshot: Record<string, unknown> | null;
  response_snapshot: Record<string, unknown> | null;
  created_at: string;
  detail: string | null;
}

/** Explicit send — never call without user confirmation. */
export async function sendOraclePayload(
  documentId: string,
  confirm: true,
): Promise<OracleSendResult> {
  return apiFetch<OracleSendResult>(
    `/api/documents/${documentId}/oracle-send`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm }),
    },
  );
}

export async function listIntegrationAudit(
  documentId: string,
): Promise<IntegrationAuditEntry[]> {
  return apiFetch<IntegrationAuditEntry[]>(
    `/api/documents/${documentId}/integration-audit`,
  );
}
