"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Check, ExternalLink, ShieldAlert, X } from "lucide-react";

import ConfidenceMeter from "@/components/ui/confidence-meter";
import type { ReviewQueueFieldDetail } from "@/lib/assignments";
import { reviewMetadataField, reviewMetadataFieldById } from "@/lib/documents";
import type { FieldValidation, MetadataField, ReviewAction } from "@/types/document";

import { formatQueueDate as formatDate, inspectHref, issueLabel, urgencyOf } from "./queue-filters";
import { REVIEW_READ_ONLY_MESSAGE, useReviewMutationsEnabled } from "@/lib/review-gate";

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

const STATUS_LABELS: Record<string, string> = {
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
  not_run: "Not checked",
};

/** A blocking failure that no reviewer has overridden yet. */
export function blocksApproval(validation: FieldValidation | null | undefined): boolean {
  return Boolean(validation?.blocking && !validation.override);
}

/** Quick inspect: the source text, the value (correctable), its validation,
 * and Approve / Reject. Saving a correction never approves it; a value that
 * failed validation is approved only with an explicit, audited override.
 * Escape closes; focus stays inside while open and returns to the opener. */
export default function InspectDrawer({
  item,
  reviewer,
  onClose,
  onDecide,
  onCorrected,
  onOverridden,
}: {
  item: ReviewQueueFieldDetail;
  reviewer: string;
  onClose: () => void;
  /** Approve / Reject through the list's undo window. */
  onDecide: (action: "accept" | "reject") => void;
  /** A correction was saved (the field stays in the queue, still pending). */
  onCorrected: (item: ReviewQueueFieldDetail, patch: Pick<ReviewQueueFieldDetail, "value" | "validation">) => void;
  /** Approved past a failed validation (the field leaves the queue). */
  onOverridden: (item: ReviewQueueFieldDetail) => void;
}) {
  const reviewEnabled = useReviewMutationsEnabled();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState(item.value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [overriding, setOverriding] = useState(false);

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

  function review(action: ReviewAction, value?: string, reason?: string): Promise<MetadataField> {
    return item.metadata_field_id != null
      ? reviewMetadataFieldById(item.document_id, item.metadata_field_id, action, reviewer, value, reason)
      : reviewMetadataField(item.document_id, item.field_key, action, reviewer, value, reason);
  }

  const validation = item.validation ?? null;
  const blocked = blocksApproval(validation);
  const changed = draft !== item.value;
  // Why Save correction is unavailable, or "" when it can be used.
  const saveBlockedBy = !reviewEnabled
    ? REVIEW_READ_ONLY_MESSAGE
    : !draft.trim()
      ? "A corrected value can't be empty."
      : !changed
        ? "Change the value to save a correction."
        : "";
  const approveBlockedBy = !reviewEnabled
    ? REVIEW_READ_ONLY_MESSAGE
    : changed
      ? "Save or discard your correction before approving."
      : blocked
        ? "This value failed validation. Correct it, or approve it with an override reason."
        : "";

  async function saveCorrection() {
    if (saveBlockedBy) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const saved = await review("correct", draft);
      const patch = { value: saved.value ?? draft, validation: saved.validation ?? null };
      onCorrected(item, patch);
      setDraft(patch.value);
      setNotice(
        patch.validation?.status === "failed"
          ? "Correction saved. It still fails validation, so it can't be approved as is."
          : "Correction saved. It is waiting for approval.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the correction.");
    } finally {
      setSaving(false);
    }
  }

  async function approveWithOverride() {
    const reason = overrideReason.trim();
    if (!reason) return;
    setOverriding(true);
    setError("");
    try {
      await review("accept", undefined, reason);
      onOverridden(item);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't approve the value.");
    } finally {
      setOverriding(false);
    }
  }

  const urgency = urgencyOf(item);
  const shortId = item.document_id.slice(0, 8);
  const originalValue = item.original_value ?? "";

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
            {/* Only text recorded from the document; never a validation message. */}
            {item.source_snippet ? (
              <blockquote className="whitespace-pre-wrap rounded-lg border border-border bg-surface-soft p-3 text-sm text-foreground">
                {item.source_snippet}
              </blockquote>
            ) : (
              <p className="rounded-lg border border-dashed border-border p-3 text-sm text-text-secondary">
                Original source text unavailable.
              </p>
            )}
            <Link href={inspectHref(item)} className="mt-1.5 inline-flex text-xs font-medium text-primary hover:underline">
              {item.page_number ? `Open page ${item.page_number} in source` : "Open in source"}
            </Link>
          </section>
          <section aria-label="Extracted value">
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Extracted value</h3>
            <textarea
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setNotice("");
              }}
              readOnly={!reviewEnabled}
              aria-label={`Corrected value for ${item.label}`}
              aria-describedby={`${titleId}-save-help`}
              rows={3}
              className="w-full rounded-lg border border-border bg-surface p-2 text-sm text-foreground outline-none focus:border-primary/40 read-only:bg-surface-soft"
            />
            {originalValue && originalValue !== item.value && (
              <p className="mt-1 text-xs text-text-secondary">
                Originally extracted: <span className="font-medium text-foreground">{originalValue}</span>
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <button
                type="button"
                onClick={() => void saveCorrection()}
                disabled={Boolean(saveBlockedBy) || saving}
                title={saveBlockedBy || undefined}
                className="btn-primary px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save correction"}
              </button>
              {changed && (
                <button
                  type="button"
                  onClick={() => {
                    setDraft(item.value);
                    setError("");
                  }}
                  className="text-text-secondary hover:text-foreground"
                >
                  Discard
                </button>
              )}
            </div>
            <p id={`${titleId}-save-help`} className="mt-1 text-[11px] text-text-muted" data-testid="save-help">
              {saveBlockedBy || "Saving keeps the original value and leaves this field for approval."}
            </p>
            {notice && (
              <p className="mt-1 text-xs text-[var(--success)]" role="status">
                {notice}
              </p>
            )}
          </section>
        </div>

        <ValidationSection
          validation={validation}
          pageNumber={item.page_number ?? null}
          onUseSuggestion={reviewEnabled ? (value) => setDraft(value) : undefined}
        />

        {error && (
          <p className="mx-5 mb-2 text-xs text-[var(--danger)]" role="alert">
            {error}
          </p>
        )}

        <div className="border-t border-border px-5 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onDecide("accept")}
              disabled={Boolean(approveBlockedBy)}
              title={approveBlockedBy || undefined}
              className="inline-flex items-center gap-1 rounded-md border border-[var(--success)]/40 bg-[var(--success)]/10 px-3 py-1.5 text-xs font-semibold text-[var(--success)] hover:border-[var(--success)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              Approve
            </button>
            {blocked && reviewEnabled && !changed && !overrideOpen && (
              <button
                type="button"
                onClick={() => setOverrideOpen(true)}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--warning)]/50 bg-surface px-3 py-1.5 text-xs font-semibold text-foreground hover:border-[var(--warning)]"
              >
                <ShieldAlert className="h-3.5 w-3.5 text-[var(--warning)]" aria-hidden="true" />
                Approve with override…
              </button>
            )}
            <button
              type="button"
              onClick={() => onDecide("reject")}
              disabled={!reviewEnabled}
              title={reviewEnabled ? undefined : REVIEW_READ_ONLY_MESSAGE}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-[var(--danger)] hover:border-[var(--danger)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Reject
            </button>
          </div>
          {approveBlockedBy && (
            <p className="mt-1.5 text-[11px] text-text-muted" data-testid="approve-help">
              {approveBlockedBy}
            </p>
          )}
          {overrideOpen && (
            <div className="mt-3 space-y-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/5 p-3" data-testid="override-form">
              <label className="block text-xs font-medium text-foreground" htmlFor={`${titleId}-override`}>
                Why is this value correct despite failing validation?
              </label>
              <textarea
                id={`${titleId}-override`}
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                rows={2}
                maxLength={500}
                className="w-full rounded-md border border-border bg-surface p-2 text-sm text-foreground outline-none focus:border-primary/40"
              />
              <p className="text-[11px] text-text-muted">
                The override, your reason, your name ({reviewer}) and the time are recorded in the audit log.
              </p>
              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => void approveWithOverride()}
                  disabled={!overrideReason.trim() || overriding}
                  title={overrideReason.trim() ? undefined : "Enter a reason first."}
                  className="btn-primary px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {overriding ? "Approving…" : "Approve with override"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOverrideOpen(false);
                    setOverrideReason("");
                  }}
                  className="text-text-secondary hover:text-foreground"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
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

/** What validation recorded, kept apart from the source text and value. */
function ValidationSection({
  validation,
  pageNumber,
  onUseSuggestion,
}: {
  validation: FieldValidation | null;
  pageNumber: number | null;
  onUseSuggestion?: (value: string) => void;
}) {
  const status = validation?.status ?? "not_run";
  const failed = status === "failed";
  return (
    <section aria-label="Validation" className="mx-5 mb-4 rounded-lg border border-border p-3 text-xs" data-testid="validation-section">
      <h3 className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
        Validation
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal ${
            failed
              ? "bg-[var(--danger)]/10 text-[var(--danger)]"
              : status === "passed"
                ? "bg-[var(--success)]/10 text-[var(--success)]"
                : "bg-surface-soft text-text-secondary"
          }`}
        >
          {STATUS_LABELS[status] ?? status}
        </span>
      </h3>
      {!validation || status === "not_run" ? (
        <p className="text-text-secondary">No validation was recorded for this value.</p>
      ) : (
        <dl className="space-y-1">
          {validation.failed_rules.length > 0 && (
            <div className="grid grid-cols-[7rem_1fr] gap-2">
              <dt className="text-text-secondary">Failed rule{validation.failed_rules.length === 1 ? "" : "s"}</dt>
              <dd className="text-foreground">
                {validation.failed_rules.map((rule) => (rule.detail ? `${rule.label} (${rule.detail})` : rule.label)).join(", ")}
              </dd>
            </div>
          )}
          {validation.messages.length > 0 && (
            <div className="grid grid-cols-[7rem_1fr] gap-2">
              <dt className="text-text-secondary">Message</dt>
              <dd className="text-foreground">{validation.messages.join(" ")}</dd>
            </div>
          )}
          <div className="grid grid-cols-[7rem_1fr] gap-2">
            <dt className="text-text-secondary">Suggested correction</dt>
            <dd className="text-foreground">
              {validation.suggested_value ? (
                <>
                  {validation.suggested_value}
                  {onUseSuggestion && (
                    <button
                      type="button"
                      onClick={() => onUseSuggestion(validation.suggested_value!)}
                      className="ml-2 font-medium text-primary hover:underline"
                    >
                      Use it
                    </button>
                  )}
                </>
              ) : (
                <span className="text-text-muted">None available</span>
              )}
            </dd>
          </div>
          <div className="grid grid-cols-[7rem_1fr] gap-2">
            <dt className="text-text-secondary">Evidence</dt>
            <dd className="text-foreground">{pageNumber ? `Page ${pageNumber}` : <span className="text-text-muted">No page recorded</span>}</dd>
          </div>
          {validation.override && (
            <div className="grid grid-cols-[7rem_1fr] gap-2">
              <dt className="text-text-secondary">Override</dt>
              <dd className="text-foreground">
                {validation.override.reviewer} · {formatDate(validation.override.at, true)}: {validation.override.reason}
              </dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}
