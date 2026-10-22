"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Download, GitCompareArrows, Loader2, Search, SlidersHorizontal, X } from "lucide-react";

import AiAnswerCard from "@/components/search/ai-answer-card";
import FacetRail from "@/components/search/facet-rail";
import ResultCard from "@/components/search/result-card";
import {
  activeFilterCount,
  EXAMPLE_QUERIES,
  loadSavedViews,
  PAGE_SIZE,
  paramsFromQuery,
  queryFromParams,
  resultsCsv,
  searchInsights,
  storeSavedViews,
  type InsightsFilters,
  type InsightsQuery,
  type InsightsResponse,
  type InsightsResult,
  type SavedView,
} from "@/lib/insights-search";

export default function InsightsSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = useMemo(() => queryFromParams(new URLSearchParams(searchParams.toString())), [searchParams]);
  const queryKey = paramsFromQuery(query).toString();

  const [draft, setDraft] = useState(query.q);
  const [draftFor, setDraftFor] = useState(query.q);
  const [tick, setTick] = useState(0);
  // The last finished request; results stay on screen while the next loads.
  const [outcome, setOutcome] = useState<{ key: string; data: InsightsResponse | null; error: string }>({
    key: "",
    data: null,
    error: "",
  });
  const [selected, setSelected] = useState<Map<string, InsightsResult>>(new Map());
  // Rendered only in the browser (below the search-params Suspense boundary).
  const [views, setViews] = useState<SavedView[]>(() => loadSavedViews());
  const [railOpen, setRailOpen] = useState(false);

  // A new ?q= (back button, saved view, chip) replaces what's in the box.
  if (draftFor !== query.q) {
    setDraftFor(query.q);
    setDraft(query.q);
  }

  const requestKey = `${queryKey}#${tick}`;
  const loading = outcome.key !== requestKey;
  const data = outcome.data;
  const error = loading ? "" : outcome.error;

  useEffect(() => {
    let active = true;
    searchInsights(query)
      .then((result) => active && setOutcome({ key: requestKey, data: result, error: "" }))
      .catch(
        (err: unknown) =>
          active &&
          setOutcome((current) => ({
            key: requestKey,
            data: current.data,
            error: err instanceof Error ? err.message : "Search failed.",
          })),
      );
    return () => {
      active = false;
    };
    // requestKey captures every input of `query` plus retries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  function navigate(next: InsightsQuery) {
    const params = paramsFromQuery(next).toString();
    router.replace(params ? `${pathname}?${params}` : pathname);
  }

  function submit(text: string) {
    navigate({ ...query, q: text.trim(), page: 1 });
  }

  function setFilters(filters: InsightsFilters) {
    navigate({ ...query, filters, page: 1 });
  }

  function toggleSelected(result: InsightsResult) {
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(result.document_id)) next.delete(result.document_id);
      else next.set(result.document_id, result);
      return next;
    });
  }

  function exportSelected() {
    const csv = resultsCsv([...selected.values()], window.location.origin);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `insights-search-${selected.size}-results.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function saveView(name: string) {
    const view: SavedView = { id: `${Date.now()}`, name, q: query.q, filters: query.filters, sort: query.sort };
    const next = [...views.filter((item) => item.name !== name), view];
    setViews(next);
    storeSavedViews(next);
  }

  function deleteView(id: string) {
    const next = views.filter((view) => view.id !== id);
    setViews(next);
    storeSavedViews(next);
  }

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  const filterCount = activeFilterCount(query.filters);
  const selectedIds = [...selected.keys()];

  const rail = (
    <FacetRail
      facets={data?.facets ?? null}
      filters={query.filters}
      onChange={setFilters}
      views={views}
      onSaveView={saveView}
      onApplyView={(view) => navigate({ q: view.q, filters: view.filters, sort: view.sort, page: 1 })}
      onDeleteView={deleteView}
    />
  );

  return (
    // Long file names and clause numbers break instead of widening the page on phones.
    <div className="min-w-0 space-y-6 [overflow-wrap:break-word]">
      <header>
        <p className="section-eyebrow">Insights</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">Contract Insights Search</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Search the full text of every document, not just file names. Matches are highlighted on the page they came from.
        </p>
      </header>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(draft);
        }}
        className="ai-surface rounded-[20px] p-2"
        role="search"
      >
        <div className="flex items-center gap-2 rounded-2xl bg-surface px-4 py-2.5">
          <Search className="h-5 w-5 shrink-0 text-text-muted" />
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Search clauses, parties, amounts, obligations… or ask a question"
            aria-label="Search documents"
            className="min-w-0 flex-1 bg-transparent py-1.5 text-base outline-none placeholder:text-text-secondary"
          />
          {draft && (
            <button type="button" onClick={() => submit("")} aria-label="Clear search" className="text-text-muted hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          )}
          <button type="submit" className="btn-primary px-4 py-2 text-sm">
            Search
          </button>
        </div>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        {EXAMPLE_QUERIES.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => submit(example)}
            className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-text-secondary hover:border-primary/40 hover:text-foreground"
          >
            {example}
          </button>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-20 lg:self-start">
          {/* .btn-secondary sets display outside Tailwind's layer, so the wrapper hides it on desktop. */}
          <div className="lg:hidden">
            <button
              type="button"
              onClick={() => setRailOpen((open) => !open)}
              aria-expanded={railOpen}
              className="btn-secondary mb-3 inline-flex w-full items-center justify-center gap-2 px-3 py-2 text-sm"
            >
              <SlidersHorizontal className="h-4 w-4" />
              Filters{filterCount > 0 ? ` (${filterCount})` : ""}
            </button>
          </div>
          <div className={`${railOpen ? "block" : "hidden"} editorial-card p-4 lg:block`}>{rail}</div>
        </aside>

        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-text-secondary" aria-live="polite">
              {loading && !data ? (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Searching…
                </span>
              ) : data ? (
                <>
                  <span className="font-medium text-foreground">{data.total.toLocaleString()}</span>{" "}
                  {data.total === 1 ? "document" : "documents"}
                  {query.q ? <> for “{query.q}”</> : ""}
                  <span className="text-text-muted"> · {data.took_ms} ms</span>
                </>
              ) : null}
            </p>
            <div className="inline-flex rounded-lg border border-border p-0.5 text-xs" role="group" aria-label="Sort">
              {(["relevance", "newest"] as const).map((sort) => (
                <button
                  key={sort}
                  type="button"
                  aria-pressed={query.sort === sort}
                  disabled={sort === "relevance" && !query.q}
                  onClick={() => navigate({ ...query, sort, page: 1 })}
                  className={[
                    "rounded-md px-2.5 py-1 capitalize disabled:opacity-40",
                    query.sort === sort && (sort === "newest" || query.q) ? "bg-primary/10 font-medium text-primary" : "text-text-secondary",
                  ].join(" ")}
                >
                  {sort}
                </button>
              ))}
            </div>
          </div>

          {selected.size > 0 && (
            <div className="sticky top-16 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-surface px-4 py-2.5 shadow-sm">
              <span className="text-sm font-medium text-foreground">{selected.size} selected</span>
              <button type="button" onClick={exportSelected} className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs">
                <Download className="h-3.5 w-3.5" />
                Export {selected.size} result{selected.size === 1 ? "" : "s"} (CSV)
              </button>
              {selected.size === 2 && (
                <Link
                  href={`/compare?left=${selectedIds[0]}&right=${selectedIds[1]}`}
                  className="btn-secondary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
                >
                  <GitCompareArrows className="h-3.5 w-3.5" />
                  Compare 2
                </Link>
              )}
              <button type="button" onClick={() => setSelected(new Map())} className="ml-auto text-xs text-text-secondary hover:text-foreground">
                Clear selection
              </button>
            </div>
          )}

          {query.q && <AiAnswerCard query={query.q} />}

          {error ? (
            <div className="editorial-card flex flex-wrap items-center justify-between gap-3 p-5 text-sm">
              <span className="text-danger">{error}</span>
              <button type="button" onClick={() => setTick((value) => value + 1)} className="btn-secondary px-3 py-1.5 text-xs">
                Retry
              </button>
            </div>
          ) : data && data.results.length === 0 && !loading ? (
            <div className="editorial-card p-8 text-center">
              <p className="font-medium text-foreground">No documents match{query.q ? ` “${query.q}”` : ""}.</p>
              <p className="mt-1 text-sm text-text-secondary">
                {filterCount > 0 ? "Try clearing a filter, or " : "Try "}a clause number (52.204-21), a party, or a topic word from the contract.
              </p>
              <Link href="/extraction/new" className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
                Upload a document <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          ) : (
            <div className={`space-y-3 ${loading ? "opacity-60" : ""}`}>
              {data?.results.map((result) => (
                <ResultCard
                  key={result.document_id}
                  result={result}
                  selected={selected.has(result.document_id)}
                  onToggle={() => toggleSelected(result)}
                />
              ))}
            </div>
          )}

          {data && pages > 1 && (
            <nav className="flex items-center justify-between pt-2 text-sm" aria-label="Pagination">
              <button
                type="button"
                disabled={query.page <= 1}
                onClick={() => navigate({ ...query, page: query.page - 1 })}
                className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40"
              >
                Previous
              </button>
              <span className="text-text-secondary">
                Page {query.page} of {pages}
              </span>
              <button
                type="button"
                disabled={query.page >= pages}
                onClick={() => navigate({ ...query, page: query.page + 1 })}
                className="btn-secondary px-3 py-1.5 text-xs disabled:opacity-40"
              >
                Next
              </button>
            </nav>
          )}
        </div>
      </div>
    </div>
  );
}
