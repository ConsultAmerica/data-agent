/**
 * RC2-03 product workflow: Upload → Understand → Discover Schema →
 * Extract → Validate → Prepare Staging. Maps backend job stages to these
 * steps without inventing progress.
 */

import { FAMILY_LABELS } from "@/lib/document-families";

export type ExtractionWorkflowStep =
  | "upload"
  | "understand"
  | "discover_schema"
  | "extract"
  | "validate"
  | "prepare_staging";

export const EXTRACTION_WORKFLOW_STEPS: {
  id: ExtractionWorkflowStep;
  label: string;
}[] = [
  { id: "upload", label: "Upload" },
  { id: "understand", label: "Understand" },
  { id: "discover_schema", label: "Discover Schema" },
  { id: "extract", label: "Extract" },
  { id: "validate", label: "Validate" },
  { id: "prepare_staging", label: "Prepare Staging" },
];

/** Backend / page pipeline stage → product step (only confirmed stages). */
const STAGE_TO_STEP: Record<string, ExtractionWorkflowStep> = {
  uploaded: "upload",
  queued: "understand",
  reading_document: "understand",
  processing_document: "understand",
  rendering_ocr: "understand",
  running_ocr: "understand",
  indexing: "understand",
  detecting_structure: "understand",
  discovering_fields: "discover_schema",
  extracting_data: "extract",
  validating_results: "validate",
  v3_classification: "prepare_staging",
  prepare_staging: "prepare_staging",
  complete: "prepare_staging",
};

export function workflowStepFromStage(
  pipelineStage: string | null | undefined,
): ExtractionWorkflowStep | null {
  if (!pipelineStage) return null;
  return STAGE_TO_STEP[pipelineStage] ?? null;
}

export function workflowStepIndex(step: ExtractionWorkflowStep): number {
  return EXTRACTION_WORKFLOW_STEPS.findIndex((item) => item.id === step);
}

/**
 * Active product step for the extraction workspace breadcrumb.
 * Prefers confirmed backend stage; falls back to UI facts (schema ready,
 * results present) without advancing past what the backend has confirmed.
 */
export function resolveWorkflowStep(input: {
  hasDocument: boolean;
  extracting: boolean;
  pipelineStage: string | null;
  schemaReady: boolean;
  schemaDiscovering: boolean;
  hasExtractResults: boolean;
  hasPresentedProfile: boolean;
  stagingReady: boolean;
}): ExtractionWorkflowStep {
  const fromStage = workflowStepFromStage(input.pipelineStage);
  if (input.extracting && fromStage) return fromStage;

  if (!input.hasDocument) return "upload";
  if (input.extracting) return fromStage ?? "understand";
  if (input.schemaDiscovering) return "discover_schema";
  if (input.stagingReady || input.hasPresentedProfile) return "prepare_staging";
  if (input.hasExtractResults) return "validate";
  if (input.schemaReady) return "discover_schema";
  if (fromStage) return fromStage;
  return "understand";
}

/**
 * The batch header's four steps (Upload → Auto-classification → Entity
 * extraction → Human-in-the-loop review, lib/intake.ts) for a single
 * document's workflow step: Understand / Discover Schema are the
 * classification step, Extract / Validate the extraction step, and
 * Prepare Staging hands over to review.
 */
export function intakeStepForWorkflowStep(
  step: ExtractionWorkflowStep,
): "upload" | "classification" | "extraction" | "review" {
  switch (step) {
    case "upload":
      return "upload";
    case "understand":
    case "discover_schema":
      return "classification";
    case "extract":
    case "validate":
      return "extraction";
    case "prepare_staging":
      return "review";
  }
}

/** Human file-type label from MIME / filename — not classification. */
export function fileTypeLabel(contentType: string, filename: string): string {
  const mime = (contentType || "").toLowerCase();
  if (mime.includes("pdf")) return "PDF";
  if (mime === "message/rfc822" || /\.eml$/i.test(filename)) return "Email";
  if (mime.includes("json") || /\.json$/i.test(filename)) return "JSON";
  // Exact XML types only: Office types ("…openxmlformats…") contain "xml".
  if (mime === "application/xml" || mime === "text/xml" || filename.toLowerCase().endsWith(".xml")) return "XML";
  if (mime.includes("html") || /\.html?$/i.test(filename)) return "HTML";
  if (mime.includes("spreadsheet") || mime.includes("excel") || /\.xlsx?$/i.test(filename))
    return "Spreadsheet";
  if (mime.includes("word") || /\.docx?$/i.test(filename)) return "Word";
  if (mime.startsWith("image/")) return "Image";
  if (mime.includes("text")) return "Text";
  const ext = filename.includes(".") ? filename.split(".").pop()?.toUpperCase() : null;
  return ext && ext.length <= 5 ? ext : "Document";
}

export type ClassificationSource = "persisted_profile" | "schema_discovery" | "unresolved";

export interface ClassificationDisplay {
  familyKey: string | null;
  familyLabel: string;
  profileLabel: string | null;
  source: ClassificationSource;
  /** Backend-provided only; never fabricate. */
  confidence: number | null;
  unresolved: boolean;
}

/**
 * Prefer persisted staging resolution over discovery hints. Never infer
 * solely from filename. Unresolved when nothing authoritative is known.
 */
export function resolveClassificationDisplay(input: {
  persistedFamilyKey?: string | null;
  persistedFamilyLabel?: string | null;
  persistedProfileLabel?: string | null;
  discoveryFamilyKey?: string | null;
  discoveryFamilyLabel?: string | null;
  discoveryConfidence?: number | null;
}): ClassificationDisplay {
  const persistedKey = input.persistedFamilyKey?.trim() || null;
  if (persistedKey && persistedKey !== "unknown") {
    return {
      familyKey: persistedKey,
      familyLabel:
        input.persistedFamilyLabel?.trim() ||
        FAMILY_LABELS[persistedKey] ||
        persistedKey,
      profileLabel: input.persistedProfileLabel?.trim() || null,
      source: "persisted_profile",
      confidence: null,
      unresolved: false,
    };
  }

  if (input.persistedProfileLabel?.trim()) {
    return {
      familyKey: persistedKey,
      familyLabel:
        input.persistedFamilyLabel?.trim() ||
        (persistedKey ? FAMILY_LABELS[persistedKey] : null) ||
        "Generic Document",
      profileLabel: input.persistedProfileLabel.trim(),
      source: "persisted_profile",
      confidence: null,
      unresolved: !persistedKey || persistedKey === "unknown",
    };
  }

  const discoveryKey = input.discoveryFamilyKey?.trim() || null;
  if (discoveryKey && discoveryKey !== "unknown") {
    const confidence =
      typeof input.discoveryConfidence === "number" &&
      Number.isFinite(input.discoveryConfidence)
        ? input.discoveryConfidence
        : null;
    return {
      familyKey: discoveryKey,
      familyLabel:
        input.discoveryFamilyLabel?.trim() ||
        FAMILY_LABELS[discoveryKey] ||
        discoveryKey,
      profileLabel: null,
      source: "schema_discovery",
      confidence,
      unresolved: false,
    };
  }

  return {
    familyKey: null,
    familyLabel: "Classification unresolved",
    profileLabel: null,
    source: "unresolved",
    confidence: null,
    unresolved: true,
  };
}

export type WorkflowErrorKind =
  | "unsupported_file"
  | "upload_failure"
  | "processing_timeout"
  | "extraction_failure"
  | "missing_source"
  | "backend_unavailable"
  | "permission_denied"
  | "generic";

export function classifyWorkflowError(message: string): WorkflowErrorKind {
  const text = message.toLowerCase();
  if (
    text.includes("unsupported") ||
    text.includes("not supported") ||
    text.includes("file type")
  ) {
    return "unsupported_file";
  }
  if (text.includes("upload") && (text.includes("fail") || text.includes("could not"))) {
    return "upload_failure";
  }
  if (text.includes("timeout") || text.includes("timed out")) {
    return "processing_timeout";
  }
  if (
    text.includes("no longer available") ||
    text.includes("re-upload") ||
    (text.includes("source") && text.includes("missing"))
  ) {
    return "missing_source";
  }
  if (
    text.includes("401") ||
    text.includes("403") ||
    text.includes("permission") ||
    text.includes("forbidden") ||
    text.includes("unauthorized")
  ) {
    return "permission_denied";
  }
  if (
    text.includes("502") ||
    text.includes("503") ||
    text.includes("unavailable") ||
    text.includes("econnrefused") ||
    text.includes("network") ||
    text.includes("failed to fetch")
  ) {
    return "backend_unavailable";
  }
  if (text.includes("extract") || text.includes("processing failed")) {
    return "extraction_failure";
  }
  return "generic";
}

/** User-facing copy — no stack traces or secrets. */
export function actionableWorkflowError(message: string): {
  kind: WorkflowErrorKind;
  title: string;
  body: string;
  canRetry: boolean;
} {
  const kind = classifyWorkflowError(message);
  switch (kind) {
    case "unsupported_file":
      return {
        kind,
        title: "Unsupported file",
        body: "This file type is not supported for extraction. Upload a PDF, XML, HTML, Word, spreadsheet, or image document.",
        canRetry: false,
      };
    case "upload_failure":
      return {
        kind,
        title: "Upload failed",
        body: "The file could not be uploaded. Check your connection and try again.",
        canRetry: true,
      };
    case "processing_timeout":
      return {
        kind,
        title: "Processing timed out",
        body: "The document took too long to process. Retry the job, or try a smaller file if the problem continues.",
        canRetry: true,
      };
    case "missing_source":
      return {
        kind,
        title: "Source file unavailable",
        body:
          message.includes("re-upload") || message.includes("no longer available")
            ? message
            : "The original source file is no longer available. Re-upload the document to continue.",
        canRetry: false,
      };
    case "permission_denied":
      return {
        kind,
        title: "Permission denied",
        body: "You do not have permission to process this document. Sign in again or contact an administrator.",
        canRetry: false,
      };
    case "backend_unavailable":
      return {
        kind,
        title: "Processing service unavailable",
        body: "The processing service is waking up or unreachable. Wait a moment and retry.",
        canRetry: true,
      };
    case "extraction_failure":
      return {
        kind,
        title: "Extraction failed",
        body: "The document was uploaded, but extraction could not be completed. You can retry processing.",
        canRetry: true,
      };
    default:
      return {
        kind,
        title: "Something went wrong",
        body: "Processing could not be completed. Retry, or replace the document and try again.",
        canRetry: true,
      };
  }
}

export function processingStatusLabel(input: {
  extracting: boolean;
  pipelineStage: string | null;
  extractionComplete: boolean;
  failed: boolean;
}): string {
  if (input.failed) return "Failed";
  if (input.extracting) {
    const step = workflowStepFromStage(input.pipelineStage);
    if (step) {
      return EXTRACTION_WORKFLOW_STEPS.find((item) => item.id === step)?.label ?? "Processing";
    }
    return "Processing";
  }
  if (input.extractionComplete) return "Ready";
  return "Uploaded";
}
