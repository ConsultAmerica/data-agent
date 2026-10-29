"use client";

import { AlertTriangle, CheckCircle2, History, Info, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  LEVEL_LABELS,
  STATUS_LABELS,
  decideClassification,
  getClassification,
  listDocumentTypes,
  reclassify,
  type CategoryOption,
  type ClassificationState,
  type ClassificationStatus,
} from "@/lib/classification";
import { useReviewMutationsEnabled } from "@/lib/review-gate";

export const STATUS_TONE: Record<ClassificationStatus, string> = {
  classified: "bg-success/10 text-success",
  confirmed: "bg-success/10 text-success",
  review_recommended: "bg-warning/10 text-warning",
  review_required: "bg-danger/10 text-danger",
};

const NEW_CATEGORY = "__new__";

function percent(value: number | null | undefined): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

/**
 * What a document was classified as, why, and what else it could be; a
 * reviewer confirms it or picks another type (or a new category), and the
 * document is re-staged with that schema. Scores are evidence strength,
 * not calibrated probabilities — the panel says so.
 */
export default function ClassificationPanel({
  documentId,
  onChanged,
}: {
  documentId: string;
  /** Called after a decision is saved (e.g. to reload staged data). */
  onChanged?: (state: ClassificationState) => void;
}) {
  const reviewEnabled = useReviewMutationsEnabled();
  const [state, setState] = useState<ClassificationState | null>(null);
  const [types, setTypes] = useState<CategoryOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
  const [family, setFamily] = useState("");
  const [subtype, setSubtype] = useState("");
  const [customLabel, setCustomLabel] = useState("");
  const [reason, setReason] = useState("");
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([getClassification(documentId), listDocumentTypes()])
      .then(([loaded, options]) => {
        if (!active) return;
        setState(loaded);
        setTypes(options);
        setFamily(loaded.family);
        setSubtype(loaded.subtype ?? "");
      })
      .catch((err) => active && setError(err instanceof Error ? err.message : "Unable to load classification."));
    return () => {
      active = false;
    };
  }, [documentId]);

  const typeByFamily = useMemo(() => new Map(types.flatMap((c) => c.types.map((t) => [t.family, t]))), [types]);
  const chosenType = typeByFamily.get(family);

  async function run(action: () => Promise<ClassificationState>) {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setState(next);
      setFamily(next.family);
      setSubtype(next.subtype ?? "");
      setChanging(false);
      setReason("");
      setCustomLabel("");
      onChanged?.(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The decision could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  if (error && !state) return <p className="p-4 text-sm text-danger" role="alert">{error}</p>;
  if (!state) return <p className="p-4 text-sm text-text-muted">Loading classification…</p>;

  const top = state.candidates[0];
  const alternatives = state.candidates.filter((candidate) => candidate.family !== state.family);

  return (
    <div className="space-y-4 text-sm" data-testid="classification-panel">
      <section>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Detected document type</p>
        <p className="mt-1 text-base font-semibold text-foreground" data-testid="classification-type">
          {state.family_label}
          {state.subtype ? <span className="font-normal text-text-secondary"> — {state.subtype}</span> : null}
        </p>
        <p className="text-xs text-text-secondary">
          {state.category_label} · schema: {state.profile_label}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[state.status]}`} data-testid="classification-status">
            {STATUS_LABELS[state.status]}
          </span>
          <span
            className="inline-flex items-center gap-1 rounded-full bg-surface-soft px-2 py-0.5 text-xs text-text-secondary"
            title="Evidence strength from the document's own content — not a calibrated probability."
          >
            Confidence: <strong className="font-medium text-foreground">{LEVEL_LABELS[state.confidence_level]}</strong>
            {state.confidence != null && ` (${percent(state.confidence)})`}
            <Info className="h-3 w-3" aria-hidden="true" />
          </span>
          <span className="text-xs text-text-muted">via {state.method}</span>
        </div>
        {state.decided && (
          <p className="mt-1 text-xs text-text-secondary">
            Decided by {state.decided_by}
            {state.predicted && state.predicted.family !== state.family
              ? ` · originally predicted ${state.predicted.family_label}${state.predicted.subtype ? ` — ${state.predicted.subtype}` : ""}`
              : ""}
          </p>
        )}
      </section>

      {state.status === "review_required" && (
        <p className="flex gap-2 rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-xs text-text-secondary">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
          The type couldn&apos;t be established with enough evidence. A general schema is used until a person confirms
          the type; everything extracted is kept.
        </p>
      )}
      {state.needs_restage && (
        <p className="rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-xs text-text-secondary">
          The data shown was staged with a different schema ({state.staged_profile_id}). Re-extract to use{" "}
          {state.profile_label}.
        </p>
      )}
      {state.mappings_to_review.length > 0 && (
        <p className="rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-xs text-text-secondary">
          Oracle mappings made for the previous type need review: {state.mappings_to_review.map((m) => m.name).join(", ")}.
        </p>
      )}

      <section>
        <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Evidence</p>
        {state.evidence.length ? (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-foreground" data-testid="classification-evidence">
            {state.evidence.slice(0, 8).map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-xs text-text-muted">No evidence recorded.</p>
        )}
      </section>

      {alternatives.length > 0 && (
        <section>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Alternative classifications</p>
          <ul className="mt-1 space-y-1" data-testid="classification-alternatives">
            {alternatives.map((candidate) => (
              <li key={candidate.family} className="flex items-center gap-2 text-xs">
                <span className="w-10 shrink-0 tabular-nums text-text-secondary">{percent(candidate.score)}</span>
                <span className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-surface-soft">
                  <span className="block h-full bg-primary/50" style={{ width: `${Math.round(candidate.score * 100)}%` }} />
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground" title={candidate.evidence.join("\n")}>
                  {candidate.label}
                  <span className="text-text-muted"> · {candidate.sources.join(", ")}</span>
                </span>
                {reviewEnabled && (
                  <button
                    type="button"
                    onClick={() => {
                      setChanging(true);
                      setFamily(candidate.family);
                      setSubtype(candidate.subtype ?? "");
                    }}
                    className="shrink-0 text-primary hover:underline"
                  >
                    Use
                  </button>
                )}
              </li>
            ))}
          </ul>
          {top && top.family !== state.family && (
            <p className="mt-1 text-[11px] text-warning">The strongest evidence points to {top.label}.</p>
          )}
        </section>
      )}

      {error && <p className="text-xs text-danger" role="alert">{error}</p>}

      {reviewEnabled ? (
        changing ? (
          <section className="space-y-2 rounded-lg border border-border p-3" data-testid="classification-change">
            <label className="block text-xs font-medium text-text-secondary">
              Document type
              <select
                value={family}
                onChange={(event) => {
                  setFamily(event.target.value);
                  setSubtype("");
                }}
                className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground"
                aria-label="Document type"
              >
                {types.map((category) => (
                  <optgroup key={category.category} label={category.label}>
                    {category.types.map((type) => (
                      <option key={type.family} value={type.family}>{type.label}</option>
                    ))}
                  </optgroup>
                ))}
                <option value={NEW_CATEGORY}>New category…</option>
              </select>
            </label>
            {family === NEW_CATEGORY ? (
              <label className="block text-xs font-medium text-text-secondary">
                New category name
                <input
                  value={customLabel}
                  onChange={(event) => setCustomLabel(event.target.value)}
                  placeholder="e.g. Board Meeting Minutes"
                  className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
                />
                <span className="mt-0.5 block font-normal text-text-muted">Uses the general extraction schema.</span>
              </label>
            ) : (
              chosenType && chosenType.subtypes.length > 0 && (
                <label className="block text-xs font-medium text-text-secondary">
                  Subtype
                  <select
                    value={subtype}
                    onChange={(event) => setSubtype(event.target.value)}
                    className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground"
                    aria-label="Subtype"
                  >
                    <option value="">—</option>
                    {chosenType.subtypes.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </label>
              )
            )}
            {chosenType && family !== NEW_CATEGORY && (
              <p className="text-[11px] text-text-muted">
                Schema: {chosenType.profile_label} · {chosenType.datasets.map((d) => d.display_name).slice(0, 5).join(", ")}
              </p>
            )}
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Reason (optional)"
              aria-label="Reason"
              className="h-9 w-full rounded-lg border border-border bg-background px-2 text-sm"
            />
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy || (family === NEW_CATEGORY && !customLabel.trim())}
                onClick={() =>
                  void run(() =>
                    family === state.family && family !== NEW_CATEGORY
                      ? decideClassification(documentId, { action: "confirm", subtype: subtype || null, reason })
                      : decideClassification(documentId, {
                          action: "override",
                          family: family === NEW_CATEGORY ? null : family,
                          custom_label: family === NEW_CATEGORY ? customLabel : null,
                          subtype: subtype || null,
                          reason,
                        }),
                  )
                }
                className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
              >
                {busy ? "Re-extracting…" : "Save and re-extract"}
              </button>
              <button type="button" onClick={() => setChanging(false)} className="btn-secondary px-3 py-1.5 text-xs">
                Cancel
              </button>
            </div>
          </section>
        ) : (
          <div className="flex flex-wrap gap-2">
            {state.status !== "confirmed" && !["unknown", "generic_business"].includes(state.family) && (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => decideClassification(documentId, { action: "confirm" }))}
                className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
              >
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                Confirm classification
              </button>
            )}
            <button type="button" onClick={() => setChanging(true)} className="btn-secondary px-3 py-1.5 text-xs">
              Change document type
            </button>
            {state.needs_restage && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(() => decideClassification(documentId, { action: "confirm", subtype: state.subtype }))
                }
                className="btn-secondary px-3 py-1.5 text-xs"
              >
                Re-extract using selected schema
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => reclassify(documentId))}
              className="inline-flex items-center gap-1 px-2 py-1.5 text-xs text-text-secondary hover:text-foreground"
              title="Run the classifier again on the stored pages"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
              Re-run
            </button>
          </div>
        )
      ) : (
        <p className="text-xs text-text-muted">Classification changes are disabled on this deployment.</p>
      )}

      <section>
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className="inline-flex items-center gap-1 text-xs font-medium text-text-secondary hover:text-foreground"
          aria-expanded={showHistory}
        >
          <History className="h-3.5 w-3.5" aria-hidden="true" />
          History ({state.history.length})
        </button>
        {showHistory && (
          <ol className="mt-1 space-y-1 text-xs" data-testid="classification-history">
            {state.history.map((event) => (
              <li key={event.id} className="flex gap-2">
                <span className="w-24 shrink-0 text-text-muted">{new Date(event.created_at).toLocaleString()}</span>
                <span className="text-foreground">
                  {event.kind === "prediction" ? "Predicted" : event.kind === "confirmation" ? "Confirmed" : "Changed to"}{" "}
                  {event.family_label}
                  {event.subtype ? ` — ${event.subtype}` : ""}
                  {event.confidence != null ? ` (${percent(event.confidence)})` : ""}
                  {event.actor_name ? ` by ${event.actor_name}` : ""}
                  {event.reason ? ` · “${event.reason}”` : ""}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <p className="text-[10px] text-text-muted">
        Thresholds: high ≥ {percent(state.thresholds.high)}, review below {percent(state.thresholds.low)} · engine {state.engine_version}
      </p>
    </div>
  );
}
