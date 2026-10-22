"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCheck,
  Download,
  History,
  Lock,
  Pencil,
  ShieldCheck,
  X,
} from "lucide-react";

import PdfPageViewer from "@/components/pdf-page-viewer";
import PayloadInspector from "@/components/sample/payload-inspector";
import { BAND_COPY, type ConfidenceBand } from "@/lib/confidence-policy";
import sample from "@/lib/sample/sample-extraction.json";
import type { PageRender } from "@/types/document";

interface SampleField {
  id: string;
  kind: "field" | "clause";
  label: string;
  value: string | null;
  alternates: string[];
  confidence: number;
  band: ConfidenceBand;
  page: number;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  decision: "needs_review" | "ready_to_accept";
  reasons: string[];
}

type ReviewStatus = "pending" | "accepted" | "edited" | "rejected";

interface Review {
  status: ReviewStatus;
  value: string | null;
}

interface AuditEntry {
  id: number;
  at: Date;
  field: string;
  action: Exclude<ReviewStatus, "pending">;
  previous: string | null;
  next: string | null;
}

const FIELDS = sample.fields as SampleField[];
const PAGES = sample.document.pages;
const PAGE_WIDTH = PAGES[0].width;

const BAND_TONE: Record<ConfidenceBand, string> = {
  high: "text-success border-success/30 bg-success/5",
  medium: "text-text-secondary border-border bg-surface-soft",
  low: "text-warning border-warning/40 bg-warning/10",
};

function displayValue(field: SampleField, review: Review) {
  if (review.value) return review.value;
  if (field.alternates.length > 0) return `${field.alternates.length} candidates`;
  return "No valid value";
}

export default function SampleContractViewer() {
  const [selectedId, setSelectedId] = useState(
    () => (FIELDS.find((f) => f.decision === "needs_review") ?? FIELDS[0]).id,
  );
  const [reviews, setReviews] = useState<Record<string, Review>>(() =>
    Object.fromEntries(
      FIELDS.map((f) => [f.id, { status: "pending", value: f.value }]),
    ),
  );
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [zoom, setZoom] = useState(1);
  const [dryRun, setDryRun] = useState(false);
  const [payloadOpen, setPayloadOpen] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);

  // Fit the page to its column; the viewer pads 16px on each side.
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width - 32;
      setZoom(Math.max(0.4, Math.min(1.25, width / PAGE_WIDTH)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const selected = FIELDS.find((f) => f.id === selectedId) ?? FIELDS[0];
  const page = PAGES.find((p) => p.page_number === selected.page) ?? PAGES[0];
  const render: PageRender = {
    page_number: page.page_number,
    image_data_url: page.image,
    page_width: page.width,
    page_height: page.height,
    highlight: selected.bbox,
  };

  const pendingReview = FIELDS.filter(
    (f) => f.decision === "needs_review" && reviews[f.id].status === "pending",
  );
  const pendingReady = FIELDS.filter(
    (f) => f.decision === "ready_to_accept" && reviews[f.id].status === "pending",
  );
  const decided = FIELDS.length - pendingReview.length - pendingReady.length;
  const exportable = FIELDS.filter((f) =>
    ["accepted", "edited"].includes(reviews[f.id].status),
  ).length;

  const groups = useMemo(
    () => [
      {
        title: "Needs review",
        fields: FIELDS.filter((f) => f.decision === "needs_review"),
      },
      {
        title: "Ready to accept",
        fields: FIELDS.filter((f) => f.decision === "ready_to_accept"),
      },
    ],
    [],
  );

  function decide(
    fieldIds: string[],
    action: AuditEntry["action"],
    nextValue?: string,
  ) {
    const now = new Date();
    const entries: AuditEntry[] = fieldIds.map((id, i) => {
      const field = FIELDS.find((f) => f.id === id)!;
      return {
        id: now.getTime() + i,
        at: now,
        field: field.label,
        action,
        previous: reviews[id].value,
        next: action === "rejected" ? null : (nextValue ?? reviews[id].value),
      };
    });
    setReviews((current) => {
      const next = { ...current };
      for (const id of fieldIds) {
        next[id] = {
          status: action,
          value:
            action === "rejected" ? current[id].value : (nextValue ?? current[id].value),
        };
      }
      return next;
    });
    setAudit((current) => [...entries.reverse(), ...current]);
    setDraft("");
    setDryRun(false);
  }

  const review = reviews[selected.id];

  /** The gate's way forward: open the next field that still needs a decision. */
  function reviewNext() {
    const next = pendingReview.find((field) => field.id !== selected.id) ?? pendingReview[0];
    if (!next) return;
    setSelectedId(next.id);
    setDraft("");
    document
      .getElementById(`sample-field-${next.id}`)
      ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  return (
    <div className="space-y-6">
      <div className="editorial-card flex flex-wrap items-center justify-between gap-4 p-4">
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">
            {sample.document.name}
          </p>
          <p className="mt-0.5 text-xs text-text-secondary">
            Specimen with fictional data · {PAGES.length} pages · {FIELDS.length}{" "}
            values extracted by the deterministic pipeline, no LLM
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 font-medium text-warning">
            {pendingReview.length} need review
          </span>
          <span className="rounded-full border border-border px-2.5 py-1 font-medium text-text-secondary">
            {pendingReady.length} ready to accept
          </span>
          <span className="rounded-full border border-success/30 px-2.5 py-1 font-medium text-success">
            {decided} decided
          </span>
          <a
            href={sample.document.pdf}
            download
            className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
          >
            <Download className="h-3.5 w-3.5" />
            PDF
          </a>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* Values on the left */}
        <div className="editorial-card flex h-[34rem] min-h-0 flex-col overflow-hidden lg:h-[46rem]">
          <div className="min-h-0 flex-1 overflow-y-auto">
            {groups.map((group) => (
              <div key={group.title}>
                <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface-soft px-4 py-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                    {group.title}
                  </p>
                  {group.title === "Ready to accept" && pendingReady.length > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        decide(
                          pendingReady.map((f) => f.id),
                          "accepted",
                        )
                      }
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                    >
                      <CheckCheck className="h-3.5 w-3.5" />
                      Accept all {pendingReady.length}
                    </button>
                  )}
                </div>
                <ul>
                  {group.fields.map((field) => {
                    const r = reviews[field.id];
                    const isSelected = field.id === selected.id;
                    return (
                      <li key={field.id} className="border-b border-border/70">
                        <button
                          type="button"
                          id={`sample-field-${field.id}`}
                          onClick={() => {
                            setSelectedId(field.id);
                            setDraft("");
                          }}
                          aria-pressed={isSelected}
                          className={[
                            "grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 text-left transition-colors",
                            isSelected
                              ? "bg-primary/8 shadow-[inset_3px_0_0_var(--primary)]"
                              : "hover:bg-surface-soft",
                          ].join(" ")}
                        >
                          <span className="truncate text-[11px] uppercase tracking-wide text-text-muted">
                            {field.label}
                          </span>
                          <span
                            className={`row-span-2 self-center rounded-full border px-2 py-0.5 text-[11px] font-semibold tabular-nums ${BAND_TONE[field.band]}`}
                          >
                            {Math.round(field.confidence * 100)}%
                          </span>
                          <span className="flex min-w-0 items-center gap-2">
                            <span
                              className={[
                                "truncate text-sm font-medium",
                                r.status === "rejected"
                                  ? "text-text-muted line-through"
                                  : "text-foreground",
                              ].join(" ")}
                            >
                              {displayValue(field, r)}
                            </span>
                            <StatusTag status={r.status} />
                          </span>
                          {field.reasons.length > 0 && r.status === "pending" && (
                            <span className="col-span-2 flex flex-wrap gap-1">
                              {field.reasons.map((reason) => (
                                <span
                                  key={reason}
                                  className="rounded bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning"
                                >
                                  {reason}
                                </span>
                              ))}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>

          {/* Review controls for the selected field */}
          <div className="border-t border-border bg-surface p-4">
            <p className="text-xs text-text-secondary">
              <span className="font-semibold text-foreground">{selected.label}</span>{" "}
              · page {selected.page} · {BAND_COPY[selected.band].label} band:{" "}
              {BAND_COPY[selected.band].outcome}
            </p>
            {review.status === "pending" ? (
              <div className="mt-3 space-y-2">
                {selected.alternates.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {selected.alternates.map((alt) => (
                      <button
                        key={alt}
                        type="button"
                        onClick={() => decide([selected.id], "edited", alt)}
                        className="btn-secondary px-3 py-1.5 text-xs"
                      >
                        Use “{alt}”
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {selected.value && (
                    <button
                      type="button"
                      onClick={() => decide([selected.id], "accepted")}
                      className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
                    >
                      <Check className="h-3.5 w-3.5" />
                      Accept
                    </button>
                  )}
                  <form
                    className="flex min-w-[12rem] flex-1 gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (draft.trim()) decide([selected.id], "edited", draft.trim());
                    }}
                  >
                    <input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder="Correct the value…"
                      aria-label={`Corrected value for ${selected.label}`}
                      className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-foreground"
                    />
                    <button
                      type="submit"
                      disabled={!draft.trim()}
                      className="btn-secondary inline-flex items-center gap-1 px-3 py-1.5 text-xs disabled:opacity-50"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </button>
                  </form>
                  <button
                    type="button"
                    onClick={() => decide([selected.id], "rejected")}
                    className="btn-secondary inline-flex items-center gap-1 px-3 py-1.5 text-xs"
                  >
                    <X className="h-3.5 w-3.5" />
                    Reject
                  </button>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-xs text-text-secondary">
                Decision recorded. See the audit trail below.
              </p>
            )}
          </div>
        </div>

        {/* Source page on the right */}
        <div
          ref={pageRef}
          className="editorial-card h-[30rem] overflow-hidden sm:h-[40rem] lg:h-[46rem]"
        >
          <PdfPageViewer render={render} loading={false} error="" zoom={zoom} />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section className="editorial-card p-5">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-primary" />
            <h2 className="font-medium text-foreground">Audit trail</h2>
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            In the workspace every decision is written to an append-only log
            with the reviewer&apos;s ID and role, the value before and after,
            and the reason. This sample keeps it in your browser tab only.
          </p>
          {audit.length === 0 ? (
            <p className="mt-4 rounded-lg border border-dashed border-border p-4 text-center text-xs text-text-muted">
              No decisions yet. Resolve a field from the list.
            </p>
          ) : (
            <ol className="mt-4 max-h-64 space-y-2 overflow-y-auto">
              {audit.map((entry) => (
                <li
                  key={entry.id}
                  className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 rounded-lg bg-surface-soft px-3 py-2 text-xs"
                >
                  <span className="tabular-nums text-text-muted">
                    {entry.at.toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">
                      Sample reviewer
                    </span>{" "}
                    <span className="text-text-secondary">{entry.action}</span>{" "}
                    <span className="font-medium text-foreground">{entry.field}</span>
                    {entry.action === "edited" && (
                      <span className="block truncate text-text-secondary">
                        {entry.previous ?? "∅"} → {entry.next}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="editorial-card p-5">
          <div className="flex items-center gap-2">
            {pendingReview.length > 0 ? (
              <Lock className="h-4 w-4 text-warning" />
            ) : (
              <ShieldCheck className="h-4 w-4 text-success" />
            )}
            <h2 className="font-medium text-foreground">Oracle export gate</h2>
          </div>
          {pendingReview.length > 0 ? (
            <p className="mt-2 flex items-start gap-2 text-xs text-text-secondary">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              Blocked: {pendingReview.length} field
              {pendingReview.length === 1 ? "" : "s"} still need a reviewer.
              Pending values are never exported.
            </p>
          ) : (
            <p className="mt-2 text-xs text-text-secondary">
              Review complete. {exportable} accepted or corrected value
              {exportable === 1 ? "" : "s"} can stage for export; rejected and
              pending values are skipped.
            </p>
          )}
          {pendingReview.length > 0 ? (
            <>
              <button
                type="button"
                onClick={reviewNext}
                className="btn-primary mt-4 w-full justify-center text-sm"
              >
                Review next: {(pendingReview.find((f) => f.id !== selected.id) ?? pendingReview[0]).label}
                <ArrowRight className="h-4 w-4" />
              </button>
              <p className="mt-2 text-center text-[11px] text-text-muted">
                The dry run unlocks when no field is waiting for a reviewer.
              </p>
            </>
          ) : (
            <button
              type="button"
              onClick={() => {
                setDryRun(true);
                setPayloadOpen(true);
              }}
              className="btn-primary mt-4 w-full justify-center text-sm"
            >
              Run dry-run preview
            </button>
          )}
          {dryRun && (
            <p className="mt-3 rounded-lg bg-success/10 p-3 text-xs text-success">
              Dry run passed: {exportable} values staged,{" "}
              {FIELDS.length - exportable} skipped. Nothing was sent. Live sends
              stay off until an administrator enables them.
            </p>
          )}
          <PayloadInspector
            documentName={sample.document.name}
            open={payloadOpen}
            onToggle={setPayloadOpen}
            fields={FIELDS.map((field) => ({
              id: field.id,
              label: field.label,
              value: reviews[field.id].value,
              confidence: field.confidence,
              page: field.page,
              bbox: field.bbox,
              status: reviews[field.id].status,
            }))}
          />
        </section>
      </div>
    </div>
  );
}

function StatusTag({ status }: { status: ReviewStatus }) {
  if (status === "pending") return null;
  const tone =
    status === "rejected"
      ? "bg-danger/10 text-danger"
      : "bg-success/10 text-success";
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold capitalize ${tone}`}
    >
      {status}
    </span>
  );
}
