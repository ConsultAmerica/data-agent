"use client";

import { ChevronDown, ChevronUp, Loader2, Search, ZoomIn, ZoomOut } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import EvidenceBanner from "@/components/viewers/evidence-banner";
import { columnLetter, getSourceSheet, parseCellRef, type ResolvedLocation, type SheetCell, type SheetContent, type SourceView } from "@/lib/source-view";

const ROW_HEIGHT = 24;
const HEADER_WIDTH = 48;
const COLUMN_WIDTH = 112;
/** Rows drawn beyond the visible ones, above and below. */
const OVERSCAN = 8;
/** Columns drawn; wider sheets are reached through search and Go to. */
const MAX_COLUMNS = 104;

function rangeOf(range: string) {
  const [a, b = a] = range.split(":");
  const start = parseCellRef(a);
  const end = parseCellRef(b);
  return start && end ? { top: start.row, left: start.column, bottom: end.row, right: end.column } : null;
}

/**
 * The workbook as the file stores it: sheet tabs, row numbers, column
 * letters and cells. A formula is shown as written next to the value the
 * file cached for it — it is never calculated here, and a missing cached
 * value is said to be missing. Rows are virtualized.
 */
export default function SpreadsheetViewer({
  documentId,
  view,
  resolved,
  label,
}: {
  documentId: string;
  view: SourceView;
  resolved: ResolvedLocation | null;
  label: string | null;
}) {
  const sheets = useMemo(() => view.sheets ?? [], [view.sheets]);
  const target = resolved?.location;
  const targetSheet = target?.kind === "sheet_cell" ? target.sheetIndex : target?.kind === "sheet" ? target.sheetIndex : null;
  const [sheetIndex, setSheetIndex] = useState(() => (targetSheet != null && targetSheet < sheets.length ? targetSheet : 0));
  const [content, setContent] = useState<SheetContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [goTo, setGoTo] = useState("");
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(480);
  const [evidenceFound, setEvidenceFound] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  // A new evidence target switches to its sheet.
  useEffect(() => {
    if (targetSheet != null && targetSheet >= 0 && targetSheet < sheets.length) queueMicrotask(() => setSheetIndex(targetSheet));
  }, [targetSheet, sheets.length]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => active && (setContent(null), setError(null)));
    getSourceSheet(documentId, sheetIndex)
      .then((sheet) => active && setContent(sheet))
      .catch((failure: unknown) => active && setError(failure instanceof Error ? failure.message : "The sheet could not be loaded."));
    return () => {
      active = false;
    };
  }, [documentId, sheetIndex]);

  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight || 480));
    observer.observe(element);
    return () => observer.disconnect();
  }, [content]);

  const byRef = useMemo(() => new Map((content?.cells ?? []).map((c) => [c.ref, c])), [content]);
  const merges = useMemo(() => (content?.merged ?? []).map((r) => ({ range: r, box: rangeOf(r) })).filter((m) => m.box), [content]);
  const frozen = content?.frozen ? parseCellRef(content.frozen) : null;
  const frozenRows = frozen ? frozen.row - 1 : 0;
  const frozenCols = frozen ? frozen.column - 1 : 0;
  const rowCount = Math.max(content?.max_row ?? 0, 1);
  const columnCount = Math.min(Math.max(content?.max_column ?? 0, 1), MAX_COLUMNS);
  const rowHeight = Math.round(ROW_HEIGHT * zoom);
  const columnWidth = Math.round(COLUMN_WIDTH * zoom);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || !content) return [];
    return content.cells.filter((c) => (c.value ?? "").toLowerCase().includes(needle) || (c.formula ?? "").toLowerCase().includes(needle));
  }, [content, query]);

  function reveal(ref: string) {
    const position = parseCellRef(ref);
    if (!position) return;
    setSelected(ref);
    const element = scroller.current;
    if (element) {
      element.scrollTop = Math.max(0, (position.row - 1 - frozenRows) * rowHeight - element.clientHeight / 2);
      element.scrollLeft = Math.max(0, (position.column - 1) * columnWidth - element.clientWidth / 2);
      setScrollTop(element.scrollTop);
    }
  }

  // Evidence: an exact cell, or the first cell whose value is the text.
  useEffect(() => {
    if (!content || !target) return;
    let ref: string | null = null;
    if (target.kind === "sheet_cell") ref = byRef.has(target.cell.toUpperCase()) || parseCellRef(target.cell) ? target.cell.toUpperCase() : null;
    if (target.kind === "sheet" && target.text) {
      const needle = target.text.trim().toLowerCase();
      ref = content.cells.find((c) => (c.value ?? "").trim().toLowerCase() === needle)?.ref
        ?? content.cells.find((c) => (c.value ?? "").toLowerCase().includes(needle))?.ref
        ?? null;
    }
    queueMicrotask(() => {
      setEvidenceFound(target.kind !== "sheet" || !target.text || ref != null);
      if (ref) reveal(ref);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reveal reads current layout
  }, [content, target]);

  const bodyRows = Math.max(rowCount - frozenRows, 0);
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const last = Math.min(bodyRows, Math.ceil((scrollTop + height) / rowHeight) + OVERSCAN);
  const visibleRows = Array.from({ length: Math.max(last - first, 0) }, (_, i) => frozenRows + first + i + 1);
  const columns = Array.from({ length: columnCount }, (_, i) => i + 1);
  const selectedCell: SheetCell | null = selected ? byRef.get(selected) ?? null : null;
  const selectedMerge = selected ? merges.find((m) => m.range.split(":")[0] === selected) : null;

  function mergeOf(row: number, column: number) {
    return merges.find((m) => m.box && row >= m.box.top && row <= m.box.bottom && column >= m.box.left && column <= m.box.right);
  }

  function renderRow(row: number, sticky: boolean) {
    return (
      <div key={row} role="row" aria-rowindex={row} className="flex" style={{ height: rowHeight }}>
        <div role="rowheader" className={`sticky left-0 z-10 shrink-0 border-b border-r border-border bg-surface-soft px-1 text-right text-[11px] tabular-nums text-text-muted ${sticky ? "z-20" : ""}`}
          style={{ width: HEADER_WIDTH, lineHeight: `${rowHeight}px` }}>{row}</div>
        {columns.map((column) => {
          const ref = `${columnLetter(column)}${row}`;
          const cell = byRef.get(ref);
          const merge = mergeOf(row, column);
          const covered = merge && merge.range.split(":")[0] !== ref;
          const isSelected = selected === ref;
          const isMatch = matches[match]?.ref === ref;
          const frozenColumn = column <= frozenCols;
          return (
            <button key={ref} type="button" role="gridcell" aria-selected={isSelected} aria-label={`${ref}${cell?.value ? `: ${cell.value}` : ""}${cell?.formula ? `, formula ${cell.formula}` : ""}`}
              onClick={() => setSelected(ref)} data-ref={ref}
              className={`shrink-0 truncate border-b border-r border-border px-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/60 ${
                isSelected ? "bg-warning/25 ring-2 ring-inset ring-warning" : isMatch ? "bg-primary-soft" : covered ? "bg-surface-soft" : "bg-surface"
              } ${cell?.formula ? "italic" : ""} ${frozenColumn ? "sticky z-10" : ""}`}
              style={{ width: columnWidth, fontSize: 12 * zoom, lineHeight: `${rowHeight}px`, ...(frozenColumn ? { left: HEADER_WIDTH + (column - 1) * columnWidth } : {}) }}
              title={merge ? `Merged ${merge.range}` : undefined}>
              {cell?.value ?? ""}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-xs" data-testid="spreadsheet-viewer">
      <EvidenceBanner resolved={resolved} found={evidenceFound} label={label} />
      {view.macros_note && <p className="border-b border-border bg-surface-soft px-3 py-1 text-[11px] text-text-secondary">{view.macros_note}</p>}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border p-1.5">
        <label className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <input value={query} onChange={(e) => { setQuery(e.target.value); setMatch(0); }} placeholder="Search cells…" aria-label="Search cells"
            className="h-7 w-40 rounded-md border border-border bg-background pl-6 pr-1.5" />
        </label>
        {query.trim() && (
          <span className="flex items-center gap-1" aria-live="polite">
            <span className="tabular-nums text-text-muted">{matches.length ? `${match + 1}/${matches.length}` : "No matches"}</span>
            <button type="button" aria-label="Previous match" disabled={!matches.length} onClick={() => { const n = (match - 1 + matches.length) % matches.length; setMatch(n); reveal(matches[n].ref); }} className="rounded p-0.5 hover:bg-surface-soft disabled:opacity-40"><ChevronUp className="h-3.5 w-3.5" /></button>
            <button type="button" aria-label="Next match" disabled={!matches.length} onClick={() => { const n = (match + 1) % matches.length; setMatch(n); reveal(matches[n].ref); }} className="rounded p-0.5 hover:bg-surface-soft disabled:opacity-40"><ChevronDown className="h-3.5 w-3.5" /></button>
          </span>
        )}
        <form onSubmit={(e) => { e.preventDefault(); if (parseCellRef(goTo)) reveal(goTo.trim().toUpperCase()); }} className="flex items-center gap-1">
          <input value={goTo} onChange={(e) => setGoTo(e.target.value)} placeholder="Go to (B12)" aria-label="Go to cell" className="h-7 w-24 rounded-md border border-border bg-background px-1.5" />
        </form>
        <span className="ml-auto flex items-center gap-1">
          <button type="button" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.7, +(z - 0.1).toFixed(1)))} className="rounded p-1 hover:bg-surface-soft"><ZoomOut className="h-3.5 w-3.5" /></button>
          <span className="w-9 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(1)))} className="rounded p-1 hover:bg-surface-soft"><ZoomIn className="h-3.5 w-3.5" /></button>
        </span>
      </div>

      {error ? (
        <p className="p-3 text-danger">{error}</p>
      ) : !content ? (
        <p className="flex items-center gap-2 p-3 text-text-muted"><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading the sheet…</p>
      ) : (
        <div ref={scroller} onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)} className="relative min-h-0 flex-1 overflow-auto"
          role="grid" aria-label={`Sheet ${content.name}`} aria-rowcount={rowCount} aria-colcount={content.max_column} data-testid="sheet-grid">
          <div style={{ width: HEADER_WIDTH + columnCount * columnWidth }}>
            <div className="sticky top-0 z-30" role="rowgroup">
              <div role="row" className="flex" style={{ height: rowHeight }}>
                <div className="sticky left-0 z-10 shrink-0 border-b border-r border-border bg-surface-soft" style={{ width: HEADER_WIDTH }} />
                {columns.map((column) => (
                  <div key={column} role="columnheader" className={`shrink-0 border-b border-r border-border bg-surface-soft text-center text-[11px] font-medium text-text-secondary ${column <= frozenCols ? "sticky z-10" : ""}`}
                    style={{ width: columnWidth, lineHeight: `${rowHeight}px`, ...(column <= frozenCols ? { left: HEADER_WIDTH + (column - 1) * columnWidth } : {}) }}>{columnLetter(column)}</div>
                ))}
              </div>
              {Array.from({ length: frozenRows }, (_, i) => renderRow(i + 1, true))}
            </div>
            <div role="rowgroup" style={{ height: bodyRows * rowHeight, position: "relative" }}>
              <div style={{ position: "absolute", top: first * rowHeight, left: 0, right: 0 }}>
                {visibleRows.map((row) => renderRow(row, false))}
              </div>
            </div>
          </div>
        </div>
      )}

      {content && (
        <div className="border-t border-border bg-surface-soft px-3 py-2" data-testid="cell-details" aria-live="polite">
          {selected ? (
            <dl className="grid grid-cols-[6rem_1fr] gap-x-2 gap-y-0.5">
              <dt className="text-text-secondary">Cell</dt><dd className="font-mono">{content.name}!{selected}</dd>
              {selectedCell?.formula ? (
                <>
                  <dt className="text-text-secondary">Formula</dt><dd className="break-all font-mono">{selectedCell.formula}</dd>
                  <dt className="text-text-secondary">Cached value</dt>
                  <dd>{selectedCell.value ?? <span className="text-text-muted">None stored in the file (the formula was never calculated when saved)</span>}</dd>
                </>
              ) : (
                <>
                  <dt className="text-text-secondary">Value</dt><dd className="whitespace-pre-wrap break-words">{selectedCell?.value ?? <span className="text-text-muted">Empty</span>}</dd>
                  {selectedCell && <><dt className="text-text-secondary">Formula</dt><dd className="text-text-muted">None (a typed value)</dd></>}
                </>
              )}
              {selectedMerge && <><dt className="text-text-secondary">Merged</dt><dd>{selectedMerge.range}</dd></>}
            </dl>
          ) : (
            <p className="text-text-muted">Select a cell to see its value and formula. Formulas are shown as written and never calculated here.</p>
          )}
        </div>
      )}

      {sheets.length > 0 && (
        <div className="flex gap-0.5 overflow-x-auto border-t border-border bg-surface px-1" role="tablist" aria-label="Sheets">
          {sheets.map((sheet) => (
            <button key={sheet.index} type="button" role="tab" aria-selected={sheet.index === sheetIndex} onClick={() => { setSheetIndex(sheet.index); setSelected(null); setScrollTop(0); }}
              className={`shrink-0 border-t-2 px-2.5 py-1 ${sheet.index === sheetIndex ? "border-primary font-medium text-foreground" : "border-transparent text-text-secondary hover:text-foreground"}`}>
              {sheet.name}
            </button>
          ))}
          {content?.truncated && <span className="ml-auto self-center px-2 text-[11px] text-warning">Only the first 200,000 cells are shown.</span>}
          {(content?.max_column ?? 0) > MAX_COLUMNS && <span className="self-center px-2 text-[11px] text-text-muted">Columns past {columnLetter(MAX_COLUMNS)}: use search or Go to.</span>}
        </div>
      )}
    </div>
  );
}
