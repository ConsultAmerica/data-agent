"use client";

import { ChevronDown, ChevronRight, Download, ListChecks, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import UcfFieldReview from "@/components/intake/ucf-field-review";
import type { SourceViewRequest } from "@/components/source-verification-panel";
import { useBrowserPreference } from "@/lib/browser-preference";
import { useRecordSelection } from "@/lib/record-selection";
import { SELECTED_EXPORT_FORMATS, downloadSelectedTargetRecords, type SelectedExportFormat } from "@/lib/staging-workbook";
import type { ExtractTargetsResult } from "@/types/document";

const HEIGHT_KEY = "dx-source-verification-height";
const MIN_HEIGHT = 380;
const DEFAULT_HEIGHT = 640;

function storedHeight(): number {
  try {
    const value = Number(window.localStorage.getItem(HEIGHT_KEY));
    return Number.isFinite(value) && value >= MIN_HEIGHT ? value : DEFAULT_HEIGHT;
  } catch {
    return DEFAULT_HEIGHT;
  }
}

/**
 * Source Verification inside the Staging Workbook: the document beside its
 * extracted fields and tables, collapsible and resizable (drag the bottom
 * edge), with the actions for selected records. Selecting never approves.
 */
export default function SourceVerificationSection({
  documentId,
  documentName,
  pageCount,
  result,
  sourceRequest,
  onViewSource,
}: {
  documentId: string;
  documentName: string;
  pageCount: number;
  result: ExtractTargetsResult;
  sourceRequest: SourceViewRequest | null;
  onViewSource: (request: SourceViewRequest) => void;
}) {
  const selection = useRecordSelection();
  const [open, setOpen] = useBrowserPreference<"open" | "closed">("dx-source-verification", ["open", "closed"], "open");
  const [format, setFormat] = useBrowserPreference<SelectedExportFormat>("dx-selected-export-format", ["xlsx", "csv", "json"], "xlsx");
  const [height] = useState(() => (typeof window === "undefined" ? DEFAULT_HEIGHT : storedHeight()));
  const [reviewIds, setReviewIds] = useState<string[] | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  // Remember the height the reviewer dragged the panel to.
  useEffect(() => {
    const element = body.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        try {
          window.localStorage.setItem(HEIGHT_KEY, String(Math.round(element.getBoundingClientRect().height)));
        } catch {
          // Storage unavailable: the height just isn't remembered.
        }
      }, 300);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, [open]);

  const selected = [...(selection?.selected ?? [])];
  const fields = selected.filter((id) => id.startsWith("field:")).map((id) => id.slice("field:".length));
  const rows = selected
    .filter((id) => id.startsWith("row:"))
    .map((id) => {
      const [table, index] = id.slice("row:".length).split("#");
      return { table, index: Number(index) };
    });
  const own = fields.length + rows.length;
  const count = selection?.recordCount ?? 0;

  async function exportSelected() {
    setBusy(true);
    setNotice("");
    try {
      await downloadSelectedTargetRecords(documentId, format, fields, rows, documentName);
      setNotice(`Exported ${own} selected record${own === 1 ? "" : "s"} as ${format.toUpperCase()}.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The export failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface" aria-label="Source verification" data-testid="source-verification-section">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button type="button" onClick={() => setOpen(open === "open" ? "closed" : "open")} aria-expanded={open === "open"}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-foreground">
          {open === "open" ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
          Source verification
        </button>
        {selection && (
          <div className="ml-auto flex flex-wrap items-center gap-2 text-xs" data-testid="selection-actions">
            <span className="tabular-nums text-text-secondary" data-testid="selection-count">
              {count} selected
            </span>
            <button type="button" className="btn-secondary inline-flex items-center gap-1 px-2 py-1 text-xs" disabled={own === 0}
              onClick={() => {
                setOpen("open");
                setReviewIds(selected.filter((id) => id.startsWith("field:") || id.startsWith("row:")));
              }}>
              <ListChecks className="h-3.5 w-3.5" aria-hidden="true" />
              Review selected
            </button>
            <label className="inline-flex items-center gap-1 text-text-secondary">
              <span className="sr-only">Export format</span>
              <select value={format} onChange={(event) => setFormat(event.target.value as SelectedExportFormat)}
                className="rounded-md border border-border bg-surface px-1.5 py-1 text-xs text-foreground" aria-label="Export format">
                {SELECTED_EXPORT_FORMATS.map((item) => <option key={item.format} value={item.format}>{item.label}</option>)}
              </select>
            </label>
            <button type="button" className="btn-secondary inline-flex items-center gap-1 px-2 py-1 text-xs" disabled={own === 0 || busy} onClick={() => void exportSelected()}>
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {busy ? "Exporting…" : "Export selected"}
            </button>
            <button type="button" className="inline-flex items-center gap-1 px-1.5 py-1 text-xs text-text-secondary hover:text-foreground" disabled={count === 0}
              onClick={() => {
                selection.clear();
                setReviewIds(null);
              }}>
              <X className="h-3.5 w-3.5" aria-hidden="true" />
              Clear selection
            </button>
          </div>
        )}
      </div>
      {notice && <p className="px-3 pb-2 text-xs text-text-secondary" role="status">{notice}</p>}
      {open === "open" && (
        <div ref={body} className="resize-y overflow-auto border-t border-border p-3" style={{ height, minHeight: MIN_HEIGHT }} data-testid="source-verification-body">
          <UcfFieldReview
            documentId={documentId}
            documentName={documentName}
            pageCount={pageCount}
            result={result}
            sourceRequest={sourceRequest}
            onViewSource={onViewSource}
            reviewIds={reviewIds}
            onReviewDone={() => setReviewIds(null)}
          />
        </div>
      )}
    </section>
  );
}
