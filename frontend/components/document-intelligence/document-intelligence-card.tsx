"use client";

import { AlertTriangle, CalendarClock, ChevronDown, ChevronRight, Crosshair } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import ClassificationTag from "@/components/classification/classification-tag";
import LifecycleBadge from "@/components/document-intelligence/lifecycle-badge";
import type { SourceViewRequest } from "@/components/source-verification-panel";
import {
  DATE_SOURCE_LABELS,
  DATE_TYPE_LABELS,
  formatCalendarDate,
  getDocumentIntelligence,
  WARNING_PERIODS,
  type DateCandidate,
  type DocumentIntelligence,
} from "@/lib/document-intelligence";

const formatDate = formatCalendarDate;

/** One date: the value used (normalized when unambiguous), what the
 * document printed, where it came from, and a jump to its evidence. */
function DateRow({ label, value, onViewSource }: { label: string; value: DateCandidate | null; onViewSource?: (request: SourceViewRequest) => void }) {
  if (!value) {
    return (
      <div className="grid grid-cols-[7.5rem_1fr] gap-2 py-0.5 text-xs">
        <dt className="text-text-secondary">{label}</dt>
        <dd className="text-text-muted">Not stated</dd>
      </div>
    );
  }
  const ambiguous = value.validation_status === "ambiguous";
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 py-0.5 text-xs" data-testid="intelligence-date">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="min-w-0">
        <span className={`font-medium ${ambiguous ? "text-warning" : "text-foreground"}`}>
          {value.normalized_date ? formatDate(value.normalized_date) : `“${value.original_text ?? "?"}” (ambiguous)`}
        </span>
        {value.review_status === "approved" && <span className="ml-1.5 rounded bg-success/10 px-1 text-[10px] text-success">Approved</span>}
        <span className="block text-[11px] text-text-muted">
          {value.original_text && value.normalized_date && `Printed “${value.original_text}” · `}
          {DATE_SOURCE_LABELS[value.source] ?? value.source}
          {value.page ? ` · p. ${value.page}` : ""}
          {value.option_period ? " · option period" : ""}
        </span>
        {ambiguous && value.interpretations.length > 0 && (
          <span className="block text-[11px] text-warning">Could be {value.interpretations.map(formatDate).join(" or ")}</span>
        )}
        {value.page && onViewSource && (
          <button type="button" className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
            onClick={() => onViewSource({ pageNumber: value.page!, highlightText: value.original_text, label, value: value.original_text ?? undefined, evidenceText: value.evidence_text })}>
            <Crosshair className="h-3 w-3" aria-hidden="true" />View in source
          </button>
        )}
      </dd>
    </div>
  );
}

/**
 * Document intelligence: what the document is (category, type, evidence,
 * whether a person must confirm it), its lifecycle dates with their
 * evidence, and its lifecycle status. Extracted and approved dates are
 * labelled apart; nothing is inferred.
 */
export default function DocumentIntelligenceCard({
  documentId,
  onViewSource,
}: {
  documentId: string;
  onViewSource?: (request: SourceViewRequest) => void;
}) {
  const [data, setData] = useState<DocumentIntelligence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [warningDays, setWarningDays] = useState<number>(30);
  const [showAll, setShowAll] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let active = true;
    getDocumentIntelligence(documentId, warningDays)
      .then((loaded) => active && (setData(loaded), setError(null)))
      .catch((failure: unknown) => active && setError(failure instanceof Error ? failure.message : "Document intelligence is unavailable."));
    return () => {
      active = false;
    };
  }, [documentId, warningDays, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);

  if (error) return <p className="text-xs text-text-muted" data-testid="document-intelligence">{error}</p>;
  if (!data) return <p className="text-xs text-text-muted" data-testid="document-intelligence">Loading document intelligence…</p>;

  const { classification: c, lifecycle, lifecycle_dates: dates } = data;
  return (
    <section className="space-y-3" data-testid="document-intelligence" aria-label="Document intelligence">
      <div>
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Document intelligence</p>
        <p className="text-xs">
          <span className="font-medium text-foreground">{c.category_label}</span>
          <span className="text-text-muted"> / </span>
          <span className="text-foreground">{c.document_type_label}{c.subtype ? ` — ${c.subtype}` : ""}</span>
        </p>
        <p className="mt-0.5 text-[11px] text-text-secondary">
          {c.decided ? `Confirmed${c.decided_by ? ` by ${c.decided_by}` : ""}` : `Detected · confidence ${c.confidence_level}`}
          {" · "}{c.method} · {c.engine_version} · {data.file_format.toUpperCase()}
        </p>
        {c.secondary_categories.length > 0 && <p className="text-[11px] text-text-muted">Also resembles: {c.secondary_categories.join(", ")}</p>}
        {c.evidence.length > 0 && (
          <button type="button" onClick={() => setShowEvidence((v) => !v)} aria-expanded={showEvidence} className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline">
            {showEvidence ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}Why this type ({c.evidence.length})
          </button>
        )}
        {showEvidence && <ul className="mt-0.5 list-disc pl-4 text-[11px] text-text-secondary">{c.evidence.map((e) => <li key={e}>{e}</li>)}</ul>}
        <div className="mt-1">
          <ClassificationTag documentId={documentId} className="text-[11px]" onChanged={reload} />
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            <CalendarClock className="h-3 w-3" aria-hidden="true" />Lifecycle
          </p>
          <label className="flex items-center gap-1 text-[11px] text-text-secondary">
            Warn
            <select value={warningDays} onChange={(e) => setWarningDays(Number(e.target.value))} aria-label="Expiring-soon warning period" className="rounded border border-border bg-background px-1 py-0.5 text-[11px]">
              {WARNING_PERIODS.map((d) => <option key={d} value={d}>{d} days</option>)}
            </select>
          </label>
        </div>
        <p className="flex flex-wrap items-center gap-1.5 text-xs">
          <LifecycleBadge status={lifecycle.status} />
          {lifecycle.days_remaining != null && lifecycle.status !== "not_applicable" && (
            <span className="text-text-secondary">{lifecycle.days_remaining >= 0 ? `${lifecycle.days_remaining} days left` : `${-lifecycle.days_remaining} days ago`}</span>
          )}
        </p>
        <ul className="mt-1 space-y-0.5 text-[11px] text-text-secondary">{lifecycle.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
        <dl className="mt-1.5 divide-y divide-border/60">
          <DateRow label="Start / effective" value={dates.start} onViewSource={onViewSource} />
          <DateRow label="Expiration" value={dates.expiration} onViewSource={onViewSource} />
          {dates.renewal && <DateRow label="Renewal" value={dates.renewal} onViewSource={onViewSource} />}
          {dates.payment_due && <DateRow label="Payment due" value={dates.payment_due} onViewSource={onViewSource} />}
        </dl>
        <p className="mt-1 text-[10px] text-text-muted">Evaluated on {formatDate(lifecycle.evaluated_on)} ({lifecycle.timezone}).</p>
      </div>

      {data.review_required.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-warning/30 bg-warning/10 p-2 text-[11px] text-text-secondary" data-testid="intelligence-review">
          {data.review_required.map((item) => (
            <li key={item} className="flex gap-1"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" aria-hidden="true" />{item}</li>
          ))}
        </ul>
      )}

      {data.date_candidates.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll} className="inline-flex items-center gap-0.5 text-[11px] text-primary hover:underline">
            {showAll ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}All dates found ({data.date_candidates.length})
          </button>
          {showAll && (
            <dl className="mt-1 divide-y divide-border/60" data-testid="intelligence-all-dates">
              {data.date_candidates.map((d, i) => (
                <DateRow key={`${d.date_type}-${d.source}-${i}`} label={DATE_TYPE_LABELS[d.date_type] ?? d.date_type} value={d} onViewSource={onViewSource} />
              ))}
            </dl>
          )}
        </div>
      )}
    </section>
  );
}
