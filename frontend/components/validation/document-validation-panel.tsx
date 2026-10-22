"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { ValidationCounts, ValidationResultList } from "@/components/validation/validation-results";
import { getDocumentValidation, type DocumentValidation } from "@/lib/validation-rules";

/** One document's validation-rule results, for the document Overview tab:
 * failures and misses first; passed and unchecked rules collapse. */
export default function DocumentValidationPanel({ documentId }: { documentId: string }) {
  const [loaded, setLoaded] = useState<DocumentValidation | null>(null);
  const [failure, setFailure] = useState<{ documentId: string; message: string } | null>(null);

  useEffect(() => {
    let active = true;
    getDocumentValidation(documentId)
      .then((data) => active && setLoaded(data))
      .catch(
        (err: unknown) =>
          active &&
          setFailure({ documentId, message: err instanceof Error ? err.message : "Unable to run validation rules." }),
      );
    return () => {
      active = false;
    };
  }, [documentId]);

  // Results for a previous document never show while the next one loads.
  const result = loaded?.document_id === documentId ? loaded : null;
  const error = failure?.documentId === documentId ? failure.message : "";

  const flagged = result?.results.filter((item) => item.status === "fail" || item.status === "missing") ?? [];
  const rest = result?.results.filter((item) => item.status === "pass" || item.status === "not_applicable") ?? [];

  return (
    <section className="rounded-xl border border-border bg-surface p-5" aria-label="Validation rules">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Validation rules</h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            Your pattern, required-field, amount and funding checks run against this document&apos;s extracted values.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {result?.applicable && <ValidationCounts summary={result.summary} />}
          <Link href="/playbook#validation-rules" className="text-xs text-text-secondary hover:text-primary">
            Edit rules
          </Link>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !result ? (
        <p className="text-sm text-text-secondary">Running checks…</p>
      ) : !result.applicable ? (
        <p className="rounded-lg bg-surface-soft px-3 py-4 text-center text-sm text-text-secondary">
          No validation rules are enabled.{" "}
          <Link href="/playbook#validation-rules" className="text-primary hover:underline">
            Turn on a template
          </Link>{" "}
          to check this document.
        </p>
      ) : (
        <>
          {flagged.length > 0 ? (
            <ValidationResultList results={flagged} documentId={documentId} />
          ) : (
            <p className="text-sm text-success">Every enabled rule passed.</p>
          )}
          {rest.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-xs text-text-secondary hover:text-foreground">
                {rest.length} passed or not checked
              </summary>
              <ValidationResultList results={rest} documentId={documentId} />
            </details>
          )}
        </>
      )}
    </section>
  );
}
