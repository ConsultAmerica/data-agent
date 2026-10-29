"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";

import PdfPageViewer from "@/components/pdf-page-viewer";
import PdfToolbar, { type SearchMatch } from "@/components/pdf-toolbar";
import { ApiError } from "@/lib/api";
import { getDocumentPages, getPageRender } from "@/lib/documents";
import type { DocumentPage, PageRender } from "@/types/document";

import type { SourceLocator } from "@/lib/staging-workbook";

export interface SourceViewRequest {
  /** Stable id of the selected result (FieldRow.id / table id) — used by
   * the results list to keep the clicked row visually selected. */
  id?: string;
  pageNumber: number;
  highlightText?: string | null;
  label?: string;
  value?: string;
  confidence?: number;
  verified?: boolean;
  /** Staging-cell provenance: text that locates the value's record on the
   * page (form label, CLIN number) — disambiguates repeated values such
   * as "0.00" so the cell itself is highlighted, not the first match. */
  anchorText?: string | null;
  /** PDF-point bbox [x0, y0, x1, y1] of the value's source region. */
  region?: [number, number, number, number] | null;
  /** Shown in the drawer alongside the page. */
  evidenceText?: string | null;
  extractionMethod?: string | null;
  reviewStatus?: string | null;
  reviewReasons?: string[];
  /** "html" routes the drawer to the structural HTML evidence view. */
  sourceType?: string | null;
  regionId?: string | null;
  locator?: SourceLocator | null;
}

interface SourceVerificationPanelProps {
  documentId: string;
  documentName: string;
  pageCount: number;
  request: SourceViewRequest | null;
}

interface HighlightTarget {
  text: string | null;
  anchor: string | null;
  region: [number, number, number, number] | null;
}

const NO_HIGHLIGHT: HighlightTarget = { text: null, anchor: null, region: null };

function renderCacheKey(page: number, target: HighlightTarget): string {
  return `${page}::${target.text ?? ""}::${target.anchor ?? ""}::${target.region?.join(",") ?? ""}`;
}

export default function SourceVerificationPanel({
  documentId,
  documentName,
  pageCount,
  request,
}: SourceVerificationPanelProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [highlight, setHighlight] = useState<HighlightTarget>(NO_HIGHLIGHT);
  const [pageRender, setPageRender] = useState<PageRender | null>(null);
  const [renderLoading, setRenderLoading] = useState(false);
  const [renderError, setRenderError] = useState("");
  // Office, text and XML files have no page images; the server says so
  // with a 422 and the viewer shows each page's extracted text instead.
  const [textOnlyDocument, setTextOnlyDocument] = useState<string | null>(null);
  const textOnly = textOnlyDocument === documentId;
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState<0 | 90 | 180 | 270>(0);

  const [documentPages, setDocumentPages] = useState<DocumentPage[] | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchMatch[] | null>(
    null,
  );
  const [lastQuery, setLastQuery] = useState("");

  const viewerRef = useRef<HTMLDivElement | null>(null);
  const renderCacheRef = useRef<Map<string, PageRender>>(new Map());

  useEffect(() => {
    if (!request) return;
    setCurrentPage(request.pageNumber);
    setHighlight({
      text: request.highlightText ?? null,
      anchor: request.anchorText ?? null,
      region: request.region ?? null,
    });
  }, [request]);

  useEffect(() => {
    if (!documentId) return;

    let active = true;
    const cacheKey = renderCacheKey(currentPage, highlight);
    const cached = renderCacheRef.current.get(cacheKey);

    if (cached) {
      setPageRender(cached);
      setRenderError("");
    }

    async function loadPage() {
      setRenderLoading(true);
      if (!cached) setRenderError("");

      try {
        const render = await getPageRender(documentId, currentPage, {
          highlight: highlight.text,
          anchor: highlight.anchor,
          region: highlight.region,
        });
        if (!active) return;

        renderCacheRef.current.set(cacheKey, render);
        setPageRender(render);
        setRenderError("");

        // Prefetch the next plain page in the background so Next feels
        // instant, without ever keeping more than one page mounted.
        const nextPage = currentPage + 1;
        if (nextPage <= pageCount) {
          const nextKey = renderCacheKey(nextPage, NO_HIGHLIGHT);
          if (!renderCacheRef.current.has(nextKey)) {
            getPageRender(documentId, nextPage)
              .then((nextRender) => {
                renderCacheRef.current.set(nextKey, nextRender);
              })
              .catch(() => {
                // Best-effort — the real fetch happens again on navigation.
              });
          }
        }
      } catch (error) {
        if (active && error instanceof ApiError && error.status === 422) {
          setTextOnlyDocument(documentId);
          if (!documentPages) {
            const pages = await getDocumentPages(documentId).catch(() => null);
            if (active && pages) setDocumentPages(pages);
          }
          return;
        }
        if (active && !cached) {
          setRenderError(
            error instanceof Error
              ? error.message
              : "Unable to render this page.",
          );
        }
      } finally {
        if (active) setRenderLoading(false);
      }
    }

    void loadPage();

    return () => {
      active = false;
    };
  }, [documentId, currentPage, highlight, pageCount]);

  // Once a highlighted render loads, make sure the highlighted region is
  // actually within the visible scroll area (matters once zoomed in).
  useEffect(() => {
    if (!pageRender?.highlight) return;
    const frame = requestAnimationFrame(() => {
      viewerRef.current
        ?.querySelector("[data-evidence-highlight]")
        ?.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [pageRender]);

  function handleRotate() {
    setRotation((current) =>
      current === 270 ? 0 : ((current + 90) as 0 | 90 | 180 | 270),
    );
  }

  function handleFitWidth() {
    if (!viewerRef.current || !pageRender) return;
    const available = viewerRef.current.clientWidth - 32;
    const isSideways = rotation === 90 || rotation === 270;
    const naturalWidth = isSideways ? pageRender.page_height : pageRender.page_width;
    if (available > 0 && naturalWidth > 0) {
      setZoom(Math.max(0.5, Math.min(2.5, +(available / naturalWidth).toFixed(2))));
    }
  }

  function handleFitPage() {
    if (!viewerRef.current || !pageRender) return;
    const width = viewerRef.current.clientWidth - 32;
    const height = viewerRef.current.clientHeight - 32;
    const isSideways = rotation === 90 || rotation === 270;
    const pageWidth = isSideways ? pageRender.page_height : pageRender.page_width;
    const pageHeight = isSideways ? pageRender.page_width : pageRender.page_height;
    if (width > 0 && height > 0 && pageWidth > 0 && pageHeight > 0) {
      setZoom(Math.max(0.5, Math.min(2.5, +Math.min(width / pageWidth, height / pageHeight).toFixed(2))));
    }
  }

  // Keyboard: PageUp/PageDown (or ←/→ with nothing else focused) change
  // page; + and − zoom; R rotates.
  function handleViewerKey(event: React.KeyboardEvent) {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, button")) return;
    const last = Math.max(pageCount, 1);
    if ((event.key === "PageDown" || event.key === "ArrowRight") && currentPage < last) {
      event.preventDefault();
      setCurrentPage(currentPage + 1);
    } else if ((event.key === "PageUp" || event.key === "ArrowLeft") && currentPage > 1) {
      event.preventDefault();
      setCurrentPage(currentPage - 1);
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setZoom((z) => Math.min(2.5, +(z + 0.1).toFixed(2)));
    } else if (event.key === "-") {
      event.preventDefault();
      setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)));
    } else if (event.key.toLowerCase() === "r") {
      event.preventDefault();
      handleRotate();
    }
  }

  async function handleSearch(query: string) {
    setSearching(true);
    setLastQuery(query);

    try {
      let pages = documentPages;

      if (!pages) {
        pages = await getDocumentPages(documentId);
        setDocumentPages(pages);
      }

      const needle = query.toLowerCase();

      const results: SearchMatch[] = pages
        .map((page) => {
          const haystack = page.final_text.toLowerCase();
          let count = 0;
          let index = haystack.indexOf(needle);

          while (index !== -1) {
            count += 1;
            index = haystack.indexOf(needle, index + needle.length);
          }

          return { pageNumber: page.page_number, matches: count };
        })
        .filter((result) => result.matches > 0);

      setSearchResults(results);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  }

  function handleJumpToResult(pageNumber: number) {
    setCurrentPage(pageNumber);
    setHighlight({ text: lastQuery, anchor: null, region: null });
  }

  const selectedLabel = request?.label?.trim();
  const selectedValue = request?.value?.trim();

  return (
    <div className="flex h-full min-h-[420px] flex-col overflow-hidden rounded-xl border border-primary/20 bg-surface shadow-[var(--shadow-soft)]">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border bg-primary/[0.04] px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-teal">
            Source Verification
          </p>
          <p className="mt-0.5 truncate text-sm font-semibold text-foreground">
            {documentName}
          </p>
          <p className="text-xs text-text-secondary">
            Page {currentPage} of {pageCount}
            {selectedLabel ? ` · ${selectedLabel}` : ""}
          </p>
          {selectedValue ? (
            <p className="mt-1 truncate text-xs text-foreground">
              Highlighting:{" "}
              <span className="font-medium">{selectedValue}</span>
            </p>
          ) : (
            <p className="mt-1 text-xs text-text-muted">
              Click a result to jump to its evidence in the PDF.
            </p>
          )}
        </div>
        {renderLoading && (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-text-muted" />
        )}
      </div>

      <PdfToolbar
        currentPage={currentPage}
        pageCount={pageCount}
        zoom={zoom}
        onPageChange={setCurrentPage}
        onZoomChange={setZoom}
        onFitWidth={handleFitWidth}
        onFitPage={textOnly ? undefined : handleFitPage}
        onRotate={handleRotate}
        searching={searching}
        searchResults={searchResults}
        onSearch={handleSearch}
        onJumpToResult={handleJumpToResult}
      />

      <div
        ref={viewerRef}
        className="min-h-0 flex-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50"
        tabIndex={0}
        role="region"
        aria-label={`${documentName}, page ${currentPage} of ${Math.max(pageCount, 1)}. Page Up and Page Down change page; plus and minus zoom; R rotates.`}
        onKeyDown={handleViewerKey}
      >
        {textOnly ? (
          <PageTextView
            page={documentPages?.find((page) => page.page_number === currentPage) ?? null}
            loading={documentPages === null}
            highlight={highlight.text}
            zoom={zoom}
          />
        ) : (
          <PdfPageViewer
            render={pageRender}
            loading={renderLoading}
            error={renderError}
            zoom={zoom}
            rotation={rotation}
            hideHeader
          />
        )}
      </div>
    </div>
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A page of a document that has no page image (Office, text, XML): its
 * extracted text, with the selected value highlighted. */
function PageTextView({
  page,
  loading,
  highlight,
  zoom,
}: {
  page: DocumentPage | null;
  loading: boolean;
  highlight: string | null;
  zoom: number;
}) {
  if (loading) {
    return (
      <p className="flex h-full items-center justify-center gap-2 text-sm text-text-secondary">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Loading the document text…
      </p>
    );
  }
  if (!page || !page.final_text.trim()) {
    return <p className="p-6 text-center text-sm text-text-secondary">No text was extracted for this page.</p>;
  }
  const needle = highlight?.trim();
  const parts = needle ? page.final_text.split(new RegExp(`(${escapeRegExp(needle)})`, "i")) : [page.final_text];
  return (
    <div className="h-full overflow-auto bg-surface p-5" data-testid="page-text-view">
      <p className="mb-3 text-[11px] text-text-muted">
        Extracted text — this file type has no page image.
      </p>
      <pre
        className="whitespace-pre-wrap break-words font-sans leading-6 text-foreground"
        style={{ fontSize: `${Math.round(13 * zoom)}px` }}
      >
        {parts.map((part, index) =>
          index % 2 === 1 ? (
            <mark key={index} className="rounded bg-warning/25 px-0.5 text-foreground">
              {part}
            </mark>
          ) : (
            <span key={index}>{part}</span>
          ),
        )}
      </pre>
    </div>
  );
}
