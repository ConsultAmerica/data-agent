"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Check, ExternalLink, Pencil, X } from "lucide-react";

import ConfidenceMeter from "@/components/ui/confidence-meter";
import type { ReviewQueueFieldDetail } from "@/lib/assignments";
import { reviewMetadataField, reviewMetadataFieldById } from "@/lib/documents";

import { formatQueueDate as formatDate, inspectHref, issueLabel, urgencyOf } from "./queue-filters";
import { useReviewMutationsEnabled } from "@/lib/review-gate";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/** Quick inspect: the source text beside the extracted value, with inline
 * edit, Approve / Reject and the assignment. Escape closes; focus stays
 * inside while open and returns to the opener on close. */
export default function InspectDrawer({
  item,
  reviewer,
  onClose,
  onDecide,
  onEdited,
}: {
  item: ReviewQueueFieldDetail;
  reviewer: string;
  onClose: () => void;
  /** Approve / Reject through the list's undo window. */
  onDecide: (action: "accept" | "reject") => void;
  /** A corrected value was saved (the field leaves the queue). */
  onEdited: (item: ReviewQueueFieldDetail, value: string) => void;
}) {
  const reviewEnabled = useReviewMutationsEnabled();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    return () => opener?.focus?.();
  }, []);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panel.current) return;
    const focusable = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  async function saveEdit() {
    const value = draft.trim();
    if (!value || value === item.value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setError("");
    try {
      if (item.metadata_field_id != null) {
        await reviewMetadataFieldById(item.document_id, item.metadata_field_id, "edit", reviewer, value);
      } else {
        await reviewMetadataField(item.document_id, item.field_key, "edit", reviewer, value);
      }
      onEdited(item, value);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the correction.");
    } finally {
      setSaving(false);
    }
  }

  const urgency = urgencyOf(item);
  const shortId = item.document_id.slice(0, 8);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onKeyDown={onKeyDown}>
      <div className="absolute inset-0 bg-black/30" aria-hidden="true" onClick={onClose} data-testid="drawer-backdrop" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex h-full w-full max-w-2xl flex-col overflow-y-auto border-l border-border bg-surface shadow-xl"
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-base font-semibold text-foreground">
              {item.label}
            </h2>
            <p className="mt-0.5 truncate text-xs text-text-secondary">
              {item.original_filename} · <span className="font-id">{shortId}</span>
              {item.page_number ? ` · p. ${item.page_number}` : ""}
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
              <span>{issueLabel(item)}</span>
              <ConfidenceMeter value={item.confidence} />
            </p>
          </div>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            aria-label="Close details"
            className="rounded-md p-1 text-text-secondary hover:bg-surface-soft hover:text-foreground"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
          <section aria-label="Original text">
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Original text</h3>
            {item.source_snippet ? (
              <blockquote className="whitespace-pre-wrap rounded-lg border border-border bg-surface-soft p-3 text-sm text-foreground">
                {item.source_snippet}
              </blockquote>
            ) : (
              <p className="rounded-lg border border-dashed border-border p-3 text-sm text-text-secondary">
                No source snippet stored —{" "}
                <Link href={inspectHref(item)} className="font-medium text-primary hover:underline">
                  open in source
                </Link>
              </p>
            )}
          </section>
          <section aria-label="Extracted value">
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Extracted value</h3>
            {editing ? (
              <div className="space-y-2">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  aria-label={`Corrected value for ${item.label}`}
                  rows={4}
                  className="w-full rounded-lg border border-border bg-surface p-2 text-sm text-foreground outline-none focus:border-primary/40"
                />
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => void saveEdit()}
                    disabled={!reviewEnabled || saving}
                    className="btn-primary px-3 py-1 text-xs disabled:opacity-50"
                  >
                    {saving ? "Saving…" : "Save correction"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(false);
                      setDraft(item.value);
                      setError("");
                    }}
                    className="text-text-secondary hover:text-foreground"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-border p-3">
                <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                  {item.value || <span className="text-text-muted">(empty)</span>}
                </p>
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  <Pencil className="h-3 w-3" aria-hidden="true" />
                  Edit value
                </button>
              </div>
            )}
            {error && (
              <p className="mt-2 text-xs text-[var(--danger)]" role="alert">
                {error}
              </p>
            )}
          </section>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={() => onDecide("accept")}
            className="inline-flex items-center gap-1 rounded-md border border-[var(--success)]/40 bg-[var(--success)]/10 px-3 py-1.5 text-xs font-semibold text-[var(--success)] hover:border-[var(--success)]"
          >
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
            Approve
          </button>
          <button
            type="button"
            onClick={() => onDecide("reject")}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-[var(--danger)] hover:border-[var(--danger)]"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
            Reject
          </button>
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t border-border px-5 py-4 text-xs">
          <dt className="text-text-secondary">Assigned to</dt>
          <dd className="text-foreground">{item.assignee || <span className="text-text-muted">Unassigned</span>}</dd>
          {item.due_date && (
            <>
              <dt className="text-text-secondary">Due</dt>
              <dd className={urgency === "overdue" ? "font-medium text-[var(--danger)]" : "text-foreground"}>
                {formatDate(item.due_date)}
                {urgency === "overdue" ? " (overdue)" : ""}
              </dd>
            </>
          )}
          {item.assigned_at && (
            <>
              <dt className="text-text-secondary">Assigned</dt>
              <dd className="text-foreground">{formatDate(item.assigned_at, true)}</dd>
            </>
          )}
          {item.contract_type && (
            <>
              <dt className="text-text-secondary">Contract type</dt>
              <dd className="text-foreground">{item.contract_type}</dd>
            </>
          )}
          {item.uploaded_at && (
            <>
              <dt className="text-text-secondary">Uploaded</dt>
              <dd className="text-foreground">{formatDate(item.uploaded_at, true)}</dd>
            </>
          )}
        </dl>

        <div className="mt-auto border-t border-border px-5 py-3 text-xs">
          <Link
            href={`/documents/${item.document_id}`}
            className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
          >
            Open the full document
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </div>
  );
}
