"use client";

import { Check, ChevronDown, ChevronRight, Crosshair, History, Pencil, X } from "lucide-react";
import { memo, useEffect, useState } from "react";

import { TriCheckbox } from "@/components/original-structure/original-structure-view";
import { getRecordHistory, reviewStructureRecords, type RecordHistoryEntry, type StructureAction } from "@/lib/original-structure";
import { layoutId } from "@/lib/record-selection";
import type { BusinessField } from "@/lib/verification";

export type Density = "comfortable" | "compact";

export const VALIDATION_CHIP: Record<string, { label: string; tone: string }> = {
  passed: { label: "Valid", tone: "bg-success/10 text-success" },
  warning: { label: "Check", tone: "bg-warning/10 text-warning" },
  failed: { label: "Invalid", tone: "bg-danger/10 text-danger" },
  missing: { label: "Missing", tone: "bg-danger/10 text-danger" },
  not_found: { label: "Not found", tone: "bg-surface-soft text-text-muted" },
  not_checked: { label: "Not checked", tone: "bg-surface-soft text-text-muted" },
};

export const REVIEW_TONE: Record<string, string> = {
  Approved: "bg-success/10 text-success",
  Corrected: "bg-primary-soft text-primary",
  Rejected: "bg-danger/10 text-danger",
  "Needs review": "bg-danger/10 text-danger",
  Added: "bg-primary-soft text-primary",
};

export function Chip({ children, tone, title }: { children: React.ReactNode; tone: string; title?: string }) {
  return <span title={title} className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{children}</span>;
}

/** Extraction confidence on its own: a number, never a verdict. */
export function ConfidenceChip({ value }: { value: number | null }) {
  if (value == null) return <Chip tone="bg-surface-soft text-text-muted" title="Read from the printed layout; no extraction score">Printed</Chip>;
  const percent = Math.round(value * 100);
  const tone = percent >= 85 ? "bg-success/10 text-success" : percent >= 60 ? "bg-warning/10 text-warning" : "bg-danger/10 text-danger";
  return <Chip tone={tone} title="Extraction confidence (not a review decision)">{percent}%</Chip>;
}

function describe(value: unknown): string {
  if (value == null || value === "") return "(blank)";
  return Array.isArray(value) ? value.join(" · ") : String(value);
}

/** Every decision on one record, loaded when asked for. */
export function RecordHistory({ documentId, recordKey }: { documentId: string; recordKey: string }) {
  const [loaded, setLoaded] = useState<{ key: string; entries: RecordHistoryEntry[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    getRecordHistory(documentId, recordKey)
      .then((result) => active && setLoaded({ key: recordKey, entries: result.entries }))
      .catch((err: unknown) => active && setError(err instanceof Error ? err.message : "History unavailable."));
    return () => {
      active = false;
    };
  }, [documentId, recordKey]);
  const entries = loaded?.key === recordKey ? loaded.entries : null;
  if (error) return <p className="text-danger" role="alert">{error}</p>;
  if (!entries) return <p className="text-text-muted">Loading history…</p>;
  if (entries.length === 0) return <p className="text-text-muted" data-testid="record-history">No review decisions yet.</p>;
  return (
    <ol className="space-y-1" data-testid="record-history">
      {entries.map((entry, index) => (
        <li key={index} className="border-l-2 border-border pl-2">
          <span className="font-medium text-foreground">{entry.new_status ?? entry.action}</span>
          {entry.new_value != null && entry.action !== "accept" && entry.action !== "accepted" && <span className="text-foreground"> → {describe(entry.new_value)}</span>}
          {entry.previous_value != null && <span className="text-text-muted"> (was {describe(entry.previous_value)})</span>}
          <span className="block text-[11px] text-text-muted">
            {[entry.by, entry.at ? new Date(entry.at).toLocaleString() : null, entry.reason].filter(Boolean).join(" · ")}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * One business field: its value with extraction confidence, validation and
 * review shown apart, the page it's printed on, and the actions a reviewer
 * takes on it. A correction keeps the printed value; approving is always an
 * explicit click.
 */
function FieldCardInner({ documentId, field, density, focused, onFocus, onChanged }: {
  documentId: string;
  field: BusinessField;
  density: Density;
  focused: boolean;
  /** Opens the record's details and its source. */
  onFocus: (recordKey: string) => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [value, setValue] = useState(field.value ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // A required field the document doesn't print is missing, not invalid.
  const validation = !field.value && field.required ? VALIDATION_CHIP.missing : VALIDATION_CHIP[field.validation_status] ?? VALIDATION_CHIP.not_checked;
  const issues = field.issues.filter((i) => !["repeating_record", "repeated_in_other_sections"].includes(i.code));
  const flagged = issues.length > 0;
  const key = field.record_key;
  const compact = density === "compact";

  async function act(action: StructureAction) {
    if (!key) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await reviewStructureRecords(documentId, [key], action, action === "correct" ? { value } : {});
      const failed = result.results.find((r) => !r.ok);
      if (failed) setMessage(failed.error ?? "Not saved.");
      else {
        setEditing(false);
        onChanged();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Not saved.");
    } finally {
      setBusy(false);
    }
  }

  const chips = (
    <span className="flex shrink-0 flex-wrap items-center gap-1">
      {field.value && <ConfidenceChip value={field.confidence} />}
      <Chip tone={validation.tone} title="Validation">{validation.label}</Chip>
      {field.review_status && <Chip tone={REVIEW_TONE[field.review_status] ?? "bg-surface-soft text-text-secondary"} title="Review">{field.review_status}</Chip>}
      {field.page != null && <span className="text-[11px] text-text-muted" title="Source page">p. {field.page}</span>}
    </span>
  );

  const actions = key && !editing && (
    <div className="flex flex-wrap gap-1.5">
      <button type="button" onClick={() => onFocus(key)} className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 hover:bg-surface-soft" title="Show the source and details">
        <Crosshair className="h-3 w-3" aria-hidden="true" />View source
      </button>
      <button type="button" disabled={busy} onClick={() => void act("accept")} className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 hover:bg-surface-soft">
        <Check className="h-3 w-3" aria-hidden="true" />Approve
      </button>
      <button type="button" disabled={busy} onClick={() => { setValue(field.value ?? ""); setEditing(true); }} className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 hover:bg-surface-soft">
        <Pencil className="h-3 w-3" aria-hidden="true" />Correct
      </button>
      <button type="button" disabled={busy} onClick={() => void act("reject")} className="rounded-md border border-border px-1.5 py-0.5 text-danger hover:bg-surface-soft">Reject</button>
      <button type="button" onClick={() => { setExpanded(true); setShowHistory((v) => !v); }} aria-pressed={showHistory}
        className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 hover:bg-surface-soft">
        <History className="h-3 w-3" aria-hidden="true" />History
      </button>
    </div>
  );

  const editor = editing && (
    <div className="mt-1.5 flex gap-1">
      <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} aria-label={`Corrected ${field.label}`}
        className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-sm" />
      <button type="button" disabled={busy || !value.trim()} onClick={() => void act("correct")} className="btn-primary px-2 py-1 text-xs">Save</button>
      <button type="button" onClick={() => setEditing(false)} aria-label="Cancel" className="btn-secondary px-1.5 py-1"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
    </div>
  );

  const details = expanded && (
    <div className="mt-2 space-y-1.5 border-t border-border pt-2" data-testid="field-card-details">
      {field.value && <p className="text-text-secondary">Printed as “{field.source_label}”{field.page ? ` · page ${field.page}` : ""}</p>}
      {field.evidence && <p className="text-text-secondary"><span className="font-medium">Evidence:</span> {field.evidence}</p>}
      {issues.map((issue, index) => <p key={index} className="text-danger">{issue.message}</p>)}
      {field.candidates.length > 1 && (
        <ul className="space-y-0.5" data-testid="field-candidates">
          <li className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Candidates ({field.candidates.length})</li>
          {field.candidates.map((candidate) => (
            <li key={candidate.record_key}>
              <button type="button" className="text-left hover:underline" onClick={() => onFocus(candidate.record_key)}>
                <span className="text-foreground">{candidate.value || "(blank)"}</span>
                <span className="text-text-muted"> · “{candidate.label}”{candidate.group ? ` under ${candidate.group}` : ""}{candidate.page ? ` · p. ${candidate.page}` : ""}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {showHistory && key && <RecordHistory documentId={documentId} recordKey={key} />}
    </div>
  );

  const toggle = (
    <button type="button" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} aria-label={expanded ? `Collapse ${field.label}` : `Expand ${field.label}`}
      className="rounded p-0.5 text-text-muted hover:bg-surface-soft">
      {expanded ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
    </button>
  );

  const shown = field.value ? (
    <button type="button" onClick={() => key && onFocus(key)} title="Show where this value comes from"
      className={compact
        ? "min-w-0 flex-1 truncate text-left text-foreground hover:underline"
        : "mt-1 block w-full truncate rounded-md border border-border bg-surface-soft px-2 py-1 text-left text-sm text-foreground hover:border-primary"}>
      {field.value}
    </button>
  ) : (
    <span className={compact ? "min-w-0 flex-1 truncate text-text-muted" : "mt-1 block rounded-md border border-dashed border-border px-2 py-1 text-sm text-text-muted"}>
      {field.validation_status === "missing" ? "Required — not found in the document" : "Not found in the document"}
    </span>
  );

  if (compact) {
    return (
      <article aria-label={field.label} data-testid="field-card" data-density="compact" data-record-key={key ?? undefined}
        className={`border-b border-border/60 px-2 py-1 text-xs ${focused ? "bg-primary/[0.06]" : ""} ${flagged ? "border-l-2 border-l-danger" : ""}`}>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          {key ? <TriCheckbox ids={[layoutId(key)]} label={`Select ${field.label}`} /> : <span className="w-3.5" />}
          {toggle}
          <span className="w-36 shrink-0 truncate font-medium text-text-secondary" title={field.label}>{field.label}{field.required && <span className="text-danger"> *</span>}</span>
          <span className="flex min-w-[9rem] flex-1">{editing ? <div className="min-w-0 flex-1">{editor}</div> : shown}</span>
          <span className="ml-auto">{chips}</span>
        </div>
        {(expanded || message) && (
          <div className="pl-12">
            {details}
            {expanded && <div className="mt-1.5">{actions}</div>}
            {message && <p className="mt-1 text-danger" role="alert">{message}</p>}
          </div>
        )}
      </article>
    );
  }

  return (
    <article aria-label={field.label} data-testid="field-card" data-density="comfortable" data-record-key={key ?? undefined}
      className={`rounded-lg border p-3 text-xs ${focused ? "ring-2 ring-primary/40" : ""} ${flagged ? "border-danger/40 bg-danger/[0.03]" : "border-border"}`}>
      <div className="flex items-start gap-2">
        {key && <TriCheckbox ids={[layoutId(key)]} label={`Select ${field.label}`} className="mt-0.5" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {toggle}
            <span className="font-medium text-text-secondary">{field.label}{field.required && <span className="text-danger" title="Required"> *</span>}</span>
            <span className="ml-auto">{chips}</span>
          </div>
          {editing ? editor : shown}
          {!expanded && issues.slice(0, 1).map((issue, index) => <p key={index} className="mt-0.5 text-[11px] text-danger">{issue.message}</p>)}
          {details}
          <div className="mt-1.5">{actions}</div>
          {message && <p className="mt-1 text-danger" role="alert">{message}</p>}
        </div>
      </div>
    </article>
  );
}

const FieldCard = memo(FieldCardInner);
export default FieldCard;
