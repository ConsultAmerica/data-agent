import { CheckCircle2, FileText, RefreshCw } from "lucide-react";
import Link from "next/link";

import DetectionCountChips from "@/components/detection-count-chips";
import DocumentStatusSummary from "@/components/extraction/document-status-summary";
import { hasDetectionCounts } from "@/lib/detection";
import {
  fileTypeLabel,
  processingStatusLabel,
  type ClassificationDisplay,
} from "@/lib/extraction-workflow";
import { formatBytes } from "@/lib/format";
import type {
  ExtractionProgress,
  ExtractionSummary,
  ProcessingStageEntry,
  StructureDetectionResult,
  UploadedDocument,
} from "@/types/document";

interface DocumentOverviewProps {
  document: UploadedDocument;
  structureDetection: StructureDetectionResult | null;
  classification: ClassificationDisplay;
  extraction: ExtractionSummary | null;
  extracting: boolean;
  progress: ExtractionProgress | null;
  elapsedSeconds: number;
  waking: boolean;
  pipelineStage?: string | null;
  stageHistory?: ProcessingStageEntry[] | null;
  stageTimingsMs?: Record<string, number> | null;
  pagesReused?: boolean;
  discoveryReused?: boolean;
  /** Short source text preview when pages are available — not parser internals. */
  sourcePreview?: string | null;
  workflowFailed?: boolean;
  onOpenProcessingDetails: () => void;
  onViewResults?: () => void;
  onReplaceDocument?: () => void;
  documentHref?: string;
}

export default function DocumentOverview({
  document,
  structureDetection,
  classification,
  extraction,
  extracting,
  progress,
  elapsedSeconds,
  waking,
  pipelineStage = null,
  stageHistory = null,
  stageTimingsMs = null,
  pagesReused = false,
  discoveryReused = false,
  sourcePreview = null,
  workflowFailed = false,
  onOpenProcessingDetails,
  onViewResults,
  onReplaceDocument,
  documentHref,
}: DocumentOverviewProps) {
  const typeLabel = fileTypeLabel(document.content_type, document.original_filename);
  const status = processingStatusLabel({
    extracting,
    pipelineStage,
    extractionComplete: Boolean(extraction) && !extracting,
    failed: workflowFailed,
  });

  const showDetected =
    structureDetection &&
    hasDetectionCounts(structureDetection.counts, structureDetection.content_stats.tables);

  return (
    <div className="editorial-card space-y-4 p-5" data-testid="document-overview">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            Document Overview
          </p>
          <div className="mt-2 flex items-start gap-3">
            <div className="file-icon-wrap h-10 w-10 shrink-0" aria-hidden="true">
              <FileText className="h-4 w-4" strokeWidth={1.75} />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-medium text-foreground" title={document.original_filename}>
                {document.original_filename}
              </h2>
              <p className="mt-0.5 text-xs text-text-secondary">
                {typeLabel} · {formatBytes(document.size_bytes)}
                {document.page_count > 0 ? ` · ${document.page_count} pages` : ""}
              </p>
            </div>
          </div>
        </div>

        {onReplaceDocument && (
          <button
            type="button"
            onClick={onReplaceDocument}
            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-text-teal hover:text-primary"
          >
            <RefreshCw className="h-3 w-3" aria-hidden="true" />
            Replace
          </button>
        )}
      </div>

      <dl className="grid gap-2 text-xs" data-testid="document-overview-meta">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <dt className="text-text-muted">Document family</dt>
          <dd
            className={
              classification.unresolved
                ? "font-medium text-warning"
                : "font-medium text-foreground"
            }
            data-testid="classification-family"
          >
            {classification.familyLabel}
          </dd>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <dt className="text-text-muted">Resolved profile</dt>
          <dd className="font-medium text-foreground" data-testid="classification-profile">
            {classification.profileLabel ?? (classification.unresolved ? "Not resolved yet" : "—")}
          </dd>
        </div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <dt className="text-text-muted">Processing status</dt>
          <dd className="font-medium text-foreground" data-testid="processing-status">
            {status}
          </dd>
        </div>
        {classification.source === "persisted_profile" && (
          <p className="text-[11px] text-text-muted">
            Classification from the saved staging profile — not re-inferred from the filename.
          </p>
        )}
      </dl>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center rounded-full border border-border bg-surface-soft px-2.5 py-0.5 text-[11px] font-semibold text-text-secondary">
          {typeLabel}
        </span>
        {!classification.unresolved && (
          <span className="inline-flex items-center rounded-full border border-primary/20 bg-primary/5 px-2.5 py-0.5 text-[11px] font-semibold text-primary">
            {classification.familyLabel}
          </span>
        )}
        {classification.unresolved && (
          <span className="inline-flex items-center rounded-full border border-warning/30 bg-warning/10 px-2.5 py-0.5 text-[11px] font-semibold text-warning">
            Unresolved
          </span>
        )}
        {extraction && !extracting && !workflowFailed && (
          <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-0.5 text-[11px] font-semibold text-success">
            <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
            Complete
          </span>
        )}
      </div>

      <div className="border-t border-border pt-3">
        <DocumentStatusSummary
          document={document}
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
          onOpenDetails={onOpenProcessingDetails}
        />
      </div>

      {sourcePreview && (
        <div className="border-t border-border pt-3" data-testid="source-preview">
          <p className="text-[11px] font-medium text-text-muted">Source preview</p>
          <p className="mt-1 line-clamp-4 whitespace-pre-wrap break-words text-xs leading-5 text-text-secondary">
            {sourcePreview}
          </p>
          {documentHref && (
            <Link
              href={documentHref}
              className="mt-2 inline-block text-xs font-medium text-primary hover:underline"
            >
              Open document workspace
            </Link>
          )}
        </div>
      )}

      {showDetected && (
        <div className="border-t border-border pt-3">
          <p className="text-[11px] font-medium text-text-muted">Detected content</p>
          <div className="mt-1.5">
            <DetectionCountChips
              counts={structureDetection.counts}
              tableTotal={structureDetection.content_stats.tables}
            />
          </div>
        </div>
      )}

      {(onViewResults || documentHref) && (
        <div className="border-t border-border pt-3">
          <p className="text-[11px] font-medium text-text-muted">Quick actions</p>
          <div className="mt-1.5 flex flex-col gap-1.5">
            {onViewResults && (
              <button
                type="button"
                onClick={onViewResults}
                className="text-left text-sm font-medium text-primary hover:underline"
              >
                Review Extraction
              </button>
            )}
            {documentHref && (
              <Link href={documentHref} className="text-sm font-medium text-primary hover:underline">
                Open document workspace
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
