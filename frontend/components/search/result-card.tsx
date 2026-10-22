import Link from "next/link";
import { FileText } from "lucide-react";

import { highlightParts, STATUS_LABELS, type InsightsResult } from "@/lib/insights-search";

const STATUS_TONE: Record<string, string> = {
  completed: "bg-success/10 text-success",
  review_required: "bg-warning/10 text-warning",
  failed: "bg-danger/10 text-danger",
  processing: "bg-surface-soft text-text-secondary",
};

export default function ResultCard({
  result,
  selected,
  onToggle,
}: {
  result: InsightsResult;
  selected: boolean;
  onToggle: () => void;
}) {
  const href = `/documents/${result.document_id}`;
  return (
    <article className={`editorial-card p-5 transition-colors ${selected ? "ring-1 ring-primary/40" : ""}`}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${result.document_name}`}
          className="mt-1 h-4 w-4 accent-[var(--primary)]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link href={href} className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground hover:text-primary">
              <FileText className="h-4 w-4 shrink-0 text-text-muted" />
              <span className="truncate">{result.document_name}</span>
            </Link>
            <span className="rounded-md bg-surface-soft px-2 py-0.5 text-[11px] text-text-secondary">{result.document_type}</span>
            {result.family_label !== result.document_type && (
              <span className="rounded-md bg-surface-soft px-2 py-0.5 text-[11px] text-text-secondary">{result.family_label}</span>
            )}
            <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[result.status] ?? STATUS_TONE.processing}`}>
              {STATUS_LABELS[result.status] ?? result.status}
            </span>
            {result.score != null && (
              <span className="ml-auto flex items-center gap-2 text-[11px] text-text-muted" title="Relevance">
                <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-soft" aria-hidden="true">
                  <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.max(6, Math.round(result.score * 100))}%` }} />
                </span>
                <span className="tabular-nums">{Math.round(result.score * 100)}%</span>
              </span>
            )}
          </div>

          {result.facts.length > 0 && (
            <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
              {result.facts.map((fact) => (
                <div key={fact.label} className="flex min-w-0 gap-1">
                  <dt className="shrink-0 whitespace-nowrap text-text-muted">{fact.label}:</dt>
                  <dd className="min-w-0 text-foreground">
                    {fact.value}
                    {fact.page && <span className="text-text-muted"> · p. {fact.page}</span>}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {result.passages.length > 0 && (
            <ul className="mt-3 space-y-2">
              {result.passages.map((passage) => (
                <li key={`${passage.page}-${passage.snippet.slice(0, 24)}`} className="rounded-lg bg-surface-soft px-3 py-2 text-sm leading-6 text-text-secondary">
                  {highlightParts(passage.snippet, passage.highlights).map((part, index) =>
                    part.mark ? (
                      <mark key={index} className="rounded-sm bg-primary/15 px-0.5 text-foreground">
                        {part.text}
                      </mark>
                    ) : (
                      <span key={index}>{part.text}</span>
                    ),
                  )}{" "}
                  <Link href={passage.href} className="whitespace-nowrap text-xs font-medium text-primary hover:underline">
                    p. {passage.page} →
                  </Link>
                </li>
              ))}
            </ul>
          )}

          {result.matched_clauses.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Matching clauses">
              {result.matched_clauses.map((clause) => (
                <li key={clause.clause_number} className="min-w-0 max-w-full">
                  <Link
                    href={clause.page ? `${href}?view=source&page=${clause.page}&hl=${encodeURIComponent(clause.clause_number)}` : href}
                    title={clause.title ?? undefined}
                    className="inline-flex max-w-full items-center sm:max-w-[22rem] gap-1 rounded-full border border-border px-2.5 py-0.5 text-[11px] text-text-secondary hover:border-primary/40 hover:text-foreground"
                  >
                    <span className="font-id shrink-0 whitespace-nowrap font-semibold text-foreground">{clause.clause_number}</span>
                    {clause.title && <span className="truncate">{clause.title}</span>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </article>
  );
}
