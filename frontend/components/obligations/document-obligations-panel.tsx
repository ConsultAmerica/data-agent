"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import ObligationStatusChip from "@/components/obligations/obligation-status-chip";
import { dueLabel, getDocumentObligations, type ObligationsResult } from "@/lib/obligations";

const SHOWN = 6;

/** A document's most urgent obligations, for its Overview tab. */
export default function DocumentObligationsPanel({ documentId }: { documentId: string }) {
  // Keyed by document so a switch never shows the previous document's list.
  const [loaded, setLoaded] = useState<{ id: string; data?: ObligationsResult; error?: string } | null>(null);

  useEffect(() => {
    let active = true;
    getDocumentObligations(documentId)
      .then((result) => active && setLoaded({ id: documentId, data: result }))
      .catch((err: unknown) =>
        active && setLoaded({ id: documentId, error: err instanceof Error ? err.message : "Unable to load obligations." }),
      );
    return () => {
      active = false;
    };
  }, [documentId]);

  const current = loaded?.id === documentId ? loaded : null;
  const data = current?.data ?? null;
  const error = current?.error ?? "";

  const total = data?.counts.total ?? 0;
  const urgent = data ? data.counts.overdue + data.counts.due_soon : 0;

  return (
    <section className="rounded-xl border border-border bg-surface p-5" aria-label="Obligations">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Obligations</h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            {data
              ? total === 0
                ? "No obligations found in this document."
                : `${total.toLocaleString()} found${urgent ? ` · ${urgent} overdue or due within 30 days` : ""}`
              : error
                ? error
                : "Reading schedules, clauses and text…"}
          </p>
        </div>
        {total > 0 && (
          <Link
            href={`/obligations?document_id=${encodeURIComponent(documentId)}`}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            View all
            <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        )}
      </div>
      {data && total > 0 && (
        <ul className="divide-y divide-border" role="list">
          {data.obligations.slice(0, SHOWN).map((item) => (
            <li key={item.obligation_id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground" title={item.title}>
                  {item.title}
                </p>
                <p className="mt-0.5 text-xs text-text-secondary">
                  <span className="font-id">{item.source_reference}</span>
                  {item.page ? ` · p. ${item.page}` : ""}
                  {item.trigger ? ` · ${item.trigger}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs tabular-nums text-text-secondary">{dueLabel(item)}</span>
                <ObligationStatusChip status={item.status} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
