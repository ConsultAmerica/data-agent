"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CheckCheck, Download, Eye, RotateCw, ShieldAlert, Undo2, X } from "lucide-react";

import SelectCheckbox from "@/components/staging/select-checkbox";
import ConfidenceMeter, { normalizeConfidence } from "@/components/ui/confidence-meter";
import DensityToggle from "@/components/ui/density-toggle";
import {
  assignFields,
  assignmentTarget,
  unassignFields,
  type Assignment,
  type ReviewQueueFieldDetail,
} from "@/lib/assignments";
import { HIGH_BAND_MIN } from "@/lib/confidence-policy";
import { reviewMetadataField, reviewMetadataFieldById, startProcessingJob } from "@/lib/documents";
import { downloadBlob } from "@/lib/export";
import { useTableDensity } from "@/lib/table-density";
import type { ReviewAction, ReviewQueueFieldItem } from "@/types/document";

import AssignPopover from "./assign-popover";
import InspectDrawer from "./inspect-drawer";
import { formatQueueDate, inspectHref, queueCsv, severity, urgencyOf } from "./queue-filters";

export { inspectHref };

/** The breadcrumb bar's live height, so a sticky header can sit right
 * under it (the bar's size comes from the theme, not from this list). */
function useChromeBarHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const bar = document.querySelector<HTMLElement>(".workspace-chrome-bar");
    if (!bar) return;
    const update = () => setHeight(Math.round(bar.getBoundingClientRect().height));
    update();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(bar);
    return () => observer?.disconnect();
  }, []);
  return height;
}

/** How long an Approve / Reject can be undone before it is saved. */
export const UNDO_WINDOW_MS = 5000;

/** Rows shown at first; "Show more" adds this many. Batch selection covers
 * only what is on screen. */
const PAGE_ROWS = 40;

type QuickAction = Extract<ReviewAction, "accept" | "reject">;

/** One decision waiting out its undo window: a single row, or a batch
 * decided together (one Undo restores the whole batch). */
interface Pending {
  key: string;
  rows: { key: string; item: ReviewQueueFieldDetail }[];
  action: QuickAction;
  timer: ReturnType<typeof setTimeout>;
}

function isHighConfidence(item: ReviewQueueFieldItem): boolean {
  return normalizeConfidence(item.confidence) >= HIGH_BAND_MIN;
}

export function itemKey(item: ReviewQueueFieldItem, index: number): string {
  return item.metadata_field_id != null
    ? `id:${item.metadata_field_id}`
    : `${item.document_id}:${item.field_key}:${index}`;
}

/** Clicks on a row's own controls never open the drawer. */
function fromControl(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button, a, input, select, textarea, label"));
}

/** Flagged values as a dense table: select, document, flagged field,
 * confidence, owner, timestamp and Approve / Reject / Inspect. Selecting
 * rows shows the batch toolbar (approve, reject, re-run extraction, assign,
 * CSV). A decision hides its rows at once and is saved after a short undo
 * window; leaving the page saves any still waiting. Clicking a row opens
 * the quick-inspect drawer. */
export default function FieldReviewList({
  items,
  reviewer,
  issueLabel,
  onDecided,
  knownAssignees = [],
  currentActor = "",
  onAssigned,
}: {
  items: ReviewQueueFieldDetail[];
  reviewer: string;
  issueLabel: (item: ReviewQueueFieldItem) => string;
  /** A decision was saved: drop the item from the queue's counts. */
  onDecided: (item: ReviewQueueFieldItem) => void;
  /** Names suggested in the Assign popover. */
  knownAssignees?: string[];
  /** Pre-filled in the Assign popover. */
  currentActor?: string;
  /** Assignments were saved for these items (an empty list: cleared). */
  onAssigned?: (items: ReviewQueueFieldDetail[], saved: Assignment[]) => void;
}) {
  const [density, setDensity] = useTableDensity("review-queue");
  const stickyTop = useChromeBarHeight();
  const [pending, setPending] = useState<Pending[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE_ROWS);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [rerunning, setRerunning] = useState(false);
  // Timers and the unmount flush read the latest pending list from here.
  const pendingRef = useRef<Pending[]>([]);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const commit = useCallback(
    async (entry: Pending) => {
      setPending((current) => current.filter((candidate) => candidate.key !== entry.key));
      // One at a time: each decision is its own audited review call.
      for (const row of entry.rows) {
        try {
          if (row.item.metadata_field_id != null) {
            await reviewMetadataFieldById(row.item.document_id, row.item.metadata_field_id, entry.action, reviewer);
          } else {
            await reviewMetadataField(row.item.document_id, row.item.field_key, entry.action, reviewer);
          }
          onDecided(row.item);
        } catch (err) {
          setErrors((current) => ({
            ...current,
            [row.key]: err instanceof Error ? err.message : "Couldn't save the decision.",
          }));
        }
      }
    },
    [onDecided, reviewer],
  );

  // Leaving the page saves decisions still inside their undo window.
  useEffect(
    () => () => {
      for (const entry of pendingRef.current) {
        clearTimeout(entry.timer);
        void commit(entry);
      }
    },
    [commit],
  );

  function decide(rows: Pending["rows"], action: QuickAction) {
    if (rows.length === 0) return;
    const rowKeys = new Set(rows.map((row) => row.key));
    setErrors((current) => {
      const next = { ...current };
      for (const rowKey of rowKeys) delete next[rowKey];
      return next;
    });
    setSelected((current) => new Set([...current].filter((rowKey) => !rowKeys.has(rowKey))));
    if (inspecting && rowKeys.has(inspecting)) setInspecting(null);
    const key = rows.length === 1 ? rows[0].key : `batch:${rows.map((row) => row.key).join("|")}`;
    const entry: Pending = {
      key,
      rows,
      action,
      timer: setTimeout(() => void commit(entryRef(key)), UNDO_WINDOW_MS),
    };
    setPending((current) => [...current.filter((candidate) => candidate.key !== key), entry]);
  }

  function entryRef(key: string): Pending {
    return pendingRef.current.find((candidate) => candidate.key === key)!;
  }

  function undo(key: string) {
    const entry = pendingRef.current.find((candidate) => candidate.key === key);
    if (entry) clearTimeout(entry.timer);
    setPending((current) => current.filter((candidate) => candidate.key !== key));
  }

  const hidden = new Set(pending.flatMap((entry) => entry.rows.map((row) => row.key)));
  const compact = density === "compact";
  const visible = items
    .slice(0, limit)
    .map((item, index) => ({ key: itemKey(item, index), item }))
    .filter((row) => !hidden.has(row.key));
  const selectedRows = visible.filter((row) => selected.has(row.key));
  const highConfidenceRows = visible.filter((row) => isHighConfidence(row.item));
  const allSelected = visible.length > 0 && selectedRows.length === visible.length;
  const inspected = inspecting ? visible.find((row) => row.key === inspecting) ?? null : null;

  function toggle(key: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function rerunExtraction() {
    const documentIds = [...new Set(selectedRows.map((row) => row.item.document_id))];
    setRerunning(true);
    setNotice("");
    let started = 0;
    const failed: string[] = [];
    // One job per document, one at a time so the worker isn't flooded.
    for (const documentId of documentIds) {
      try {
        await startProcessingJob(documentId);
        started += 1;
      } catch (err) {
        failed.push(err instanceof Error ? err.message : documentId);
      }
    }
    setRerunning(false);
    setNotice(
      `Re-run extraction started for ${started} ${started === 1 ? "document" : "documents"}` +
        (failed.length ? ` · ${failed.length} could not start (${failed[0]})` : "") +
        ". Refresh when it finishes.",
    );
  }

  async function assign(assignee: string, dueDate: string | null) {
    const rows = selectedRows.map((row) => row.item);
    const result = await assignFields(rows.map(assignmentTarget), assignee, dueDate);
    onAssigned?.(rows, result.assigned);
    setNotice(`Assigned ${rows.length} ${rows.length === 1 ? "value" : "values"} to ${assignee}.`);
  }

  async function unassign() {
    const rows = selectedRows.map((row) => row.item);
    await unassignFields(rows.map(assignmentTarget));
    onAssigned?.(rows, []);
    setNotice(`Cleared the assignment on ${rows.length} ${rows.length === 1 ? "value" : "values"}.`);
  }

  function exportCsv() {
    downloadBlob(queueCsv(selectedRows.map((row) => row.item)), "review-queue.csv", "text/csv;charset=utf-8;");
  }

  const suggestions = [...new Set([...knownAssignees, ...items.map((item) => item.assignee ?? "").filter(Boolean)])].sort(
    (a, b) => a.localeCompare(b),
  );
  const cell = compact ? "px-3 py-1.5" : "px-3 py-2.5";

  return (
    <div className="editorial-card mb-6 overflow-clip">
      {/* Sticks under the breadcrumb bar while the list scrolls with the page. */}
      <div style={{ top: stickyTop }} className="sticky z-10 border-b border-border bg-surface px-5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-[var(--warning)]" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-foreground">Review</p>
              <p className="text-xs text-text-secondary">
                Red rows are critical (validation failures, conflicts); amber rows are low-confidence or missing values.
              </p>
            </div>
          </div>
          <DensityToggle value={density} onChange={setDensity} />
        </div>

        {visible.length > 0 && (
          <div
            className="mt-3 flex flex-wrap items-center gap-2 text-xs"
            role="toolbar"
            aria-label="Batch review actions"
            data-testid="review-batch-toolbar"
          >
            <label className="inline-flex items-center gap-2 font-medium text-foreground">
              <SelectCheckbox
                checked={allSelected}
                indeterminate={selectedRows.length > 0}
                onChange={() => setSelected(allSelected ? new Set() : new Set(visible.map((row) => row.key)))}
                label={allSelected ? "Clear selection" : "Select all shown"}
              />
              {selectedRows.length > 0 ? `${selectedRows.length} selected` : "Select all"}
            </label>
            <button
              type="button"
              onClick={() => setSelected(new Set(highConfidenceRows.map((row) => row.key)))}
              disabled={highConfidenceRows.length === 0}
              title={`Select values scored ${Math.round(HIGH_BAND_MIN * 100)}% or higher`}
              className="rounded-md border border-border bg-surface px-2.5 py-1 font-medium text-foreground hover:bg-surface-soft disabled:opacity-50"
            >
              Select high confidence ({highConfidenceRows.length})
            </button>
            {/* The batch actions appear once something is selected. */}
            {selectedRows.length > 0 && (
              <>
                <span className="mx-1 hidden h-4 w-px bg-border sm:inline-block" aria-hidden="true" />
                <button
                  type="button"
                  onClick={() => decide(selectedRows, "accept")}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--success)]/40 bg-[var(--success)]/10 px-2.5 py-1 font-semibold text-[var(--success)] hover:border-[var(--success)]"
                >
                  <CheckCheck className="h-3.5 w-3.5" aria-hidden="true" />
                  Approve selected
                </button>
                <button
                  type="button"
                  onClick={() => decide(selectedRows, "reject")}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 font-semibold text-[var(--danger)] hover:border-[var(--danger)]"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                  Reject selected
                </button>
                <button
                  type="button"
                  onClick={() => void rerunExtraction()}
                  disabled={rerunning}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 font-semibold text-foreground hover:border-primary/40 disabled:opacity-50"
                >
                  <RotateCw className={`h-3.5 w-3.5 ${rerunning ? "animate-spin" : ""}`} aria-hidden="true" />
                  {rerunning ? "Starting…" : "Re-run extraction"}
                </button>
                <AssignPopover
                  count={selectedRows.length}
                  knownAssignees={suggestions}
                  defaultAssignee={currentActor}
                  onAssign={assign}
                  onUnassign={selectedRows.some((row) => row.item.assignee) ? unassign : undefined}
                />
                <button
                  type="button"
                  onClick={exportCsv}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 font-semibold text-foreground hover:border-primary/40"
                >
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  Export to CSV
                </button>
              </>
            )}
          </div>
        )}
        {notice && (
          <p className="mt-2 text-xs text-text-secondary" role="status">
            {notice}
          </p>
        )}
      </div>

      {pending.length > 0 && (
        <ul className="border-b border-border bg-surface-soft px-6 py-2 text-xs" aria-live="polite">
          {pending.map((entry) => (
            <li key={entry.key} className="flex items-center justify-between gap-3 py-0.5">
              <span className="min-w-0 truncate text-text-secondary">
                <span className="font-medium text-foreground">{entry.action === "accept" ? "Approved" : "Rejected"}</span>{" "}
                {entry.rows.length === 1
                  ? `${entry.rows[0].item.label}${entry.rows[0].item.value ? ` · ${entry.rows[0].item.value}` : ""}`
                  : `${entry.rows.length} values`}
              </span>
              <button
                type="button"
                onClick={() => undo(entry.key)}
                className="inline-flex shrink-0 items-center gap-1 font-semibold text-primary hover:underline"
              >
                <Undo2 className="h-3.5 w-3.5" aria-hidden="true" />
                Undo
              </button>
            </li>
          ))}
        </ul>
      )}

      {visible.length === 0 ? (
        <p className="px-6 py-10 text-center text-sm text-text-secondary">No flagged values match these filters.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[56rem] text-sm" data-density={density} aria-label="Values flagged for review">
            <thead>
              <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                <th className="w-8 px-3 py-2">
                  <span className="sr-only">Select</span>
                </th>
                <th className="px-3 py-2">Document</th>
                <th className="px-3 py-2">Flagged field</th>
                <th className="px-3 py-2">AI confidence</th>
                <th className="px-3 py-2">Owner</th>
                <th className="px-3 py-2">Uploaded</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map(({ key, item }) => {
                const picked = selected.has(key);
                const critical = severity(item) === "critical";
                const urgency = urgencyOf(item);
                return (
                  <tr
                    key={key}
                    data-severity={critical ? "critical" : "standard"}
                    onClick={(event) => {
                      if (!fromControl(event.target)) setInspecting(key);
                    }}
                    className={[
                      "group cursor-pointer align-top hover:bg-surface-soft focus-within:bg-surface-soft",
                      picked ? "bg-primary/[0.05]" : "",
                    ].join(" ")}
                  >
                    {/* Left accent: red for critical compliance items, amber otherwise. */}
                    <td
                      className={`${cell} ${critical ? "shadow-[inset_3px_0_0_0_var(--danger)]" : "shadow-[inset_3px_0_0_0_var(--warning)]"}`}
                    >
                      <SelectCheckbox checked={picked} onChange={() => toggle(key)} label={`Select ${item.label}`} />
                    </td>
                    <td className={`${cell} max-w-[14rem]`}>
                      <p className="truncate text-foreground" title={item.original_filename}>
                        {item.original_filename}
                      </p>
                      <p className="font-id text-[11px] text-text-muted">{item.document_id.slice(0, 8)}</p>
                    </td>
                    <td className={`${cell} max-w-[22rem]`}>
                      <button
                        type="button"
                        onClick={() => setInspecting(key)}
                        aria-label={`Open details for ${item.label}`}
                        className={`block max-w-full truncate text-left font-medium text-foreground hover:text-primary ${compact ? "text-[13px]" : "text-sm"}`}
                      >
                        {item.label}
                      </button>
                      <p className="truncate text-xs text-text-secondary">
                        <span className={critical ? "text-[var(--danger)]" : "text-[var(--warning)]"}>{issueLabel(item)}</span>
                        {item.value ? ` · ${item.value}` : ""}
                      </p>
                      {errors[key] && <p className="mt-0.5 text-xs text-[var(--danger)]">{errors[key]}</p>}
                    </td>
                    <td className={cell}>
                      <ConfidenceMeter value={item.confidence} />
                    </td>
                    <td className={`${cell} whitespace-nowrap text-xs`}>
                      {item.assignee ? (
                        <>
                          <p className="text-foreground">{item.assignee}</p>
                          {item.due_date && (
                            <p
                              className={
                                urgency === "overdue"
                                  ? "font-medium text-[var(--danger)]"
                                  : urgency === "due7"
                                    ? "text-[var(--warning)]"
                                    : "text-text-secondary"
                              }
                            >
                              {urgency === "overdue" ? "Overdue · " : "Due "}
                              {formatQueueDate(item.due_date)}
                            </p>
                          )}
                        </>
                      ) : (
                        <span className="text-text-muted">Unassigned</span>
                      )}
                    </td>
                    <td className={`${cell} whitespace-nowrap text-xs tabular-nums text-text-secondary`}>
                      {item.uploaded_at ? formatQueueDate(item.uploaded_at) : "—"}
                    </td>
                    <td className={cell}>
                      {/* Always visible on touch / narrow screens; on desktop they appear on hover or keyboard focus. */}
                      <div className="flex items-center justify-end gap-1 transition-opacity lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100">
                        <button
                          type="button"
                          onClick={() => decide([{ key, item }], "accept")}
                          aria-label={`Approve ${item.label}`}
                          title="Approve"
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface px-2 text-xs font-medium text-[var(--success)] hover:border-[var(--success)]"
                        >
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          <span className="hidden xl:inline">Approve</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => decide([{ key, item }], "reject")}
                          aria-label={`Reject ${item.label}`}
                          title="Reject"
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface px-2 text-xs font-medium text-[var(--danger)] hover:border-[var(--danger)]"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                          <span className="hidden xl:inline">Reject</span>
                        </button>
                        <Link
                          href={inspectHref(item)}
                          aria-label={`Inspect ${item.label} in the source`}
                          title="Inspect in the source"
                          className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface px-2 text-xs font-medium text-text-secondary hover:text-foreground"
                        >
                          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                          <span className="hidden xl:inline">Inspect</span>
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {items.length > limit && (
        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-2 text-xs text-text-secondary">
          <span>
            Showing the first {Math.min(limit, items.length)} of {items.length}.
          </span>
          <button
            type="button"
            onClick={() => setLimit((value) => value + PAGE_ROWS)}
            className="font-semibold text-primary hover:underline"
          >
            Show more
          </button>
        </div>
      )}

      {inspected && (
        <InspectDrawer
          key={inspected.key}
          item={inspected.item}
          reviewer={reviewer}
          onClose={() => setInspecting(null)}
          onDecide={(action) => decide([inspected], action)}
          onEdited={(item, value) => {
            setInspecting(null);
            setNotice(`Saved the correction for ${item.label}: ${value}`);
            onDecided(item);
          }}
        />
      )}
    </div>
  );
}
