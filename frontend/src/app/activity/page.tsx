"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, History } from "lucide-react";

import PageHeader from "@/components/page-header";
import EmptyState from "@/components/ui/empty-state";
import { formatRelativeTime } from "@/lib/format";
import { getGlobalAuditLog } from "@/lib/documents";
import type { AuditAction, GlobalAuditEntry } from "@/types/document";

const PAGE_SIZE = 50;

const ACTION_LABELS: Record<AuditAction, string> = {
  accept: "Accepted",
  edit: "Edited",
  reject: "Rejected",
  mark_unknown: "Marked Unknown",
  approve: "Approved",
  promote: "Promoted",
  delete: "Deleted",
};

const ACTION_STYLES: Record<AuditAction, string> = {
  accept: "bg-success/10 text-success",
  edit: "bg-brand-blue/10 text-brand-blue",
  reject: "bg-error/10 text-error",
  mark_unknown: "bg-warning/10 text-warning",
  approve: "bg-success/10 text-success",
  promote: "bg-brand-blue/10 text-brand-blue",
  delete: "bg-error/10 text-error",
};

export default function ActivityPage() {
  const [entries, setEntries] = useState<GlobalAuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setError("");

      try {
        const result = await getGlobalAuditLog(PAGE_SIZE, offset);
        if (!active) return;
        setEntries(result.entries);
        setTotal(result.total);
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error ? err.message : "Unable to load activity.",
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    return () => {
      active = false;
    };
  }, [offset]);

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <PageHeader
        title="Activity"
        description="Recent metadata review actions in your workspace. Use Audit explorer for document, actor, action, outcome, date, and correlation filters."
      />

      {error && (
        <div className="mb-4 rounded-xl border border-error/20 bg-error/5 p-3 text-sm text-error">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        {loading && entries.length === 0 ? (
          <p className="p-12 text-center text-sm text-text-secondary">
            Loading activity...
          </p>
        ) : entries.length === 0 ? (
          <EmptyState
            icon={History}
            title="No review actions yet"
            description="Accepts, corrections and rejections appear here as reviewers work through the review queue."
            action={
              <Link href="/review-queue" className="btn-secondary px-4 py-2 text-sm">
                Open the review queue
              </Link>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-border bg-background">
                <tr>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-text-secondary">
                    Document
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-text-secondary">
                    Field
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-text-secondary">
                    Action
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-text-secondary">
                    Reviewer
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-semibold uppercase text-text-secondary">
                    When
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, index) => (
                  <tr
                    key={index}
                    className="border-t border-border hover:bg-background"
                  >
                    <td className="px-5 py-3">
                      <Link
                        href={`/documents/${entry.document_id}/review`}
                        className="font-medium text-brand-blue hover:underline"
                      >
                        {entry.document_filename.replace(/\.[^.]+$/, "")}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-text-secondary">
                      {entry.field_key}
                    </td>
                    <td className="px-5 py-3">
                      <span
                        className={[
                          "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                          ACTION_STYLES[entry.action] ?? "bg-surface-soft text-text-secondary",
                        ].join(" ")}
                      >
                        {ACTION_LABELS[entry.action] ?? entry.action}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-text-secondary">
                      {entry.changed_by}
                    </td>
                    <td className="px-5 py-3 text-xs text-text-secondary">
                      {formatRelativeTime(entry.changed_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {total > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-text-secondary">
          <p>
            Showing {from}–{to} of {total.toLocaleString()}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setOffset((current) => Math.max(0, current - PAGE_SIZE))
              }
              disabled={offset === 0}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              Previous
            </button>
            <button
              type="button"
              onClick={() => setOffset((current) => current + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold disabled:opacity-40"
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
