import Link from "next/link";

import type { ActionResult, ActionSection } from "@/lib/document-actions";

const SEVERITY_CLASS: Record<string, string> = {
  high: "font-medium text-danger",
  medium: "font-medium text-warning",
  low: "text-text-secondary",
};

function PageLink({ documentId, page }: { documentId: string; page: number | string | null | undefined }) {
  if (page === null || page === undefined || page === "") return <span className="text-text-muted">—</span>;
  return (
    <Link
      href={`/documents/${documentId}?view=source`}
      className="whitespace-nowrap text-primary hover:underline"
      title="Open the source document"
    >
      p. {page}
    </Link>
  );
}

function Section({ documentId, section }: { documentId: string; section: ActionSection }) {
  if (section.kind === "text") {
    return <p className="text-sm leading-relaxed text-foreground">{section.text}</p>;
  }
  if (section.kind === "facts") {
    return (
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
        {section.facts.map((fact) => (
          <div key={fact.label} className="min-w-0">
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">{fact.label}</dt>
            <dd className="mt-0.5 flex items-baseline gap-2 text-sm">
              <span className={`min-w-0 break-words ${fact.value ? "text-foreground" : "text-text-muted"}`}>
                {fact.value || "Not extracted"}
              </span>
              {fact.page !== null && <PageLink documentId={documentId} page={fact.page} />}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  if (section.rows.length === 0) {
    return (
      <p className="rounded-lg bg-surface-soft px-3 py-6 text-center text-sm text-text-secondary">
        {section.empty_message ?? "None."}
      </p>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
            {section.columns.map((column) => (
              <th key={column.key} className="py-2 pr-4 align-bottom">
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {section.rows.map((row, index) => (
            <tr key={index} className="align-top">
              {section.columns.map((column) => {
                const value = row[column.key];
                if (column.key === "page") {
                  return (
                    <td key={column.key} className="py-2 pr-4">
                      <PageLink documentId={documentId} page={value} />
                    </td>
                  );
                }
                const severity = column.key === "severity" ? SEVERITY_CLASS[String(value)] : undefined;
                const long = column.key === "evidence" || column.key === "rationale" || column.key === "recommendation";
                return (
                  <td
                    key={column.key}
                    className={[
                      "py-2 pr-4",
                      severity ?? (value === null || value === "" ? "text-text-muted" : "text-foreground"),
                      long ? "min-w-[14rem] max-w-md text-text-secondary" : "",
                    ].join(" ")}
                  >
                    {long && typeof value === "string" ? (
                      <span className="line-clamp-3" title={value}>
                        {value}
                      </span>
                    ) : value === null || value === "" ? (
                      "—"
                    ) : (
                      String(value)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A finished action report: warnings first, then each section. */
export default function ActionResultView({ result }: { result: ActionResult }) {
  return (
    <div className="space-y-4">
      {result.warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-text-secondary" role="note">
          {result.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {result.sections.length === 0 && result.warnings.length === 0 && (
        <p className="text-sm text-text-secondary">This action produced no output for this document.</p>
      )}
      {result.sections.map((section) => (
        <section key={section.heading} className="rounded-xl border border-border bg-surface p-5" aria-label={section.heading}>
          <h3 className="mb-3 text-sm font-semibold text-foreground">{section.heading}</h3>
          <Section documentId={result.document_id} section={section} />
        </section>
      ))}
    </div>
  );
}
