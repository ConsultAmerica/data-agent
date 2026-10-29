export interface ExistingDocumentSummary {
  document_id: string;
  original_filename: string;
  size_bytes: number;
  uploaded_at: string;
  file_available: boolean;
}

export interface UploadedDocument {
  document_id: string;
  original_filename: string;
  status: string;
  content_type: string;
  size_bytes: number;
  checksum_sha256: string | null;
  page_count: number;
  encrypted: boolean;
  uploaded_at: string;
  message: string;
  duplicate?: boolean;
  existing_document?: ExistingDocumentSummary | null;
  embedded_files?: EmbeddedFileSummary[] | null;
  pipeline_log?: string[];
  approved_by?: string | null;
  approved_at?: string | null;
  promoted_by?: string | null;
  promoted_at?: string | null;
  source_status?: "available" | "missing";
  size_tier?: string;
  prefer_background?: boolean;
  processing_job_id?: number | null;
  ingestion_provenance?: Record<string, unknown> | null;
  /** Open an existing doc without re-running page extraction. */
  reused_existing?: boolean;
  /** Intake tags given at upload (GET /api/documents/{id}). */
  agency?: string | null;
  contracting_officer?: string | null;
  /** Sensitivity class: public | internal | confidential | restricted (null = not yet classified). */
  data_class?: string | null;
  data_class_source?: string | null;
}

export type DuplicateResolution = "use_existing" | "upload_anyway";

export type DocumentStatus =
  | "processing"
  | "review_required"
  | "completed"
  | "failed";

export type RepositoryStatus =
  | "not_approved"
  | "approved"
  | "repository";

export interface DocumentSummary {
  document_id: string;
  original_filename: string;
  document_type: string | null;
  status: DocumentStatus;
  confidence: number | null;
  uploaded_at: string;
  page_count: number;
  fields_extracted: number;
  last_updated: string;
  counterparty?: string | null;
  effective_date?: string | null;
  expiration_date?: string | null;
  contract_value?: string | null;
  relationship?: string | null;
  repository_status?: RepositoryStatus;
  source_status?: "available" | "missing";
  /** The persisted staging resolution — what the document is listed as.
   * Null until the document has been staged (offer Reprocess). */
  profile_id?: string | null;
  profile_label?: string | null;
  type_label?: string | null;
  staging_status?: "staged" | "not_staged";
  /** Broad category of the detected type (Contracts & Awards, Financial…);
   * "unclassified" until staged. */
  category?: string;
  category_label?: string;
  /** classified | review_recommended | review_required | confirmed. */
  classification_status?: string | null;
  /** Intake tags given at upload (null when none were given). */
  agency?: string | null;
  contracting_officer?: string | null;
  /** Upload batch this document arrived in, and that batch's state. */
  batch_id?: string | null;
  intake_status?: "draft" | "submitted" | "rejected" | null;
}

export interface HierarchyNode {
  document_id: string;
  title: string;
  document_number: string | null;
  document_type: string | null;
  relationship_type: string | null;
  relationship_status: string | null;
  children: HierarchyNode[];
}

export interface DocumentHierarchyResult {
  roots: HierarchyNode[];
}

export interface DashboardStats {
  total_documents: number;
  completed: number;
  review_required: number;
  processing: number;
  extraction_accuracy: number | null;
  average_processing_seconds: number | null;
  human_review_rate: number | null;
  fields_extracted: number;
  review_completion_rate: number | null;
  ocr_accuracy: number | null;
  clause_extraction_accuracy: number | null;
  fields_extracted_today: number;
  documents_requiring_manual_review: number;
}

export type ReviewQueueBucket =
  | "high"
  | "medium"
  | "low"
  | "rejected"
  | "unknown";

export interface ReviewQueueEntry {
  document_id: string;
  original_filename: string;
  document_type: string | null;
  confidence: number | null;
  queue_bucket: ReviewQueueBucket;
  uploaded_at: string;
  pending_field_count?: number;
  attention_field_count?: number;
  top_reasons?: string[];
  review_href?: string | null;
}

export interface ReviewQueueFieldItem {
  document_id: string;
  original_filename: string;
  /** Persisted row id; review actions address the field by it. */
  metadata_field_id?: number | null;
  field_key: string;
  label: string;
  value: string;
  confidence: number;
  confidence_band?: string | null;
  review_status: string;
  extraction_source: string;
  extraction_method?: string | null;
  reasons: string[];
  reason_labels: string[];
  priority: string;
  decision_status: string;
  page_number?: number | null;
  review_href?: string | null;
}

export interface DocumentSearchResponse {
  documents: DocumentSummary[];
  total: number;
}

export interface DocumentStatusCountsResponse {
  total: number;
  by_status: Partial<Record<DocumentStatus, number>>;
  /** Category id -> documents, over the other filters (not the category). */
  by_category?: Record<string, number>;
  /** The same, labeled and in display order (empty categories left out). */
  categories?: CategoryCount[];
}

export interface CategoryCount {
  category: string;
  label: string;
  count: number;
}

export interface GlobalAuditEntry {
  document_id: string;
  document_filename: string;
  field_key: string;
  action: AuditAction;
  previous_value: string | null;
  new_value: string | null;
  previous_status?: string | null;
  new_status?: string | null;
  reason?: string | null;
  request_id?: string | null;
  actor_id?: string | null;
  actor_type?: string | null;
  actor_role?: string | null;
  changed_by: string;
  changed_at: string;
}

export interface GlobalAuditLogFilters {
  documentId?: string;
  actorId?: string;
  changedBy?: string;
  action?: string;
  requestId?: string;
  outcome?: string;
  from?: string;
  to?: string;
}

export interface GlobalAuditLogResponse {
  entries: GlobalAuditEntry[];
  total: number;
}

export interface ExtractionProgress {
  document_id: string;
  status: string;

  page_current: number;
  page_total: number;
  percent: number;

  native_pages: number;
  ocr_pages: number;
  ocr_completed_pages: number;
}

export interface ProcessingStageEntry {
  stage: string;
  at: string;
  duration_ms?: number;
}

export interface DetectedTable {
  key: string;
  label: string;
  pages: number[];
  confidence: number;
  suggested_prompt?: string | null;
  columns?: string[];
}

export interface DetectedField {
  key: string;
  label: string;
  pages: number[];
}

export type DetectionExtractionType =
  | "field"
  | "table"
  | "contact"
  | "obligation"
  | "clause"
  | "signature"
  | "custom";

export interface DetectedTarget {
  key: string;
  label: string;
  extraction_type: DetectionExtractionType;
  pages: number[];
  confidence: number;
  evidence: string[];
  suggested_prompt: string | null;
  columns: string[];
}

export interface DetectionCounts {
  fields: number;
  tables: number;
  contacts: number;
  obligations: number;
  clauses: number;
  signatures: number;
}

export interface ContentStats {
  tables: number;
  dates: number;
  currency_values: number;
  organizations: number;
}

export type TargetType =
  | "field"
  | "table"
  | "section"
  | "contact"
  | "date"
  | "amount"
  | "identifier"
  | "clause"
  | "obligation"
  | "signature"
  | "custom";

export type TargetSource = "detected" | "template" | "custom";

export interface DocumentTarget {
  id: string;
  key: string;
  label: string;
  target_type: TargetType;
  page_numbers: number[];
  confidence: number;
  source_examples: string[];
  parent_section: string | null;
  columns: string[];
  occurrence_count: number;
  suggested_instruction: string | null;
  source: TargetSource;
  display_name?: string | null;
  group?: string | null;
  value_type?: string | null;
  discovery_method?: string | null;
  source_labels?: string[];
  is_custom?: boolean;
  is_internal?: boolean;
  selectable?: boolean;
  description?: string | null;
}

export interface DiscoverSchemaResult {
  document_id: string;
  document_family: string;
  document_family_label: string;
  document_family_confidence: number;
  /** Broad category the document is grouped under. */
  category?: string | null;
  category_label?: string | null;
  /** The type the document is listed as, e.g. "SF 1442 Contract Award". */
  type_label?: string | null;
  targets: DocumentTarget[];
  counts_by_type: Partial<Record<TargetType, number>>;
  generated_at: string;
}

export type ConfidenceBand = "high" | "medium" | "low";

export interface CandidatePageScore {
  page: number;
  score: number;
}

export interface RetrievalTrace {
  target_key: string;
  candidate_pages: CandidatePageScore[];
  selected_pages: number[];
  deterministic_status:
    | "resolved"
    | "ambiguous"
    | "unresolved"
    | "not_attempted";
  ai_fallback_required: boolean;
}

export interface ConfidenceSignals {
  exact_label_match: boolean;
  label_proximity: "strong" | "moderate" | "weak" | "none";
  native_text: boolean;
  format_validation: boolean;
  source_grounded: boolean;
  corroborating_occurrences: number;
  ambiguity: boolean;
  ai_fallback: boolean;
}

export interface ConfidenceDetail {
  score: number;
  band: ConfidenceBand;
  signals: ConfidenceSignals;
}

export interface ValidationCheck {
  type: string;
  status: "passed" | "failed" | "skipped";
  detail?: string | null;
}

export interface ValidationResult {
  status: "passed" | "failed" | "skipped";
  checks: ValidationCheck[];
  warnings: string[];
}

export interface ScalarTargetResult {
  target: string;
  normalized_key: string;
  value: unknown;
  /** Latest machine extract when it differs from reviewed ``value``. */
  extracted_value?: unknown;
  review_status?: string | null;
  page: number;
  confidence: number;
  confidence_band: ConfidenceBand;
  verified: boolean;
  extraction_method: string;
  display_method: string;
  evidence: SourceEvidence;
  retrieval?: RetrievalTrace | null;
  confidence_detail?: ConfidenceDetail | null;
  validation?: ValidationResult | null;
  review_decision?: {
    status?: string;
    priority?: string;
    reasons?: string[];
  } | null;
  confidence_signals?: Array<Record<string, unknown>>;
  validation_status?: "passed" | "failed" | "skipped";
}

export interface TableTargetResult {
  target: string;
  columns: string[];
  rows: Record<string, unknown>[];
  pages: number[];
}

/** Optional AI enrichment outcome of a processing run. AI never decides
 * whether a document processed: deterministic_status does. */
export interface AIEnrichmentSummary {
  deterministic_status: "completed";
  ai_enrichment_status: "completed" | "not_needed" | "skipped" | "unavailable" | "failed";
  reason: string | null;
  notice: { title: string; detail: string | null } | null;
  provider: string | null;
  model: string | null;
  error_kind: string | null;
  error_detail: string | null;
  calls_attempted: number;
  calls_succeeded: number;
}

export interface ExtractTargetsResult {
  document_id: string;
  scalars: ScalarTargetResult[];
  tables: TableTargetResult[];
  unresolved_targets: string[];
  warnings: string[];
  ai_enrichment?: AIEnrichmentSummary | null;
}

export type CorrectionAction = "edit" | "verify" | "reject";

export interface TargetCorrection {
  id: number;
  document_id: string;
  normalized_key: string;
  action: CorrectionAction;
  original_value: unknown;
  corrected_value: unknown;
  evidence_snapshot: SourceEvidence | null;
  changed_by: string | null;
  created_at: string;
}

export type ExtractionJobType = "processing" | "extraction";
export type ExtractionJobStatus = "queued" | "processing" | "complete" | "failed";

export interface ExtractionJob {
  id: number;
  document_id: string;
  job_type: ExtractionJobType;
  status: ExtractionJobStatus;
  stage: string | null;
  progress: number;
  error_message: string | null;
  retry_count: number;
  result: (ExtractTargetsResult & {
    stage_history?: ProcessingStageEntry[];
    stage_timings_ms?: Record<string, number>;
    pages_reused?: boolean;
    discovery_reused?: boolean;
    partial?: boolean;
    batches_completed?: number;
    batches_total?: number;
    targets_discovered?: number;
    page_text_chars?: number;
    warnings?: string[];
  }) | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface EmbeddedFileSummary {
  filename: string;
  size_bytes: number;
  page_count?: number | null;
}

export interface StructureDetectionResult {
  document_id: string;

  document_family: string;
  document_family_label: string;
  document_family_confidence: number;

  detected_fields: DetectedField[];
  detected_tables: DetectedTable[];
  detected_contacts: string[];
  detected_obligations: string[];

  detected_targets: DetectedTarget[];
  possible_targets: DetectedTarget[];

  content_stats: ContentStats;
  counts: DetectionCounts;
}

export interface ExtractionSummary {
  document_id: string;
  status: string;

  total_document_pages: number;
  pages_requested: number;
  pages_processed: number;

  native_pages: number;
  ocr_required_pages: number;
  ocr_completed_pages: number;
  failed_pages: number;

  page_numbers_processed: number[];
  warnings: string[];
  page_text_chars?: number;

  completed_at: string;
}

export interface DocumentPage {
  document_id: string;
  page_number: number;
  page_label: string | null;

  extraction_method: string;
  final_text: string;

  requires_ocr: boolean;
  ocr_attempted: boolean;
  ocr_succeeded: boolean;

  character_count: number;
  word_count: number;

  page_width: number;
  page_height: number;

  source_reference: string;
}

export interface FinancialTable {
  table_id: string;
  page_number: number;
  headers: string[];

  rows: Record<
    string,
    string | number | null
  >[];

  confidence: number;

  source_reference: string;

  warnings: string[];
}

export interface FinancialAnalysisResult {
  document_id: string;

  instruction: string;

  pages_used: number[];

  tables: FinancialTable[];

  status: string;

  warnings: string[];
}

export interface SourceEvidence {
  page_number: number;
  source_text: string;
  source_reference: string;

  section?: string | null;

  block_index?: number | null;

  x0?: number | null;
  y0?: number | null;
  x1?: number | null;
  y1?: number | null;
}

export interface UniversalValue {
  label: string;

  value: unknown;

  value_type: string;

  normalized_value?: unknown;

  confidence: number;

  confidence_band?: ConfidenceBand;

  extraction_method: string;

  display_method?: string;

  evidence: SourceEvidence;

  verified: boolean;
}

export interface UniversalTable {
  table_id: string;

  title?: string | null;

  headers: string[];

  rows: Record<
    string,
    unknown
  >[];

  page_number: number;

  confidence: number;

  source_reference: string;
}

export interface UniversalExtractionResult {
  document_id: string;

  instruction: string;

  intent: string;

  answer?: string | null;

  values: UniversalValue[];

  tables: UniversalTable[];

  pages_used: number[];

  unresolved_requests: string[];

  warnings: string[];
}

export type ContractSide = "buy_side" | "sell_side" | "unknown";

export type DocumentStatusLabel =
  | "Original"
  | "Amendment"
  | "Renewal"
  | "Supporting Document"
  | "Unknown";

export const DOCUMENT_TYPE_OPTIONS = [
  "Master Services Agreement",
  "NDA",
  "Supplier Agreement",
  "Purchase Agreement",
  "Professional Services Agreement",
  "Software Agreement",
  "SaaS Agreement",
  "Lease",
  "Statement of Work",
  "Amendment",
  "Change Order",
  "Purchase Order",
  "Service Level Agreement",
  "License Agreement",
  "Consulting Agreement",
  "Construction Agreement",
  "Government Contract",
  "Subcontract",
  "Other",
] as const;

export interface ContractClassification {
  document_type: string;
  industry: string | null;
  contract_side: ContractSide;
  language: string | null;
  document_status: DocumentStatusLabel;
  confidence: number;
}

export interface ClassificationUpdate {
  document_type?: string;
  contract_side?: ContractSide;
  language?: string;
  changed_by: string;
}

export interface ClassificationHistoryEntry {
  field_changed: string;
  previous_value: string | null;
  new_value: string | null;
  changed_by: string;
  changed_at: string;
}

export type ReviewStatus =
  | "pending"
  | "accepted"
  | "edited"
  | "rejected"
  | "unknown";

export type ReviewAction =
  | "accept"
  | "edit"
  | "reject"
  | "mark_unknown";

/** Actions the global audit log can hold: field review actions plus
 * document-level events (approve/promote and the deletion record). */
export type AuditAction = ReviewAction | "approve" | "promote" | "delete";

export interface MetadataField {
  /** Persisted DocumentMetadataField.id — preferred review address. */
  id?: number | null;
  field_group: string;
  field_key: string;
  label: string;

  /** Authoritative effective value (accepted / edited / current). */
  value: string;

  confidence: number;

  extraction_method: string;

  /** contract | target | v3 — distinguishes duplicate field_key rows. */
  extraction_source?: string;

  evidence: SourceEvidence;

  verified: boolean;
  review_status: ReviewStatus;
  original_value: string;
  /** Machine extraction when the API provides it; else fall back to original_value. */
  extracted_value?: string;
}

export interface FieldAuditEntry {
  action: ReviewAction;
  metadata_field_id?: number | null;
  previous_value: string | null;
  new_value: string | null;
  changed_by: string;
  changed_at: string;
}

export type RelationshipStatus =
  | "pending"
  | "confirmed"
  | "rejected"
  | "manual";

export interface DetectedRelationship {
  parent_document_id: string;
  parent_document_title: string;
  parent_document_number: string | null;

  relationship_type: string;

  confidence: number;

  matched_on: "contract_number" | "contract_title";

  status: RelationshipStatus;

  reasons: string[];
  detection_method: "automatic" | "manual";
}

export interface ChildRelationship {
  child_document_id: string;
  child_document_title: string;
  child_document_number: string | null;

  relationship_type: string;

  confidence: number;

  status: RelationshipStatus;

  reasons: string[];
}

export interface ChildRelationshipsResult {
  parent_document_id: string;
  children: ChildRelationship[];
}

export interface ApproveDocumentResult {
  document_id: string;
  approved_by: string;
  approved_at: string;
}

export interface PromoteDocumentResult {
  document_id: string;
  promoted_by: string;
  promoted_at: string;
}

export interface ContractAnalysisResult {
  document_id: string;

  classification: ContractClassification;

  metadata_fields: MetadataField[];

  relationship: DetectedRelationship | null;

  warnings: string[];

  /** Contract number / contractor from the staging workbook, when staged. */
  staged_contract_number?: string | null;

  staged_contractor?: string | null;
}

export type RelationshipAction = "confirm" | "reject";

export interface ConfirmRelationshipResult {
  document_id: string;
  status: "confirmed" | "rejected";
  relationship: DetectedRelationship | null;
}

export interface RenewalTerms {
  type: "automatic" | "manual" | null;
  period_months: number | null;
  notice_days: number | null;
}

export type StructuredContractOutput = Record<string, unknown> & {
  renewal?: RenewalTerms;
};

export interface HighlightBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageRender {
  page_number: number;
  image_data_url: string;
  page_width: number;
  page_height: number;
  highlight: HighlightBox | null;
}

export interface ClauseResult {
  clause_type: string;
  classification: string;
  extracted_text: string;
  value_summary: string;
  confidence: number;
  evidence: SourceEvidence;
}

export interface ClauseExtractionResult {
  document_id: string;
  clauses: ClauseResult[];
  warnings: string[];
}

export interface RateCardRow {
  role: string;
  rate: number | null;
  unit: string | null;
  currency: string | null;
}

export interface NormalizedTable {
  table_id: string;
  table_type: "rate_card" | "generic";
  page_number: number;
  source_reference: string;
  headers: string[];
  rows: Record<string, unknown>[];
  rate_card_rows: RateCardRow[];
}

export interface TableExtractionResult {
  document_id: string;
  tables: NormalizedTable[];
}

export interface SignatureResult {
  party_name: string;
  signatory_name: string;
  signatory_title: string;
  signed: boolean;
  signature_date: string | null;
  confidence: number;
  evidence: SourceEvidence;
}

export interface SignatureExtractionResult {
  document_id: string;
  signatures: SignatureResult[];
  warnings: string[];
}

export type ExtractionFieldDataType =
  | "text"
  | "number"
  | "currency"
  | "date"
  | "boolean"
  | "list";

export interface ExtractionField {
  id: number;
  model_id: number;
  field_name: string;
  description: string;
  data_type: ExtractionFieldDataType;
  created_at: string;
}

export interface ExtractionModel {
  id: number;
  name: string;
  description: string;
  document_types: string[];
  created_at: string;
  fields: ExtractionField[];
}

export interface ActorInfo {
  id: string;
  actor_type: string;
  display_name: string;
  email: string | null;
  role: string;
  active: boolean;
  permissions: string[];
}

/** One page's reading-order transcript (GET /pages/{n}/transcript). Boxes
 * are PDF points in page space — the same space evidence highlights use. */
export type TranscriptBox = [number, number, number, number];

export interface TranscriptLine {
  text: string;
  bbox: TranscriptBox | null;
  words: { text: string; bbox: TranscriptBox }[];
}

export interface TranscriptBlock {
  kind: "heading" | "paragraph" | "table";
  text: string;
  bbox: TranscriptBox | null;
  lines: TranscriptLine[];
  table: { headers: string[]; rows: string[][] } | null;
}

export interface PageTranscript {
  document_id: string;
  page_number: number;
  source_type: string;
  extraction_method: string | null;
  word_count: number;
  page_width: number | null;
  page_height: number | null;
  blocks: TranscriptBlock[];
  /** spatial: lines carry page boxes (highlightable) · text_only: engine
   * text without positions · none: no text on the page. */
  positioning?: "spatial" | "text_only" | "none";
  warnings: string[];
}
