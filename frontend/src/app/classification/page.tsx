"use client";

import { ShieldQuestion } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import ClassificationPanel, { STATUS_TONE } from "@/components/classification/classification-panel";
import ConsoleHeader from "@/components/layout/ConsoleHeader";
import { ErrorState, LoadingState } from "@/components/layout/StatusState";
import SourceVerificationPanel from "@/components/source-verification-panel";
import { STATUS_LABELS, classificationQueue, type ClassificationQueueItem } from "@/lib/classification";

type Filter = "pending" | "review_required" | "review_recommended";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "pending", label: "All needing review" },
  { id: "review_required", label: "Review required" },
  { id: "review_recommended", label: "Review recommended" },
];

/** Documents whose type a person should confirm, most uncertain first. */
export default function ClassificationReviewPage() {
  const [filter, setFilter] = useState<Filter>("pending");
  const [items, setItems] = useState<ClassificationQueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ClassificationQueueItem | null>(null);

  const load = useCallback((which: Filter) => {
    classificationQueue(which)
      .then((rows) => {
        setError(null);
        setItems(rows);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load the queue."));
  }, []);

  useEffect(() => {
    load(filter);
  }, [filter, load]);

  return (
    <div className="workspace-page w-full" data-testid="classification-review">
      <ConsoleHeader
        icon={ShieldQuestion}
        title="Classification review"
        description="Documents whose type couldn't be established with enough evidence, or where the evidence is mixed. Confirm the type or choose another; the document is re-extracted with that schema and nothing extracted is lost."
        tabsLabel="Queue filter"
        tabs={FILTERS.map((item) => ({
          id: item.id,
          label: item.label,
          count: item.id === filter ? items?.length : undefined,
          active: filter === item.id,
          onSelect: () => {
            setSelected(null);
            setFilter(item.id);
          },
        }))}
      />
      <div className="px-4 py-5 sm:px-6">
        {error ? (
          <ErrorState error={error} onRetry={() => load(filter)} />
        ) : items === null ? (
          <LoadingState title="Loading…" compact />
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-surface px-6 py-12 text-center text-sm text-text-muted">
            Nothing to review — every document&apos;s type is established or confirmed.
          </div>
        ) : (
          <div className={`grid gap-4 ${selected ? "xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(360px,0.9fr)]" : ""}`}>
            <section className="overflow-hidden rounded-xl border border-border bg-surface" aria-label="Queue">
              <table className="w-full text-sm" data-testid="classification-queue">
                <thead className="bg-surface-soft text-left text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                  <tr>
                    <th className="px-3 py-2.5">Document</th>
                    <th className="px-3 py-2.5">Predicted type</th>
                    <th className="px-3 py-2.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr
                      key={item.document_id}
                      onClick={() => setSelected(item)}
                      className={`cursor-pointer border-t border-border/70 ${selected?.document_id === item.document_id ? "bg-primary/[0.06]" : "hover:bg-surface-soft"}`}
                    >
                      <td className="max-w-[16rem] px-3 py-2.5">
                        <p className="truncate font-medium text-foreground">{item.original_filename}</p>
                        <p className="text-xs text-text-muted">{item.page_count} p.</p>
                      </td>
                      <td className="px-3 py-2.5">
                        <p className="text-foreground">
                          {item.family_label}
                          {item.confidence != null && (
                            <span className="ml-1 text-xs text-text-muted">{Math.round(item.confidence * 100)}%</span>
                          )}
                        </p>
                        {item.top_alternatives.length > 0 && (
                          <p className="truncate text-xs text-text-secondary">
                            or {item.top_alternatives.map((a) => `${a.label} ${Math.round(a.score * 100)}%`).join(", ")}
                          </p>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[item.status]}`}>
                          {STATUS_LABELS[item.status]}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            {selected && (
              <>
                <section className="min-h-[480px] overflow-hidden rounded-xl border border-border bg-surface" aria-label="Document preview">
                  <SourceVerificationPanel
                    key={selected.document_id}
                    documentId={selected.document_id}
                    documentName={selected.original_filename}
                    pageCount={selected.page_count || 1}
                    request={{ pageNumber: 1, label: selected.original_filename }}
                  />
                </section>
                <section className="rounded-xl border border-border bg-surface p-4" aria-label="Classification">
                  <ClassificationPanel
                    key={selected.document_id}
                    documentId={selected.document_id}
                    onChanged={() => {
                      setSelected(null);
                      load(filter);
                    }}
                  />
                  <Link href={`/documents/${selected.document_id}`} className="mt-4 inline-block text-xs font-medium text-primary hover:underline">
                    Open document workspace →
                  </Link>
                </section>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
