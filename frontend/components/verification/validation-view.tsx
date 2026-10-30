"use client";

import { AlertCircle, AlertTriangle, Info } from "lucide-react";

import type { SourceViewRequest } from "@/components/source-verification-panel";
import DocumentValidationPanel from "@/components/validation/document-validation-panel";
import { layoutId, useRecordSelection } from "@/lib/record-selection";
import type { ValidationSummary } from "@/lib/verification";

const SEVERITY = {
  error: { icon: AlertCircle, tone: "text-danger", label: "Errors" },
  warning: { icon: AlertTriangle, tone: "text-warning", label: "Warnings" },
  info: { icon: Info, tone: "text-text-secondary", label: "Notes" },
} as const;

const ORDER = { error: 0, warning: 1, info: 2 };

/** Every exception in the document, most serious first: missing and
 * conflicting values, wrong associations, invalid dates / identifiers /
 * amounts, totals and cross-field checks. Click one to see its source. */
export default function ValidationView({ documentId, validation, onViewRecord, onViewSource }: {
  documentId: string;
  validation: ValidationSummary | null;
  onViewRecord: (key: string) => void;
  onViewSource: (request: SourceViewRequest) => void;
}) {
  const selection = useRecordSelection();
  if (!validation) return <p className="mt-4 text-sm text-text-muted">Checking the document…</p>;
  const groups = [...validation.groups].sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  return (
    <div className="mt-4 space-y-4" data-testid="validation-tab">
      <div className="flex flex-wrap gap-3 text-xs">
        {(["error", "warning", "info"] as const).map((severity) => {
          const Icon = SEVERITY[severity].icon;
          const count = validation.counts[severity === "error" ? "errors" : severity === "warning" ? "warnings" : "info"];
          return (
            <span key={severity} className={`inline-flex items-center gap-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 ${SEVERITY[severity].tone}`}>
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />{count} {SEVERITY[severity].label.toLowerCase()}
            </span>
          );
        })}
        <span className="self-center text-text-muted">Validation is separate from extraction confidence and from review decisions.</span>
      </div>
      {groups.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-muted">No exceptions found.</p>
      )}
      {groups.map((group) => {
        const Icon = SEVERITY[group.severity].icon;
        const keys = group.issues.flatMap((issue) => issue.record_keys);
        return (
          <section key={group.kind} className="rounded-xl border border-border bg-surface" data-testid="validation-group">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <Icon className={`h-4 w-4 ${SEVERITY[group.severity].tone}`} aria-hidden="true" />
              <h3 className="text-sm font-semibold text-foreground">{group.label}</h3>
              <span className="text-xs text-text-muted">{group.issues.length}</span>
              {selection && keys.length > 0 && (
                <button type="button" className="ml-auto text-xs text-primary hover:underline" onClick={() => selection.toggle(keys.map(layoutId), true)}>
                  Select these records
                </button>
              )}
            </div>
            <ul className="divide-y divide-border/60">
              {group.issues.slice(0, 200).map((issue, index) => (
                <li key={index}>
                  <button type="button" className="flex w-full flex-wrap items-baseline gap-2 px-4 py-2 text-left text-xs hover:bg-surface-soft"
                    onClick={() => (issue.record_keys[0] ? onViewRecord(issue.record_keys[0]) : issue.page && onViewSource({ pageNumber: issue.page, label: issue.message }))}>
                    <span className="text-foreground">{issue.message}</span>
                    {Object.entries(issue.values).filter(([, v]) => v).length > 0 && (
                      <span className="text-text-secondary">
                        {Object.entries(issue.values).filter(([, v]) => v).map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`).join(" · ")}
                      </span>
                    )}
                    {issue.candidates && issue.candidates.length > 1 && (
                      <span className="text-text-secondary">values: {Array.from(new Set(issue.candidates)).slice(0, 4).join(" | ")}</span>
                    )}
                    <span className="ml-auto text-text-muted">{issue.section ? `${issue.section} · ` : ""}{issue.page ? `page ${issue.page}` : ""}</span>
                  </button>
                </li>
              ))}
              {group.issues.length > 200 && <li className="px-4 py-2 text-xs text-text-muted">…and {group.issues.length - 200} more</li>}
            </ul>
          </section>
        );
      })}
      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="mb-2 text-sm font-semibold text-foreground">Workspace rules</h3>
        <DocumentValidationPanel documentId={documentId} />
      </section>
    </div>
  );
}
