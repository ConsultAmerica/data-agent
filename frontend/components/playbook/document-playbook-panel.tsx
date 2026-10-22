"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { DeviationCounts, PlaybookFindingList } from "@/components/playbook/playbook-findings";
import { getDocumentPlaybook, type DocumentPlaybook } from "@/lib/playbook";

/** One document's clause playbook check, for the document Overview tab:
 * deviation counts, then deviations first; satisfied rules collapse. */
export default function DocumentPlaybookPanel({ documentId }: { documentId: string }) {
  const [loaded, setLoaded] = useState<DocumentPlaybook | null>(null);
  const [failure, setFailure] = useState<{ documentId: string; message: string } | null>(null);

  useEffect(() => {
    let active = true;
    getDocumentPlaybook(documentId)
      .then((data) => active && setLoaded(data))
      .catch(
        (err: unknown) =>
          active &&
          setFailure({ documentId, message: err instanceof Error ? err.message : "Unable to check the clause playbook." }),
      );
    return () => {
      active = false;
    };
  }, [documentId]);

  // Results for a previous document never show while the next one loads.
  const result = loaded?.document_id === documentId ? loaded : null;
  const error = failure?.documentId === documentId ? failure.message : "";

  const deviations = result?.findings.filter((finding) => finding.status !== "satisfied") ?? [];
  const satisfied = result?.findings.filter((finding) => finding.status === "satisfied") ?? [];

  return (
    <section className="rounded-xl border border-border bg-surface p-5" aria-label="Clause playbook">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Clause playbook</h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            Cited clauses checked against your expected, prohibited and review-worthy clauses.
            {result?.applicable && (result.is_dod ? " DoD rules apply (DFARS clauses listed)." : " Civilian rules only.")}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {result?.applicable && <DeviationCounts summary={result.summary} />}
          <Link href="/playbook" className="text-xs text-text-secondary hover:text-primary">
            Edit playbook
          </Link>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !result ? (
        <p className="text-sm text-text-secondary">Checking clauses…</p>
      ) : !result.applicable ? (
        <p className="rounded-lg bg-surface-soft px-3 py-4 text-center text-sm text-text-secondary">
          Not applicable — no clauses detected in this document.
        </p>
      ) : (
        <>
          {deviations.length > 0 ? (
            <PlaybookFindingList findings={deviations} documentId={documentId} />
          ) : (
            <p className="text-sm text-success">Every applicable playbook rule is satisfied.</p>
          )}
          {satisfied.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-text-secondary hover:text-foreground">
                {satisfied.length} satisfied {satisfied.length === 1 ? "rule" : "rules"}
              </summary>
              <PlaybookFindingList findings={satisfied} documentId={documentId} />
            </details>
          )}
        </>
      )}
    </section>
  );
}
