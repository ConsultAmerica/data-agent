import { apiFetch } from "@/lib/api";

/** Mirrors backend app/document_validation (service.py and its parts) and
 * the jobs retry endpoint (app/api/jobs.py). */

export type StageStatus = "done" | "active" | "failed" | "pending";
export type CheckStatus = "passed" | "warning" | "failed" | "info";
export type MeasureStatus = "complete" | "gaps" | "not_measured" | "not_applicable";
export type ReadinessState = "ready" | "ready_with_warnings" | "review_required";

export interface JobFailure {
  job_id: number;
  job_type: string;
  stage: string | null;
  reason: string;
  retryable: boolean;
  message: string;
  retry_count: number;
}

export interface ProcessingStage {
  key: "uploading" | "file_verified" | "classifying" | "extracting" | "validating" | "ready_for_review";
  label: string;
  status: StageStatus;
  detail: string;
  job_id?: number;
  failure?: JobFailure;
}

export interface FileCheck {
  code: string;
  label: string;
  status: CheckStatus;
  detail: string;
  pages?: number[];
}

export interface CompletenessMeasure {
  key: string;
  label: string;
  source: number | null;
  represented: number | null;
  status: MeasureStatus;
  detail: string;
  missing: Record<string, unknown>[];
  missing_count: number;
}

export interface LabelEntry {
  record_key: string | null;
  printed: string;
  display: string;
  item_number: string;
  meaning: string | null;
  value: string | null;
  page: number | null;
}

export interface ConsistencyCheck {
  key: string;
  label: string;
  status: "consistent" | "inconsistent";
  expected: unknown;
  found: unknown;
  examples: Record<string, unknown>[];
}

export interface ReadinessCheck {
  key: string;
  label: string;
  status: "passed" | "warning" | "blocker" | "info";
  detail: string;
}

export interface ClassificationCandidate {
  family: string;
  family_label: string | null;
  score: number | null;
  subtype?: string | null;
  evidence?: string[];
}

export interface DocumentValidation {
  document_id: string;
  generated_at: string;
  cached?: boolean;
  processing: {
    stages: ProcessingStage[];
    completed: number;
    total: number;
    failed: boolean;
    job_durations_ms: Record<string, number>;
  };
  file: { status: "verified" | "warning" | "failed"; checks: FileCheck[]; facts: Record<string, unknown> };
  classification: {
    family: string;
    family_label: string;
    subtype: string | null;
    confidence: number | null;
    status: string;
    review_status: string;
    decided: boolean;
    review_required: boolean;
    evidence: string[];
    candidates: ClassificationCandidate[];
    suggested: ClassificationCandidate | null;
  } | null;
  labels: {
    total: number;
    resolved: number;
    by_source: Record<string, number>;
    unresolved: LabelEntry[];
    rewritten: LabelEntry[];
    rewritten_count: number;
  } | null;
  association: {
    fields: Record<"confirmed" | "matched" | "needs_review" | "unresolved", number>;
    needs_review: { key: string; label: string; value: string | null; page: number | null; candidates: string[]; issues: string[] }[];
    issues: { message: string; page: number | null; record_keys: string[] }[];
    issue_count: number;
  } | null;
  completeness: {
    status: "complete" | "gaps" | "partial";
    measures: CompletenessMeasure[];
    gaps: CompletenessMeasure[];
    review: { key: string; count: number; message: string }[];
  } | null;
  consistency: { status: "consistent" | "inconsistent"; checks: ConsistencyCheck[]; rows: number } | null;
  entities: { contracts: string[] };
  readiness: { state: ReadinessState; label: string; checks: ReadinessCheck[]; note: string } | null;
  summary: { state: "ready" | "warnings" | "review_required" | "processing" | "failed"; headline: string };
  timings_ms: Record<string, number>;
}

export function getDocumentValidation(documentId: string): Promise<DocumentValidation> {
  return apiFetch(`/api/documents/${documentId}/upload-validation`);
}

export function revalidateDocument(documentId: string, parts: ("file" | "all")[] = ["all"]): Promise<DocumentValidation> {
  return apiFetch(`/api/documents/${documentId}/upload-validation/revalidate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts }),
  });
}

export function retryJob(jobId: number): Promise<{ id: number; status: string; retry_count: number }> {
  return apiFetch(`/v1/jobs/${jobId}/retry`, { method: "POST" });
}

export const FAILURE_REASONS: Record<string, string> = {
  file_invalid: "The file failed verification",
  source_unavailable: "The stored file couldn't be reached",
  extraction_failed: "Reading the pages failed",
  timeout: "The step took too long",
  document_missing: "The document no longer exists",
  interrupted: "Interrupted by a server restart",
  unexpected_error: "An unexpected error",
};
