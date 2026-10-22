import Link from "next/link";

import { SeverityBadge } from "@/components/portfolio/portfolio-parts";
import { STATUS_LABELS, type PlaybookFinding, type PlaybookSummary } from "@/lib/playbook";

const STATUS_TONE: Record<PlaybookFinding["status"], string> = {
  missing: "text-danger",
  present_prohibited: "text-danger",
  present_review: "text-warning",
  present_text_match: "text-primary",
  satisfied: "text-success",
};

/** High / medium / low deviation counts as compact pills; "No deviations"
 * when there are none. */
export function DeviationCounts({ summary }: { summary: PlaybookSummary }) {
  const textMatches = summary.text_matches ?? 0;
  if (summary.deviations === 0) {
    return (
      <span className="text-xs font-medium text-success">
        No deviations
        {textMatches > 0 && (
          <span className="ml-1.5 font-normal text-primary">
            · {textMatches} text {textMatches === 1 ? "match" : "matches"} to confirm
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {(["high", "medium", "low"] as const)
        .filter((level) => summary[level] > 0)
        .map((level) => (
          <span key={level} className="inline-flex items-center gap-1 text-xs text-text-secondary">
            <SeverityBadge severity={level} />
            <span className="tabular-nums text-foreground">{summary[level]}</span>
          </span>
        ))}
    </span>
  );
}

export function PlaybookFindingList({ findings, documentId }: { findings: PlaybookFinding[]; documentId?: string }) {
  return (
    <ul className="divide-y divide-border" role="list">
      {findings.map((finding) => (
        <li key={finding.rule_id} className="flex flex-wrap items-start gap-x-4 gap-y-1 py-2.5 text-sm">
          <span className="w-20 shrink-0">
            <SeverityBadge severity={finding.severity} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-foreground">
              <span className="font-id font-medium">{finding.clause_number}</span>
              {finding.title && <span className="text-text-secondary"> · {finding.title}</span>}
            </p>
            {finding.rationale && <p className="mt-0.5 text-xs text-text-secondary">{finding.rationale}</p>}
            {finding.status === "present_text_match" && finding.pattern_match && (
              <p className="mt-0.5 text-xs text-primary">
                Not cited as a clause; {finding.pattern_match.kind} “{finding.pattern_match.pattern}” matched the page
                text{finding.pattern_match.note ? ` (${finding.pattern_match.note})` : ""}.
              </p>
            )}
            {finding.evidence && (
              <p className="mt-0.5 truncate text-xs text-text-muted" title={finding.evidence}>
                “{finding.evidence}”
              </p>
            )}
          </div>
          <span className={`shrink-0 text-xs font-medium ${STATUS_TONE[finding.status]}`}>
            {STATUS_LABELS[finding.status]}
            {finding.page != null &&
              (documentId ? (
                <Link
                  href={`/documents/${documentId}?view=source`}
                  className="ml-1.5 font-normal text-text-secondary hover:text-primary"
                >
                  p. {finding.page}
                </Link>
              ) : (
                <span className="ml-1.5 font-normal text-text-secondary">p. {finding.page}</span>
              ))}
          </span>
        </li>
      ))}
    </ul>
  );
}
