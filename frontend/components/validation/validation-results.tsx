import Link from "next/link";
import { CheckCircle2, CircleHelp, MinusCircle, XCircle } from "lucide-react";

import { SeverityBadge } from "@/components/portfolio/portfolio-parts";
import type { ValidationResult, ValidationStatus, ValidationSummary } from "@/lib/validation-rules";

const STATUS: Record<ValidationStatus, { label: string; tone: string; icon: typeof CheckCircle2 }> = {
  fail: { label: "Failed", tone: "text-danger", icon: XCircle },
  missing: { label: "Field missing", tone: "text-warning", icon: CircleHelp },
  not_applicable: { label: "Not checked", tone: "text-text-muted", icon: MinusCircle },
  pass: { label: "Passed", tone: "text-success", icon: CheckCircle2 },
};

/** Status is never color alone: icon + label. */
export function ValidationStatusChip({ status }: { status: ValidationStatus }) {
  const { label, tone, icon: Icon } = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${tone}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}

/** "2 failed · 1 missing", or "All checks passed". */
export function ValidationCounts({ summary }: { summary: ValidationSummary }) {
  if (summary.fail === 0 && summary.missing === 0) {
    return <span className="text-xs font-medium text-success">All checks passed</span>;
  }
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      {summary.fail > 0 && <span className="font-medium text-danger tabular-nums">{summary.fail} failed</span>}
      {summary.missing > 0 && <span className="font-medium text-warning tabular-nums">{summary.missing} missing</span>}
    </span>
  );
}

export function ValidationResultList({ results, documentId }: { results: ValidationResult[]; documentId?: string }) {
  return (
    <ul className="divide-y divide-border" role="list">
      {results.map((result) => (
        <li key={result.rule_id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-2.5 text-sm">
          <span className="w-28 shrink-0">
            <ValidationStatusChip status={result.status} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground">{result.name}</span>
              <SeverityBadge severity={result.severity} />
            </span>
            <span className="mt-0.5 block text-xs text-text-secondary">{result.detail}</span>
          </span>
          {documentId && result.page && (
            <Link
              href={`/documents/${documentId}?view=source&page=${result.page}`}
              className="shrink-0 text-xs text-text-secondary hover:text-primary"
            >
              p. {result.page}
            </Link>
          )}
        </li>
      ))}
    </ul>
  );
}
