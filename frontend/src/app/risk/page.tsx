"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { FileSearch, ShieldCheck } from "lucide-react";

import ContentSection from "@/components/layout/ContentSection";
import PageHero from "@/components/layout/PageHero";
import EmptyState from "@/components/ui/empty-state";
import {
  EmptyNote,
  Panel,
  PortfolioGate,
  SeverityBadge,
  StatTile,
  usePortfolio,
} from "@/components/portfolio/portfolio-parts";
import type { RiskItem, RiskSeverity } from "@/lib/portfolio";

type Filter = "all" | RiskSeverity;
const PAGE_SIZE = 25;

export default function RiskPage() {
  const { portfolio, error, retry } = usePortfolio();
  return (
    <>
      <PageHero
        compact
        eyebrow="Administration"
        title="Risk register"
        description="Documents that need attention: failed processing, periods of performance ending, unreviewed low-confidence values, missing contract numbers and duplicates."
      />
      <ContentSection>
        <PortfolioGate portfolio={portfolio} error={error} retry={retry}>
          {(data) => (
            <div className="space-y-6">
              <div className="grid gap-3 sm:grid-cols-3">
                <StatTile label="High" value={data.risks.by_severity.high.toLocaleString()} hint="Act now" />
                <StatTile label="Medium" value={data.risks.by_severity.medium.toLocaleString()} hint="Review soon" />
                <StatTile label="Low" value={data.risks.by_severity.low.toLocaleString()} hint="Housekeeping" />
              </div>
              <RiskTable
                items={data.risks.items}
                total={data.risks.total}
                kinds={data.risks.by_kind.map((kind) => kind.name)}
                documents={data.totals.documents}
              />
            </div>
          )}
        </PortfolioGate>
      </ContentSection>
    </>
  );
}

function RiskTable({
  items,
  total,
  kinds,
  documents,
}: {
  items: RiskItem[];
  total: number;
  kinds: string[];
  documents: number;
}) {
  const [severity, setSeverity] = useState<Filter>("all");
  const [kind, setKind] = useState("all");
  const [page, setPage] = useState(0);
  const filtered = useMemo(
    () => items.filter((item) => (severity === "all" || item.severity === severity) && (kind === "all" || item.kind === kind)),
    [items, severity, kind],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clamped = Math.min(page, pages - 1);
  const shown = filtered.slice(clamped * PAGE_SIZE, clamped * PAGE_SIZE + PAGE_SIZE);

  return (
    <Panel
      title="Findings"
      description={total > items.length ? `Showing the ${items.length} most severe of ${total.toLocaleString()} findings.` : `${total.toLocaleString()} findings.`}
      action={
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-0.5 rounded-lg border border-border bg-surface-soft p-0.5 text-xs" role="group" aria-label="Severity">
            {(["all", "high", "medium", "low"] as Filter[]).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={severity === value}
                onClick={() => {
                  setSeverity(value);
                  setPage(0);
                }}
                className={`rounded-md px-2.5 py-1 font-medium capitalize ${severity === value ? "bg-surface text-foreground shadow-sm" : "text-text-secondary hover:text-foreground"}`}
              >
                {value}
              </button>
            ))}
          </div>
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
              setPage(0);
            }}
            aria-label="Finding type"
            className="rounded-lg border border-border bg-surface px-2 py-1 text-xs text-foreground"
          >
            <option value="all">All types</option>
            {kinds.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {total === 0 ? (
        documents > 0 ? (
          <EmptyState
            icon={ShieldCheck}
            tone="success"
            title="No risks found"
            description={`All ${documents.toLocaleString()} ${documents === 1 ? "document was" : "documents were"} checked: none failed processing, has a period of performance ending, unreviewed low-confidence values, a missing contract number or a duplicate.`}
          />
        ) : (
          <EmptyState
            icon={FileSearch}
            title="Nothing to check yet"
            description="Risks are found in processed documents. Upload a contract to see its findings here."
            action={
              <Link href="/extraction/new" className="btn-primary px-4 py-2 text-sm">
                Start an extraction
              </Link>
            }
          />
        )
      ) : filtered.length === 0 ? (
        <EmptyNote>No findings match this filter.</EmptyNote>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                  <th className="py-2 pr-4">Severity</th>
                  <th className="py-2 pr-4">Finding</th>
                  <th className="py-2 pr-4">Document</th>
                  <th className="py-2">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.map((item, index) => (
                  <tr key={`${item.document_id}:${item.kind}:${index}`} className="align-top">
                    <td className="py-2.5 pr-4">
                      <SeverityBadge severity={item.severity} />
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-4 text-foreground">{item.kind}</td>
                    <td className="max-w-[18rem] py-2.5 pr-4">
                      <Link href={`/documents/${item.document_id}`} className="block truncate text-foreground hover:text-primary" title={item.filename}>
                        {item.filename || item.document_id}
                      </Link>
                    </td>
                    <td className="py-2.5 text-text-secondary">{item.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div className="mt-3 flex items-center justify-between text-xs text-text-secondary">
              <button type="button" disabled={clamped === 0} onClick={() => setPage(clamped - 1)} className="rounded-md border border-border px-2.5 py-1 disabled:opacity-40">
                Previous
              </button>
              <span>
                Page {clamped + 1} of {pages}
              </span>
              <button type="button" disabled={clamped >= pages - 1} onClick={() => setPage(clamped + 1)} className="rounded-md border border-border px-2.5 py-1 disabled:opacity-40">
                Next
              </button>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}
