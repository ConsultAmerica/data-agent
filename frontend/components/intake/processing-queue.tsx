"use client";

import { useEffect, useState } from "react";
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
import { ApiError } from "@/lib/api";
import { getExtractionJob } from "@/lib/documents";
import type { ExtractionJob } from "@/types/document";
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

/** The backend stage a file is in, in words (only stages it reports). */
const STAGE_WORDS: Record<string, string> = {
  uploaded: "Uploaded",
  queued: "Queued on the server",
  reading_document: "Reading the document",
  verifying_file: "Verifying the file",
  processing_document: "Reading the document",
  rendering_ocr: "Reading pages",
  running_ocr: "Running OCR",
  indexing: "Indexing",
  detecting_structure: "Detecting structure",
  discovering_fields: "Finding fields",
  classifying: "Classifying the document",
  extracting_data: "Extracting values",
  validating_results: "Validating",
  v3_classification: "Classifying",
  prepare_staging: "Preparing the workbook",
};

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The current time, ticking each second only while `active`. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** What the file is doing now, how long it has taken, and its place in
 * line — only facts the queue knows (no estimated percentages). */
export function progressLine(item: QueueItem, now: number, waitingAhead: number): string | null {
  const elapsed = item.startedAt != null ? formatElapsed((item.finishedAt ?? now) - item.startedAt) : null;
  if (item.status === "waiting") return waitingAhead > 0 ? `Waiting · ${waitingAhead} ahead` : "Waiting · next";
  if (item.status === "duplicate" || item.status === "portfolio") return "Waiting for your choice";
  if (item.status === "processed") return `Waiting to extract${elapsed ? ` · ${elapsed}` : ""}`;
  if (item.status === "extracted") return elapsed ? `Done in ${elapsed}` : null;
  if (item.status === "failed") return elapsed ? `Failed after ${elapsed}` : null;
  const stage = (item.pipelineStage && STAGE_WORDS[item.pipelineStage]) || (item.status === "uploading" ? "Uploading" : null);
  return [stage, elapsed].filter(Boolean).join(" · ") || null;
}

/** No backend report for this long while active: possibly stalled. The
 * server marks a job whose worker stopped as interrupted (job_recovery.py). */
export const STALL_AFTER_MS = 180_000;

const ACTIVE = new Set<QueueItem["status"]>(["uploading", "processing", "extracting"]);

/** The detail panel's rows: only values the backend or the browser
 * actually recorded — nothing estimated, no percentages. */
export function processingDetails(item: QueueItem, now: number): { label: string; value: string; tone?: "warning" | "danger" }[] {
  const rows: { label: string; value: string; tone?: "warning" | "danger" }[] = [];
  const active = ACTIVE.has(item.status);
  if (!active && item.status !== "failed") return rows;
  const stage = (item.pipelineStage && STAGE_WORDS[item.pipelineStage]) || STATUS_LABEL[item.status];
  rows.push({
    label: "Stage",
    value: `${stage} · ${item.statusUnavailable ? "status unavailable" : item.status === "failed" ? "failed" : "in progress"}`,
    tone: item.statusUnavailable ? "warning" : item.status === "failed" ? "danger" : undefined,
  });
  if (item.jobState && JOB_STATE_WORDS[item.jobState]) {
    rows.push({ label: "State", value: JOB_STATE_WORDS[item.jobState], tone: item.jobState === "interrupted" ? "warning" : undefined });
  }
  if (item.pagesDone != null && item.pageCount) rows.push({ label: "Pages read", value: `${item.pagesDone} of ${item.pageCount}` });
  if (item.ocrRequired) rows.push({ label: "OCR pages", value: `${item.ocrCompleted ?? 0} of ${item.ocrRequired}` });
  if (item.batchesTotal) rows.push({ label: "Batches", value: `${item.batchesDone ?? 0} of ${item.batchesTotal}` });
  if (item.startedAt != null) rows.push({ label: "Elapsed", value: formatElapsed((item.finishedAt ?? now) - item.startedAt) });
  if (active && item.lastProgressAt != null) {
    const quiet = now - item.lastProgressAt;
    rows.push(
      quiet > STALL_AFTER_MS
        ? { label: "Last update", value: `${formatElapsed(quiet)} ago — no progress reported; if the server stopped, the job will be marked interrupted and can be retried`, tone: "warning" }
        : { label: "Last update", value: `${formatElapsed(quiet)} ago` },
    );
  }
  if (item.retries) rows.push({ label: "Retries", value: String(item.retries), tone: "warning" });
  if (item.status === "failed" && item.error) {
    rows.push(item.statusUnavailable ? { label: "Status", value: item.error, tone: "warning" } : { label: "Error", value: item.error, tone: "danger" });
  }
  return rows;
}

/** Badge for the backend's finer job state, where it differs from the
 * queue's own status. */
const JOB_STATE_BADGE: Record<string, { label: string; tone: string }> = {
  interrupted: { label: "Interrupted", tone: "bg-warning/10 text-warning" },
  partially_complete: { label: "Partially complete", tone: "bg-warning/10 text-warning" },
  cancelled: { label: "Cancelled", tone: "bg-surface-soft text-text-secondary" },
};

const JOB_STATE_WORDS: Record<string, string> = {
  queued: "Queued",
  processing: "Processing",
  interrupted: "Interrupted — a worker stopped; its pages are being picked up again",
  partially_complete: "Partially complete — some pages finished, others failed",
  ready_for_review: "Ready for review",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export function statusBadge(item: QueueItem): { label: string; tone: string } {
  if (item.statusUnavailable) return { label: "Status unavailable", tone: "bg-warning/10 text-warning" };
  const special = item.jobState ? JOB_STATE_BADGE[item.jobState] : undefined;
  if (special) return special;
  return { label: STATUS_LABEL[item.status], tone: STATUS_TONE[item.status] };
}

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
  const [diagnosticsFor, setDiagnosticsFor] = useState<QueueItem | null>(null);
  const prompt = items.find((item) => item.id === promptId) ?? null;
  const now = useNow(items.some((item) => item.startedAt != null && item.finishedAt == null && item.status !== "waiting"));
  const waitingOrder = items.filter((item) => item.status === "waiting").map((item) => item.id);

  if (items.length === 0) {
    return (
      <section className="data-panel p-4 sm:p-5" aria-labelledby="queue-title">
        <h2 id="queue-title" className="text-[15px] font-semibold tracking-tight text-foreground">
          Processing queue
        </h2>
        <p className="mt-0.5 text-[13px] text-text-secondary">Live status for every file in this batch.</p>
        <div className="mt-4 flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-10 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-soft text-text-muted ring-1 ring-inset ring-border">
            <FileText className="h-5 w-5" aria-hidden="true" />
          </div>
          <p className="mt-3 text-sm font-semibold text-foreground">No files yet</p>
          <p className="mt-1 max-w-xs text-xs leading-5 text-text-muted">
            Files you add appear here and move through upload, OCR, layout and extraction.
          </p>
          {/* What each file will go through, so the empty panel still explains the pipeline. */}
          <ol className="mt-5 flex flex-wrap items-center justify-center gap-1" aria-label="Stages each file goes through">
            {FILE_STAGES.map((stage, index) => (
              <li key={stage.id}>
                <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-text-secondary">
                  <span className="tabular-nums text-text-muted">{index + 1}</span>
                  {stage.label}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </section>
    );
  }

  function renderItem(item: QueueItem) {
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
            <div className="flex min-w-0 items-center gap-2">
              <p className="truncate text-sm font-medium text-foreground" title={item.name}>
                {item.name}
              </p>
              {item.typeLabel && (
                <span
                  className="shrink-0 rounded-md bg-primary-soft px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary"
                  data-testid="queue-type-label"
                  title="Detected from the document's own content"
                >
                  {item.typeLabel}
                </span>
              )}
            </div>
            <p className="text-xs text-text-muted">
              {item.size > 0 ? formatBytes(item.size) : "Size unknown"}
              {item.pageCount ? ` · ${item.pageCount} ${item.pageCount === 1 ? "page" : "pages"}` : ""}
              {item.profileLabel && item.profileLabel !== item.typeLabel &&
              !(item.typeLabel && item.profileLabel === "Generic Document")
                ? ` · ${item.profileLabel}`
                : ""}
              {item.fieldsExtracted != null ? ` · ${item.fieldsExtracted} fields extracted` : ""}
            </p>
            {(() => {
              const line = progressLine(item, now, waitingOrder.indexOf(item.id));
              return line ? <p className="text-xs tabular-nums text-text-secondary" data-testid="queue-progress">{line}</p> : null;
            })()}
          </div>
          {(() => {
            const badge = statusBadge(item);
            return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${badge.tone}`} data-testid="queue-status">{badge.label}</span>;
          })()}
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
            {item.jobId != null && (
              <button
                type="button"
                className="rounded-lg px-2 py-1 text-xs font-medium text-text-secondary hover:bg-surface-soft hover:text-foreground"
                onClick={() => setDiagnosticsFor(item)}
                aria-label={`View diagnostics for ${item.name}`}
              >
                Diagnostics
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

        {(() => {
          const details = processingDetails(item, now);
          if (details.length === 0) return null;
          return (
            <dl className="mt-2 ml-7 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-0.5 rounded-lg border border-border bg-surface-soft/60 px-3 py-2 text-xs" data-testid="processing-details" aria-label={`Processing details for ${item.name}`}>
              {details.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="text-text-secondary">{row.label}</dt>
                  <dd role={row.label === "Error" ? "alert" : undefined}
                    className={`tabular-nums ${row.tone === "danger" ? "text-danger" : row.tone === "warning" ? "text-warning" : "text-foreground"}`}>{row.value}</dd>
                </div>
              ))}
            </dl>
          );
        })()}
        {item.note && <p className="mt-1.5 pl-7 text-xs text-text-muted">{item.note}</p>}
        {item.error && item.status !== "failed" && (
          <p className="mt-1.5 pl-7 text-xs text-danger" role="alert">
            {item.error}
          </p>
        )}
      </li>
    );
  }

  const groups = groupByCategory(items);

  return (
    <section className="data-panel p-4 sm:p-5" aria-labelledby="queue-title">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="queue-title" className="text-[15px] font-semibold tracking-tight text-foreground">
          Processing queue
        </h2>
        <p className="text-xs text-text-muted">
          {items.length} {items.length === 1 ? "file" : "files"}
        </p>
      </div>

      {groups.some((group) => group.key !== PENDING) ? (
        <div className="mt-4 space-y-4" data-testid="processing-queue">
          {groups.map((group) => (
            <section key={group.key} aria-label={group.label} data-testid="queue-category">
              <h3 className="flex items-baseline gap-2 border-b border-border pb-1.5 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                {group.label}
                <span className="font-normal tabular-nums text-text-muted">{group.items.length}</span>
              </h3>
              <ul className="divide-y divide-border">{group.items.map(renderItem)}</ul>
            </section>
          ))}
        </div>
      ) : (
        <ul className="mt-4 divide-y divide-border" data-testid="processing-queue">
          {items.map(renderItem)}
        </ul>
      )}

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
      {diagnosticsFor?.jobId != null && (
        <DiagnosticsDialog item={diagnosticsFor} jobId={diagnosticsFor.jobId} onClose={() => setDiagnosticsFor(null)} />
      )}
    </section>
  );
}

/** What the backend reports for a file's job: state, stage, times, retries,
 * error and per-stage timings. No document content. */
function DiagnosticsDialog({ item, jobId, onClose }: { item: QueueItem; jobId: number; onClose: () => void }) {
  const [job, setJob] = useState<ExtractionJob | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    getExtractionJob(jobId)
      .then((value) => active && setJob(value))
      .catch((err: unknown) =>
        active &&
        setError(
          err instanceof ApiError && err.status === 404
            ? `Job ${jobId} is not available from the server (removed, or started from another browser workspace).`
            : err instanceof Error ? err.message : "Diagnostics could not be loaded.",
        ),
      );
    return () => {
      active = false;
    };
  }, [jobId]);
  const metrics = (job?.result as { metrics?: { stages?: { stage: string; ms: number; percent: number }[]; total_ms?: number; queue_wait_ms?: number | null } } | null)?.metrics;
  const rows: [string, string][] = job
    ? [
        ["Job", `#${job.id} · ${job.job_type}`],
        ["Status", job.state ? `${job.status} (${job.state})` : job.status],
        ["Stage", job.stage ?? "—"],
        ["Created", job.created_at ?? "—"],
        ["Started", job.started_at ?? "—"],
        ["Completed", job.completed_at ?? "—"],
        ["Retries", String(job.retry_count ?? 0)],
        ["Error", job.error_message ?? "—"],
        ...(metrics?.total_ms != null ? ([["Total", formatElapsed(metrics.total_ms)]] as [string, string][]) : []),
        ...(metrics?.queue_wait_ms != null ? ([["Queue wait", `${metrics.queue_wait_ms} ms`]] as [string, string][]) : []),
      ]
    : [];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label={`Diagnostics for ${item.name}`}>
      <div className="max-h-[80vh] w-full max-w-lg overflow-auto rounded-xl border border-border bg-surface p-5 text-xs shadow-xl">
        <div className="mb-3 flex items-start justify-between gap-2">
          <h3 className="text-sm font-semibold text-foreground">Diagnostics · {item.name}</h3>
          <button type="button" onClick={onClose} aria-label="Close diagnostics" className="rounded-md p-1 text-text-muted hover:bg-surface-soft">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {error && <p className="text-warning" role="status">{error}</p>}
        {!job && !error && <p className="text-text-muted">Loading…</p>}
        {job && (
          <>
            <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1" data-testid="diagnostics-job">
              {rows.map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-text-secondary">{label}</dt>
                  <dd className="break-words tabular-nums text-foreground">{value}</dd>
                </div>
              ))}
            </dl>
            {metrics?.stages && metrics.stages.length > 0 && (
              <table className="mt-3 w-full" data-testid="diagnostics-stages">
                <thead>
                  <tr className="text-left text-text-secondary"><th className="py-1 font-medium">Stage</th><th className="py-1 text-right font-medium">Time</th><th className="py-1 text-right font-medium">Share</th></tr>
                </thead>
                <tbody>
                  {metrics.stages.map((stage) => (
                    <tr key={stage.stage} className="border-t border-border/60">
                      <td className="py-1">{stage.stage.replace(/_/g, " ")}</td>
                      <td className="py-1 text-right tabular-nums">{stage.ms.toLocaleString()} ms</td>
                      <td className="py-1 text-right tabular-nums">{stage.percent}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}

interface QueueGroup {
  key: string;
  label: string;
  items: QueueItem[];
}

const NEEDS_ATTENTION = "__attention__";
const PENDING = "__pending__";
const ATTENTION_STATUSES = new Set<QueueItem["status"]>(["duplicate", "portfolio", "failed"]);

/** Files under their detected category, in the order categories first
 * appear; uncategorized files waiting on the user (duplicate, portfolio
 * choice, failure) come first, files still being read come last. */
function groupByCategory(items: QueueItem[]): QueueGroup[] {
  const groups = new Map<string, QueueGroup>();
  for (const item of items) {
    const key = item.category ?? (ATTENTION_STATUSES.has(item.status) ? NEEDS_ATTENTION : PENDING);
    const label =
      key === NEEDS_ATTENTION ? "Needs attention" : key === PENDING ? "Recognizing type…" : (item.categoryLabel ?? key);
    const group = groups.get(key) ?? { key, label, items: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const attention = groups.get(NEEDS_ATTENTION);
  const pending = groups.get(PENDING);
  groups.delete(NEEDS_ATTENTION);
  groups.delete(PENDING);
  return [...(attention ? [attention] : []), ...groups.values(), ...(pending ? [pending] : [])];
}
