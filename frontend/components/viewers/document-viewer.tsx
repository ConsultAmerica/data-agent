"use client";

import { Loader2 } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import SourceVerificationPanel, { type SourceViewRequest } from "@/components/source-verification-panel";
import { UnsupportedPreview, ViewerErrorBoundary } from "@/components/viewers/viewer-error-boundary";
import { getSourceView, resolveLocation, type SourceView, type ViewerKind } from "@/lib/source-view";

// Each format's viewer loads only when a document of that format opens.
const SpreadsheetViewer = lazy(() => import("@/components/viewers/spreadsheet-viewer"));
const DelimitedViewer = lazy(() => import("@/components/viewers/delimited-viewer"));
const XmlViewer = lazy(() => import("@/components/viewers/xml-viewer"));
const WordViewer = lazy(() => import("@/components/viewers/word-viewer"));
const JsonSourceTree = lazy(() => import("@/components/smart-view/json-source-tree"));

const FORMAT_LABEL: Partial<Record<ViewerKind, string>> = {
  spreadsheet: "Sheets",
  delimited: "Rows",
  json: "Tree",
  xml: "Tree",
  word: "Document",
};

function Loading({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 p-4 text-xs text-text-muted" role="status">
      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      {label}
    </p>
  );
}

/**
 * DocumentViewerRouter: opens the original document in the viewer its
 * verified type calls for (PDF/image pages, sheets and cells, rows, JSON or
 * XML trees, Word structure) and passes the selected value's recorded
 * evidence to it. "Page text" shows what extraction read, for any format.
 * Unknown or unverifiable files get a plain explanation, not a guess.
 */
export default function DocumentViewer({
  documentId,
  documentName,
  pageCount,
  request,
  onPageClick,
}: {
  documentId: string;
  documentName: string;
  pageCount: number;
  request: SourceViewRequest | null;
  /** A click on a page image, in PDF points (reverse selection). */
  onPageClick?: (page: number, x: number, y: number) => void;
}) {
  const [view, setView] = useState<SourceView | null>(null);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<"structured" | "text">("structured");

  useEffect(() => {
    let active = true;
    getSourceView(documentId)
      .then((loaded) => active && setView(loaded))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [documentId]);

  const kind: ViewerKind = failed ? "pdf" : (view?.viewer ?? "pdf");
  const sheetNames = useMemo(() => (view?.sheets ?? []).map((s) => s.name), [view]);
  const resolved = useMemo(
    () =>
      request
        ? resolveLocation(
            { pageNumber: request.pageNumber, region: request.region, highlightText: request.highlightText, value: request.value, locator: request.locator },
            kind,
            sheetNames,
          )
        : null,
    [request, kind, sheetNames],
  );

  if (!view && !failed) return <Loading label="Opening the document…" />;

  const pageViewer = (
    <SourceVerificationPanel documentId={documentId} documentName={documentName} pageCount={pageCount} request={request ?? { pageNumber: 1 }} onPageClick={onPageClick} />
  );

  if (!view || failed || kind === "pdf" || kind === "image" || kind === "text") {
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="document-viewer" data-viewer={kind}>
        {view?.note && <p className="border-b border-border bg-surface-soft px-3 py-1.5 text-[11px] text-text-secondary">{view.note}</p>}
        <div className="min-h-0 flex-1">{pageViewer}</div>
      </div>
    );
  }

  if (kind === "unsupported") return <UnsupportedPreview note={view.note} />;

  return (
    <div className="flex h-full min-h-[520px] flex-col overflow-hidden rounded-xl border border-border bg-surface" data-testid="document-viewer" data-viewer={kind}>
      <div className="flex items-center gap-1 border-b border-border p-1.5" role="tablist" aria-label="Source view">
        {(["structured", "text"] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={mode === id} onClick={() => setMode(id)}
            className={`rounded-md px-2 py-1 text-xs font-medium ${mode === id ? "bg-primary-soft text-primary" : "text-text-secondary hover:bg-surface-soft"}`}>
            {id === "structured" ? FORMAT_LABEL[kind] : "Page text"}
          </button>
        ))}
        <span className="ml-auto truncate px-1 text-[11px] text-text-muted" title={documentName}>{documentName}</span>
      </div>
      {view.note && <p className="border-b border-border bg-surface-soft px-3 py-1.5 text-[11px] text-text-secondary">{view.note}</p>}
      <div className="min-h-0 flex-1">
        {mode === "text" ? (
          pageViewer
        ) : (
          <ViewerErrorBoundary fallback={pageViewer} resetKey={`${documentId}:${kind}`}>
          <Suspense fallback={<Loading label="Loading the viewer…" />}>
            {kind === "spreadsheet" && <SpreadsheetViewer documentId={documentId} view={view} resolved={resolved} label={request?.label ?? null} />}
            {kind === "delimited" && <DelimitedViewer view={view} resolved={resolved} label={request?.label ?? null} />}
            {kind === "xml" && <XmlViewer view={view} resolved={resolved} label={request?.label ?? null} />}
            {kind === "word" && <WordViewer view={view} resolved={resolved} label={request?.label ?? null} />}
            {kind === "json" && (
              <JsonSourceTree documentId={documentId} data={view.data as never} resolved={resolved} highlight={resolved?.location.kind === "json_value" ? resolved.location.text : null} />
            )}
          </Suspense>
          </ViewerErrorBoundary>
        )}
      </div>
    </div>
  );
}

