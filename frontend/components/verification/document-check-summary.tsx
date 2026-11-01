"use client";

import { AlertTriangle, Check, ChevronDown, Circle, Loader2, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";

import { decideClassification } from "@/lib/classification";
import {
  FAILURE_REASONS,
  getDocumentValidation,
  retryJob,
  revalidateDocument,
  type CheckStatus,
  type DocumentValidation,
  type ProcessingStage,
} from "@/lib/document-validation";

const READINESS_TONE: Record<string, string> = {
  ready: "bg-success/10 text-success",
  ready_with_warnings: "bg-warning/10 text-warning",
  review_required: "bg-danger/10 text-danger",
};
const CHECK_TONE: Record<string, string> = {
  passed: "text-success",
  consistent: "text-success",
  complete: "text-success",
  info: "text-text-secondary",
  not_applicable: "text-text-muted",
  not_measured: "text-text-muted",
  warning: "text-warning",
  gaps: "text-warning",
  failed: "text-danger",
  blocker: "text-danger",
  inconsistent: "text-danger",
};
const CHECK_WORD: Record<string, string> = {
  passed: "Passed",
  consistent: "Consistent",
  complete: "Complete",
  info: "Info",
  not_applicable: "None in source",
  not_measured: "Not measured",
  warning: "Warning",
  gaps: "Gaps",
  failed: "Failed",
  blocker: "Review",
  inconsistent: "Differs",
};

function StageStep({ stage, last }: { stage: ProcessingStage; last: boolean }) {
  const icon = {
    done: <Check className="h-3 w-3" aria-hidden="true" />,
    active: <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />,
    failed: <X className="h-3 w-3" aria-hidden="true" />,
    pending: <Circle className="h-2 w-2" aria-hidden="true" />,
  }[stage.status];
  const tone = {
    done: "bg-success text-white",
    active: "bg-primary text-white",
    failed: "bg-danger text-white",
    pending: "border border-border text-text-muted",
  }[stage.status];
  return (
    <li className="flex items-center gap-1" data-testid={`stage-${stage.key}`} data-status={stage.status}
      title={stage.detail || undefined}>
      <span className={`inline-flex h-4 w-4 items-center justify-center rounded-full ${tone}`}>{icon}</span>
      <span className={stage.status === "pending" ? "text-text-muted" : stage.status === "failed" ? "text-danger" : "text-foreground"}>
        {stage.label}
      </span>
      {!last && <span className="mx-1 text-text-muted" aria-hidden="true">→</span>}
    </li>
  );
}

function Chip({ tone, children, testId }: { tone: string; children: ReactNode; testId?: string }) {
  return <span data-testid={testId} className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 ${tone}`}>{children}</span>;
}

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="min-w-0" data-testid={testId}>
      <h4 className="mb-1 font-semibold text-foreground">{title}</h4>
      {children}
    </section>
  );
}

function CheckLine({ label, status, detail }: { label: string; status: CheckStatus | string; detail?: string }) {
  return (
    <li className="flex gap-2 py-0.5">
      <span className={`w-20 shrink-0 font-medium ${CHECK_TONE[status] ?? "text-text-secondary"}`}>{CHECK_WORD[status] ?? status}</span>
      <span className="min-w-0 text-foreground">
        {label}
        {detail ? <span className="text-text-secondary"> — {detail}</span> : null}
      </span>
    </li>
  );
}

function tone(ok: boolean, warn: boolean) {
  return ok ? "bg-success/10 text-success" : warn ? "bg-warning/10 text-warning" : "bg-danger/10 text-danger";
}

/** Upload and extraction quality in one compact strip: the processing
 * stages, the file check, the document type, completeness, labels, the
 * Original File / Excel check and Oracle mapping readiness — details on
 * demand. `refreshKey` changes when the workspace reloads its data, so a
 * review or a type change is revalidated. */
export default function DocumentCheckSummary({ documentId, refreshKey, onClassificationChanged }: {
  documentId: string;
  refreshKey?: unknown;
  onClassificationChanged?: () => void;
}) {
  const [report, setReport] = useState<DocumentValidation | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    getDocumentValidation(documentId)
      .then((data) => {
        if (!active) return;
        setReport(data);
        setError("");
      })
      .catch((err: unknown) => active && setError(err instanceof Error ? err.message : "The document check couldn't be loaded."));
    return () => {
      active = false;
    };
  }, [documentId, refreshKey]);

  // While a stage runs, check again as it advances.
  const running = report?.processing.stages.some((s) => s.status === "active");
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => {
      getDocumentValidation(documentId).then(setReport).catch(() => undefined);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [documentId, running, report]);

  const act = useCallback(async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setNotice("");
    try {
      await work();
      setNotice(done);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }, []);

  if (error) {
    return <p className="mt-3 text-xs text-text-secondary" data-testid="document-check-error">Document check unavailable: {error}</p>;
  }
  if (!report) {
    return <p className="mt-3 text-xs text-text-muted" data-testid="document-check-loading">Checking the document…</p>;
  }

  const { processing, file, classification, labels, completeness, consistency, readiness, association } = report;
  const failure = processing.stages.find((s) => s.failure)?.failure;
  const formFields = completeness?.measures.find((m) => m.key === "form_fields");
  const coverage = completeness?.measures.filter((m) => m.status === "complete" || m.status === "gaps") ?? [];

  return (
    <section className="mt-3 rounded-xl border border-border bg-surface px-3 py-2 text-xs" data-testid="document-check"
      aria-label="Document check">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <ol className="flex flex-wrap items-center" aria-label={`Processing: ${processing.completed} of ${processing.total} stages done`}
          data-testid="processing-stages">
          {processing.stages.map((stage, index) => (
            <StageStep key={stage.key} stage={stage} last={index === processing.stages.length - 1} />
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-1.5">
          {readiness && (
            <Chip tone={READINESS_TONE[readiness.state]} testId="mapping-readiness">
              {readiness.state === "ready" ? <Check className="h-3 w-3" aria-hidden="true" /> : <AlertTriangle className="h-3 w-3" aria-hidden="true" />}
              {readiness.label}
            </Chip>
          )}
          <Chip tone={tone(file.status === "verified", file.status === "warning")} testId="file-status">
            File {file.status === "verified" ? "verified" : file.status === "warning" ? "verified with warnings" : "failed"}
          </Chip>
          {classification && (
            <Chip tone={tone(classification.decided || classification.status === "classified", !classification.review_required)}
              testId="type-status">
              {classification.family_label}
              {classification.confidence != null && !classification.decided ? ` · ${Math.round(classification.confidence * 100)}%` : ""}
              {classification.decided ? " · confirmed" : classification.review_required ? " · review" : ""}
            </Chip>
          )}
          {completeness && (
            <Chip tone={tone(completeness.status === "complete", completeness.status === "partial")} testId="coverage-status">
              {completeness.status === "complete" ? "Coverage complete" : completeness.status === "gaps" ? `${completeness.gaps.length} coverage gap${completeness.gaps.length === 1 ? "" : "s"}` : "Coverage partly measured"}
              {formFields && formFields.source ? ` · ${formFields.represented}/${formFields.source} form fields` : ""}
            </Chip>
          )}
          {labels && (
            <Chip tone={tone(labels.unresolved.length === 0, true)} testId="label-status">
              {labels.resolved}/{labels.total} labels
            </Chip>
          )}
          {consistency && (
            <Chip tone={tone(consistency.status === "consistent", false)} testId="excel-status">
              {consistency.status === "consistent" ? "Excel matches the tab" : "Excel differs from the tab"}
            </Chip>
          )}
          <button type="button" className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-primary hover:underline"
            aria-expanded={open} onClick={() => setOpen(!open)} data-testid="document-check-toggle">
            Details
            <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden="true" />
          </button>
        </div>
      </div>

      {failure && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 px-2.5 py-1.5" role="alert"
          data-testid="processing-failure">
          <span className="font-semibold text-danger">{FAILURE_REASONS[failure.reason] ?? "Processing failed"}:</span>{" "}
          <span className="text-foreground">{failure.message}</span>
          {failure.retry_count > 0 && <span className="text-text-secondary">(retried {failure.retry_count}×)</span>}
          {failure.retryable && (
            <button type="button" className="btn-secondary ml-auto inline-flex items-center gap-1 px-2 py-0.5 text-xs" disabled={busy}
              data-testid="retry-processing"
              onClick={() => act(async () => {
                await retryJob(failure.job_id);
                setReport(await getDocumentValidation(documentId));
              }, "Retrying — pages and fields already read are reused.")}>
              <RotateCcw className="h-3 w-3" aria-hidden="true" />Retry
            </button>
          )}
        </div>
      )}

      {open && (
        <div className="mt-3 grid gap-4 border-t border-border pt-3 md:grid-cols-2 xl:grid-cols-3" data-testid="document-check-details">
          <Section title="File" testId="details-file">
            <ul>{file.checks.map((c) => <CheckLine key={c.code} label={c.label} status={c.status} detail={c.detail} />)}</ul>
          </Section>

          {classification && (
            <Section title="Document type" testId="details-type">
              <p className="text-foreground">
                {classification.family_label}{classification.subtype ? ` · ${classification.subtype}` : ""}
                <span className="text-text-secondary">
                  {classification.decided ? " — confirmed by a reviewer" : classification.confidence != null ? ` — ${Math.round(classification.confidence * 100)}% confidence` : ""}
                </span>
              </p>
              {classification.evidence[0] && <p className="text-text-secondary">{classification.evidence[0]}</p>}
              {classification.review_required && (
                <p className="mt-1 text-warning">Confidence is too low to rely on: the type isn&apos;t forced. Confirm or change it with the Type tag above.</p>
              )}
              {classification.suggested && (
                <button type="button" className="btn-secondary mt-1.5 px-2 py-0.5 text-xs" disabled={busy} data-testid="confirm-suggested-type"
                  onClick={() => act(async () => {
                    await decideClassification(documentId, {
                      action: "override", family: classification.suggested!.family, apply: true,
                      reason: "Suggested by the document check",
                    });
                    onClassificationChanged?.();
                    setReport(await revalidateDocument(documentId));
                  }, "Type changed; the document was revalidated.")}>
                  Use {classification.suggested.family_label ?? classification.suggested.family}
                  {classification.suggested.score != null ? ` (${Math.round(classification.suggested.score * 100)}%)` : ""}
                </button>
              )}
              {report.entities.contracts.length > 1 && (
                <p className="mt-1 text-warning" data-testid="multiple-contracts">
                  {report.entities.contracts.length} contracts in this document: {report.entities.contracts.slice(0, 4).join(", ")}
                </p>
              )}
            </Section>
          )}

          {completeness && (
            <Section title="Extraction completeness" testId="details-completeness">
              <ul>
                {(coverage.length ? coverage : completeness.measures).map((m) => (
                  <CheckLine key={m.key} label={m.source != null ? `${m.label}: ${m.represented} of ${m.source}` : m.label}
                    status={m.status} detail={m.detail} />
                ))}
              </ul>
              {completeness.gaps.flatMap((g) => g.missing.slice(0, 3).map((item, i) => (
                <p key={`${g.key}-${i}`} className="pl-[5.5rem] text-text-secondary">
                  Not represented: {Object.entries(item).map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(" | ") : String(v)}`).join(", ")}
                </p>
              )))}
              {completeness.review.length > 0 && (
                <ul className="mt-1">{completeness.review.map((r) => <CheckLine key={r.key} label={`${r.count} ${r.message.toLowerCase()}`} status="warning" />)}</ul>
              )}
            </Section>
          )}

          {labels && (
            <Section title="Labels and values" testId="details-labels">
              <p className="text-foreground">{labels.resolved} of {labels.total} values have a readable label
                {labels.rewritten_count ? `; ${labels.rewritten_count} shown in a cleaner form (the printed wording is kept)` : ""}.</p>
              {labels.rewritten.slice(0, 4).map((l) => (
                <p key={l.record_key ?? l.printed} className="text-text-secondary">
                  “{l.printed}” → <span className="text-foreground">{l.item_number ? `${l.item_number} · ` : ""}{l.display}</span>
                </p>
              ))}
              {labels.unresolved.slice(0, 4).map((l) => (
                <p key={l.record_key ?? l.printed} className="text-warning">No readable label: “{l.printed || "—"}” = {l.value || "—"}{l.page ? ` (page ${l.page})` : ""}</p>
              ))}
              {association && association.needs_review.length > 0 && (
                <div className="mt-1" data-testid="association-review">
                  {association.needs_review.slice(0, 4).map((f) => (
                    <p key={f.key} className="text-warning">
                      {f.label}: needs review — {f.issues[0] ?? "uncertain which value belongs here"}
                      {f.candidates.length ? ` (candidates: ${f.candidates.join(", ")})` : ""}
                    </p>
                  ))}
                </div>
              )}
              {association && association.issue_count > 0 && (
                <p className="mt-1 text-text-secondary">{association.issue_count} possible wrong-box reading{association.issue_count === 1 ? "" : "s"} — see the Validation tab.</p>
              )}
            </Section>
          )}

          {consistency && (
            <Section title="Original File and Excel" testId="details-consistency">
              <ul>{consistency.checks.map((c) => <CheckLine key={c.key} label={c.label} status={c.status}
                detail={c.status === "inconsistent" && c.examples[0] ? JSON.stringify(c.examples[0]) : undefined} />)}</ul>
            </Section>
          )}

          {readiness && (
            <Section title="Oracle mapping readiness" testId="details-readiness">
              <ul>{readiness.checks.map((c) => <CheckLine key={c.key} label={c.label} status={c.status} detail={c.detail} />)}</ul>
              <p className="mt-1 text-text-muted">{readiness.note} Mapping stays open while fields are in review.</p>
            </Section>
          )}

          <div className="flex flex-wrap items-center gap-2 md:col-span-2 xl:col-span-3">
            <button type="button" className="btn-secondary px-2 py-0.5 text-xs" disabled={busy} data-testid="revalidate"
              onClick={() => act(async () => setReport(await revalidateDocument(documentId)), "Validated again.")}>
              Validate again
            </button>
            <button type="button" className="btn-secondary px-2 py-0.5 text-xs" disabled={busy}
              onClick={() => act(async () => setReport(await revalidateDocument(documentId, ["file", "all"])), "File checked again.")}>
              Check the file again
            </button>
            {report.timings_ms.total_ms != null && (
              <span className="text-text-muted">Checked in {(report.timings_ms.total_ms / 1000).toFixed(1)} s</span>
            )}
          </div>
        </div>
      )}
      {notice && <p className="mt-1.5 text-text-secondary" role="status">{notice}</p>}
    </section>
  );
}
