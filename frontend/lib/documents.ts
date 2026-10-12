import { apiFetch } from "@/lib/api";

import type {
  ApproveDocumentResult,
  ChildRelationshipsResult,
  ClassificationHistoryEntry,
  ClassificationUpdate,
  ClauseExtractionResult,
  ConfirmRelationshipResult,
  ContractAnalysisResult,
  ContractClassification,
  DashboardStats,
  DetectedRelationship,
  DiscoverSchemaResult,
  DocumentHierarchyResult,
  DocumentPage,
  PageTranscript,
  DocumentSearchResponse,
  DocumentStatusCountsResponse,
  DocumentSummary,
  DocumentTarget,
  DuplicateResolution,
  ExtractTargetsResult,
  ExtractionJob,
  ExtractionProgress,
  ExtractionSummary,
  FieldAuditEntry,
  FinancialAnalysisResult,
  GlobalAuditLogFilters,
  GlobalAuditLogResponse,
  MetadataField,
  PageRender,
  PromoteDocumentResult,
  RelationshipAction,
  ReviewAction,
  ReviewQueueEntry,
  ReviewQueueFieldItem,
  SignatureExtractionResult,
  StructureDetectionResult,
  StructuredContractOutput,
  TableExtractionResult,
  UniversalExtractionResult,
  UploadedDocument,
} from "@/types/document";

export async function listDocuments(
  limit = 10,
): Promise<DocumentSummary[]> {
  return apiFetch(`/api/documents?limit=${limit}`);
}

export async function deleteDocument(documentId: string): Promise<void> {
  return apiFetch(`/api/documents/${documentId}`, {
    method: "DELETE",
  });
}

export interface BulkDeleteResult {
  deleted: string[];
  not_found: string[];
  forbidden: string[];
  storage_errors: string[];
}

/** Deletes documents and everything that belongs to them, in one request
 * (the server's single deletion service). */
export async function deleteDocuments(documentIds: string[]): Promise<BulkDeleteResult> {
  return apiFetch("/api/documents/bulk-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ document_ids: documentIds }),
  });
}

export async function getDashboardStats(): Promise<DashboardStats> {
  return apiFetch("/api/dashboard/stats");
}

export type DocumentSortBy = "uploaded_at" | "updated_at";
export type DocumentSortDir = "asc" | "desc";

export interface DocumentSearchParams {
  q?: string;
  status?: string;
  documentType?: string;
  confidence_min?: number;
  confidence_max?: number;
  repositoryStatus?: string;
  /** Staging family: invoice, academic_transcript, government_contract … */
  family?: string;
  /** Persisted staging profile id (contract_v3, invoice, …). */
  profileId?: string;
  sortBy?: DocumentSortBy;
  sortDir?: DocumentSortDir;
  limit?: number;
  offset?: number;
}

export async function searchDocuments(
  params: DocumentSearchParams = {},
): Promise<DocumentSearchResponse> {
  const query = new URLSearchParams();

  if (params.q) query.set("q", params.q);
  if (params.status) query.set("status", params.status);
  if (params.documentType) {
    query.set("document_type", params.documentType);
  }
  if (params.confidence_min !== undefined) {
    query.set("confidence_min", String(params.confidence_min));
  }
  if (params.confidence_max !== undefined) {
    query.set("confidence_max", String(params.confidence_max));
  }
  if (params.repositoryStatus) {
    query.set("repository_status", params.repositoryStatus);
  }
  if (params.family) query.set("family", params.family);
  if (params.profileId) query.set("profile_id", params.profileId);
  if (params.sortBy) query.set("sort_by", params.sortBy);
  if (params.sortDir) query.set("sort_dir", params.sortDir);
  query.set("limit", String(params.limit ?? 25));
  query.set("offset", String(params.offset ?? 0));

  return apiFetch(`/api/documents/search?${query.toString()}`);
}

export async function getDocumentStatusCounts(
  family?: string,
): Promise<DocumentStatusCountsResponse> {
  const query = family ? `?family=${encodeURIComponent(family)}` : "";
  return apiFetch(`/api/documents/status-counts${query}`);
}

export async function getGlobalAuditLog(
  limit = 50,
  offset = 0,
  filters: GlobalAuditLogFilters = {},
): Promise<GlobalAuditLogResponse> {
  const query = new URLSearchParams();
  query.set("limit", String(limit));
  query.set("offset", String(offset));
  if (filters.documentId) query.set("document_id", filters.documentId);
  if (filters.actorId) query.set("actor_id", filters.actorId);
  if (filters.changedBy) query.set("changed_by", filters.changedBy);
  if (filters.action) query.set("action", filters.action);
  if (filters.requestId) query.set("request_id", filters.requestId);
  if (filters.outcome) query.set("outcome", filters.outcome);
  if (filters.from) query.set("from", filters.from);
  if (filters.to) query.set("to", filters.to);
  return apiFetch(`/api/documents/audit-log?${query.toString()}`);
}

export async function getReviewQueue(): Promise<ReviewQueueEntry[]> {
  return apiFetch("/api/dashboard/review-queue");
}

export async function getReviewQueueFields(): Promise<ReviewQueueFieldItem[]> {
  return apiFetch("/api/dashboard/review-queue/fields");
}

export async function resolveDuplicate(
  documentId: string,
  action: DuplicateResolution,
  originalFilename?: string,
  onRetry?: (attempt: number, total: number) => void,
  existingDocumentId?: string,
): Promise<UploadedDocument> {
  return apiFetch(
    `/api/documents/${documentId}/resolve-duplicate`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action,
        original_filename: originalFilename ?? null,
        existing_document_id: existingDocumentId ?? null,
      }),
    },
    onRetry,
  );
}

export async function extractDocumentPages(
  documentId: string,
  onRetry?: (attempt: number, total: number) => void,
): Promise<ExtractionSummary> {
  return apiFetch(
    `/api/documents/${documentId}/extract-pages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        run_ocr: true,
        page_start: null,
        page_end: null,
        force_reprocess: false,
      }),
    },
    onRetry,
  );
}

export async function getExtractionProgress(
  documentId: string,
): Promise<ExtractionProgress> {
  return apiFetch(`/api/documents/${documentId}/progress`);
}

export async function getDocumentPages(
  documentId: string,
): Promise<DocumentPage[]> {
  return apiFetch(`/api/documents/${documentId}/pages`);
}

export async function getPageTranscript(
  documentId: string,
  pageNumber: number,
): Promise<PageTranscript> {
  return apiFetch(`/api/documents/${documentId}/pages/${pageNumber}/transcript`);
}

export async function detectStructures(
  documentId: string,
  onRetry?: (attempt: number, total: number) => void,
): Promise<StructureDetectionResult> {
  return apiFetch(
    `/api/documents/${documentId}/detect-structures`,
    { method: "POST" },
    onRetry,
  );
}

export async function analyzeFinancialDocument(
  documentId: string,
  instruction: string,
): Promise<FinancialAnalysisResult> {
  return apiFetch(`/api/documents/${documentId}/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      instruction,
      page_start: null,
      page_end: null,
    }),
  });
}

export async function analyzeContract(
  documentId: string,
  extractionModelId?: number | null,
  onRetry?: (attempt: number, total: number) => void,
): Promise<ContractAnalysisResult> {
  return apiFetch(
    `/api/documents/${documentId}/analyze-contract`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        extraction_model_id: extractionModelId ?? null,
      }),
    },
    onRetry,
  );
}

export async function confirmRelationship(
  documentId: string,
  action: RelationshipAction,
  changedBy: string,
): Promise<ConfirmRelationshipResult> {
  return apiFetch(`/api/documents/${documentId}/confirm-relationship`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, changed_by: changedBy }),
  });
}

export async function assignRelationship(
  documentId: string,
  parentDocumentId: string,
  changedBy: string,
  relationshipType = "amendment_of",
): Promise<DetectedRelationship> {
  return apiFetch(`/api/documents/${documentId}/relationship`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent_document_id: parentDocumentId,
      relationship_type: relationshipType,
      changed_by: changedBy,
    }),
  });
}

export async function removeRelationship(
  documentId: string,
  changedBy: string,
): Promise<void> {
  await apiFetch(`/api/documents/${documentId}/relationship`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ changed_by: changedBy }),
  });
}

export async function updateClassification(
  documentId: string,
  update: ClassificationUpdate,
): Promise<ContractClassification> {
  return apiFetch(`/api/documents/${documentId}/classification`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(update),
  });
}

export async function getClassificationHistory(
  documentId: string,
): Promise<ClassificationHistoryEntry[]> {
  return apiFetch(`/api/documents/${documentId}/classification-history`);
}

export async function getDocumentHierarchy(): Promise<DocumentHierarchyResult> {
  return apiFetch("/api/documents/hierarchy");
}

export async function getChildRelationships(
  documentId: string,
): Promise<ChildRelationshipsResult> {
  return apiFetch(`/api/documents/${documentId}/child-relationships`);
}

export async function approveDocument(
  documentId: string,
  changedBy: string,
): Promise<ApproveDocumentResult> {
  return apiFetch(`/api/documents/${documentId}/approve`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ changed_by: changedBy }),
  });
}

export async function promoteDocument(
  documentId: string,
  changedBy: string,
): Promise<PromoteDocumentResult> {
  return apiFetch(`/api/documents/${documentId}/promote`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ changed_by: changedBy }),
  });
}

export async function getStructuredOutput(
  documentId: string,
): Promise<StructuredContractOutput> {
  return apiFetch(`/api/documents/${documentId}/structured-output`);
}

export async function getDocument(
  documentId: string,
): Promise<UploadedDocument> {
  return apiFetch(`/api/documents/${documentId}`);
}

export async function getContractAnalysis(
  documentId: string,
): Promise<ContractAnalysisResult> {
  return apiFetch(`/api/documents/${documentId}/analyze-contract`);
}

export interface PageHighlightOptions {
  highlight?: string | null;
  /** Text locating the record the highlight belongs to (see backend
   * page_extraction.locate_highlight). */
  anchor?: string | null;
  /** PDF-point bbox of the source region. */
  region?: [number, number, number, number] | null;
}

export async function getPageRender(
  documentId: string,
  pageNumber: number,
  options: PageHighlightOptions | string = {},
): Promise<PageRender> {
  const { highlight, anchor, region } =
    typeof options === "string" ? { highlight: options } : options;
  const query = new URLSearchParams();
  if (highlight) query.set("highlight", highlight);
  if (anchor) query.set("anchor", anchor);
  if (region) query.set("region", region.join(","));
  const queryString = query.toString();
  const params = queryString ? `?${queryString}` : "";

  return apiFetch(
    `/api/documents/${documentId}/pages/${pageNumber}/render${params}`,
  );
}

export async function reviewMetadataField(
  documentId: string,
  fieldKey: string,
  action: ReviewAction,
  changedBy: string,
  value?: string,
): Promise<MetadataField> {
  return apiFetch(
    `/api/documents/${documentId}/metadata-fields/${fieldKey}/review`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action,
        value: value ?? null,
        changed_by: changedBy,
      }),
    },
  );
}

/** Prefer this over field_key review when the persisted row id is known. */
export async function reviewMetadataFieldById(
  documentId: string,
  metadataFieldId: number,
  action: ReviewAction,
  changedBy: string,
  value?: string,
): Promise<MetadataField> {
  return apiFetch(
    `/api/documents/${documentId}/metadata-fields/by-id/${metadataFieldId}/review`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action,
        value: value ?? null,
        changed_by: changedBy,
      }),
    },
  );
}

export async function acceptAllMetadataFields(
  documentId: string,
  changedBy: string,
): Promise<MetadataField[]> {
  return apiFetch(`/api/documents/${documentId}/metadata-fields/accept-all`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ changed_by: changedBy }),
  });
}

export async function getFieldAuditLog(
  documentId: string,
  fieldKey: string,
): Promise<FieldAuditEntry[]> {
  return apiFetch(
    `/api/documents/${documentId}/metadata-fields/${fieldKey}/audit-log`,
  );
}

export async function getFieldAuditLogById(
  documentId: string,
  metadataFieldId: number,
): Promise<FieldAuditEntry[]> {
  return apiFetch(
    `/api/documents/${documentId}/metadata-fields/by-id/${metadataFieldId}/audit-log`,
  );
}

export async function extractClauses(
  documentId: string,
): Promise<ClauseExtractionResult> {
  return apiFetch(`/api/documents/${documentId}/extract-clauses`, {
    method: "POST",
  });
}

export async function getClauses(
  documentId: string,
): Promise<ClauseExtractionResult> {
  return apiFetch(`/api/documents/${documentId}/extract-clauses`);
}

export async function extractTables(
  documentId: string,
): Promise<TableExtractionResult> {
  return apiFetch(`/api/documents/${documentId}/extract-tables`, {
    method: "POST",
  });
}

export async function extractSignatures(
  documentId: string,
): Promise<SignatureExtractionResult> {
  return apiFetch(`/api/documents/${documentId}/extract-signatures`, {
    method: "POST",
  });
}

export async function getSignatures(
  documentId: string,
): Promise<SignatureExtractionResult> {
  return apiFetch(`/api/documents/${documentId}/extract-signatures`);
}

export async function universalExtract(
  documentId: string,
  instruction: string,
  onRetry?: (attempt: number, total: number) => void,
): Promise<UniversalExtractionResult> {
  return apiFetch(
    `/api/documents/${documentId}/extract`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        instruction,
        page_start: null,
        page_end: null,
        max_pages: 20,
        use_ai_fallback: true,
      }),
    },
    onRetry,
  );
}

export async function discoverSchema(
  documentId: string,
  onRetry?: (attempt: number, total: number) => void,
): Promise<DiscoverSchemaResult> {
  return apiFetch(
    `/api/documents/${documentId}/discover-schema`,
    { method: "POST" },
    onRetry,
  );
}

export async function getTargets(
  documentId: string,
): Promise<DiscoverSchemaResult> {
  return apiFetch(`/api/documents/${documentId}/targets`);
}

export async function getExtractResults(
  documentId: string,
): Promise<ExtractTargetsResult> {
  return apiFetch(`/api/documents/${documentId}/extract-results`);
}

export async function createCustomTarget(
  documentId: string,
  label: string,
): Promise<DocumentTarget> {
  return apiFetch(`/api/documents/${documentId}/targets/custom`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
}

export async function renameCustomTarget(
  documentId: string,
  targetKey: string,
  label: string,
): Promise<DocumentTarget> {
  return apiFetch(
    `/api/documents/${documentId}/targets/custom/${encodeURIComponent(targetKey)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    },
  );
}

export async function deleteCustomTarget(
  documentId: string,
  targetKey: string,
): Promise<void> {
  await apiFetch(
    `/api/documents/${documentId}/targets/custom/${encodeURIComponent(targetKey)}`,
    { method: "DELETE" },
  );
}

// The backend caps a single extract-targets request at 50 target IDs
// (app/schemas/document_target.py). "Extract All" can easily select
// more than that, so split into sequential batches and merge the
// results rather than surfacing a 422 for selecting too much at once.
/** Sync extract-targets API cap — keep in sync with backend EXTRACTION_BATCH_SIZE. */
export const MAX_TARGET_IDS_PER_REQUEST = 50;

export function chunkTargetIds<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

export async function extractTargets(
  documentId: string,
  targetIds: string[],
  onRetry?: (attempt: number, total: number) => void,
): Promise<ExtractTargetsResult> {
  const batches = chunkTargetIds(targetIds, MAX_TARGET_IDS_PER_REQUEST);

  const merged: ExtractTargetsResult = {
    document_id: documentId,
    scalars: [],
    tables: [],
    unresolved_targets: [],
    warnings: [],
  };

  for (const batch of batches) {
    const result = await apiFetch<ExtractTargetsResult>(
      `/api/documents/${documentId}/extract-targets`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          target_ids: batch,
          use_ai_fallback: true,
        }),
      },
      onRetry,
    );

    if (!result || typeof result !== "object") {
      merged.warnings.push("A target batch returned an empty response.");
      merged.unresolved_targets.push(...batch);
      continue;
    }

    merged.scalars.push(...(result.scalars ?? []));
    merged.tables.push(...(result.tables ?? []));
    merged.unresolved_targets.push(...(result.unresolved_targets ?? []));
    merged.warnings.push(...(result.warnings ?? []));
  }

  return merged;
}

export async function startExtractionJob(
  documentId: string,
  targetIds: string[],
  onRetry?: (attempt: number, total: number) => void,
): Promise<ExtractionJob> {
  return apiFetch(
    `/api/documents/${documentId}/jobs/extract`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        target_ids: targetIds,
        use_ai_fallback: true,
      }),
    },
    onRetry,
  );
}

export async function getExtractionJob(
  jobId: number,
  onRetry?: (attempt: number, total: number) => void,
): Promise<ExtractionJob> {
  return apiFetch(`/v1/jobs/${jobId}`, undefined, onRetry);
}

// Jobs run for minutes on large documents. Polling starts quick for short
// jobs, then backs off: Render's edge (Cloudflare) rate-limits bursty
// clients with a 429 challenge the browser reports as unreachable.
const JOB_POLL_INITIAL_MS = 1500;
const JOB_POLL_MAX_MS = 5000;
const JOB_POLL_BACKOFF = 1.3;

function nextJobPollDelay(current: number): number {
  return Math.min(Math.round(current * JOB_POLL_BACKOFF), JOB_POLL_MAX_MS);
}
const MIN_STAGE_DWELL_MS = 450;

export async function startProcessingJob(
  documentId: string,
  onRetry?: (attempt: number, total: number) => void,
): Promise<ExtractionJob> {
  return apiFetch(
    `/api/documents/${documentId}/jobs/process`,
    { method: "POST" },
    onRetry,
  );
}

export async function processDocumentViaJob(
  documentId: string,
  existingJobId?: number | null,
  onStageChange?: (job: ExtractionJob) => void,
  onRetry?: (attempt: number, total: number) => void,
): Promise<ExtractionJob> {
  let job =
    existingJobId != null
      ? await getExtractionJob(existingJobId, onRetry)
      : await startProcessingJob(documentId, onRetry);

  let lastStage = job.stage || job.status;
  let lastStageAt = Date.now();
  onStageChange?.(job);

  let pollDelay = JOB_POLL_INITIAL_MS;
  while (job.status === "queued" || job.status === "processing") {
    await new Promise((resolve) => setTimeout(resolve, pollDelay));
    pollDelay = nextJobPollDelay(pollDelay);
    job = await getExtractionJob(job.id, onRetry);
    const nextStage = job.stage || job.status;
    if (nextStage !== lastStage) {
      const elapsed = Date.now() - lastStageAt;
      if (elapsed < MIN_STAGE_DWELL_MS) {
        await new Promise((resolve) =>
          setTimeout(resolve, MIN_STAGE_DWELL_MS - elapsed),
        );
      }
      lastStage = nextStage;
      lastStageAt = Date.now();
    }
    onStageChange?.(job);
  }

  if (job.status === "failed") {
    throw new Error(job.error_message ?? "Document processing failed.");
  }

  // Hold the final processing stage briefly so Completeness is visible.
  const settle = Date.now() - lastStageAt;
  if (settle < MIN_STAGE_DWELL_MS) {
    await new Promise((resolve) =>
      setTimeout(resolve, MIN_STAGE_DWELL_MS - settle),
    );
  }

  return job;
}

/**
 * Runs target extraction as a background job instead of the client-side
 * chunked requests above, so the frontend never has to know about (or
 * expose to the user) any backend batch limit — one job, any number of
 * target ids, the server batches internally.
 */
export async function extractTargetsViaJob(
  documentId: string,
  targetIds: string[],
  onStageChange?: (job: ExtractionJob) => void,
  onRetry?: (attempt: number, total: number) => void,
): Promise<ExtractTargetsResult> {
  const empty: ExtractTargetsResult = {
    document_id: documentId,
    scalars: [],
    tables: [],
    unresolved_targets: [...targetIds],
    warnings: ["Extraction returned no usable result payload."],
  };

  // Deduplicate / drop empties so stale UI IDs cannot crash rendering.
  const cleanIds = Array.from(
    new Set(targetIds.filter((id) => typeof id === "string" && id.trim())),
  );
  if (cleanIds.length === 0) {
    return {
      ...empty,
      unresolved_targets: [],
      warnings: ["No valid target IDs were selected."],
    };
  }

  let job = await startExtractionJob(documentId, cleanIds, onRetry);
  if (!job || typeof job.id !== "number") {
    // A resolved-but-invalid `job` here means the POST got an ok (2xx)
    // response whose body wasn't the expected ExtractionJob JSON — most
    // often a non-JSON page (proxy/cold-start interstitial) that apiFetch
    // returns as a raw string. Surface what was actually received instead
    // of a dead-end message, so the next occurrence is diagnosable from
    // the on-screen error alone.
    const raw: unknown = job;
    const received =
      typeof raw === "string"
        ? raw.slice(0, 200)
        : JSON.stringify(raw)?.slice(0, 200);
    throw new Error(
      `Failed to start extraction job. Unexpected response from the ` +
        `server${received ? `: ${received}` : "."}`,
    );
  }
  onStageChange?.(job);

  let pollDelay = JOB_POLL_INITIAL_MS;
  while (job.status === "queued" || job.status === "processing") {
    await new Promise((resolve) => setTimeout(resolve, pollDelay));
    pollDelay = nextJobPollDelay(pollDelay);
    const next = await getExtractionJob(job.id, onRetry);
    if (!next) {
      throw new Error("Lost contact with the extraction job.");
    }
    job = next;
    onStageChange?.(job);
  }

  if (job.status === "failed") {
    throw new Error(job.error_message ?? "Extraction failed.");
  }

  const raw = job.result;
  if (!raw || typeof raw !== "object") {
    return empty;
  }

  // Normalize so callers never see undefined arrays (large selections
  // previously crashed when partial payloads omitted keys).
  return {
    document_id:
      typeof raw.document_id === "string" ? raw.document_id : documentId,
    scalars: Array.isArray(raw.scalars) ? raw.scalars : [],
    tables: Array.isArray(raw.tables) ? raw.tables : [],
    unresolved_targets: Array.isArray(raw.unresolved_targets)
      ? raw.unresolved_targets
      : [],
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    ai_enrichment:
      raw.ai_enrichment && typeof raw.ai_enrichment === "object" ? raw.ai_enrichment : null,
  };
}

export async function selectPortfolioFile(
  documentId: string,
  filename: string,
  onRetry?: (attempt: number, total: number) => void,
): Promise<UploadedDocument> {
  return apiFetch(
    `/api/documents/${documentId}/portfolio/select`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ filename }),
    },
    onRetry,
  );
}
