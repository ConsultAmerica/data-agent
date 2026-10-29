"use client";

import { AlertTriangle, CheckCircle2, CircleDashed, CircleSlash, ShieldCheck, XCircle } from "lucide-react";

import type { StagingCell, StagingRecord } from "@/lib/staging-workbook";

/**
 * Review signals kept apart, never merged into one "confidence":
 *
 * - Evidence check: the platform found the value on the page (staging's
 *   Verified / Needs Review / Missing) — automatic, not a person.
 * - Validation: the field's checks passed / failed / weren't run.
 * - Model confidence: only when the extraction reported one (OCR
 *   confidence today); otherwise "Not provided" — never a made-up number.
 * - Human review: a person's decision. Staging records don't carry one;
 *   approvals happen in Metadata review.
 */

export type EvidenceStatus = "verified" | "needs_review" | "not_extracted" | "unknown";

const EVIDENCE: Record<EvidenceStatus, { label: string; tone: string; Icon: typeof CheckCircle2 }> = {
  verified: { label: "Evidence verified", tone: "bg-success/10 text-success", Icon: ShieldCheck },
  needs_review: { label: "Needs review", tone: "bg-warning/10 text-warning", Icon: AlertTriangle },
  not_extracted: { label: "Not extracted", tone: "bg-surface-soft text-text-muted", Icon: CircleSlash },
  unknown: { label: "Not checked", tone: "bg-surface-soft text-text-secondary", Icon: CircleDashed },
};

export function evidenceStatus(status: string | null | undefined): EvidenceStatus {
  if (status === "Verified") return "verified";
  if (status === "Needs Review") return "needs_review";
  if (status === "Missing") return "not_extracted";
  return "unknown";
}

/** Compact badge for a record's evidence check (icon + text, not color alone). */
export function EvidenceBadge({ status }: { status: string | null | undefined }) {
  const { label, tone, Icon } = EVIDENCE[evidenceStatus(status)];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[11px] font-medium ${tone}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}

export function validationOf(cells: StagingCell[]): "passed" | "failed" | "not_checked" {
  if (cells.some((c) => c.validation?.status === "failed")) return "failed";
  if (cells.some((c) => c.validation?.status === "passed")) return "passed";
  return "not_checked";
}

export function modelConfidence(cells: StagingCell[]): number | null {
  const values = cells.map((c) => c.provenance?.ocr_confidence).filter((v): v is number => typeof v === "number");
  return values.length ? Math.min(...values) : null;
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <dt className="text-xs text-text-secondary">{label}</dt>
      <dd className="text-right text-xs">{children}</dd>
    </div>
  );
}

/** The four signals for one record, each with its own wording. */
export function ReviewSignals({ record }: { record: StagingRecord }) {
  const cells = Object.values(record.cells);
  const validation = validationOf(cells);
  const confidence = modelConfidence(cells);
  const failed = cells.flatMap((c) => (c.validation?.checks ?? []).filter((k) => !k.passed).map((k) => `${c.display_label}: ${k.message ?? k.check}`));
  return (
    <div data-testid="review-signals">
      <dl className="divide-y divide-border/60">
        <Line label="Evidence check"><EvidenceBadge status={record.record_status} /></Line>
        <Line label="Validation">
          {validation === "failed" ? (
            <span className="inline-flex items-center gap-1 font-medium text-danger"><XCircle className="h-3 w-3" aria-hidden="true" />Validation failed</span>
          ) : validation === "passed" ? (
            <span className="inline-flex items-center gap-1 font-medium text-success"><CheckCircle2 className="h-3 w-3" aria-hidden="true" />Passed</span>
          ) : (
            <span className="text-text-muted">Not checked</span>
          )}
        </Line>
        <Line label="Model confidence">
          {confidence == null ? <span className="text-text-muted">Not provided by the extraction</span> : <span className="font-medium">{Math.round(confidence * (confidence <= 1 ? 100 : 1))}% (OCR)</span>}
        </Line>
        <Line label="Human review"><span className="text-text-muted">Not reviewed</span></Line>
      </dl>
      {failed.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-danger">{failed.slice(0, 6).map((f) => <li key={f}>{f}</li>)}</ul>
      )}
      {record.cells && Object.values(record.cells).some((c) => c.review_reasons?.length) && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-warning">
          {Object.values(record.cells).flatMap((c) => c.review_reasons.map((r) => `${c.display_label}: ${r}`)).slice(0, 6).map((r) => <li key={r}>{r}</li>)}
        </ul>
      )}
      <p className="mt-1.5 text-[10px] text-text-muted">
        “Evidence verified” is an automatic check that the value is on the page — it is not a person&apos;s approval.
      </p>
    </div>
  );
}
