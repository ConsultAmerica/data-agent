"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Search } from "lucide-react";

import RegulatoryComparator from "@/components/clauses/regulatory-comparator";
import ConfidenceIndicator from "@/components/confidence-indicator";
import PageHeader from "@/components/page-header";
import { getClauses, searchDocuments } from "@/lib/documents";
import type { ClauseResult } from "@/types/document";

interface ComparedClause {
  documentId: string;
  contractTitle: string;
  clause: ClauseResult | null;
}

type CompareMode = "regulatory" | "contracts";

export default function ClauseComparePage() {
  return (
    <Suspense>
      <ClauseCompareContent />
    </Suspense>
  );
}

/** Two comparisons: ingested regulation texts (two versions of a clause, or
 * a FAR clause and its DFARS counterpart), and one clause across contracts. */
function ClauseCompareContent() {
  const router = useRouter();
  const params = useSearchParams();
  const mode: CompareMode = params.get("mode") === "contracts" ? "contracts" : "regulatory";
  const clause = params.get("clause")?.trim() ?? "";

  return (
    <div className="page-container-wide">
      <PageHeader
        title="Compare clauses"
        description="Compare ingested FAR / DFARS regulation texts word by word, or the same clause provision across your contracts."
      />
      <div className="mb-6 flex gap-1 rounded-lg border border-border p-0.5 sm:w-fit" role="tablist" aria-label="Comparison">
        {(
          [
            ["regulatory", "Regulation texts"],
            ["contracts", "Across contracts"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={mode === id}
            onClick={() => router.replace(id === "contracts" ? "/clauses/compare?mode=contracts" : "/clauses/compare", { scroll: false })}
            className={[
              "rounded-md px-3 py-1.5 text-sm font-medium",
              mode === id ? "bg-primary-soft text-primary" : "text-text-secondary hover:text-foreground",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === "regulatory" ? <RegulatoryComparator key={clause} initialClause={clause} /> : <CrossContractCompare />}
    </div>
  );
}

function CrossContractCompare() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [results, setResults] = useState<ComparedClause[]>([]);

  async function handleCompare(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;

    setLoading(true);
    setError("");
    setResults([]);

    try {
      const search = await searchDocuments({ q: trimmed, limit: 5 });
      const compared = await Promise.all(
        search.documents.map(async (doc) => {
          try {
            const extraction = await getClauses(doc.document_id);
            const match =
              extraction.clauses.find(
                (clause) =>
                  clause.clause_type.includes(trimmed) ||
                  clause.extracted_text.includes(trimmed) ||
                  clause.value_summary.includes(trimmed),
              ) ?? extraction.clauses[0] ?? null;

            return {
              documentId: doc.document_id,
              contractTitle: doc.original_filename.replace(/\.[^.]+$/, ""),
              clause: match,
            };
          } catch {
            return {
              documentId: doc.document_id,
              contractTitle: doc.original_filename.replace(/\.[^.]+$/, ""),
              clause: null,
            };
          }
        }),
      );

      setResults(compared.filter((item) => item.clause));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to compare clauses.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <p className="mb-4 text-sm text-text-secondary">Compare the same clause provision across multiple contracts.</p>
      <form onSubmit={handleCompare} className="max-w-2xl">
        <div className="relative">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="FAR 52.232-7"
            className="w-full rounded-2xl border border-border bg-surface py-3.5 pl-11 pr-4 text-[15px] outline-none focus:border-primary/30"
          />
        </div>
        <button type="submit" disabled={loading} className="btn-primary mt-4">
          {loading ? "Comparing..." : "Compare Across Contracts"}
        </button>
      </form>

      {error && (
        <div className="mt-6 rounded-2xl border border-danger/20 bg-danger/5 p-4 text-sm text-danger">
          {error}
        </div>
      )}

      {loading && (
        <div className="mt-10 flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin" />
          Detecting FAR / DFARS clauses...
        </div>
      )}

      {results.length > 0 && (
        <div className="mt-10 overflow-x-auto">
          <div
            className="grid gap-4"
            style={{
              gridTemplateColumns: `repeat(${results.length}, minmax(280px, 1fr))`,
            }}
          >
            {results.map((item) => (
              <div key={item.documentId} className="editorial-card p-6">
                <Link
                  href={`/documents/${item.documentId}/review`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  {item.contractTitle}
                </Link>
                {item.clause ? (
                  <>
                    <p className="mt-3 text-xs text-text-secondary">
                      {item.clause.clause_type}
                    </p>
                    <p className="mt-2 text-sm leading-6 text-foreground">
                      {item.clause.extracted_text}
                    </p>
                    <div className="mt-4 flex items-center justify-between text-xs text-text-secondary">
                      <span>Page {item.clause.evidence.page_number}</span>
                      <ConfidenceIndicator confidence={item.clause.confidence} />
                    </div>
                  </>
                ) : (
                  <p className="mt-3 text-sm text-text-secondary">
                    Clause not found in this contract.
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
