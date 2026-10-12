"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  SELECTED_EXPORT_FORMATS,
  downloadSelectedExport,
  type SelectedExportFormat,
} from "@/lib/staging-workbook";
import { selectionCounts, selectionManifest, type Selection } from "@/lib/table-selection";

/** Compact, sticky bar over a grid once anything is selected: what is
 * selected, Clear, Select visible, and Export Selected. */
export default function SelectionToolbar({
  documentId,
  datasetId,
  filename,
  selection,
  onClear,
  onSelectVisible,
  resultCount,
  allResultsSelected = false,
  onSelectAllResults,
  summary,
  exportSelection,
}: {
  documentId?: string;
  datasetId: string;
  filename: string;
  selection: Selection;
  onClear: () => void;
  onSelectVisible: () => void;
  /** Records matching the current search / filters (all pages). */
  resultCount?: number;
  allResultsSelected?: boolean;
  /** Every field of every matching record — offered explicitly, never implied. */
  onSelectAllResults?: () => void;
  /** Replaces the cells / records / fields counts (e.g. "3 values selected"). */
  summary?: string;
  /** Exports the selection itself, for selections that aren't one staged
   * dataset's cells (label / value lists, composed tables). */
  exportSelection?: (format: SelectedExportFormat) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const counts = selectionCounts(selection);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (counts.cells === 0) return null;

  async function exportAs(format: SelectedExportFormat) {
    if (!documentId) return;
    setOpen(false);
    setBusy(true);
    setError("");
    try {
      if (exportSelection) await exportSelection(format);
      else await downloadSelectedExport(documentId, datasetId, format, selectionManifest(selection), filename);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

  return (
    <div
      className="sticky top-0 z-40 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-primary/30 bg-surface px-3 py-1.5 text-xs shadow-sm"
      role="toolbar"
      aria-label="Selection"
      data-testid="selection-toolbar"
    >
      {summary ? (
        <span className="font-medium text-foreground tabular-nums">{summary}</span>
      ) : (
        <>
          <span className="font-medium text-foreground tabular-nums">{plural(counts.cells, "cell")} selected</span>
          <span className="text-text-secondary tabular-nums">{plural(counts.records, "record")}</span>
          <span className="text-text-secondary tabular-nums">{plural(counts.fields, "field")}</span>
        </>
      )}
      {busy && (
        <span className="sr-only" aria-live="polite">
          Preparing selected export…
        </span>
      )}
      {error && (
        <span className="text-danger" role="alert">
          {error}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <button type="button" onClick={onClear} className="rounded-md border border-border px-2 py-1 hover:bg-surface-soft">
          Clear
        </button>
        <button type="button" onClick={onSelectVisible} className="rounded-md border border-border px-2 py-1 hover:bg-surface-soft">
          Select visible
        </button>
        {onSelectAllResults && resultCount != null && resultCount > 0 && !allResultsSelected && (
          <button
            type="button"
            onClick={onSelectAllResults}
            className="rounded-md border border-border px-2 py-1 hover:bg-surface-soft"
          >
            Select all {resultCount.toLocaleString()} result{resultCount === 1 ? "" : "s"}
          </button>
        )}
        {documentId && (
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              disabled={busy}
              aria-haspopup="menu"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 font-medium text-white disabled:opacity-60"
            >
              {busy ? "Exporting…" : "Export Selected"}
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            </button>
            {open && (
              <div role="menu" className="absolute right-0 z-50 mt-1 w-36 rounded-lg border border-border bg-surface py-1 shadow-sm">
                {SELECTED_EXPORT_FORMATS.map((item) => (
                  <button
                    key={item.format}
                    type="button"
                    role="menuitem"
                    onClick={() => void exportAs(item.format)}
                    className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-soft"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
