"use client";

import { useState, useSyncExternalStore } from "react";

import { ensureBackendHealthy, markUploadCompleted, markUploadStarted } from "@/lib/backend-warmup";
import {
  extractTargetsViaJob,
  getExtractionProgress,
  getTargets,
  processDocumentViaJob,
  resolveDuplicate,
  selectPortfolioFile,
} from "@/lib/documents";
import {
  extractableTargets,
  fileStageFromPipeline,
  intakeFormFields,
  putDocumentIntake,
  type IntakeBatch,
  type IntakeFields,
} from "@/lib/intake";
import { uploadFileWithProgress } from "@/lib/upload";
import type {
  DiscoverSchemaResult,
  EmbeddedFileSummary,
  ExistingDocumentSummary,
  ExtractTargetsResult,
  ExtractionJob,
  ExtractionProgress,
  UploadedDocument,
} from "@/types/document";

/**
 * The batch processing queue on /extraction/new: each dropped file is
 * uploaded with the batch's intake tags, then processed (pages, OCR,
 * schema discovery) as a background job; "Run full extraction" then
 * extracts every discovered field of each processed file. All progress
 * shown comes from the upload's byte count and the backend job's
 * reported stage — nothing is simulated.
 */

export type QueueItemStatus =
  | "waiting"
  | "uploading"
  | "duplicate"
  | "portfolio"
  | "processing"
  | "processed"
  | "extracting"
  | "extracted"
  | "failed";

export interface QueueItem {
  id: string;
  /** Null for a file restored from the server (?batch=). */
  file: File | null;
  name: string;
  size: number;
  status: QueueItemStatus;
  uploadFraction: number;
  documentId: string | null;
  pipelineStage: string | null;
  pageCount: number | null;
  ocrRequired: number | null;
  ocrCompleted: number | null;
  error: string | null;
  failedPhase: "upload" | "processing" | "extraction" | null;
  duplicate: { stagedId: string; originalFilename: string; existing: ExistingDocumentSummary } | null;
  portfolio: { stagedId: string; files: EmbeddedFileSummary[] } | null;
  /** Pinned staging profile (restored files): true/false, null = unknown. */
  staged: boolean | null;
  profileLabel: string | null;
  /** Detected document type (Invoice, Passport, Receipt…). */
  typeLabel: string | null;
  /** Broad category of that type (the queue groups files by it). */
  category: string | null;
  categoryLabel: string | null;
  fieldsExtracted: number | null;
  /** E.g. "reused the existing document". */
  note: string | null;
}

export interface BatchQueueDeps {
  ensureReady: () => Promise<void>;
  upload: (
    file: File,
    fields: Record<string, string | null>,
    onProgress: (fraction: number) => void,
    allowDuplicate: boolean,
  ) => Promise<UploadedDocument>;
  resolveDuplicate: (
    stagedId: string,
    action: "use_existing" | "upload_anyway",
    originalFilename: string,
    existingId: string,
  ) => Promise<UploadedDocument>;
  selectPortfolioFile: (stagedId: string, filename: string) => Promise<UploadedDocument>;
  tagDocument: (documentId: string, fields: IntakeFields) => Promise<unknown>;
  process: (
    documentId: string,
    jobId: number | null,
    onStage: (job: ExtractionJob) => void,
  ) => Promise<unknown>;
  progress: (documentId: string) => Promise<ExtractionProgress>;
  targets: (documentId: string) => Promise<DiscoverSchemaResult>;
  extract: (
    documentId: string,
    targetIds: string[],
    onStage: (job: ExtractionJob) => void,
  ) => Promise<ExtractTargetsResult>;
}

export const defaultBatchQueueDeps: BatchQueueDeps = {
  ensureReady: () => ensureBackendHealthy(),
  upload: async (file, fields, onProgress, allowDuplicate) => {
    markUploadStarted();
    try {
      return await uploadFileWithProgress<UploadedDocument>(
        allowDuplicate ? "/api/documents/upload?allow_duplicate=true" : "/api/documents/upload",
        file,
        onProgress,
        undefined,
        fields,
      );
    } finally {
      markUploadCompleted();
    }
  },
  resolveDuplicate: (stagedId, action, originalFilename, existingId) =>
    resolveDuplicate(stagedId, action, originalFilename, undefined, existingId),
  selectPortfolioFile: (stagedId, filename) => selectPortfolioFile(stagedId, filename),
  tagDocument: (documentId, fields) => putDocumentIntake(documentId, fields),
  process: (documentId, jobId, onStage) => processDocumentViaJob(documentId, jobId, onStage),
  progress: (documentId) => getExtractionProgress(documentId),
  targets: (documentId) => getTargets(documentId),
  extract: (documentId, targetIds, onStage) => extractTargetsViaJob(documentId, targetIds, onStage),
};

const MAX_CONCURRENT = 2;
const OCR_STAGES = new Set(["reading_document", "rendering_ocr", "running_ocr", "processing_document"]);
/** Families that are "no specific type" — not shown as a type badge. */
const GENERIC_FAMILIES = new Set(["unknown", "generic_business"]);

function message(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

let localIds = 0;

function newItem(file: File | null, name: string, size: number): QueueItem {
  localIds += 1;
  return {
    id: `q${Date.now().toString(36)}-${localIds}`,
    file,
    name,
    size,
    status: "waiting",
    uploadFraction: 0,
    documentId: null,
    pipelineStage: null,
    pageCount: null,
    ocrRequired: null,
    ocrCompleted: null,
    error: null,
    failedPhase: null,
    duplicate: null,
    portfolio: null,
    staged: null,
    profileLabel: null,
    typeLabel: null,
    category: null,
    categoryLabel: null,
    fieldsExtracted: null,
    note: null,
  };
}

/** An extraction job's stage, never earlier than extraction itself: the
 * job also reports "queued" and stage names the queue doesn't chart, which
 * would otherwise show the file going back to OCR. */
function extractionPhaseStage(stage: string | null | undefined): string {
  const fileStage = fileStageFromPipeline(stage);
  return stage && (fileStage === "extraction" || fileStage === "indexing") ? stage : "extracting_data";
}

export class BatchQueue {
  private items: QueueItem[] = [];
  private listeners = new Set<() => void>();
  private active = 0;
  private extracting = false;

  constructor(
    private readonly getFields: () => IntakeFields,
    private readonly deps: BatchQueueDeps = defaultBatchQueueDeps,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.items;

  get extractionRunning() {
    return this.extracting;
  }

  private emit() {
    this.items = [...this.items];
    for (const listener of this.listeners) listener();
  }

  private patch(id: string, update: Partial<QueueItem>) {
    this.items = this.items.map((item) => (item.id === id ? { ...item, ...update } : item));
    this.emit();
  }

  private find(id: string) {
    return this.items.find((item) => item.id === id) ?? null;
  }

  addFiles(files: File[]) {
    if (files.length === 0) return;
    this.items = [...this.items, ...files.map((file) => newItem(file, file.name, file.size))];
    this.emit();
    this.pump();
  }

  /** Rows for a batch reopened from the server (no live job). */
  restore(batch: IntakeBatch) {
    const known = new Set(this.items.map((item) => item.documentId));
    const restored = batch.documents
      .filter((document) => !known.has(document.document_id))
      .map((document): QueueItem => {
        const failed = document.status === "failed";
        const processed = document.status !== "processing" && !failed;
        return {
          ...newItem(null, document.original_filename, document.size_bytes),
          status: failed ? "failed" : processed ? "processed" : "processing",
          uploadFraction: 1,
          documentId: document.document_id,
          pageCount: document.page_count,
          ocrRequired: document.ocr_required_page_count,
          ocrCompleted: document.ocr_completed_page_count,
          failedPhase: failed ? "processing" : null,
          error: failed ? "Processing failed on the server." : null,
          staged: document.profile_id != null,
          profileLabel: document.profile_label,
          typeLabel: document.type_label ?? null,
          category: document.category ?? null,
          categoryLabel: document.category_label ?? null,
        };
      });
    if (restored.length === 0) return;
    this.items = [...this.items, ...restored];
    this.emit();
  }

  remove(id: string) {
    const item = this.find(id);
    if (!item || item.status === "uploading" || item.status === "processing" || item.status === "extracting") return;
    this.items = this.items.filter((entry) => entry.id !== id);
    this.emit();
  }

  retry(id: string) {
    const item = this.find(id);
    if (!item || item.status !== "failed") return;
    if (item.failedPhase === "upload" || !item.documentId) {
      if (!item.file) return;
      this.patch(id, { status: "waiting", error: null, failedPhase: null, uploadFraction: 0 });
      this.pump();
      return;
    }
    if (item.failedPhase === "processing") {
      this.patch(id, { status: "processing", error: null, failedPhase: null, pipelineStage: null });
      void this.process(id, item.documentId, null);
      return;
    }
    this.patch(id, { status: "processed", error: null, failedPhase: null });
  }

  private pump() {
    while (this.active < MAX_CONCURRENT) {
      const next = this.items.find((item) => item.status === "waiting");
      if (!next) return;
      this.active += 1;
      this.patch(next.id, { status: "uploading", uploadFraction: 0 });
      void this.upload(next.id, false).finally(() => {
        this.active -= 1;
        this.pump();
      });
    }
  }

  private async upload(id: string, allowDuplicate: boolean) {
    const item = this.find(id);
    if (!item?.file) return;
    try {
      this.patch(id, { note: "Connecting to the server…" });
      await this.deps.ensureReady();
      this.patch(id, { note: null });
      const result = await this.deps.upload(
        item.file,
        intakeFormFields(this.getFields()),
        (fraction) => this.patch(id, { uploadFraction: fraction }),
        allowDuplicate,
      );
      await this.afterUpload(id, result, false);
    } catch (error) {
      this.patch(id, { status: "failed", failedPhase: "upload", error: message(error, "Upload failed.") });
    }
  }

  private async afterUpload(id: string, result: UploadedDocument, needsTag: boolean) {
    if (result.status === "portfolio_pending" && result.embedded_files) {
      this.patch(id, {
        status: "portfolio",
        uploadFraction: 1,
        portfolio: { stagedId: String(result.document_id), files: result.embedded_files },
      });
      return;
    }
    if (result.duplicate && result.existing_document) {
      this.patch(id, {
        status: "duplicate",
        uploadFraction: 1,
        duplicate: {
          stagedId: String(result.document_id),
          originalFilename: result.original_filename,
          existing: result.existing_document,
        },
      });
      return;
    }

    const documentId = String(result.document_id);
    this.patch(id, {
      status: "processing",
      uploadFraction: 1,
      documentId,
      pageCount: result.page_count ?? null,
      pipelineStage: "uploaded",
      duplicate: null,
      portfolio: null,
      note: result.reused_existing ? "Reused the existing document" : null,
    });

    if (needsTag) {
      // Duplicate / portfolio follow-ups create the document without the
      // upload's form fields; tag it now. Not fatal if it fails.
      try {
        await this.deps.tagDocument(documentId, this.getFields());
      } catch {
        this.patch(id, { note: "Uploaded, but the batch tags could not be saved." });
      }
    }

    if (result.reused_existing) {
      try {
        await this.deps.targets(documentId);
        this.patch(id, { status: "processed", pipelineStage: null });
        void this.runFullExtraction();
        return;
      } catch {
        // No discovered schema yet — process it like a new upload.
      }
    }
    await this.process(id, documentId, result.processing_job_id ?? null);
  }

  private async process(id: string, documentId: string, jobId: number | null) {
    try {
      await this.deps.process(documentId, jobId, (job) => {
        const stage = job.stage || job.status;
        this.patch(id, { pipelineStage: stage });
        if (stage && OCR_STAGES.has(stage)) {
          // OCR page counts, best effort (shown only when reported).
          this.deps
            .progress(documentId)
            .then((progress) =>
              this.patch(id, {
                ocrRequired: progress.ocr_pages,
                ocrCompleted: progress.ocr_completed_pages,
                pageCount: progress.page_total || this.find(id)?.pageCount || null,
              }),
            )
            .catch(() => undefined);
        }
      });
      this.patch(id, { status: "processed", pipelineStage: null });
    } catch (error) {
      this.patch(id, { status: "failed", failedPhase: "processing", error: message(error, "Processing failed.") });
      return;
    }
    // Grouped by category as soon as it's read, not when its turn to
    // extract comes; extraction then starts on its own.
    await this.classify(id, documentId);
    void this.runFullExtraction();
  }

  /** The file's type and category from its schema (best effort). */
  private applyClassification(id: string, schema: DiscoverSchemaResult) {
    const typeLabel =
      schema.type_label ??
      (schema.document_family_label && !GENERIC_FAMILIES.has(schema.document_family) ? schema.document_family_label : null);
    this.patch(id, {
      ...(typeLabel ? { typeLabel } : {}),
      ...(schema.category ? { category: schema.category, categoryLabel: schema.category_label ?? null } : {}),
    });
  }

  private async classify(id: string, documentId: string) {
    try {
      this.applyClassification(id, await this.deps.targets(documentId));
    } catch {
      // Grouped when extraction reads the schema instead.
    }
  }

  async resolveDuplicate(id: string, action: "use_existing" | "upload_anyway") {
    const item = this.find(id);
    if (!item?.duplicate) return;
    const { stagedId, originalFilename, existing } = item.duplicate;
    this.patch(id, { status: "uploading", duplicate: null });
    try {
      let result: UploadedDocument;
      try {
        result = await this.deps.resolveDuplicate(stagedId, action, originalFilename, String(existing.document_id));
      } catch (error) {
        const text = message(error, "");
        // The staged copy expired: send the file again, skipping the check.
        if (
          action === "upload_anyway" &&
          item.file &&
          (text.includes("STAGED_UPLOAD_EXPIRED") || text.includes("No pending upload found"))
        ) {
          result = await this.deps.upload(
            item.file,
            intakeFormFields(this.getFields()),
            (fraction) => this.patch(id, { uploadFraction: fraction }),
            true,
          );
          await this.afterUpload(id, result, false);
          return;
        }
        throw error;
      }
      await this.afterUpload(id, result, true);
    } catch (error) {
      this.patch(id, { status: "failed", failedPhase: "upload", error: message(error, "Unable to resolve the duplicate.") });
    }
  }

  async selectPortfolio(id: string, filename: string) {
    const item = this.find(id);
    if (!item?.portfolio) return;
    const { stagedId } = item.portfolio;
    this.patch(id, { status: "uploading", portfolio: null });
    try {
      const result = await this.deps.selectPortfolioFile(stagedId, filename);
      await this.afterUpload(id, result, true);
    } catch (error) {
      this.patch(id, { status: "failed", failedPhase: "upload", error: message(error, "Unable to open the embedded file.") });
    }
  }

  private nextToExtract(): QueueItem | undefined {
    return this.items.find((entry) => entry.status === "processed" && entry.documentId);
  }

  /** Extracts every discovered field of each processed file, one file at
   * a time, including files that finish processing while it runs. Called
   * automatically as files are processed; resolves when none are left. */
  async runFullExtraction() {
    if (this.extracting) return;
    this.extracting = true;
    this.emit();
    try {
      for (
        let item = this.nextToExtract();
        item;
        item = this.nextToExtract()
      ) {
        const documentId = item.documentId!;
        this.patch(item.id, { status: "extracting", pipelineStage: "extracting_data", error: null });
        try {
          const schema = await this.deps.targets(documentId);
          this.applyClassification(item.id, schema);
          const ids = extractableTargets(schema.targets ?? []).map((target) => target.id);
          if (ids.length === 0) {
            this.patch(item.id, {
              status: "extracted",
              pipelineStage: null,
              fieldsExtracted: 0,
              note: "No extractable fields were discovered in this file.",
            });
            continue;
          }
          const result = await this.deps.extract(documentId, ids, (job) =>
            this.patch(item.id, { pipelineStage: extractionPhaseStage(job.stage || job.status) }),
          );
          this.patch(item.id, {
            status: "extracted",
            pipelineStage: null,
            staged: true,
            fieldsExtracted: result.scalars.length,
          });
          // Staging may settle a more specific type (e.g. an SF 1442 award).
          await this.classify(item.id, documentId);
        } catch (error) {
          this.patch(item.id, {
            status: "failed",
            failedPhase: "extraction",
            error: message(error, "Extraction failed."),
          });
        }
      }
    } finally {
      this.extracting = false;
      this.emit();
    }
  }
}

/** The page's queue, bound to the latest intake fields. */
export function useBatchQueue(getFields: () => IntakeFields): {
  queue: BatchQueue;
  items: QueueItem[];
} {
  // In-flight work after unmount only updates a store nobody reads.
  const [queue] = useState(() => new BatchQueue(getFields));
  const items = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  return { queue, items };
}
