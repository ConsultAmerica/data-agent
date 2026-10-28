import { apiFetch } from "@/lib/api";
import type { DocumentTarget, ScalarTargetResult } from "@/types/document";

/** Mirrors backend app/api/intake.py (mounted at /api/intake). */

export type IntakeStatus = "draft" | "submitted" | "rejected";

export interface IntakeProfileOption {
  profile_id: string;
  label: string;
}

export interface IntakeConfig {
  /** The per-file limit the upload endpoint actually enforces. */
  max_upload_mb: number;
  max_pdf_pages: number;
  profiles: IntakeProfileOption[];
  /** False: a requested profile is stored as a hint only. */
  profile_override_supported: boolean;
}

export interface IntakeBatchDocument {
  document_id: string;
  original_filename: string;
  uploaded_at: string;
  page_count: number;
  size_bytes: number;
  processing_status: string;
  processed_page_count: number;
  ocr_required_page_count: number;
  ocr_completed_page_count: number;
  status: "processing" | "review_required" | "completed" | "failed";
  document_type: string | null;
  profile_id: string | null;
  profile_label: string | null;
  /** Detected document type, e.g. "Receipt". */
  type_label?: string | null;
  /** Broad category of that type, e.g. "Financial". */
  category?: string | null;
  category_label?: string | null;
  agency: string | null;
  contracting_officer: string | null;
  extraction_profile: string;
  intake_status: IntakeStatus;
}

export interface IntakeBatch {
  batch_id: string;
  documents: IntakeBatchDocument[];
  intake_status: IntakeStatus | "mixed";
}

export interface DocumentIntake {
  document_id: string;
  batch_id: string | null;
  agency: string | null;
  contracting_officer: string | null;
  extraction_profile: string;
  intake_status: IntakeStatus;
}

/** What the uploader typed in the intake form. */
export interface IntakeFields {
  batch_id: string;
  agency: string;
  contracting_officer: string;
  /** A staging profile id, or "auto". */
  extraction_profile: string;
}

export function getIntakeConfig(): Promise<IntakeConfig> {
  return apiFetch<IntakeConfig>("/api/intake/config");
}

export function getIntakeBatch(batchId: string): Promise<IntakeBatch> {
  return apiFetch<IntakeBatch>(`/api/intake/batches/${encodeURIComponent(batchId)}`);
}

export function setIntakeBatchStatus(
  batchId: string,
  status: IntakeStatus,
): Promise<{ batch_id: string; intake_status: IntakeStatus; updated: string[] }> {
  return apiFetch(`/api/intake/batches/${encodeURIComponent(batchId)}/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
}

export function getDocumentIntake(documentId: string): Promise<DocumentIntake> {
  return apiFetch<DocumentIntake>(`/api/intake/documents/${documentId}`);
}

/** Tags a document after a duplicate / PDF Portfolio follow-up, where the
 * document only exists once the user has chosen. */
export function putDocumentIntake(
  documentId: string,
  fields: IntakeFields,
): Promise<DocumentIntake> {
  return apiFetch<DocumentIntake>(`/api/intake/documents/${documentId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(intakeFormFields(fields)),
  });
}

/** Multipart / JSON fields for the upload; blanks become "not provided". */
export function intakeFormFields(fields: IntakeFields): Record<string, string | null> {
  return {
    batch_id: fields.batch_id || null,
    agency: fields.agency.trim() || null,
    contracting_officer: fields.contracting_officer.trim() || null,
    extraction_profile: fields.extraction_profile || "auto",
  };
}

/** A batch id the backend accepts ([A-Za-z0-9_-], ≤ 64). */
export function newBatchId(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, "");
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 10)
      : Math.random().toString(36).slice(2, 12);
  return `batch-${stamp}-${random}`;
}

// ---------------------------------------------------------------------------
// Header progress tracker: the four product steps of a batch.

export type IntakeStep = "upload" | "classification" | "extraction" | "review";

export const INTAKE_STEPS: { id: IntakeStep; label: string; detail: string }[] = [
  { id: "upload", label: "Upload", detail: "Files stored and fingerprinted" },
  { id: "classification", label: "Auto-classification", detail: "Pages read, OCR, document type and fields discovered" },
  { id: "extraction", label: "Entity extraction", detail: "Field values extracted, validated and staged" },
  { id: "review", label: "Human-in-the-loop review", detail: "Approved into the review queue" },
];

export function intakeStepIndex(step: IntakeStep): number {
  return INTAKE_STEPS.findIndex((item) => item.id === step);
}

// ---------------------------------------------------------------------------
// Per-file processing queue.

export type FileStage = "upload" | "ocr" | "layout" | "extraction" | "indexing";

export const FILE_STAGES: { id: FileStage; label: string }[] = [
  { id: "upload", label: "Upload" },
  { id: "ocr", label: "OCR" },
  { id: "layout", label: "Layout analysis" },
  { id: "extraction", label: "Field extraction" },
  { id: "indexing", label: "Indexing" },
];

export type FileStageState = "done" | "active" | "pending" | "failed" | "unknown";

/** Backend job / page pipeline stage → the queue's file stage. Only
 * stages the backend actually reports are mapped. */
const PIPELINE_STAGE_TO_FILE_STAGE: Record<string, FileStage> = {
  uploaded: "upload",
  queued: "ocr",
  reading_document: "ocr",
  processing_document: "ocr",
  rendering_ocr: "ocr",
  running_ocr: "ocr",
  indexing: "layout",
  detecting_structure: "layout",
  discovering_fields: "layout",
  extracting_data: "extraction",
  validating_results: "extraction",
  v3_classification: "indexing",
  prepare_staging: "indexing",
};

export function fileStageFromPipeline(stage: string | null | undefined): FileStage | null {
  if (!stage) return null;
  return PIPELINE_STAGE_TO_FILE_STAGE[stage] ?? null;
}

/** Where a queued file is, from facts the client has observed. */
export interface QueueFileFacts {
  /** Upload request finished with a stored document. */
  uploaded: boolean;
  uploading: boolean;
  /** Page processing + schema discovery finished. */
  processed: boolean;
  /** Field extraction finished (incl. validation and staging). */
  extracted: boolean;
  /** Latest backend stage while a job runs. */
  pipelineStage: string | null;
  failed: boolean;
  /** For a file restored from the server without a live job: whether its
   * staging profile is pinned (staging ran). Null = not known. */
  staged?: boolean | null;
}

/**
 * State of each file stage. Stages before the current one are done, the
 * current one is active (or failed), later ones pending. When the client
 * has not observed a stage (a file restored from the server), it is
 * "unknown" rather than guessed.
 */
export function fileStageStates(facts: QueueFileFacts): Record<FileStage, FileStageState> {
  const order = FILE_STAGES.map((stage) => stage.id);
  const states = Object.fromEntries(order.map((id) => [id, "pending"])) as Record<FileStage, FileStageState>;
  const upTo = (current: FileStage, state: FileStageState) => {
    const index = order.indexOf(current);
    order.forEach((id, i) => {
      if (i < index) states[id] = "done";
      else if (i === index) states[id] = state;
    });
  };

  if (!facts.uploaded) {
    if (facts.failed) states.upload = "failed";
    else if (facts.uploading) states.upload = "active";
    return states;
  }
  if (facts.extracted) {
    for (const id of order) states[id] = "done";
    return states;
  }

  const current = fileStageFromPipeline(facts.pipelineStage);
  if (current && current !== "upload") {
    upTo(current, facts.failed ? "failed" : "active");
    return states;
  }

  if (facts.processed) {
    upTo("extraction", "pending");
    if (facts.staged === true) {
      // A pinned staging profile: extraction and staging have run.
      states.extraction = "done";
      states.indexing = "done";
    } else if (facts.staged == null) {
      // Restored from the server: whether extraction ran isn't known.
      states.extraction = "unknown";
      states.indexing = "unknown";
    }
    return states;
  }

  states.upload = "done";
  if (facts.failed) states.ocr = "failed";
  return states;
}

// ---------------------------------------------------------------------------
// Uniform Contract Format grouping of extracted fields.

export type UcfPart = "part1" | "part2" | "part3" | "part4" | "other";

export const UCF_PARTS: { id: UcfPart; label: string; sections: string }[] = [
  { id: "part1", label: "Part I — The Schedule", sections: "Sections A–H" },
  { id: "part2", label: "Part II — Contract Clauses", sections: "Section I" },
  { id: "part3", label: "Part III — List of Documents, Exhibits & Attachments", sections: "Section J" },
  { id: "part4", label: "Part IV — Representations & Instructions", sections: "Sections K–M" },
  { id: "other", label: "Other", sections: "Section not identified" },
];

const ROMAN_PART: Record<string, UcfPart> = { I: "part1", II: "part2", III: "part3", IV: "part4" };

/**
 * UCF part of a field from the section the backend resolved for its
 * evidence (app/services/document_outline.py display strings such as
 * "B — Supplies or Services and Prices/Costs", "Part II — …",
 * "Attachment 3 — …", "SF33 — Solicitation, Offer and Award"). Anything
 * else — including numbered commercial headings — is "other".
 */
export function ucfPartForSection(section: string | null | undefined): UcfPart {
  const text = (section ?? "").trim();
  if (!text) return "other";

  const letter = /^(?:section\s+)?([A-M])(?:\.\d+(?:\.\d+)?)?\s*(?:—|-|–|:|$)/i.exec(text);
  if (letter) {
    const code = letter[1].toUpperCase();
    if (code <= "H") return "part1";
    if (code === "I") return "part2";
    if (code === "J") return "part3";
    return "part4";
  }
  const part = /^part\s+(IV|III|II|I)\b/i.exec(text);
  if (part) return ROMAN_PART[part[1].toUpperCase()];
  if (/^(attachment|exhibit)\b/i.test(text)) return "part3";
  // The SF 33 / SF 1442 cover form is Section A.
  if (/^(sf\s?33|sf\s?1442)\b/i.test(text)) return "part1";
  return "other";
}

export interface UcfFieldGroup {
  part: UcfPart;
  label: string;
  sections: string;
  fields: ScalarTargetResult[];
}

/** Scalars grouped by UCF part, in part order; empty parts kept so every
 * tab can say honestly that nothing was found there. */
export function groupFieldsByUcfPart(scalars: ScalarTargetResult[]): UcfFieldGroup[] {
  const byPart = new Map<UcfPart, ScalarTargetResult[]>(UCF_PARTS.map((part) => [part.id, []]));
  for (const scalar of scalars) {
    byPart.get(ucfPartForSection(scalar.evidence?.section))!.push(scalar);
  }
  return UCF_PARTS.map((part) => ({
    part: part.id,
    label: part.label,
    sections: part.sections,
    fields: (byPart.get(part.id) ?? []).sort((a, b) => (a.page ?? 0) - (b.page ?? 0)),
  }));
}

/** The batch's step in the header tracker, from its files' facts. */
export function batchIntakeStep(
  files: Pick<QueueFileFacts, "uploaded" | "uploading" | "processed" | "extracted" | "failed">[],
  intakeStatus: IntakeStatus | "mixed" | null,
): { step: IntakeStep; complete: boolean } {
  if (intakeStatus === "submitted") return { step: "review", complete: true };
  const live = files.filter((file) => !file.failed);
  if (live.length === 0) return { step: "upload", complete: false };
  if (live.some((file) => !file.uploaded)) return { step: "upload", complete: false };
  if (live.some((file) => !file.processed && !file.extracted)) return { step: "classification", complete: false };
  if (live.some((file) => !file.extracted)) return { step: "extraction", complete: false };
  return { step: "review", complete: false };
}

/** The discovered targets a reviewer can extract — the same selection the
 * extraction workspace's target picker offers (no templates, no targets
 * without a source example, no clause/section/obligation listings, no
 * per-page table stubs). */
export function extractableTargets(targets: DocumentTarget[]): DocumentTarget[] {
  return targets.filter(
    (target) =>
      target.source !== "template" &&
      target.source_examples.length > 0 &&
      target.target_type !== "clause" &&
      target.target_type !== "section" &&
      target.target_type !== "obligation" &&
      !target.key.startsWith("table_p"),
  );
}
