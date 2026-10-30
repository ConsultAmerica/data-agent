"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";


import { ArrowLeft, ArrowRight, Loader2, Play, Sparkles, UploadCloud } from "lucide-react";

import ContentSection from "@/components/layout/ContentSection";
import ConsoleHeader from "@/components/layout/ConsoleHeader";
import WorkflowBreadcrumb from "@/components/workflow-breadcrumb";
import ExtractionResultsWorkspace from "@/components/extraction/extraction-results-workspace";
import ProcessingDetailsDrawer from "@/components/extraction/processing-details-drawer";
import TargetResults from "@/components/extraction/target-results";
import AnalysisRequest from "@/components/analysis-request";
import UniversalResults from "@/components/universal-results";
import type { SourceViewRequest } from "@/components/source-verification-panel";
import DocumentOverview from "@/components/document-overview";
import BackendStatusBanner from "@/components/backend-status-banner";
import BatchFooter from "@/components/intake/batch-footer";
import BatchIntakePortal from "@/components/intake/batch-intake-portal";
import { useBatchQueue, type QueueItem } from "@/components/intake/batch-queue";
import IntakeProgressTracker from "@/components/intake/intake-progress-tracker";
import ProcessingQueue from "@/components/intake/processing-queue";
import UcfFieldReview from "@/components/intake/ucf-field-review";
import {
  batchIntakeStep,
  extractableTargets,
  getDocumentIntake,
  getIntakeBatch,
  getIntakeConfig,
  newBatchId,
  type IntakeConfig,
  type IntakeFields,
  type IntakeStatus,
} from "@/lib/intake";
import { recordRecentDocument } from "@/lib/recent-documents";
import {
  markExtractionCompleted,
  markBackendHealthy,
  markProcessingStarted,
  startBackendWarmup,
} from "@/lib/backend-warmup";
import {
  analyzeContract,
  confirmRelationship,
  createCustomTarget,
  deleteCustomTarget,
  detectStructures,
  discoverSchema,
  extractDocumentPages,
  extractTargetsViaJob,
  getDocument,
  getDocumentPages,
  getExtractResults,
  getExtractionProgress,
  getStructuredOutput,
  getTargets,
  processDocumentViaJob,
  renameCustomTarget,
  universalExtract,
} from "@/lib/documents";
import {
  actionableWorkflowError,
  intakeStepForWorkflowStep,
  resolveClassificationDisplay,
  resolveWorkflowStep,
} from "@/lib/extraction-workflow";
import { listExtractionModels } from "@/lib/extraction-models";
import { getStagingProfile, type ProfileDescriptor } from "@/lib/staging-workbook";
import type {
  ContractAnalysisResult,
  DiscoverSchemaResult,
  DocumentPage,
  ExtractTargetsResult,
  ExtractionJob,
  ExtractionModel,
  ExtractionProgress,
  ExtractionSummary,
  ProcessingStageEntry,
  RelationshipAction,
  StructureDetectionResult,
  StructuredContractOutput,
  UniversalExtractionResult,
  UploadedDocument,
} from "@/types/document";

function confidenceQualifier(confidence: number): string {
  if (confidence >= 0.85) return "High confidence";
  if (confidence >= 0.6) return "Medium confidence";
  return "Low confidence";
}

const ANALYZE_STAGE_MESSAGES = [
  "Classifying document... Identifying document type, contract side, language, and status.",
  "Detecting related documents... Checking parent and child relationships.",
];

export default function NewExtractionPage() {
  return (
    <Suspense fallback={null}>
      <NewExtractionPageContent />
    </Suspense>
  );
}

function NewExtractionPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const reopenDocumentId = searchParams.get("documentId");
  const focusFieldKey = searchParams.get("focus");
  const reopenBatchId = searchParams.get("batch");

  // Batch intake: tags sent with each upload, the per-file queue, and the
  // batch's draft / submitted / rejected decision.
  const [intakeConfig, setIntakeConfig] = useState<IntakeConfig | null>(null);
  const [intakeConfigError, setIntakeConfigError] = useState(false);
  const [intakeFields, setIntakeFields] = useState<IntakeFields>(() => ({
    batch_id: reopenBatchId || newBatchId(),
    agency: "",
    contracting_officer: "",
    extraction_profile: "auto",
  }));
  const intakeFieldsRef = useRef(intakeFields);
  useEffect(() => {
    intakeFieldsRef.current = intakeFields;
  }, [intakeFields]);
  const { queue, items: queueItems } = useBatchQueue(() => intakeFieldsRef.current);
  const queueItemsRef = useRef<QueueItem[]>(queueItems);
  useEffect(() => {
    queueItemsRef.current = queueItems;
  }, [queueItems]);
  const [batchStatus, setBatchStatus] = useState<IntakeStatus | "mixed" | null>(null);
  const adoptedBatchRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    getIntakeConfig()
      .then((config) => {
        markBackendHealthy();
        if (active) setIntakeConfig(config);
      })
      .catch(() => {
        if (active) setIntakeConfigError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  /** Loads a saved batch into the queue (files restored from the server). */
  const adoptBatch = useCallback(
    (batchId: string) => {
      if (adoptedBatchRef.current === batchId) return;
      adoptedBatchRef.current = batchId;
      getIntakeBatch(batchId)
        .then((batch) => {
          queue.restore(batch);
          setBatchStatus(batch.intake_status);
          const first = batch.documents[0];
          setIntakeFields((current) => ({
            ...current,
            batch_id: batchId,
            agency: current.agency || first?.agency || "",
            contracting_officer: current.contracting_officer || first?.contracting_officer || "",
            extraction_profile:
              current.extraction_profile !== "auto" ? current.extraction_profile : first?.extraction_profile || "auto",
          }));
        })
        .catch(() => {
          // Unknown / unreachable batch: the page still works as a new batch.
          adoptedBatchRef.current = null;
        });
    },
    [queue],
  );

  useEffect(() => {
    if (reopenBatchId) adoptBatch(reopenBatchId);
  }, [reopenBatchId, adoptBatch]);

  const [document, setDocument] =
    useState<UploadedDocument | null>(null);

  const [extraction, setExtraction] =
    useState<ExtractionSummary | null>(null);

  const [pages, setPages] = useState<DocumentPage[]>([]);

  const [extracting, setExtracting] = useState(false);

  const [progress, setProgress] =
    useState<ExtractionProgress | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [waking, setWaking] = useState(false);
  const [pipelineStage, setPipelineStage] = useState<string | null>(null);
  const [stageHistory, setStageHistory] = useState<
    ProcessingStageEntry[] | null
  >(null);
  const [stageTimingsMs, setStageTimingsMs] = useState<Record<
    string,
    number
  > | null>(null);
  const [pagesReused, setPagesReused] = useState(false);
  const [discoveryReused, setDiscoveryReused] = useState(false);
  const [targetExtractionJob, setTargetExtractionJob] =
    useState<ExtractionJob | null>(null);

  const [analyzeStageIndex, setAnalyzeStageIndex] = useState(0);
  const [wasAnalyzing, setWasAnalyzing] = useState(false);

  const resultsWorkspaceRef = useRef<HTMLDivElement | null>(null);
  const universalResultRef = useRef<HTMLDivElement | null>(null);
  const targetResultRef = useRef<HTMLDivElement | null>(null);
  /** Prevents overlapping process / extract submissions. */
  const processInFlightRef = useRef(false);
  const extractInFlightRef = useRef(false);

  // The staging profile loaded for a document; it applies only while
  // that document is open with its pages extracted.
  const [loadedProfile, setLoadedProfile] = useState<{
    documentId: string;
    profile: ProfileDescriptor | null;
  } | null>(null);
  const stagingProfile =
    document && extraction && loadedProfile?.documentId === document.document_id
      ? loadedProfile.profile
      : null;

  // Overlap Render cold-start with browsing/file pick — upload auto-starts when healthy.
  useEffect(() => {
    const documentId = document?.document_id;
    if (!documentId || !extraction) return;
    let active = true;
    getStagingProfile(documentId)
      .then((profile) => {
        if (active) setLoadedProfile({ documentId, profile });
      })
      .catch(() => {
        if (active) setLoadedProfile({ documentId, profile: null });
      });
    return () => {
      active = false;
    };
  }, [document?.document_id, extraction]);

  useEffect(() => {
    startBackendWarmup().catch(() => {
      // Background only; uploader awaits readiness and auto-uploads the selected file.
    });
  }, []);

  const [processingDrawerOpen, setProcessingDrawerOpen] = useState(false);
  const [sourceRequest, setSourceRequest] =
    useState<SourceViewRequest | null>(null);
  // True mobile only (below sm) — tablet and up always show the source
  // pane stacked/split, no drawer needed there.
  const [mobileSourceOpen, setMobileSourceOpen] = useState(false);

  function handleViewSource(request: SourceViewRequest) {
    setSourceRequest(request);
    setMobileSourceOpen(true);
  }

  const [universalResult, setUniversalResult] =
    useState<UniversalExtractionResult | null>(null);

  const [schemaDiscovery, setSchemaDiscovery] =
    useState<DiscoverSchemaResult | null>(null);
  const [schemaDiscovering, setSchemaDiscovering] = useState(false);
  const [schemaDiscoveryError, setSchemaDiscoveryError] = useState("");

  const [targetResult, setTargetResult] =
    useState<ExtractTargetsResult | null>(null);
  const [targetResultDurationMs, setTargetResultDurationMs] = useState<
    number | null
  >(null);

  const [workflowError, setWorkflowError] = useState("");

  const [contractAnalysis, setContractAnalysis] =
    useState<ContractAnalysisResult | null>(null);

  // A profile that declares its own presentation (e.g. FAR Part 52) is
  // reviewed in its document workspace, not the generic analysis tabs.
  const presentedProfile = stagingProfile?.views?.length ? stagingProfile : null;
  // Once a specific profile is resolved (XML Document, FAR Part 52,
  // Contract…), it — not incidental keyword hits such as "Amount Due" —
  // names the document. The generic profile defers to keyword detection.
  const resolvedProfile =
    stagingProfile && stagingProfile.profile_id !== "generic_business_document" ? stagingProfile : null;

  const [analyzingContract, setAnalyzingContract] =
    useState(false);

  const [contractAnalysisError, setContractAnalysisError] =
    useState("");

  const [relationshipBusy, setRelationshipBusy] =
    useState(false);

  const [structuredOutput, setStructuredOutput] =
    useState<StructuredContractOutput | null>(null);

  const [structureDetection, setStructureDetection] =
    useState<StructureDetectionResult | null>(null);

  const [extractionModels, setExtractionModels] = useState<
    ExtractionModel[]
  >([]);
  const [selectedModelId, setSelectedModelId] = useState<
    number | null
  >(null);

  useEffect(() => {
    const documentFamily = schemaDiscovery?.document_family;
    if (!documentFamily) return;

    let active = true;

    listExtractionModels(documentFamily)
      .then((models) => {
        if (active) setExtractionModels(models);
      })
      .catch(() => {
        // Non-fatal — the analyze button still works without models.
      });

    return () => {
      active = false;
    };
  }, [schemaDiscovery?.document_family]);

  // Reopen durable intelligence record — never re-extract automatically.
  useEffect(() => {
    if (!reopenDocumentId || document) return;

    let active = true;

    async function hydrate() {
      try {
        const [doc, pagesResult, targets, extractResults] =
          await Promise.all([
            getDocument(reopenDocumentId!),
            getDocumentPages(reopenDocumentId!),
            getTargets(reopenDocumentId!).catch(() => null),
            getExtractResults(reopenDocumentId!).catch(() => null),
          ]);
        if (!active) return;

        setDocument(doc);
        recordRecentDocument(doc.document_id, doc.original_filename);
        if (!reopenBatchId && queueItemsRef.current.length === 0) {
          // Opened on its own: bring in the batch it was uploaded with.
          getDocumentIntake(doc.document_id)
            .then((intake) => {
              if (active && intake.batch_id) adoptBatch(intake.batch_id);
            })
            .catch(() => undefined);
        }
        setPages(pagesResult);
        setExtraction({
          document_id: doc.document_id,
          status: "completed",
          total_document_pages: doc.page_count,
          pages_requested: doc.page_count,
          pages_processed: pagesResult.length || doc.page_count,
          native_pages: pagesResult.length || doc.page_count,
          ocr_required_pages: 0,
          ocr_completed_pages: 0,
          failed_pages: 0,
          page_numbers_processed: pagesResult.map((p) => p.page_number),
          warnings: [],
          completed_at: doc.uploaded_at,
        });
        if (targets) setSchemaDiscovery(targets);
        // The Staging Workbook renders inside Results and explains its own
        // outcome, so a reopened document always gets a Results area even
        // when the legacy target-extraction results are unavailable.
        setTargetResult(
          extractResults ?? {
            document_id: doc.document_id,
            scalars: [],
            tables: [],
            unresolved_targets: [],
            warnings: [],
          },
        );
        if (extractResults) {
          const focused =
            (focusFieldKey
              ? extractResults.scalars.find(
                  (scalar) =>
                    scalar.normalized_key === focusFieldKey ||
                    scalar.target === focusFieldKey,
                )
              : null) ?? extractResults.scalars[0];
          if (focused?.evidence) {
            setSourceRequest({
              id: focused.normalized_key,
              pageNumber: focused.page,
              highlightText:
                focused.evidence.source_text || String(focused.value),
              label: focused.target,
              value: String(focused.value ?? ""),
              confidence: focused.confidence,
              verified: focused.verified,
            });
            setMobileSourceOpen(true);
            // Defer scroll until results DOM is painted.
            window.setTimeout(() => {
              window.document
                .getElementById(`field-row-${focused.normalized_key}`)
                ?.scrollIntoView({ behavior: "smooth", block: "center" });
            }, 250);
          }
        }
      } catch (error) {
        if (active) {
          setWorkflowError(
            error instanceof Error
              ? error.message
              : "Unable to reopen persisted document.",
          );
        }
      }
    }

    hydrate();
    return () => {
      active = false;
    };
  }, [reopenDocumentId, document, focusFieldKey, reopenBatchId, adoptBatch]);

  useEffect(() => {
    if (!extracting || !document) {
      return;
    }

    let active = true;
    const documentId = document.document_id;
    const startedAt = Date.now();

    async function poll() {
      // Best-effort UI detail: skip while the tab is in the background.
      if (window.document.hidden) return;
      try {
        const result = await getExtractionProgress(documentId);

        if (active) {
          setProgress(result);
        }
      } catch {
        // Progress polling is best-effort — keep showing the last
        // known state rather than surfacing an error for it.
      }
    }

    poll();
    const progressInterval = setInterval(poll, 4000);

    const elapsedInterval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => {
      active = false;
      clearInterval(progressInterval);
      clearInterval(elapsedInterval);
    };
  }, [extracting, document]);

  if (analyzingContract !== wasAnalyzing) {
    setWasAnalyzing(analyzingContract);

    if (!analyzingContract) {
      setAnalyzeStageIndex(0);
    }
  }

  useEffect(() => {
    if (!analyzingContract) {
      return;
    }

    const interval = setInterval(() => {
      setAnalyzeStageIndex(
        (index) => (index + 1) % ANALYZE_STAGE_MESSAGES.length,
      );
    }, 3000);

    return () => clearInterval(interval);
  }, [analyzingContract]);

  async function runSchemaDiscovery(documentId: string) {
    setSchemaDiscovering(true);
    setSchemaDiscoveryError("");

    try {
      const discovery = await discoverSchema(
        documentId,
        () => setWaking(true),
      );

      setSchemaDiscovery(discovery);
    } catch (error) {
      setSchemaDiscoveryError(
        error instanceof Error
          ? error.message
          : "Schema discovery failed.",
      );
    } finally {
      setSchemaDiscovering(false);
      setWaking(false);
    }
  }

  async function handleAddCustomField(label: string) {
    if (!document) return;

    const target = await createCustomTarget(document.document_id, label);

    setSchemaDiscovery((current) =>
      current
        ? { ...current, targets: [...current.targets, target] }
        : current,
    );

    return target;
  }

  async function handleRenameCustomField(targetKey: string, label: string) {
    if (!document) return;

    const updated = await renameCustomTarget(
      document.document_id,
      targetKey,
      label,
    );

    setSchemaDiscovery((current) =>
      current
        ? {
            ...current,
            targets: current.targets.map((target) =>
              target.key === targetKey ? updated : target,
            ),
          }
        : current,
    );
  }

  async function handleDeleteCustomField(targetKey: string) {
    if (!document) return;

    await deleteCustomTarget(document.document_id, targetKey);

    setSchemaDiscovery((current) =>
      current
        ? {
            ...current,
            targets: current.targets.filter(
              (target) => target.key !== targetKey,
            ),
          }
        : current,
    );
  }

  async function handleUploadComplete(
    uploadedDocument: UploadedDocument,
  ) {
    if (processInFlightRef.current) return;
    processInFlightRef.current = true;
    setDocument(uploadedDocument);
    setExtraction(null);
    setPages([]);
    setUniversalResult(null);
    setTargetResult(null);
    setWorkflowError("");
    setContractAnalysis(null);
    setContractAnalysisError("");
    setStructuredOutput(null);
    setStructureDetection(null);
    setSchemaDiscovery(null);
    setSchemaDiscovering(false);
    setSchemaDiscoveryError("");
    setProgress(null);
    setElapsedSeconds(0);
    setWaking(false);
    setPipelineStage("uploaded");
    setStageHistory(null);
    setStageTimingsMs(null);
    setPagesReused(false);
    setDiscoveryReused(false);
    setSourceRequest(null);
    setMobileSourceOpen(false);

    // Duplicate → "Use existing": open the durable record. Do not re-run
    // page extraction (original bytes may be gone from ephemeral disk).
    if (uploadedDocument.reused_existing) {
      setExtracting(true);
      setPipelineStage("complete");
      setPagesReused(true);
      let fallThroughToExtract = false;
      try {
        const [pagesResult, targets, extractResults] = await Promise.all([
          getDocumentPages(uploadedDocument.document_id),
          getTargets(uploadedDocument.document_id).catch(() => null),
          getExtractResults(uploadedDocument.document_id).catch(() => null),
        ]);

        if (pagesResult.length === 0) {
          if (uploadedDocument.source_status === "missing") {
            setWorkflowError(
              "This document has no stored pages, and the original file is " +
                "no longer available on the server. Please re-upload the document.",
            );
            processInFlightRef.current = false;
            return;
          }
          // File still available — continue into normal extraction below.
          fallThroughToExtract = true;
        } else {
          setPages(pagesResult);
          setExtraction({
            document_id: uploadedDocument.document_id,
            status: "completed",
            total_document_pages:
              pagesResult.length || uploadedDocument.page_count,
            pages_requested:
              pagesResult.length || uploadedDocument.page_count,
            pages_processed:
              pagesResult.length || uploadedDocument.page_count,
            native_pages: pagesResult.length || uploadedDocument.page_count,
            ocr_required_pages: 0,
            ocr_completed_pages: 0,
            failed_pages: 0,
            page_numbers_processed: pagesResult.map((p) => p.page_number),
            warnings: [],
            page_text_chars: pagesResult.reduce(
              (total, page) => total + (page.final_text?.length ?? 0),
              0,
            ),
            completed_at: uploadedDocument.uploaded_at,
          });

          if (targets) {
            setSchemaDiscovery(targets);
            setDiscoveryReused(true);
          } else {
            await runSchemaDiscovery(uploadedDocument.document_id);
          }

          if (extractResults) {
            setTargetResult(extractResults);
          }

          try {
            const refreshed = await getDocument(uploadedDocument.document_id);
            setDocument((current) =>
              current
                ? {
                    ...current,
                    ...refreshed,
                    message: current.message,
                    pipeline_log: current.pipeline_log,
                    reused_existing: true,
                  }
                : refreshed,
            );
          } catch {
            // Non-fatal — we already have the upload payload.
          }
          processInFlightRef.current = false;
          return;
        }
      } catch (error) {
        setWorkflowError(
          error instanceof Error
            ? error.message
            : "Unable to open the existing document.",
        );
        processInFlightRef.current = false;
        return;
      } finally {
        if (!fallThroughToExtract) {
          setExtracting(false);
          markExtractionCompleted();
        }
      }
      if (!fallThroughToExtract) {
        processInFlightRef.current = false;
        return;
      }
    }

    setExtracting(true);
    markProcessingStarted();

    try {
      if (
        uploadedDocument.prefer_background ||
        uploadedDocument.processing_job_id
      ) {
        setPipelineStage("queued");
        await processDocumentViaJob(
          uploadedDocument.document_id,
          uploadedDocument.processing_job_id,
          (job) => {
            setPipelineStage(job.stage || job.status);
            const result = job.result as {
              stage_history?: ProcessingStageEntry[];
              stage_timings_ms?: Record<string, number>;
              pages_reused?: boolean;
              discovery_reused?: boolean;
            } | null;
            if (result?.stage_history) {
              setStageHistory(result.stage_history);
            }
            if (result?.stage_timings_ms) {
              setStageTimingsMs(result.stage_timings_ms);
            }
            if (typeof result?.pages_reused === "boolean") {
              setPagesReused(result.pages_reused);
            }
            if (typeof result?.discovery_reused === "boolean") {
              setDiscoveryReused(result.discovery_reused);
            }
            if (typeof job.progress === "number") {
              setProgress({
                document_id: uploadedDocument.document_id,
                status: job.status,
                page_current: 0,
                page_total: uploadedDocument.page_count || 0,
                percent: job.progress,
                native_pages: 0,
                ocr_pages: 0,
                ocr_completed_pages: 0,
              });
            }
          },
          () => setWaking(true),
        );
        setWaking(false);
        setPipelineStage("complete");
      } else {
        setPipelineStage("reading_document");
        const extractionResult = await extractDocumentPages(
          uploadedDocument.document_id,
          () => setWaking(true),
        );

        setWaking(false);
        setExtraction(extractionResult);
        setPipelineStage("indexing");
      }

      const extractedPages = await getDocumentPages(
        uploadedDocument.document_id,
      );

      setPages(extractedPages);

      if (
        uploadedDocument.prefer_background ||
        uploadedDocument.processing_job_id
      ) {
        const ocrPages = extractedPages.filter((page) => page.ocr_succeeded);
        const nativePages = extractedPages.filter(
          (page) => page.extraction_method === "native",
        );
        setExtraction({
          document_id: uploadedDocument.document_id,
          status: "completed",
          total_document_pages: extractedPages.length,
          pages_requested: extractedPages.length,
          pages_processed: extractedPages.length,
          native_pages: nativePages.length,
          ocr_required_pages: extractedPages.filter((page) => page.requires_ocr)
            .length,
          ocr_completed_pages: ocrPages.length,
          failed_pages: 0,
          page_numbers_processed: extractedPages.map(
            (page) => page.page_number,
          ),
          warnings: [],
          page_text_chars: extractedPages.reduce(
            (total, page) => total + (page.final_text?.length ?? 0),
            0,
          ),
          completed_at: new Date().toISOString(),
        });
      }

      try {
        // Skip structure detection when background processing already
        // discovered schema — it duplicates work and adds latency.
        if (
          !(
            uploadedDocument.prefer_background ||
            uploadedDocument.processing_job_id
          )
        ) {
          const detection = await detectStructures(
            uploadedDocument.document_id,
          );
          setStructureDetection(detection);
        }
      } catch {
        // Structure detection is a convenience layer on top of a
        // successful extraction — if it fails, the overview card
        // just skips the detected-content summary.
      }

      setPipelineStage("discovering_fields");
      if (
        uploadedDocument.prefer_background ||
        uploadedDocument.processing_job_id
      ) {
        // Background job already discovered schema — hydrate UI.
        // Brief retries cover commit lag; avoid a full rediscovery.
        let targets = null;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            targets = await getTargets(uploadedDocument.document_id);
            break;
          } catch {
            await new Promise((resolve) =>
              setTimeout(resolve, 400 * (attempt + 1)),
            );
          }
        }
        if (targets) {
          setSchemaDiscovery(targets);
        } else {
          await runSchemaDiscovery(uploadedDocument.document_id);
        }
      } else {
        await runSchemaDiscovery(uploadedDocument.document_id);
      }

      try {
        const refreshed = await getDocument(uploadedDocument.document_id);
        setDocument((current) =>
          current
            ? {
                ...current,
                ...refreshed,
                message: current.message,
                pipeline_log: current.pipeline_log,
              }
            : refreshed,
        );
      } catch {
        // Provenance refresh is best-effort.
      }

      setPipelineStage("complete");
    } catch (error) {
      setWorkflowError(
        error instanceof Error
          ? error.message
          : "Page extraction failed.",
      );
    } finally {
      setExtracting(false);
      setWaking(false);
      processInFlightRef.current = false;
    }
  }

  async function handleAnalyze(
    instruction: string,
  ): Promise<UniversalExtractionResult> {
    if (!document) {
      throw new Error("Upload a document first.");
    }

    try {
      const result = await universalExtract(
        document.document_id,
        instruction,
        () => setWaking(true),
      );

      setUniversalResult(result);
      requestAnimationFrame(() => {
        universalResultRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });

      return result;
    } finally {
      setWaking(false);
    }
  }

  async function handleExtractTargets(
    targetIds: string[],
  ): Promise<ExtractTargetsResult> {
    if (!document) {
      throw new Error("Upload a document first.");
    }
    if (extractInFlightRef.current) {
      throw new Error("Extraction is already running.");
    }
    extractInFlightRef.current = true;

    const startedAt = Date.now();

    try {
      const result = await extractTargetsViaJob(
        document.document_id,
        targetIds,
        (job) => {
          setTargetExtractionJob(job);
          const partial = job.result;
          if (
            partial &&
            Array.isArray(partial.scalars) &&
            (partial.scalars.length > 0 || (partial.tables?.length ?? 0) > 0)
          ) {
            setTargetResult({
              document_id: document.document_id,
              scalars: partial.scalars,
              tables: partial.tables ?? [],
              unresolved_targets: partial.unresolved_targets ?? [],
              warnings: [
                ...(partial.warnings ?? []),
                ...(partial.partial
                  ? [
                      `Showing partial results (${partial.batches_completed ?? 0}/${partial.batches_total ?? "?"} batches).`,
                    ]
                  : []),
              ],
            });
          }
          if (partial?.stage_history) {
            setStageHistory(partial.stage_history);
          }
          if (partial?.stage_timings_ms) {
            setStageTimingsMs(partial.stage_timings_ms);
          }
        },
        () => setWaking(true),
      );

      setTargetResult(result);
      setTargetResultDurationMs(Date.now() - startedAt);
      markExtractionCompleted();

      const first = result?.scalars?.[0];
      if (first) {
        setSourceRequest({
          id: first.normalized_key,
          label: first.target,
          value: String(first.value ?? ""),
          pageNumber: first.page,
          highlightText: String(first.value ?? ""),
          confidence: first.confidence,
          verified: first.verified,
        });
      }

      requestAnimationFrame(() => {
        targetResultRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });

      return (
        result ?? {
          document_id: document.document_id,
          scalars: [],
          tables: [],
          unresolved_targets: targetIds,
          warnings: ["Extraction returned an empty result."],
        }
      );
    } finally {
      setWaking(false);
      setTargetExtractionJob(null);
      extractInFlightRef.current = false;
    }
  }

  async function handleAnalyzeContract() {
    if (!document) {
      return;
    }

    setAnalyzingContract(true);
    setContractAnalysisError("");
    setStructuredOutput(null);

    try {
      const result = await analyzeContract(
        document.document_id,
        selectedModelId,
        () => setWaking(true),
      );

      setContractAnalysis(result);

      if (result.metadata_fields.length > 0) {
        try {
          const structured = await getStructuredOutput(
            document.document_id,
          );

          setStructuredOutput(structured);
        } catch {
          // Structured output is a secondary view of the same
          // data already shown in the metadata grid — not worth
          // surfacing a separate error banner if it fails.
        }
      }
    } catch (error) {
      setContractAnalysisError(
        error instanceof Error
          ? error.message
          : "Contract analysis failed.",
      );
    } finally {
      setAnalyzingContract(false);
      setWaking(false);
    }
  }

  async function handleRelationshipAction(
    action: RelationshipAction,
  ) {
    if (!document || !contractAnalysis?.relationship) {
      return;
    }

    setRelationshipBusy(true);

    try {
      const result = await confirmRelationship(
        document.document_id,
        action,
        "Dataomatix",
      );

      setContractAnalysis({
        ...contractAnalysis,
        relationship: result.relationship,
      });
    } catch (error) {
      setContractAnalysisError(
        error instanceof Error
          ? error.message
          : "Unable to resolve the relationship.",
      );
    } finally {
      setRelationshipBusy(false);
    }
  }

  function resetDocumentState() {
    processInFlightRef.current = false;
    extractInFlightRef.current = false;
    setDocument(null);
    setExtraction(null);
    setPages([]);
    setUniversalResult(null);
    setTargetResult(null);
    setTargetResultDurationMs(null);
    setContractAnalysis(null);
    setStructuredOutput(null);
    setStructureDetection(null);
    setSchemaDiscovery(null);
    setSchemaDiscoveryError("");
    setWorkflowError("");
    setContractAnalysisError("");
    setLoadedProfile(null);
    setSourceRequest(null);
    setPipelineStage(null);
  }

  const batchHasFiles = queueItems.length > 0 || batchStatus != null;

  function extractionUrl(documentId?: string): string {
    const params = new URLSearchParams();
    if (batchHasFiles) params.set("batch", intakeFields.batch_id);
    if (documentId) params.set("documentId", documentId);
    const query = params.toString();
    return query ? `/extraction/new?${query}` : "/extraction/new";
  }

  /** Opens a processed file of the batch in the review workspace (the
   * same persisted-record path as ?documentId=). */
  function openQueueItem(item: QueueItem) {
    if (!item.documentId) return;
    resetDocumentState();
    router.replace(extractionUrl(item.documentId), { scroll: false });
  }

  /** Back to the batch (upload portal + queue). */
  function closeDocument() {
    resetDocumentState();
    router.replace(extractionUrl(), { scroll: false });
  }

  const handleBatchFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      // A live batch: never re-load it from the server over the queue.
      adoptedBatchRef.current = intakeFieldsRef.current.batch_id;
      if (batchStatus === "submitted" || batchStatus === "rejected") setBatchStatus("mixed");
      queue.addFiles(files);
    },
    [queue, batchStatus],
  );

  // A single dropped file opens in the review workspace once its automatic
  // extraction is done (or failed), so the extracted fields show at once.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoOpenedRef.current || document || reopenDocumentId) return;
    const live = queueItems.filter((item) => item.file != null);
    if (queueItems.length !== 1 || live.length !== 1) return;
    const [only] = live;
    const settled = only.status === "extracted" || (only.status === "failed" && only.failedPhase === "extraction");
    if (settled && only.documentId) {
      autoOpenedRef.current = true;
      const params = new URLSearchParams({ batch: intakeFieldsRef.current.batch_id, documentId: only.documentId });
      router.replace(`/extraction/new?${params.toString()}`, { scroll: false });
    }
  }, [queueItems, document, reopenDocumentId, router]);

  const focusedExtractable = extractableTargets(schemaDiscovery?.targets ?? []);
  const queueExtractable = queueItems.some((item) => item.status === "processed");
  const runFullExtractionDisabled = document
    ? !extraction || extracting || Boolean(targetExtractionJob) || focusedExtractable.length === 0
    : queue.extractionRunning || !queueExtractable;
  const fullExtractionRunning = document ? Boolean(targetExtractionJob) : queue.extractionRunning;

  async function handleRunFullExtraction() {
    if (document) {
      try {
        await handleExtractTargets(focusedExtractable.map((target) => target.id));
      } catch (error) {
        setWorkflowError(error instanceof Error ? error.message : "Extraction failed.");
      }
      return;
    }
    await queue.runFullExtraction();
  }

  const batchDocumentCount = queueItems.filter((item) => item.documentId != null).length;
  const batchBusyCount = queueItems.filter((item) =>
    ["waiting", "uploading", "processing", "extracting"].includes(item.status),
  ).length;

  const classificationBase = resolveClassificationDisplay({
    persistedFamilyKey: stagingProfile?.document_families?.[0] ?? null,
    persistedFamilyLabel: null,
    persistedProfileLabel: stagingProfile?.display_name ?? null,
    discoveryFamilyKey:
      schemaDiscovery?.document_family ?? structureDetection?.document_family ?? null,
    discoveryFamilyLabel:
      schemaDiscovery?.document_family_label ??
      structureDetection?.document_family_label ??
      null,
    discoveryConfidence: schemaDiscovery?.document_family_confidence ?? null,
  });
  const classification =
    resolvedProfile && !classificationBase.unresolved
      ? { ...classificationBase, profileLabel: resolvedProfile.display_name }
      : classificationBase;

  const workflowStep = resolveWorkflowStep({
    hasDocument: Boolean(document),
    extracting,
    pipelineStage,
    schemaReady: Boolean(schemaDiscovery),
    schemaDiscovering,
    hasExtractResults: Boolean(targetResult || universalResult || contractAnalysis),
    hasPresentedProfile: Boolean(presentedProfile),
    stagingReady: Boolean(stagingProfile && extraction && !extracting),
  });

  const sourcePreview =
    pages.find((page) => page.final_text?.trim())?.final_text?.trim().slice(0, 420) ?? null;

  const workflowErrorInfo = workflowError ? actionableWorkflowError(workflowError) : null;

  const headerStep = document
    ? {
        step: intakeStepForWorkflowStep(workflowStep),
        complete: batchStatus === "submitted" && intakeStepForWorkflowStep(workflowStep) === "review",
      }
    : batchIntakeStep(
        queueItems.map((item) => ({
          uploaded: item.documentId != null,
          uploading: item.status === "uploading",
          processed: item.status === "processed" || item.status === "extracting",
          extracted: item.status === "extracted",
          failed: item.status === "failed",
        })),
        batchStatus,
      );

  const tracker = (
    <IntakeProgressTracker
      embedded={!document}
      activeStep={headerStep.step}
      complete={headerStep.complete}
      actions={
        <>
          <button
            type="button"
            onClick={() => void handleRunFullExtraction()}
            disabled={runFullExtractionDisabled}
            className={`${runFullExtractionDisabled && !fullExtractionRunning ? "btn-secondary" : "btn-primary"} h-9 px-3.5 text-[13px] disabled:cursor-not-allowed disabled:opacity-60`}
            title={
              document
                ? "Extract every field discovered in this document"
                : "Extract every discovered field of each processed file in the batch"
            }
            data-testid="run-full-extraction"
          >
            {fullExtractionRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Play className="h-4 w-4" aria-hidden="true" />
            )}
            {fullExtractionRunning ? "Extracting…" : "Run full extraction"}
          </button>
          {batchHasFiles && (
            <span className="text-xs text-text-secondary" data-testid="batch-status">
              {batchDocumentCount} of {queueItems.length} {queueItems.length === 1 ? "file" : "files"} uploaded
              {batchBusyCount > 0 ? ` · ${batchBusyCount} in progress` : ""}
            </span>
          )}
        </>
      }
    />
  );

  return (
    <>
      {!document ? (
        <ConsoleHeader
          icon={UploadCloud}
          title="New batch"
          description="Upload invoices, receipts, pay stubs, passports, driving licences, transcripts, contracts and more. Dataomatix detects each document's type, extracts its fields and stages them for review."
        >
          {tracker}
        </ConsoleHeader>
      ) : (
        <div className="extraction-bar-inner border-b border-border bg-surface py-3" data-testid="extraction-page-header">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                Extraction workspace
              </p>
              <h1 className="truncate text-base font-semibold text-foreground sm:text-lg">
                {document.original_filename}
              </h1>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {batchHasFiles && (
                <button type="button" onClick={closeDocument} className="btn-secondary text-sm">
                  <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                  Back to batch
                </button>
              )}
              <Link
                href={`/documents/${document.document_id}`}
                className="btn-secondary text-sm"
              >
                Open workspace
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </div>
      )}

      {document && tracker}

      <ContentSection wide>
        <BackendStatusBanner />
        {document && (
          <div className="mb-6">
            <WorkflowBreadcrumb activeStep={workflowStep} />
          </div>
        )}

        <div className="extraction-workspace">
          <div className="extraction-bar-inner">
            {!document ? (
              <div className="grid items-start gap-4 lg:gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
                <section className="space-y-4">
                  <BatchIntakePortal
                    config={intakeConfig}
                    configError={intakeConfigError}
                    fields={intakeFields}
                    onFieldsChange={setIntakeFields}
                    onFiles={handleBatchFiles}
                  />
                </section>
                <ProcessingQueue
                  items={queueItems}
                  onOpen={openQueueItem}
                  onRetry={(id) => queue.retry(id)}
                  onRemove={(id) => queue.remove(id)}
                  onResolveDuplicate={(id, action) => void queue.resolveDuplicate(id, action)}
                  onSelectPortfolioFile={(id, filename) => void queue.selectPortfolio(id, filename)}
                />
              </div>
            ) : (
              <div
                className="extraction-split grid gap-5 lg:grid-cols-[minmax(260px,30fr)_minmax(0,70fr)]"
                data-testid="extraction-split"
              >
                <section className="extraction-overview-panel space-y-4 lg:sticky lg:top-4 lg:self-start" data-testid="document-overview-panel">
                  <DocumentOverview
                    document={document}
                    structureDetection={structureDetection}
                    classification={classification}
                    extraction={extraction}
                    extracting={extracting}
                    progress={progress}
                    elapsedSeconds={elapsedSeconds}
                    waking={waking}
                    pipelineStage={pipelineStage}
                    stageHistory={stageHistory}
                    stageTimingsMs={stageTimingsMs}
                    pagesReused={pagesReused}
                    discoveryReused={discoveryReused}
                    sourcePreview={sourcePreview}
                    workflowFailed={Boolean(workflowError)}
                    documentHref={`/documents/${document.document_id}`}
                    onOpenProcessingDetails={() => setProcessingDrawerOpen(true)}
                    onReplaceDocument={closeDocument}
                    onViewResults={
                      contractAnalysis || universalResult || targetResult
                        ? () =>
                            (contractAnalysis
                              ? resultsWorkspaceRef
                              : targetResult
                                ? targetResultRef
                                : universalResultRef
                            ).current?.scrollIntoView({ behavior: "smooth" })
                        : undefined
                    }
                  />
                </section>

                <section className="extraction-schema-panel min-w-0 space-y-5" data-testid="schema-panel">
                  {!presentedProfile && (
                    <AnalysisRequest
                      documentHref={document ? `/documents/${document.document_id}?view=data` : undefined}
                      disabled={!extraction || extracting}
                      onAnalyze={handleAnalyze}
                      onExtractTargets={handleExtractTargets}
                      waking={waking}
                      extractionJob={targetExtractionJob}
                      onAddCustomField={handleAddCustomField}
                      onRenameCustomField={handleRenameCustomField}
                      onDeleteCustomField={handleDeleteCustomField}
                      targets={focusedExtractable}
                      documentFamily={classification.familyKey}
                      documentFamilyLabel={
                        classification.unresolved ? null : classification.familyLabel
                      }
                      documentFamilyConfidence={
                        classification.source === "schema_discovery"
                          ? classification.confidence
                          : undefined
                      }
                      schemaDiscovering={schemaDiscovering}
                      documentProcessing={extracting && !schemaDiscovering}
                      pipelineStage={pipelineStage}
                      schemaDiscoveryError={schemaDiscoveryError}
                      onRetryDiscovery={() =>
                        document && runSchemaDiscovery(document.document_id)
                      }
                    />
                  )}

                  {extraction && presentedProfile && document && (
                    <div className="editorial-card animate-fade-in p-6">
                      <p className="text-base font-medium text-foreground">
                        {presentedProfile.display_name}
                      </p>
                      <p className="mt-2 text-sm leading-6 text-text-secondary">
                        {presentedProfile.description}
                      </p>
                      <ul className="mt-4 flex flex-wrap gap-2">
                        {(presentedProfile.views ?? []).map((view) => (
                          <li key={view.view_id}>
                            <Link
                              href={`/documents/${document.document_id}?view=${view.view_id}`}
                              className="inline-flex rounded-full border border-border px-3 py-1 text-xs text-text-secondary hover:bg-surface-soft hover:text-foreground"
                            >
                              {view.label}
                            </Link>
                          </li>
                        ))}
                      </ul>
                      <Link
                        href={`/documents/${document.document_id}`}
                        className="btn-primary mt-5"
                      >
                        Open {presentedProfile.views?.[0]?.label}
                        <ArrowRight className="h-4 w-4" />
                      </Link>
                    </div>
                  )}

                  {extraction && !contractAnalysis && !presentedProfile && (
                    <div className="editorial-card animate-fade-in p-6">
                      <p className="text-base font-medium text-foreground">
                        Document Intelligence
                      </p>
                      {resolvedProfile ? (
                        <p className="mt-1 text-xs text-text-secondary">
                          Detected: {resolvedProfile.display_name}
                        </p>
                      ) : (
                        schemaDiscovery &&
                        schemaDiscovery.document_family !== "unknown" && (
                          <p className="mt-1 text-xs text-text-secondary">
                            Detected: {schemaDiscovery.document_family_label}
                            {" · "}
                            {confidenceQualifier(
                              schemaDiscovery.document_family_confidence,
                            )}
                          </p>
                        )
                      )}
                      <p className="mt-2 text-sm leading-6 text-text-secondary">
                        Classify this document, extract structured metadata, and
                        detect related documents when present.
                      </p>

                      {analyzingContract && (
                        <div className="mt-4 flex items-center gap-2 rounded-xl border border-primary/15 bg-primary/5 px-3.5 py-2.5 text-xs text-text-secondary">
                          <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
                          {waking
                            ? "Connecting to processing service… this can take up to a minute after idle."
                            : ANALYZE_STAGE_MESSAGES[analyzeStageIndex]}
                        </div>
                      )}

                      {extractionModels.length > 0 && (
                        <label className="mt-5 block text-xs text-text-secondary">
                          Extraction Model (optional)
                          <select
                            value={selectedModelId ?? ""}
                            onChange={(event) =>
                              setSelectedModelId(
                                event.target.value
                                  ? Number(event.target.value)
                                  : null,
                              )
                            }
                            className="mt-1.5 w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm text-foreground outline-none focus:border-primary/30"
                          >
                            <option value="">None</option>
                            {extractionModels.map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}

                      <button
                        type="button"
                        onClick={handleAnalyzeContract}
                        disabled={analyzingContract}
                        className="btn-primary mt-5 disabled:cursor-not-allowed disabled:opacity-60"
                      >
                        {analyzingContract ? (
                          <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
                        ) : (
                          <Sparkles className="h-4 w-4" />
                        )}
                        {analyzingContract
                          ? "Analyzing..."
                          : "Run Document Intelligence"}
                      </button>

                      {contractAnalysisError && (
                        <div className="mt-4 rounded-xl border border-danger/20 bg-danger/5 p-3 text-sm text-danger">
                          {contractAnalysisError}
                        </div>
                      )}
                    </div>
                  )}

                  {contractAnalysis && extraction && (
                    <div className="editorial-card animate-fade-in p-6">
                      <p className="text-base font-medium text-foreground">
                        Ready for review
                      </p>
                      <ul className="mt-3 space-y-1 text-sm text-text-secondary">
                        <li>{extraction.pages_processed} pages processed</li>
                        <li>Document classified</li>
                        <li>Relationships analyzed</li>
                        <li>
                          {contractAnalysis.metadata_fields.length} metadata
                          fields extracted
                        </li>
                      </ul>
                      <button
                        type="button"
                        onClick={() =>
                          resultsWorkspaceRef.current?.scrollIntoView({
                            behavior: "smooth",
                          })
                        }
                        className="btn-primary mt-5"
                      >
                        Review Extraction
                      </button>
                    </div>
                  )}

                  {workflowErrorInfo && (
                    <div
                      className="rounded-xl border border-danger/20 bg-danger/5 p-4"
                      role="alert"
                      data-testid="workflow-error"
                    >
                      <p className="text-sm font-medium text-danger">{workflowErrorInfo.title}</p>
                      <p className="mt-1 text-sm leading-6 text-danger/80">{workflowErrorInfo.body}</p>
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        {workflowErrorInfo.canRetry && (
                          <button
                            type="button"
                            onClick={() => handleUploadComplete(document)}
                            className="btn-secondary text-sm"
                            disabled={extracting}
                          >
                            Retry
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={closeDocument}
                          className="text-sm font-medium text-danger/80 underline decoration-dotted underline-offset-4"
                        >
                          Replace document
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>
        </div>

        {/* Source Verification lives inside the Staging Workbook (below its
            tabs) when the target results show; elsewhere it stays here. */}
        {document && targetResult && targetResult.scalars.length > 0 && (contractAnalysis || presentedProfile) && (
          <div className="mt-8">
            <UcfFieldReview
              documentId={document.document_id}
              documentName={document.original_filename}
              pageCount={document.page_count}
              result={targetResult}
              sourceRequest={sourceRequest}
              onViewSource={handleViewSource}
            />
          </div>
        )}

        {document && targetResult && !contractAnalysis && !presentedProfile && (
          <div className="extraction-workspace -mx-[max(1.5rem,3vw)] mt-8">
            <div
              ref={targetResultRef}
              className="extraction-workspace-inner animate-fade-in"
            >
              <div className="min-w-0">
                <TargetResults
                  result={targetResult}
                  targets={extractableTargets(schemaDiscovery?.targets ?? [])}
                  documentId={document.document_id}
                  documentName={document.original_filename}
                  pageCount={document.page_count}
                  status="complete"
                  processingDurationMs={targetResultDurationMs}
                  selectedResultId={sourceRequest?.id ?? null}
                  onViewSource={handleViewSource}
                  embedSourceVerification={targetResult.scalars.length > 0}
                  sourceVerificationRequest={sourceRequest}
                />
              </div>
            </div>
          </div>
        )}

        {document && universalResult && !contractAnalysis && !presentedProfile && (
          <div className="extraction-workspace -mx-[max(1.5rem,3vw)] mt-8">
            <div
              ref={universalResultRef}
              className="extraction-bar-inner animate-fade-in"
            >
              <p className="text-base font-medium text-foreground">
                Extraction Result
              </p>
              <div className="mt-4">
                <UniversalResults result={universalResult} />
              </div>
            </div>
          </div>
        )}

        {contractAnalysis && document && (
          <div ref={resultsWorkspaceRef} className="mt-8">
            <ExtractionResultsWorkspace
              document={document}
              analysis={contractAnalysis}
              pages={pages}
              structuredOutput={structuredOutput}
              universalResult={universalResult}
              extractingPages={extracting}
              pagesError={workflowError}
              onRetryPages={() => handleUploadComplete(document)}
              relationshipBusy={relationshipBusy}
              onRelationshipAction={handleRelationshipAction}
              onRelationshipChange={(relationship) =>
                setContractAnalysis((current) =>
                  current ? { ...current, relationship } : current,
                )
              }
            />
          </div>
        )}

        {batchHasFiles && (
          <BatchFooter
            batchId={intakeFields.batch_id}
            documentCount={batchDocumentCount}
            busyCount={batchBusyCount}
            status={batchStatus}
            onStatusChange={setBatchStatus}
          />
        )}
      </ContentSection>

      {document && (
        <ProcessingDetailsDrawer
          open={processingDrawerOpen}
          onClose={() => setProcessingDrawerOpen(false)}
          document={document}
          extraction={extraction}
          extracting={extracting}
          contractAnalyzed={Boolean(contractAnalysis)}
          progress={progress}
          elapsedSeconds={elapsedSeconds}
          waking={waking}
          pipelineStage={pipelineStage}
          schemaTargetCount={schemaDiscovery?.targets?.length ?? null}
          stageHistory={stageHistory}
          stageTimingsMs={stageTimingsMs}
          pagesReused={pagesReused}
          discoveryReused={discoveryReused}
        />
      )}
    </>
  );
}
