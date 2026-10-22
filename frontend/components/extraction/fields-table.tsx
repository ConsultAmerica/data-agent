"use client";

import { Check, CheckCircle2, ChevronDown, ChevronRight, Eye, Pencil, ShieldCheck, X, XCircle } from "lucide-react";
import { useEffect, useState } from "react";

import type { FieldRow } from "@/components/extraction/field-row";
import IntelligenceTrace from "@/components/extraction/intelligence-trace";
import FieldToneLegend from "@/components/ui/field-tone-legend";
import type { SourceViewRequest } from "@/components/source-verification-panel";
import { fieldToneClass, toneFromConfidence } from "@/lib/field-tone";

interface FieldsTableProps {
  title: string;
  rows: FieldRow[];
  selectedId?: string | null;
  onViewSource?: (request: SourceViewRequest) => void;
  onSaveCorrection?: (row: FieldRow, correctedValue: string) => Promise<void> | void;
  onMarkVerified?: (row: FieldRow) => Promise<void> | void;
  onReject?: (row: FieldRow) => Promise<void> | void;
}

const SNIPPET_MAX_LENGTH = 220;

function evidenceSnippet(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SNIPPET_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, SNIPPET_MAX_LENGTH).trimEnd()}…`;
}

function methodLabel(method: string | null): string {
  switch (method) {
    case "form_field":
      return "PDF Form Field";
    case "label_value":
      return "Label / Value";
    case "regex":
      return "Pattern Match";
    case "table":
      return "Table";
    case "ai":
      return "AI Fallback";
    case null:
      return "—";
    default:
      return method;
  }
}

const CONFIDENCE_BAND_STYLES: Record<string, string> = {
  high: "bg-success/10 text-success",
  medium: "bg-warning/10 text-warning",
  low: "bg-danger/10 text-danger",
};

function ConfidenceTag({ row }: { row: FieldRow }) {
  if (row.confidence == null || row.confidence_band == null) {
    return <span className="text-text-muted">—</span>;
  }
  const style = CONFIDENCE_BAND_STYLES[row.confidence_band] ?? CONFIDENCE_BAND_STYLES.medium;
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold uppercase ${style}`}
    >
      {row.confidence_band} {row.confidence.toFixed(2)}
    </span>
  );
}

/** Whether a correction exists that changed the value (as opposed to a
 * pure "mark verified" action, which leaves the value untouched). */
function isEditCorrection(row: FieldRow): boolean {
  return Boolean(row.correction) && row.correction!.action !== "verify";
}

function isHumanVerified(row: FieldRow): boolean {
  return row.correction?.action === "verify";
}

function isRejected(row: FieldRow): boolean {
  return row.correction?.action === "reject";
}

function reviewReasonLabels(row: FieldRow): string[] {
  const reasons = row.scalar?.review_decision?.reasons;
  if (!reasons?.length) return [];
  const labels: Record<string, string> = {
    low_confidence: "Low confidence",
    validation_failed: "Validation failed",
    not_source_grounded: "Not source-grounded",
    ambiguous_candidates: "Ambiguous candidates",
    ai_escalation: "AI escalation",
    unresolved_or_weak_method: "Weak extraction method",
    extraction_differs_from_reviewed: "New extraction differs from reviewed value",
  };
  return reasons.map((reason) => labels[reason] ?? reason);
}

function displayValue(row: FieldRow): string {
  const current = isEditCorrection(row) ? row.correction!.corrected_value : row.value;
  if (row.status === "not_found") return "";
  if (current === null || current === undefined || current === "") return "";
  return String(current);
}

function ValidationDetail({ row }: { row: FieldRow }) {
  if (isHumanVerified(row)) {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-sm text-success">
        <ShieldCheck className="h-4 w-4" />
        Verified by reviewer
      </p>
    );
  }
  if (row.status === "not_found") {
    return <p className="mt-1 text-sm text-text-secondary">Not found in this document.</p>;
  }
  if (row.status === "empty") {
    return <p className="mt-1 text-sm text-text-secondary">Resolved with no captured value.</p>;
  }

  const structured = row.scalar?.validation;
  if (structured) {
    const failed = structured.checks.filter((check) => check.status === "failed");
    if (structured.status === "passed") {
      return (
        <p className="mt-1 flex items-center gap-1.5 text-sm text-success">
          <CheckCircle2 className="h-4 w-4" />
          Validation passed ({structured.checks.length} checks)
        </p>
      );
    }
    return (
      <p className="mt-1 flex items-center gap-1.5 text-sm text-warning">
        <span aria-hidden>⚠</span>
        {failed.length
          ? `Failed: ${failed.map((check) => check.type.replace(/_/g, " ")).join(", ")}`
          : "Validation incomplete"}
      </p>
    );
  }

  if (!row.verified) {
    return (
      <p className="mt-1 flex items-center gap-1.5 text-sm text-warning">
        <span aria-hidden>⚠</span>
        Could not confirm this value against the source text.
      </p>
    );
  }
  return (
    <p className="mt-1 flex items-center gap-1.5 text-sm text-success">
      <CheckCircle2 className="h-4 w-4" />
      Format valid
    </p>
  );
}

function FieldCard({
  row,
  selected,
  expanded,
  onToggleExpand,
  onViewSource,
  onSaveCorrection,
  onMarkVerified,
  onReject,
}: {
  row: FieldRow;
  selected: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onViewSource?: (request: SourceViewRequest) => void;
  onSaveCorrection?: (row: FieldRow, correctedValue: string) => Promise<void> | void;
  onMarkVerified?: (row: FieldRow) => Promise<void> | void;
  onReject?: (row: FieldRow) => Promise<void> | void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayValue(row));
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const value = displayValue(row);
  const canEdit = Boolean(onSaveCorrection) && row.status !== "not_found";
  const canVerify = Boolean(onMarkVerified) && row.status !== "not_found";
  const canReject = Boolean(onReject) && row.status !== "not_found";
  const highlighted = selected || expanded;
  const reasonLabels = reviewReasonLabels(row);

  async function handleSave() {
    if (!onSaveCorrection) return;
    setSaving(true);
    try {
      await onSaveCorrection(row, draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleMarkVerified() {
    if (!onMarkVerified) return;
    setVerifying(true);
    try {
      await onMarkVerified(row);
    } finally {
      setVerifying(false);
    }
  }

  async function handleReject() {
    if (!onReject) return;
    setRejecting(true);
    try {
      await onReject(row);
    } finally {
      setRejecting(false);
    }
  }

  function handleViewSourceClick(event: React.MouseEvent) {
    event.stopPropagation();
    if (!onViewSource || !row.evidence) return;
    onViewSource({
      id: row.id,
      pageNumber: row.evidence.page_number,
      highlightText: row.evidence.source_text || value,
      label: row.label,
      value,
      confidence: row.confidence ?? 0,
      verified: row.verified,
    });
  }

  return (
    <div
      id={`field-row-${row.id}`}
      className={[
        "scroll-mt-32 border-b border-border last:border-0",
        highlighted ? "bg-primary/5" : "",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={onToggleExpand}
        className="flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-surface-soft sm:px-4"
      >
        {expanded ? (
          <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />
        ) : (
          <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />
        )}

        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            {row.label}
          </p>
          {value ? (
            <p className="mt-0.5 truncate text-sm font-medium text-foreground">
              <span
                className={fieldToneClass(
                  toneFromConfidence(row.confidence, row.confidence_band, row.status === "validation_failed"),
                )}
              >
                {value}
              </span>
            </p>
          ) : (
            <p className="mt-0.5 text-sm italic text-text-muted">
              {row.status === "not_found" ? "Not found in document" : "No value captured"}
            </p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-text-secondary">
            <ConfidenceTag row={row} />
            {row.evidence && (
              <>
                <span>·</span>
                <span>{row.display_method || methodLabel(row.extraction_method)}</span>
                <span>·</span>
                <span>Page {row.evidence.page_number}</span>
              </>
            )}
            {isHumanVerified(row) && (
              <span className="inline-flex items-center gap-0.5 text-success">
                <ShieldCheck className="h-3 w-3" />
                Verified
              </span>
            )}
            {isRejected(row) && (
              <span className="inline-flex items-center gap-0.5 text-danger">
                <XCircle className="h-3 w-3" />
                Rejected
              </span>
            )}
            {reasonLabels.length > 0 && !isHumanVerified(row) && !isRejected(row) && (
              <span className="text-warning">· Needs review</span>
            )}
            {isEditCorrection(row) && (
              <span
                title={`Corrected from "${String(row.correction!.original_value ?? "")}"`}
                className="inline-flex items-center gap-0.5 text-primary"
              >
                <Pencil className="h-3 w-3" />
                Edited
              </span>
            )}
            {row.scalar?.retrieval?.ai_fallback_required && (
              <span className="text-warning">· AI escalated</span>
            )}
            {row.scalar?.retrieval &&
              row.scalar.retrieval.selected_pages.length > 0 &&
              !row.evidence && (
                <span>
                  · Pages {row.scalar.retrieval.selected_pages.slice(0, 3).join(", ")}
                </span>
              )}
          </div>
        </div>

        {row.evidence && onViewSource && (
          <span
            role="button"
            tabIndex={0}
            onClick={handleViewSourceClick}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") handleViewSourceClick(event as never);
            }}
            className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-text-teal hover:text-primary"
          >
            <Eye className="h-3 w-3" />
            View Source
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-border bg-surface-soft/60 px-3 py-3 sm:px-4">
          {row.evidence?.source_text && (
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                Source evidence
              </p>
              <p className="mt-1 text-sm leading-6 text-foreground">
                &ldquo;{evidenceSnippet(row.evidence.source_text)}&rdquo;
              </p>
            </div>
          )}

          <div className="mt-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
              Validation
            </p>
            <ValidationDetail row={row} />
          </div>

          {reasonLabels.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                Review routing
              </p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {reasonLabels.map((label) => (
                  <li
                    key={label}
                    className="rounded bg-warning/10 px-1.5 py-0.5 text-xs font-medium text-warning"
                  >
                    {label}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <IntelligenceTrace scalar={row.scalar} />

          {isEditCorrection(row) && (
            <div className="mt-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                Original extraction
              </p>
              <p className="mt-1 text-sm text-text-secondary">
                {String(row.correction!.original_value ?? "") || "—"}
              </p>
            </div>
          )}

          {editing ? (
            <div className="mt-3 flex items-center gap-2">
              <input
                autoFocus
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="w-full min-w-[10rem] rounded-lg border border-primary/40 bg-surface px-2 py-1.5 text-sm outline-none"
              />
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-1 text-xs font-semibold text-success disabled:opacity-60"
              >
                <Check className="h-3.5 w-3.5" />
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDraft(value);
                }}
                disabled={saving}
                className="inline-flex items-center gap-1 text-xs font-semibold text-text-secondary"
              >
                <X className="h-3.5 w-3.5" />
                Cancel
              </button>
            </div>
          ) : (
            (canEdit || canVerify || canReject) && (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => {
                      setDraft(value);
                      setEditing(true);
                    }}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-text-secondary hover:text-primary"
                  >
                    <Pencil className="h-3 w-3" />
                    Edit
                  </button>
                )}
                {canVerify && (
                  <button
                    type="button"
                    onClick={handleMarkVerified}
                    disabled={verifying || isHumanVerified(row)}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-text-secondary hover:text-primary disabled:cursor-default disabled:text-success disabled:opacity-100"
                  >
                    <ShieldCheck className="h-3 w-3" />
                    {isHumanVerified(row) ? "Verified" : verifying ? "Marking…" : "Accept"}
                  </button>
                )}
                {canReject && (
                  <button
                    type="button"
                    onClick={handleReject}
                    disabled={rejecting || isRejected(row)}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-text-secondary hover:text-danger disabled:cursor-default disabled:text-danger disabled:opacity-100"
                  >
                    <XCircle className="h-3 w-3" />
                    {isRejected(row) ? "Rejected" : rejecting ? "Rejecting…" : "Reject"}
                  </button>
                )}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

export default function FieldsTable({
  title,
  rows,
  selectedId = null,
  onViewSource,
  onSaveCorrection,
  onMarkVerified,
  onReject,
}: FieldsTableProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Clicking "View Source" elsewhere selects a result — auto-expand it
  // here too, so the compact detail panel appears alongside the PDF jump.
  useEffect(() => {
    if (selectedId) {
      setExpandedId(selectedId);
      window.setTimeout(() => {
        window.document
          .getElementById(`field-row-${selectedId}`)
          ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }, 50);
    }
  }, [selectedId]);

  if (rows.length === 0) return null;

  return (
    <div className="editorial-card overflow-hidden p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-5 sm:px-6">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <FieldToneLegend />
      </div>
      <div className="mt-3">
        {rows.map((row) => (
          <FieldCard
            key={row.id}
            row={row}
            selected={row.id === selectedId}
            expanded={row.id === expandedId}
            onToggleExpand={() =>
              setExpandedId((current) => (current === row.id ? null : row.id))
            }
            onViewSource={onViewSource}
            onSaveCorrection={onSaveCorrection}
            onMarkVerified={onMarkVerified}
            onReject={onReject}
          />
        ))}
      </div>
    </div>
  );
}
