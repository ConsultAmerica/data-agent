"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import EmptyState from "@/components/illustrations/empty-state";
import { LoadingState } from "@/components/layout/StatusState";
import PageHeader from "@/components/page-header";
import { getGlobalAuditLog } from "@/lib/documents";
import type {
  GlobalAuditEntry,
  GlobalAuditLogFilters,
  ReviewAction,
} from "@/types/document";

const PAGE_SIZE = 50;

const ACTION_LABELS: Record<ReviewAction, string> = {
  accept: "Accepted",
  edit: "Edited",
  reject: "Rejected",
  mark_unknown: "Marked Unknown",
};

const ACTION_STYLES: Record<ReviewAction, string> = {
  accept: "bg-success/10 text-success",
  edit: "bg-primary-soft text-primary",
  reject: "bg-danger/10 text-danger",
  mark_unknown: "bg-warning/10 text-warning",
};

const EMPTY_FILTERS: GlobalAuditLogFilters = {
  documentId: "",
  changedBy: "",
  action: "",
  requestId: "",
  outcome: "",
  from: "",
  to: "",
};

export default function AuditLogPage() {
  const [entries, setEntries] = useState<GlobalAuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [draft, setDraft] = useState<GlobalAuditLogFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<GlobalAuditLogFilters>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const result = await getGlobalAuditLog(PAGE_SIZE, offset, applied);
        if (!active) return;
        setEntries(result.entries);
        setTotal(result.total);
      } catch (err) {
        if (!active) return;
        setError(
          err instanceof Error ? err.message : "Unable to load the audit log.",
        );
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [offset, applied]);

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  function applyFilters(event: React.FormEvent) {
    event.preventDefault();
    const next: GlobalAuditLogFilters = {};
    if (draft.documentId?.trim()) next.documentId = draft.documentId.trim();
    if (draft.changedBy?.trim()) next.changedBy = draft.changedBy.trim();
    if (draft.action) next.action = draft.action;
    if (draft.requestId?.trim()) next.requestId = draft.requestId.trim();
    if (draft.outcome) next.outcome = draft.outcome;
    if (draft.from) next.from = new Date(draft.from).toISOString();
    if (draft.to) next.to = new Date(draft.to).toISOString();
    setOffset(0);
    setApplied(next);
  }

  return (
    <div className="page-container-wide">
      <PageHeader
        title="Audit explorer"
        description="Append-only metadata review decisions for documents in your workspace. Event category is metadata review (this API). Oracle, export, and classification history stay on their own APIs — they are not invented here."
      />

      <form
        onSubmit={applyFilters}
        className="mb-6 grid gap-3 rounded-xl border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4"
        data-testid="audit-filters"
      >
        <label className="text-xs text-text-secondary">
          Document ID
          <input
            className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            value={draft.documentId ?? ""}
            onChange={(e) =>
              setDraft((current) => ({ ...current, documentId: e.target.value }))
            }
          />
        </label>
        <label className="text-xs text-text-secondary">
          Actor / changed by
          <input
            className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            value={draft.changedBy ?? ""}
            onChange={(e) =>
              setDraft((current) => ({ ...current, changedBy: e.target.value }))
            }
          />
        </label>
        <label className="text-xs text-text-secondary">
          Action
          <select
            className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            value={draft.action ?? ""}
            onChange={(e) =>
              setDraft((current) => ({ ...current, action: e.target.value }))
            }
          >
            <option value="">Any</option>
            <option value="accept">Accept</option>
            <option value="edit">Edit</option>
            <option value="reject">Reject</option>
            <option value="mark_unknown">Mark unknown</option>
          </select>
        </label>
        <label className="text-xs text-text-secondary">
          Outcome (new status)
          <select
            className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            value={draft.outcome ?? ""}
            onChange={(e) =>
              setDraft((current) => ({ ...current, outcome: e.target.value }))
            }
          >
            <option value="">Any</option>
            <option value="accepted">Accepted</option>
            <option value="edited">Edited</option>
            <option value="rejected">Rejected</option>
            <option value="pending">Pending</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>
        <label className="text-xs text-text-secondary">
          Correlation / request ID
          <input
            className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm font-mono"
            value={draft.requestId ?? ""}
            onChange={(e) =>
              setDraft((current) => ({ ...current, requestId: e.target.value }))
            }
          />
        </label>
        <label className="text-xs text-text-secondary">
          From
          <input
            type="datetime-local"
            className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            value={draft.from ?? ""}
            onChange={(e) =>
              setDraft((current) => ({ ...current, from: e.target.value }))
            }
          />
        </label>
        <label className="text-xs text-text-secondary">
          To
          <input
            type="datetime-local"
            className="mt-1 w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
            value={draft.to ?? ""}
            onChange={(e) =>
              setDraft((current) => ({ ...current, to: e.target.value }))
            }
          />
        </label>
        <div className="flex items-end gap-2">
          <button type="submit" className="btn-primary px-3 py-2 text-sm">
            Apply filters
          </button>
          <button
            type="button"
            className="btn-secondary px-3 py-2 text-sm"
            onClick={() => {
              setDraft(EMPTY_FILTERS);
              setApplied({});
              setOffset(0);
            }}
          >
            Clear
          </button>
        </div>
      </form>

      {error && (
        <div className="mb-6 rounded-2xl border border-danger/20 bg-danger/5 p-4 text-sm text-danger" role="alert">
          {error}
        </div>
      )}

      <div className="editorial-card overflow-hidden">
        {loading && entries.length === 0 ? (
          <LoadingState
            title="Loading audit history..."
            description="Querying metadata review audit records for your workspace."
          />
        ) : entries.length === 0 ? (
          <EmptyState
            variant="documents"
            title="No audit actions match"
            description="Human Accept / Edit / Reject events appear here. Missing rows are not invented — try clearing filters or reviewing a document."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm" data-testid="audit-table">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-text-secondary">
                    Actor
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-text-secondary">
                    Action
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-text-secondary">
                    Outcome
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-text-secondary">
                    Document
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-text-secondary">
                    Field
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-text-secondary">
                    Values
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-text-secondary">
                    Correlation
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium uppercase text-text-secondary">
                    Timestamp
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, index) => (
                  <tr
                    key={`${entry.document_id}-${entry.field_key}-${entry.changed_at}-${index}`}
                    className="border-b border-border/70 transition duration-200 hover:bg-surface-soft/60"
                  >
                    <td className="px-4 py-3 text-foreground">
                      <div>{entry.changed_by}</div>
                      {(entry.actor_role || entry.actor_id) && (
                        <div className="text-[11px] text-text-muted">
                          {[entry.actor_role, entry.actor_id]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={[
                          "rounded-full px-2.5 py-0.5 text-xs font-medium",
                          ACTION_STYLES[entry.action],
                        ].join(" ")}
                      >
                        {ACTION_LABELS[entry.action]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {entry.new_status || "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Link
                        href={`/documents/${entry.document_id}/review`}
                        className="font-medium text-primary hover:underline"
                      >
                        {entry.document_filename}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {entry.field_key}
                    </td>
                    <td className="max-w-[200px] px-4 py-3 text-xs text-text-secondary">
                      <span className="block truncate">
                        {entry.previous_value || "—"} → {entry.new_value || "—"}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-text-muted">
                      {entry.request_id || "—"}
                    </td>
                    <td className="px-4 py-3 text-text-secondary">
                      {new Date(entry.changed_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {total > 0 && (
        <div className="mt-6 flex items-center justify-between text-sm text-text-secondary">
          <p aria-live="polite">
            Showing {from}–{to} of {total.toLocaleString()}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setOffset((current) => Math.max(0, current - PAGE_SIZE))
              }
              disabled={offset === 0}
              className="btn-secondary py-1.5 text-xs disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Previous
            </button>
            <button
              type="button"
              onClick={() => setOffset((current) => current + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total}
              className="btn-secondary py-1.5 text-xs disabled:opacity-40"
            >
              Next
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
