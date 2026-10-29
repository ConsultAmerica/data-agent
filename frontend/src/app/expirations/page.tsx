"use client";

import { CalendarClock } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import ContentSection from "@/components/layout/ContentSection";
import PageHero from "@/components/layout/PageHero";
import { ErrorState, LoadingState } from "@/components/layout/StatusState";
import EmptyState from "@/components/ui/empty-state";
import {
  evidenceHref,
  formatKeyDate,
  keyDateText,
  KIND_LABELS,
  listKeyDates,
  relativeLabel,
  SOURCE_LABELS,
  type KeyDate,
  type KeyDateStatus,
} from "@/lib/key-dates";

type Filter = "attention" | "expired" | "expiring" | "upcoming";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "attention", label: "Needs attention" },
  { id: "expired", label: "Expired" },
  { id: "expiring", label: "Expiring soon" },
  { id: "upcoming", label: "Later" },
];
const STATUS_STYLE: Record<KeyDateStatus, string> = {
  expired: "bg-danger/10 text-danger",
  expiring: "bg-warning/10 text-warning",
  upcoming: "bg-success/10 text-success",
  past: "bg-surface-soft text-text-secondary",
  ambiguous: "bg-warning/10 text-warning",
};
const STATUS_LABEL: Record<KeyDateStatus, string> = {
  expired: "Expired",
  expiring: "Expiring soon",
  upcoming: "Valid",
  past: "Past",
  ambiguous: "Date needs review",
};

export default function ExpirationsPage() {
  const [rows, setRows] = useState<KeyDate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("attention");

  const load = useCallback(() => {
    setError(null);
    listKeyDates()
      .then(setRows)
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load key dates."));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const counts = useMemo(() => {
    const all = rows ?? [];
    return {
      expired: all.filter((r) => r.status === "expired").length,
      expiring: all.filter((r) => r.status === "expiring").length,
      upcoming: all.filter((r) => r.status === "upcoming").length,
    };
  }, [rows]);

  const visible = useMemo(() => {
    const all = rows ?? [];
    if (filter === "attention") return all.filter((r) => r.status === "expired" || r.status === "expiring");
    return all.filter((r) => r.status === filter);
  }, [rows, filter]);

  return (
    <>
      <PageHero
        compact
        eyebrow="Compliance & Controls"
        title="Expirations"
        description="Passports, visas, IDs, certificates, policies and contracts — every expiry, validity or period end a document states, found automatically, with the page it came from."
      />
      <ContentSection>
        <div className="mb-3 flex flex-wrap items-center gap-2" role="tablist" aria-label="Filter">
          {FILTERS.map((item) => {
            const count =
              item.id === "attention" ? counts.expired + counts.expiring : counts[item.id as keyof typeof counts];
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={filter === item.id}
                onClick={() => setFilter(item.id)}
                className={`rounded-full border px-3 py-1 text-xs font-medium ${
                  filter === item.id ? "border-primary bg-primary-soft text-primary" : "border-border bg-surface text-text-secondary"
                }`}
              >
                {item.label}
                <span className="ml-1 text-text-muted">{rows ? count : ""}</span>
              </button>
            );
          })}
        </div>

        {error ? (
          <ErrorState error={error} onRetry={load} />
        ) : rows === null ? (
          <LoadingState title="Loading expirations…" compact />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title={filter === "attention" ? "Nothing has expired or expires soon" : "No documents here"}
            description="Dates are detected when a document is processed: machine-readable zones, contract schedules and labelled dates such as “Expiration Date” or “Valid until”."
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-surface">
            <table className="min-w-full text-left text-sm" data-testid="expirations-table">
              <thead className="bg-surface-soft text-xs uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Document</th>
                  <th className="px-3 py-2 font-medium">What</th>
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium">Found in</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {visible.map((row) => (
                  <tr key={`${row.document_id}-${row.kind}-${row.date}`}>
                    <td className="px-3 py-2">
                      <Link href={`/documents/${row.document_id}`} className="font-medium text-foreground hover:text-primary">
                        {row.document_name || row.document_id}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-text-secondary">
                      <span className="text-foreground">{KIND_LABELS[row.kind] ?? row.kind}</span>
                      <span className="block text-xs">{row.label}</span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-foreground">
                      {keyDateText(row)}
                      {row.ambiguous && row.interpretations?.length ? (
                        <span className="block text-xs text-warning">Could be {row.interpretations.map(formatKeyDate).join(" or ")}</span>
                      ) : null}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[row.status]}`}>
                        {STATUS_LABEL[row.status]}
                      </span>
                      {!row.ambiguous && <span className="ml-2 text-xs text-text-secondary">{relativeLabel(row)}</span>}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      <Link href={evidenceHref(row)} className="text-primary hover:underline">
                        {SOURCE_LABELS[row.source] ?? row.source}
                        {row.page ? `, page ${row.page}` : ""}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ContentSection>
    </>
  );
}
