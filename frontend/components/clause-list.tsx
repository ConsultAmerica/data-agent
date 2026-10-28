import { Eye, ScrollText } from "lucide-react";

import ConfidenceBadge from "@/components/confidence-badge";
import type { ClauseResult } from "@/types/document";
import { sourcePageLabel } from "@/lib/source-page";

interface ClauseListProps {
  clauses: ClauseResult[];
  onViewSource: (clause: ClauseResult) => void;
}

export default function ClauseList({
  clauses,
  onViewSource,
}: ClauseListProps) {
  if (clauses.length === 0) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center gap-2">
        <ScrollText className="h-4 w-4 text-blue-600" />
        <h2 className="text-sm font-semibold text-slate-950">
          Clauses
        </h2>
        <span className="text-xs text-slate-400">
          {clauses.length} found
        </span>
      </div>

      <div className="mt-4 space-y-3">
        {clauses.map((clause, index) => (
          <div
            key={`${clause.clause_type}-${index}`}
            className="rounded-xl border border-slate-200 bg-slate-50 p-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {clause.clause_type}
              </p>
              <ConfidenceBadge confidence={clause.confidence} />
            </div>

            <p className="mt-1 text-sm font-semibold text-slate-900">
              {clause.classification}
            </p>

            {clause.value_summary && (
              <p className="mt-0.5 text-sm text-slate-600">
                Value: {clause.value_summary}
              </p>
            )}

            <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-600">
              <p className="whitespace-pre-wrap">
                {clause.extracted_text}
              </p>
            </div>

            <button
              type="button"
              onClick={() => onViewSource(clause)}
              className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-700 hover:text-blue-800"
            >
              <Eye className="h-3.5 w-3.5" />
              View Source ({sourcePageLabel(clause.evidence.page_number)})
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
