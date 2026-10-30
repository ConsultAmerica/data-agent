import { apiFetch } from "@/lib/api";
import { downloadExport, postSelectedExport, type SelectedExportFormat } from "@/lib/staging-workbook";
import type { LayoutFlag, LayoutTableRow } from "@/lib/original-structure";

/** Mirrors backend app/skills/business_data.py, validation.py, dates.py,
 * find.py and app/api/document_workspace.py. */

export interface BusinessCandidate {
  record_key: string;
  label: string;
  group: string | null;
  source_section: string | null;
  value: string;
  document_value: string | null;
  extracted_value: string | null;
  page: number | null;
  evidence: string | null;
  found_by: string | null;
  confidence: number | null;
  validation_status: string | null;
  review_status: string | null;
  layout_flags: LayoutFlag[];
}

export interface BusinessIssue {
  code: string;
  message: string;
  source?: "field" | "layout";
}

export interface BusinessField {
  key: string;
  label: string;
  type: string;
  required: boolean;
  date_role: string | null;
  value: string | null;
  record_key: string | null;
  page: number | null;
  evidence: string | null;
  source_label: string | null;
  /** Kept apart: extraction confidence, validation, and a person's review. */
  confidence: number | null;
  validation_status: "passed" | "failed" | "warning" | "missing" | "not_found" | "not_checked";
  review_status: string | null;
  issues: BusinessIssue[];
  candidates: BusinessCandidate[];
}

export interface BusinessTable {
  record_key: string;
  label: string;
  source_section: string | null;
  headers: string[];
  pages: number[];
  rows: LayoutTableRow[];
  row_count: number;
}

export interface BusinessSection {
  key: string;
  label: string;
  /** True: a skill's business category; false: the document's own section. */
  canonical: boolean;
  fields: BusinessField[];
  /** Values listed as found (documents without a skill). */
  values: BusinessCandidate[];
  tables: BusinessTable[];
}

export interface ValidationIssue {
  kind: string;
  severity: "error" | "warning" | "info";
  message: string;
  fields: string[];
  values: Record<string, string | null>;
  candidates?: string[];
  record_keys: string[];
  page: number | null;
  section?: string | null;
}

export interface BusinessData {
  document_class: string | null;
  document_class_label: string | null;
  document_type: string | null;
  subtype: string | null;
  skill: { skill_id: string; version: string; name: string } | null;
  sections: BusinessSection[];
  other: { values: BusinessCandidate[]; tables: BusinessTable[] };
  issues: ValidationIssue[];
  stats: { fields: number; found: number; missing_required: number; values: number; tables: number; other_values: number };
}

export interface ValidationSummary {
  groups: { kind: string; label: string; severity: "error" | "warning" | "info"; issues: ValidationIssue[] }[];
  counts: { errors: number; warnings: number; info: number };
}

export interface DocumentDate {
  role: string;
  role_label: string;
  text: string;
  date: string | null;
  valid: boolean;
  /** explicit: printed as this date; inferred: read off another statement. */
  basis: "explicit" | "inferred";
  inferred_from?: string;
  label: string;
  page: number | null;
  evidence: string | null;
  record_key: string | null;
  source: string;
}

export type ExpirationStatus = "Active" | "Expiring Soon" | "Expired" | "Not Applicable" | "Unknown";

export interface DocumentDates {
  status: ExpirationStatus;
  reason: string;
  days_remaining: number | null;
  warning_days: number;
  expiration: DocumentDate | null;
  dates: DocumentDate[];
}

export interface FindAnswer {
  value: string;
  source_label?: string;
  page: number | null;
  evidence: string | null;
  record_key?: string | null;
  confidence: number | null;
  validation_status: string;
  review_status?: string | null;
  basis?: "explicit" | "inferred";
}

export interface FindResult {
  query: string;
  label: string;
  kind?: "field" | "clauses" | "date";
  found: boolean;
  answers?: FindAnswer[];
  message: string;
}

export function getBusinessData(documentId: string): Promise<BusinessData> {
  return apiFetch(`/api/documents/${documentId}/business-data`);
}

export function getValidationSummary(documentId: string): Promise<ValidationSummary> {
  return apiFetch(`/api/documents/${documentId}/validation-summary`);
}

export function getDocumentDates(documentId: string, warningDays?: number): Promise<DocumentDates> {
  const query = warningDays ? `?warning_days=${warningDays}` : "";
  return apiFetch(`/api/documents/${documentId}/document-dates${query}`);
}

export function findValue(documentId: string, query: string): Promise<FindResult> {
  return apiFetch(`/api/documents/${documentId}/find`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
}

function stem(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{2,5}$/, "");
}

/** Whole-document exports built from the same records as the workspace. */
export function downloadWorkspaceExport(documentId: string, kind: "original" | "all_fields" | "json", documentName: string) {
  const spec = {
    original: { format: "xlsx" as const, href: `/api/documents/${documentId}/original-structure/export.xlsx`, label: "Original Structure export", name: `${stem(documentName)} - original structure.xlsx` },
    all_fields: { format: "csv" as const, href: `/api/documents/${documentId}/all-fields.csv`, label: "All Extracted Fields export", name: `${stem(documentName)} - all extracted fields.csv` },
    json: { format: "json" as const, href: `/api/documents/${documentId}/structured.json`, label: "Structured JSON export", name: `${stem(documentName)} - structured.json` },
  }[kind];
  return downloadExport({ capability_id: kind, label: spec.label, format: spec.format, href: spec.href, dataset_id: null }, spec.name);
}

/** Only the selected records, in their original layout. */
export function downloadSelectedRecords(documentId: string, records: string[], format: SelectedExportFormat, documentName: string) {
  return postSelectedExport(
    `/api/documents/${documentId}/original-structure/export-selected`,
    { records, format },
    format,
    `${stem(documentName)} - selected records.${format}`,
  );
}
