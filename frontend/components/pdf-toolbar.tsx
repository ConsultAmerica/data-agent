"use client";

import { useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  RotateCw,
  Search,
  ZoomIn,
  ZoomOut,
  Shrink,
} from "lucide-react";

export interface SearchMatch {
  pageNumber: number;
  matches: number;
}

interface PdfToolbarProps {
  currentPage: number;
  pageCount: number;
  onPageChange: (page: number) => void;

  zoom: number;
  onZoomChange: (zoom: number) => void;
  onFitWidth?: () => void;
  /** Fit the whole page in the viewer. */
  onFitPage?: () => void;

  onRotate: () => void;

  onSearch: (query: string) => void;
  searching: boolean;
  searchResults: SearchMatch[] | null;
  onJumpToResult: (pageNumber: number) => void;
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.1;

export default function PdfToolbar({
  currentPage,
  pageCount,
  onPageChange,
  zoom,
  onZoomChange,
  onFitWidth,
  onFitPage,
  onRotate,
  onSearch,
  searching,
  searchResults,
  onJumpToResult,
}: PdfToolbarProps) {
  const [pageDraft, setPageDraft] = useState(String(currentPage));
  const [lastSyncedPage, setLastSyncedPage] = useState(currentPage);
  const [query, setQuery] = useState("");
  const [showResults, setShowResults] = useState(false);

  if (currentPage !== lastSyncedPage) {
    setLastSyncedPage(currentPage);
    setPageDraft(String(currentPage));
  }

  function commitPageDraft() {
    const parsed = Number(pageDraft);

    if (
      Number.isInteger(parsed) &&
      parsed >= 1 &&
      parsed <= pageCount
    ) {
      onPageChange(parsed);
    } else {
      setPageDraft(String(currentPage));
    }
  }

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();

    if (!query.trim()) return;

    setShowResults(true);
    onSearch(query.trim());
  }

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
      <button
        type="button"
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage <= 1}
        aria-label="Previous page"
        className="rounded-md border border-border p-1.5 text-text-secondary transition hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>

      <button
        type="button"
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage >= pageCount}
        aria-label="Next page"
        className="rounded-md border border-border p-1.5 text-text-secondary transition hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>

      <div className="flex items-center gap-1 text-xs text-text-secondary">
        <input
          type="text"
          inputMode="numeric"
          value={pageDraft}
          onChange={(event) => setPageDraft(event.target.value)}
          onBlur={commitPageDraft}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
          className="w-10 rounded-md border border-border bg-surface px-1.5 py-1 text-center text-xs text-foreground"
        />
        <span>/ {pageCount}</span>
      </div>

      <div className="mx-1 h-5 w-px bg-border" />

      <button
        type="button"
        onClick={() =>
          onZoomChange(Math.max(ZOOM_MIN, +(zoom - ZOOM_STEP).toFixed(2)))
        }
        disabled={zoom <= ZOOM_MIN}
        aria-label="Zoom out"
        className="rounded-md border border-border p-1.5 text-text-secondary transition hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ZoomOut className="h-3.5 w-3.5" />
      </button>

      <span className="w-10 text-center text-xs text-text-secondary">
        {Math.round(zoom * 100)}%
      </span>

      <button
        type="button"
        onClick={() =>
          onZoomChange(Math.min(ZOOM_MAX, +(zoom + ZOOM_STEP).toFixed(2)))
        }
        disabled={zoom >= ZOOM_MAX}
        aria-label="Zoom in"
        className="rounded-md border border-border p-1.5 text-text-secondary transition hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-40"
      >
        <ZoomIn className="h-3.5 w-3.5" />
      </button>

      {onFitWidth && (
        <button
          type="button"
          onClick={onFitWidth}
          aria-label="Fit width"
          title="Fit width"
          className="rounded-md border border-border p-1.5 text-text-secondary transition hover:bg-surface-soft"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      )}

      {onFitPage && (
        <button
          type="button"
          onClick={onFitPage}
          aria-label="Fit page"
          title="Fit page"
          className="rounded-md border border-border p-1.5 text-text-secondary transition hover:bg-surface-soft"
        >
          <Shrink className="h-3.5 w-3.5" />
        </button>
      )}

      <button
        type="button"
        onClick={onRotate}
        aria-label="Rotate page"
        className="rounded-md border border-border p-1.5 text-text-secondary transition hover:bg-surface-soft"
      >
        <RotateCw className="h-3.5 w-3.5" />
      </button>

      <div className="mx-1 h-5 w-px bg-border" />

      <div className="relative flex-1 min-w-[140px]">
        <form onSubmit={submitSearch} className="flex items-center gap-1">
          <Search className="h-3.5 w-3.5 shrink-0 text-text-muted" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={() => setShowResults(true)}
            placeholder="Search document..."
            className="w-full min-w-0 rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground"
          />
        </form>

        {showResults && (searching || searchResults !== null) && (
          <div className="absolute right-0 top-full z-10 mt-1 w-64 rounded-lg border border-border bg-surface p-1.5 shadow-lg">
            <div className="flex items-center justify-between px-1.5 py-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                {searching ? "Searching..." : "Results"}
              </span>
              <button
                type="button"
                onClick={() => setShowResults(false)}
                className="text-[11px] text-text-muted hover:text-foreground"
              >
                Close
              </button>
            </div>

            {!searching && searchResults?.length === 0 && (
              <p className="px-1.5 py-1 text-xs text-text-muted">
                No matches found.
              </p>
            )}

            {!searching &&
              searchResults?.map((result) => (
                <button
                  key={result.pageNumber}
                  type="button"
                  onClick={() => {
                    onJumpToResult(result.pageNumber);
                    setShowResults(false);
                  }}
                  className="flex w-full items-center justify-between rounded-md px-1.5 py-1.5 text-left text-xs text-foreground transition hover:bg-surface-soft"
                >
                  <span>Page {result.pageNumber}</span>
                  <span className="text-text-muted">
                    {result.matches} match
                    {result.matches === 1 ? "" : "es"}
                  </span>
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
