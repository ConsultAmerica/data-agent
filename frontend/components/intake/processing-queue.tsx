"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Check,
  CircleDashed,
  FileText,
  HelpCircle,
  Loader2,
  RotateCcw,
  X,
} from "lucide-react";

import DuplicateDialog from "@/components/duplicate-dialog";
import PortfolioPicker from "@/components/portfolio-picker";
import type { QueueItem } from "@/components/intake/batch-queue";
import { formatBytes } from "@/lib/format";
import { FILE_STAGES, fileStageStates, type FileStage, type FileStageState } from "@/lib/intake";

interface ProcessingQueueProps {
  items: QueueItem[];
  selectedDocumentId?: string | null;
  onOpen: (item: QueueItem) => void;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onResolveDuplicate: (id: string, action: "use_existing" | "upload_anyway") => void;
  onSelectPortfolioFile: (id: string, filename: string) => void;
}

const STATUS_LABEL: Record<QueueItem["status"], string> = {
  waiting: "Waiting",
  uploading: "Uploading",
  duplicate: "Possible duplicate",
  portfolio: "Choose a file",
  processing: "Classifying",
  processed: "Ready to extract",
  extracting: "Extracting",
  extracted: "Extracted",
  failed: "Failed",
};

const STATUS_TONE: Record<QueueItem["status"], string> = {
  waiting: "bg-surface-soft text-text-muted",
  uploading: "bg-primary-soft text-primary",
  duplicate: "bg-warning/10 text-warning",
  portfolio: "bg-warning/10 text-warning",
  processing: "bg-primary-soft text-primary",
  processed: "bg-surface-soft text-text-secondary",
  extracting: "bg-primary-soft text-primary",
  extracted: "bg-success/10 text-success",
  failed: "bg-danger/10 text-danger",
};

const REMOVABLE = new Set<QueueItem["status"]>(["waiting", "duplicate", "portfolio", "failed", "processed", "extracted"]);

function StageIcon({ state }: { state: FileStageState }) {
  if (state === "done") return <Check className="h-3 w-3" strokeWidth={2.5} aria-hidden="true" />;
  if (state === "active") return <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />;
  if (state === "failed") return <AlertTriangle className="h-3 w-3" aria-hidden="true" />;
  if (state === "unknown") return <HelpCircle className="h-3 w-3" aria-hidden="true" />;
  return <CircleDashed className="h-3 w-3" aria-hidden="true" />;
}

const STAGE_TONE: Record<FileStageState, string> = {
  done: "border-success/30 bg-success/10 text-success",
  active: "border-primary/40 bg-primary-soft text-primary",
  failed: "border-danger/30 bg-danger/10 text-danger",
  unknown: "border-border bg-surface text-text-muted",
  pending: "border-border bg-surface text-text-muted",
};

const STATE_WORD: Record<FileStageState, string> = {
  done: "done",
  active: "in progress",
  failed: "failed",
  unknown: "not known",
  pending: "pending",
};

/** Extra real detail for the active stage, when the backend reported it. */
function stageDetail(item: QueueItem, stage: FileStage, state: FileStageState): string | null {
  if (stage === "upload" && state === "active" && item.status === "uploading") {
    return `${Math.round(item.uploadFraction * 100)}%`;
  }
  if (stage === "ocr" && item.ocrRequired != null && item.ocrRequired > 0) {
    return `${item.ocrCompleted ?? 0}/${item.ocrRequired} pages`;
  }
  return null;
}

export default function ProcessingQueue({
  items,
  selectedDocumentId = null,
  onOpen,
  onRetry,
  onRemove,
  onResolveDuplicate,
  onSelectPortfolioFile,
}: ProcessingQueueProps) {
  const [promptId, setPromptId] = useState<string | null>(null);
  const prompt = items.find((item) => item.id === promptId) ?? null;

  if (items.length === 0) {
    return (
      <section className="editorial-card p-5 sm:p-6" aria-labelledby="queue-title">
        <h2 id="queue-title" className="text-lg font-medium tracking-tight text-foreground">
          Processing queue
        </h2>
        <p className="mt-2 text-sm text-text-secondary">
          No files in this batch yet. Files you add appear here with their real processing stage.
        </p>
      </section>
    );
  }

  return (
    <section className="editorial-card p-5 sm:p-6" aria-labelledby="queue-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="queue-title" className="text-lg font-medium tracking-tight text-foreground">
          Processing queue
        </h2>
        <p className="text-xs text-text-muted">
          {items.length} {items.length === 1 ? "file" : "files"} · stages as reported by the server
        </p>
      </div>

      <ul className="mt-4 divide-y divide-border" data-testid="processing-queue">
        {items.map((item) => {
          const states = fileStageStates({
            uploaded: item.documentId != null,
            uploading: item.status === "uploading",
            processed: item.status === "processed" || item.status === "extracting" || item.status === "extracted" ||
              (item.status === "failed" && item.failedPhase === "extraction"),
            extracted: item.status === "extracted",
            pipelineStage: item.pipelineStage,
            failed: item.status === "failed",
            staged: item.file == null ? item.staged : item.status === "extracted" ? true : false,
          });
          const openable =
            item.documentId != null && (item.status === "processed" || item.status === "extracted" ||
              (item.status === "failed" && item.failedPhase === "extraction"));
          const selected = item.documentId != null && item.documentId === selectedDocumentId;
          return (
            <li
              key={item.id}
              className={`py-3 ${selected ? "-mx-2 rounded-lg bg-primary-soft/40 px-2" : ""}`}
              data-testid="queue-row"
            >
              <div className="flex flex-wrap items-center gap-3">
                <FileText className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground" title={item.name}>
                    {item.name}
                  </p>
                  <p className="text-xs text-text-muted">
                    {item.size > 0 ? formatBytes(item.size) : "Size unknown"}
                    {item.pageCount ? ` · ${item.pageCount} ${item.pageCount === 1 ? "page" : "pages"}` : ""}
                    {item.profileLabel ? ` · ${item.profileLabel}` : ""}
                    {item.fieldsExtracted != null ? ` · ${item.fieldsExtracted} fields extracted` : ""}
                  </p>
                </div>
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[item.status]}`}>
                  {STATUS_LABEL[item.status]}
                </span>
                <div className="flex items-center gap-1.5">
                  {(item.status === "duplicate" || item.status === "portfolio") && (
                    <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setPromptId(item.id)}>
                      Resolve
                    </button>
                  )}
                  {openable && (
                    <button
                      type="button"
                      className="btn-secondary px-2.5 py-1 text-xs"
                      onClick={() => onOpen(item)}
                      aria-pressed={selected}
                    >
                      {selected ? "Open" : "Review"}
                    </button>
                  )}
                  {item.status === "failed" && (item.file != null || item.documentId != null) && (
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-text-secondary hover:bg-surface-soft hover:text-foreground"
                      onClick={() => onRetry(item.id)}
                    >
                      <RotateCcw className="h-3 w-3" aria-hidden="true" />
                      Retry
                    </button>
                  )}
                  {REMOVABLE.has(item.status) && (
                    <button
                      type="button"
                      className="rounded-lg p-1 text-text-muted hover:bg-surface-soft hover:text-foreground"
                      onClick={() => onRemove(item.id)}
                      aria-label={`Remove ${item.name} from the queue`}
                      title="Remove from the queue (the uploaded document is kept)"
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                </div>
              </div>

              <ol className="mt-2 flex flex-wrap gap-1.5 pl-7" aria-label={`Stages for ${item.name}`}>
                {FILE_STAGES.map((stage) => {
                  const state = states[stage.id];
                  const detail = stageDetail(item, stage.id, state);
                  return (
                    <li
                      key={stage.id}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${STAGE_TONE[state]}`}
                      data-state={state}
                      title={state === "unknown" ? "Not reported for this file" : undefined}
                    >
                      <StageIcon state={state} />
                      {stage.label}
                      {detail && <span className="tabular-nums">· {detail}</span>}
                      <span className="sr-only">: {STATE_WORD[state]}</span>
                    </li>
                  );
                })}
              </ol>

              {item.note && <p className="mt-1.5 pl-7 text-xs text-text-muted">{item.note}</p>}
              {item.error && (
                <p className="mt-1.5 pl-7 text-xs text-danger" role="alert">
                  {item.error}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {prompt?.status === "duplicate" && prompt.duplicate && (
        <DuplicateDialog
          existingDocument={prompt.duplicate.existing}
          onUseExisting={() => {
            setPromptId(null);
            onResolveDuplicate(prompt.id, "use_existing");
          }}
          onUploadAnyway={() => {
            setPromptId(null);
            onResolveDuplicate(prompt.id, "upload_anyway");
          }}
          onCancel={() => setPromptId(null)}
        />
      )}
      {prompt?.status === "portfolio" && prompt.portfolio && (
        <PortfolioPicker
          files={prompt.portfolio.files}
          onSelect={(filename) => {
            setPromptId(null);
            onSelectPortfolioFile(prompt.id, filename);
          }}
          onCancel={() => setPromptId(null)}
        />
      )}
    </section>
  );
}
