"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight, BookCheck, ChevronDown, ChevronRight, Loader2, Search, Sparkles } from "lucide-react";

import AskAnswer from "@/components/ask/ask-answer";
import RegulatoryComparator from "@/components/clauses/regulatory-comparator";
import ContentSection from "@/components/layout/ContentSection";
import PageHero from "@/components/layout/PageHero";
import SaveQueryButton from "@/components/playbook/save-query-button";
import { askQuestion, type AskResponse } from "@/lib/ask";
import { citationsByDocument, PRESET_PROMPTS, searchTerms } from "@/lib/clause-citations";
import { searchDocuments } from "@/lib/documents";
import { listSavedQueries, type SavedQuery } from "@/lib/playbook";
import { getPortfolio, type Portfolio } from "@/lib/portfolio";
import type { DocumentSummary } from "@/types/document";

export default function ClausesPage() {
  return (
    <Suspense>
      <ClausesContent />
    </Suspense>
  );
}

interface Results {
  query: string;
  documents: DocumentSummary[];
}

interface Answer {
  query: string;
  response: AskResponse | null;
  error: string;
}

function ClausesContent() {
  const router = useRouter();
  const initial = useSearchParams().get("q")?.trim() ?? "";
  const [query, setQuery] = useState(initial);
  const [submittedQuery, setSubmittedQuery] = useState(initial);
  const [topClauses, setTopClauses] = useState<Portfolio["clauses"]["top"]>([]);
  const [savedSearches, setSavedSearches] = useState<SavedQuery[]>([]);
  const [results, setResults] = useState<Results | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    getPortfolio()
      .then((data) => active && setTopClauses(data.clauses.top))
      .catch(() => {
        /* Suggestions are optional. */
      });
    listSavedQueries("clause_search")
      .then((items) => active && setSavedSearches(items))
      .catch(() => {
        /* Saved searches are optional. */
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!submittedQuery) return;
    let active = true;

    // The grounded answer and its page citations; a failure there never
    // drops the matching documents below.
    askQuestion(submittedQuery)
      .then((response) => active && setAnswer({ query: submittedQuery, response, error: "" }))
      .catch(
        (err: unknown) =>
          active &&
          setAnswer({
            query: submittedQuery,
            response: null,
            error: err instanceof Error ? err.message : "The question could not be answered.",
          }),
      );

    Promise.all(searchTerms(submittedQuery).map((term) => searchDocuments({ q: term, limit: 30 }).catch(() => null)))
      .then((pages) => {
        if (!active) return;
        const seen = new Set<string>();
        const documents: DocumentSummary[] = [];
        for (const page of pages) {
          for (const doc of page?.documents ?? []) {
            if (seen.has(doc.document_id)) continue;
            seen.add(doc.document_id);
            documents.push(doc);
          }
        }
        setResults({ query: submittedQuery, documents });
      });

    return () => {
      active = false;
    };
  }, [submittedQuery]);

  // Keep the query in the URL so it can be shared and shows in the breadcrumb.
  useEffect(() => {
    router.replace(submittedQuery ? `/clauses?q=${encodeURIComponent(submittedQuery)}` : "/clauses", { scroll: false });
  }, [router, submittedQuery]);

  // Results for an earlier query never show while the next one loads.
  const current = answer?.query === submittedQuery ? answer : null;
  const documents = results?.query === submittedQuery ? results.documents : null;
  const loading = Boolean(submittedQuery) && documents === null;
  const citations = current?.response ? citationsByDocument(current.response) : new Map();

  function ask(question: string) {
    const trimmed = question.trim();
    setQuery(trimmed);
    setSubmittedQuery(trimmed);
    setExpandedId(null);
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    ask(query);
  }

  return (
    <>
      <PageHero
        compact
        eyebrow="Intelligence & AI"
        title="FAR / DFARS intelligence"
        description="Ask about FAR and DFARS requirements across your contracts, check which agreements cite a clause, and compare ingested regulation texts — every answer linked to the page it came from."
      />

      <ContentSection>
        <form onSubmit={handleSubmit} className="mb-4" role="search" aria-label="Ask FAR / DFARS">
          <div className="relative">
            <Search className="pointer-events-none absolute left-5 top-1/2 h-5 w-5 -translate-y-1/2 text-text-secondary" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Ask FAR/DFARS or check cross-references"
              placeholder="Ask FAR/DFARS or check cross-references (e.g. 'Which contracts include DFARS 252.204-7012?')"
              className="w-full rounded-2xl border border-border bg-surface py-5 pl-14 pr-28 text-base shadow-sm outline-none focus:border-primary/40"
            />
            <button
              type="submit"
              disabled={!query.trim()}
              className="btn-primary absolute right-2.5 top-1/2 -translate-y-1/2 disabled:opacity-50"
            >
              Ask
            </button>
          </div>
        </form>

        <div className="mb-6 flex flex-wrap items-center gap-2" aria-label="Preset questions">
          <Sparkles className="h-3.5 w-3.5 text-text-teal" aria-hidden="true" />
          {PRESET_PROMPTS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              title={preset.question}
              onClick={() => ask(preset.question)}
              className={[
                "rounded-full border px-3 py-1.5 text-xs font-medium transition duration-200",
                submittedQuery === preset.question
                  ? "border-primary/30 bg-primary-soft text-primary"
                  : "border-border bg-surface text-text-secondary hover:border-primary/20",
              ].join(" ")}
            >
              {preset.label}
            </button>
          ))}
          {submittedQuery && (
            <span className="ml-auto">
              <SaveQueryButton kind="clause_search" query={submittedQuery} />
            </span>
          )}
        </div>

        {submittedQuery && (
          <div className="mb-6" data-testid="clauses-answer">
            {current?.response ? (
              <AskAnswer turnId="clauses" response={current.response} onAsk={ask} />
            ) : current?.error ? (
              <p className="rounded-xl border border-danger/20 bg-danger/5 p-4 text-sm text-danger">{current.error}</p>
            ) : (
              <div className="flex items-center gap-2 rounded-2xl border border-border bg-surface p-6 text-sm text-text-secondary">
                <Loader2 className="h-4 w-4 animate-spin" />
                Answering from your documents…
              </div>
            )}
          </div>
        )}

        {!submittedQuery && savedSearches.length > 0 && (
          <section className="mb-6" aria-label="Team saved searches" data-testid="clause-saved-searches">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-text-teal">
              <BookCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Team saved searches
            </p>
            <div className="flex flex-wrap gap-2">
              {savedSearches.map((saved) => (
                <button key={saved.id} type="button" title={saved.query} onClick={() => ask(saved.query)} className="chip">
                  {saved.name}
                </button>
              ))}
            </div>
          </section>
        )}

        {!submittedQuery && topClauses.length > 0 && (
          <section className="mb-6" aria-label="Most cited clauses">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-text-teal">Most cited in your documents</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {topClauses.map((clause) => (
                <button
                  key={clause.clause_number}
                  type="button"
                  onClick={() => ask(clause.clause_number)}
                  className="flex items-baseline justify-between gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-primary/40"
                >
                  <span className="min-w-0">
                    <span className="font-id block text-sm text-foreground">{clause.clause_number}</span>
                    <span className="block truncate text-xs text-text-secondary">{clause.title}</span>
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-text-muted">
                    {clause.documents} doc{clause.documents === 1 ? "" : "s"}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {submittedQuery && (
          <section className="mb-8" aria-label="Matching contracts">
            <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-text-teal">Matching contracts</p>
            {loading && (
              <div className="flex items-center gap-2 text-sm text-text-secondary">
                <Loader2 className="h-4 w-4 animate-spin" />
                Searching clauses...
              </div>
            )}
            {documents && documents.length === 0 && (
              <p className="text-sm text-text-secondary">No contracts found containing &ldquo;{submittedQuery}&rdquo;.</p>
            )}
            <div className="space-y-2">
              {(documents ?? []).map((doc) => {
                const expanded = expandedId === doc.document_id;
                const title = doc.original_filename.replace(/\.[^.]+$/, "");
                const cited = citations.get(doc.document_id);

                return (
                  <div key={doc.document_id} className="rounded-xl border border-border bg-surface">
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : doc.document_id)}
                      className="flex w-full items-center gap-3 px-5 py-4 text-left"
                    >
                      {expanded ? (
                        <ChevronDown className="h-4 w-4 text-text-secondary" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-text-secondary" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-foreground">{title}</p>
                        <p className="text-xs text-text-secondary">
                          {cited?.clause ? `Cites ${cited.clause}` : "Matches your search"}
                          {doc.counterparty ? ` · ${doc.counterparty}` : ""}
                        </p>
                      </div>
                      {cited && (
                        <Link
                          href={cited.href}
                          onClick={(event) => event.stopPropagation()}
                          aria-label={`Open the cited page${cited.page != null ? ` ${cited.page}` : ""} of ${title}`}
                          title={cited.snippet}
                          className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary-soft px-2 py-0.5 text-[11px] font-semibold text-primary hover:bg-primary hover:text-white"
                          data-testid="clause-cite-pill"
                        >
                          {cited.clause ?? "Cited"}
                          {cited.page != null && <span className="font-medium opacity-80">· p.{cited.page}</span>}
                        </Link>
                      )}
                      <Link
                        href={`/documents/${doc.document_id}/review`}
                        onClick={(event) => event.stopPropagation()}
                        className="text-xs font-semibold text-brand-blue hover:underline"
                      >
                        View Contract
                      </Link>
                    </button>

                    {expanded && (
                      <div className="border-t border-border px-5 py-4 text-sm text-text-secondary">
                        {cited ? (
                          <>
                            <blockquote className="border-l-2 border-primary/40 pl-3 text-[13px] leading-6 text-foreground">
                              {cited.snippet}
                            </blockquote>
                            <Link
                              href={cited.href}
                              className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                            >
                              Open {cited.page != null ? `page ${cited.page}` : "the cited passage"} in the source
                              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                            </Link>
                          </>
                        ) : (
                          <p>
                            Clause reference detected in contract text. Open the contract to review extracted clause
                            details, source pages, and confidence scores.
                          </p>
                        )}
                        {doc.confidence !== null && (
                          <p className="mt-2 text-xs">Document confidence: {Math.round(doc.confidence * 100)}%</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <RegulatoryComparator />
        <p className="mt-3 text-xs text-text-secondary">
          Comparing one clause across contracts instead?{" "}
          <Link href="/clauses/compare?mode=contracts" className="font-medium text-primary hover:underline">
            Open the cross-contract comparison
          </Link>
        </p>
      </ContentSection>
    </>
  );
}
