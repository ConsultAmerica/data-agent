"use client";

import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight, Columns3, Copy, Download, Filter, Pin, PinOff, Search, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { downloadBlob } from "@/lib/export";

/**
 * SmartDataGrid — the reusable table of the Smart View.
 *
 * Rows are plain string values keyed by column; the grid never changes a
 * value, it only chooses how to show it. Columns that are empty for every
 * row shown are hidden by default ("Show all fields" brings them back) —
 * an empty cell is a missing value, never confused with a printed dash.
 * Preferences (widths, order, visibility, pins, density, text mode) are
 * kept per table type in this browser.
 */

export interface GridColumn {
  key: string;
  label: string;
  width?: number;
  /** Pinned by default (identifiers: CLIN, clause number…). */
  pinned?: boolean;
  /** "options" filters with a value list (low-cardinality columns);
   * "range" with minimum / maximum numbers (amounts, quantities). */
  filter?: "text" | "options" | "range";
  /** Hidden by default even when filled (still in the column menu). */
  optional?: boolean;
  /** Shown even when empty (the record's identifier). Pinned columns are
   * essential unless they say otherwise. */
  essential?: boolean;
}

/** The number a printed value states ("USD 1,420,351.70" → 1420351.7),
 * or null. A printed "(1,000.00)" is negative, as in accounting. */
export function numberOf(text: string): number | null {
  const trimmed = text.trim();
  const match = trimmed.match(/-?\d[\d,]*(?:\.\d+)?|-?\.\d+/);
  if (!match) return null;
  const n = Number(match[0].replaceAll(",", ""));
  if (Number.isNaN(n)) return null;
  return /^\(.*\)$/.test(trimmed) && n > 0 ? -n : n;
}

export interface GridRow {
  id: string;
  values: Record<string, string>;
  /** Shown as a status badge column when present. */
  status?: string | null;
}

type TextMode = "single" | "two" | "wrap";
type Density = "comfortable" | "compact";

interface Prefs {
  widths: Record<string, number>;
  order: string[];
  hidden: string[];
  shown: string[];
  pinned: string[];
  unpinned: string[];
  text: TextMode;
  density: Density;
  pageSize: number;
  /** Show every column, empty ones included. */
  showAll: boolean;
}

const DEFAULT_PREFS: Prefs = { widths: {}, order: [], hidden: [], shown: [], pinned: [], unpinned: [], text: "single", density: "comfortable", pageSize: 50, showAll: false };
/** Prefs that "Reset columns" restores (density, text and page size stay). */
const COLUMN_PREFS: Partial<Prefs> = { widths: {}, order: [], hidden: [], shown: [], pinned: [], unpinned: [], showAll: false };
const MIN_WIDTH = 72;
const CHECK = 36;
const EXPAND = 30;

function loadPrefs(key: string): Prefs {
  try {
    const raw = typeof window !== "undefined" ? window.localStorage.getItem(`dx-grid:${key}`) : null;
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(key: string, prefs: Prefs) {
  try {
    window.localStorage.setItem(`dx-grid:${key}`, JSON.stringify(prefs));
  } catch {
    // Storage blocked: preferences last for this visit only.
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function csv(columns: GridColumn[], rows: GridRow[]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  return [columns.map((c) => cell(c.label)).join(","), ...rows.map((r) => columns.map((c) => cell(r.values[c.key] ?? "")).join(","))].join("\r\n");
}

export interface SmartDataGridProps {
  /** Preference key, e.g. "contract:clauses". */
  tableKey: string;
  columns: GridColumn[];
  rows: GridRow[];
  /** Label for the status column (when rows carry a status). */
  statusLabel?: string;
  renderStatus?: (status: string | null | undefined) => React.ReactNode;
  /** Row click / Enter. */
  onOpen?: (row: GridRow) => void;
  selectedId?: string | null;
  renderExpanded?: (row: GridRow) => React.ReactNode;
  emptyMessage?: string;
  exportName?: string;
  /** Extra controls in the toolbar (e.g. view switches). */
  toolbar?: React.ReactNode;
  /** Ids of the rows left after search and filters, whenever they change. */
  onFilteredChange?: (ids: string[]) => void;
  /** Show this row: turn to its page and scroll it into view. */
  focusId?: string | null;
}

export default function SmartDataGrid({
  tableKey,
  columns,
  rows,
  statusLabel = "Status",
  renderStatus,
  onOpen,
  selectedId,
  renderExpanded,
  emptyMessage = "No records.",
  exportName = "records",
  toolbar,
  onFilteredChange,
  focusId = null,
}: SmartDataGridProps) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [ranges, setRanges] = useState<Record<string, { min: string; max: string }>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [sort, setSort] = useState<{ key: string; dir: "asc" | "desc" } | null>(null);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menuOpen, setMenuOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const dragColumn = useRef<string | null>(null);
  const tableRef = useRef<HTMLTableElement>(null);

  useEffect(() => {
    const loaded = loadPrefs(tableKey);
    queueMicrotask(() => {
      setPrefs(loaded);
      setReady(true);
    });
  }, [tableKey]);

  useEffect(() => {
    if (ready) savePrefs(tableKey, prefs);
  }, [prefs, ready, tableKey]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  const update = (patch: Partial<Prefs>) => setPrefs((p) => ({ ...p, ...patch }));
  const hasStatus = rows.some((r) => r.status != null);

  // ---------------------------------------------------------------- filtering

  const activeRanges = useMemo(
    () =>
      Object.entries(ranges)
        .map(([key, r]) => ({ key, min: numberOf(r.min), max: numberOf(r.max) }))
        .filter((r) => r.min != null || r.max != null),
    [ranges],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const active = Object.entries(filters).filter(([, v]) => v.trim());
    return rows.filter((row) => {
      if (needle && !Object.values(row.values).some((v) => v.toLowerCase().includes(needle)) && !(row.status ?? "").toLowerCase().includes(needle)) return false;
      for (const [key, value] of active) {
        const cell = key === "__status" ? row.status ?? "" : row.values[key] ?? "";
        const column = columns.find((c) => c.key === key);
        if (column?.filter === "options" || key === "__status" ? cell !== value : !cell.toLowerCase().includes(value.toLowerCase())) return false;
      }
      // A value range keeps only rows whose cell states a number in it.
      for (const { key, min, max } of activeRanges) {
        const n = numberOf(row.values[key] ?? "");
        if (n == null || (min != null && n < min) || (max != null && n > max)) return false;
      }
      return true;
    });
  }, [rows, query, filters, columns, activeRanges]);

  const filteredListener = useRef(onFilteredChange);
  useEffect(() => {
    filteredListener.current = onFilteredChange;
  });
  // Keyed on the ids, not the array: callers often rebuild rows each render,
  // and reporting an unchanged result would loop through their state.
  const filteredKey = JSON.stringify(filtered.map((r) => r.id));
  useEffect(() => {
    filteredListener.current?.(JSON.parse(filteredKey) as string[]);
  }, [filteredKey]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const value = (r: GridRow) => (sort.key === "__status" ? r.status ?? "" : r.values[sort.key] ?? "");
    // Amounts sort by the number they state ("USD 1,420,351.70" after
    // "USD 142,035.17"), which digit-group collation gets wrong.
    const numeric = columns.find((c) => c.key === sort.key)?.filter === "range";
    const list = [...filtered].sort((a, b) => {
      const x = value(a), y = value(b);
      if (!x && y) return 1;
      if (x && !y) return -1;
      if (numeric) {
        const nx = numberOf(x), ny = numberOf(y);
        if (nx != null && ny != null && nx !== ny) return nx - ny;
      }
      return collator.compare(x, y);
    });
    return sort.dir === "desc" ? list.reverse() : list;
  }, [filtered, sort, columns]);

  // Reset to the first page when the result set changes shape.
  const resultKey = `${query}|${JSON.stringify(filters)}|${JSON.stringify(activeRanges)}|${sort?.key}${sort?.dir}|${rows.length}`;
  const [seenKey, setSeenKey] = useState(resultKey);
  if (seenKey !== resultKey) {
    setSeenKey(resultKey);
    if (page !== 0) setPage(0);
  }

  // Turn to a row asked for from outside (evidence), once per request.
  const [focusedFor, setFocusedFor] = useState<string | null>(null);
  if (focusId && focusId !== focusedFor && ready) {
    const index = sorted.findIndex((r) => r.id === focusId);
    setFocusedFor(focusId);
    if (index >= 0) setPage(Math.floor(index / prefs.pageSize));
  }
  useEffect(() => {
    if (!focusedFor) return;
    tableRef.current?.querySelector(`[data-row-id="${focusedFor.replaceAll("\"", "")}"]`)?.scrollIntoView?.({ block: "center" });
  }, [focusedFor, page]);

  // ---------------------------------------------------------------- columns

  const filled = useMemo(() => {
    const set = new Set<string>();
    for (const row of filtered) for (const [k, v] of Object.entries(row.values)) if (v && v.trim()) set.add(k);
    return set;
  }, [filtered]);

  const ordered = useMemo(() => {
    const byKey = new Map(columns.map((c) => [c.key, c]));
    const order = [...prefs.order.filter((k) => byKey.has(k)), ...columns.map((c) => c.key).filter((k) => !prefs.order.includes(k))];
    return order.map((k) => byKey.get(k)!);
  }, [columns, prefs.order]);

  // The user's own choices win; then "show all"; then identifiers; then
  // every column with a value somewhere in the filtered rows (all pages).
  const showAll = prefs.showAll;
  const isVisible = useCallback((c: GridColumn) => {
    if (prefs.hidden.includes(c.key)) return false;
    if (prefs.shown.includes(c.key) || showAll) return true;
    if (c.essential ?? c.pinned) return true;
    return !c.optional && filled.has(c.key);
  }, [prefs.hidden, prefs.shown, showAll, filled]);

  const visible = ordered.filter(isVisible);
  const autoHidden = ordered.filter((c) => !isVisible(c) && !prefs.hidden.includes(c.key));
  const isPinned = (c: GridColumn) => !narrow && (prefs.pinned.includes(c.key) || (c.pinned && !prefs.unpinned.includes(c.key)));
  const pinnedCols = visible.filter(isPinned);
  const display = [...pinnedCols, ...visible.filter((c) => !isPinned(c))];
  const widthOf = (c: GridColumn) => prefs.widths[c.key] ?? c.width ?? 160;
  const lead = CHECK + (renderExpanded ? EXPAND : 0);
  const offsets: Record<string, number> = {};
  pinnedCols.reduce((left, c) => { offsets[c.key] = left; return left + widthOf(c); }, lead);
  const tableWidth = lead + display.reduce((s, c) => s + widthOf(c), 0) + (hasStatus ? 140 : 0);

  // ---------------------------------------------------------------- paging / selection

  const pages = Math.max(1, Math.ceil(sorted.length / prefs.pageSize));
  const current = Math.min(page, pages - 1);
  const pageRows = sorted.slice(current * prefs.pageSize, current * prefs.pageSize + prefs.pageSize);
  const allPageSelected = pageRows.length > 0 && pageRows.every((r) => selected.has(r.id));

  const toggleRow = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  function startResize(event: React.PointerEvent, column: GridColumn) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const start = widthOf(column);
    const move = (e: PointerEvent) => update({ widths: { ...prefs.widths, [column.key]: Math.max(MIN_WIDTH, Math.round(start + e.clientX - startX)) } });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function dropColumn(target: string) {
    const source = dragColumn.current;
    dragColumn.current = null;
    if (!source || source === target) return;
    const order = ordered.map((c) => c.key).filter((k) => k !== source);
    order.splice(order.indexOf(target), 0, source);
    update({ order });
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard?.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied(null), 1200);
    } catch {
      // Clipboard unavailable; nothing to do.
    }
  }

  // Arrow-key movement between cells (the focused cell is a button/td with data-cell).
  function onKeyDown(event: React.KeyboardEvent) {
    const target = event.target as HTMLElement;
    const cell = target.closest<HTMLElement>("[data-cell]");
    if (!cell || !tableRef.current) return;
    const [r, c] = (cell.dataset.cell ?? "0:0").split(":").map(Number);
    const go = (row: number, col: number) => {
      const next = tableRef.current?.querySelector<HTMLElement>(`[data-cell="${row}:${col}"]`);
      if (next) { event.preventDefault(); next.focus(); }
    };
    if (event.key === "ArrowDown") go(r + 1, c);
    else if (event.key === "ArrowUp") go(r - 1, c);
    else if (event.key === "ArrowRight") go(r, c + 1);
    else if (event.key === "ArrowLeft") go(r, c - 1);
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
      const row = pageRows[r];
      const column = display[c];
      if (row && column) void copy(row.values[column.key] ?? "", `${row.id}:${column.key}`);
    } else if (event.key === "Enter" && onOpen) {
      const row = pageRows[r];
      if (row) onOpen(row);
    }
  }

  const activeFilters = Object.entries(filters).filter(([, v]) => v.trim());
  const chipCount = activeFilters.length + activeRanges.length + (query.trim() ? 1 : 0);
  const rangeText = ({ min, max }: { min: number | null; max: number | null }) =>
    min != null && max != null ? `${min.toLocaleString()} – ${max.toLocaleString()}` : min != null ? `≥ ${min.toLocaleString()}` : `≤ ${max!.toLocaleString()}`;
  const textClass = prefs.text === "wrap" ? "whitespace-pre-wrap break-words" : prefs.text === "two" ? "line-clamp-2 break-words" : "truncate";
  const cellPad = prefs.density === "compact" ? "px-2 py-1" : "px-3 py-2";
  const exportCols = display;

  const optionsFor = (key: string) => {
    const values = new Set<string>();
    for (const r of rows) { const v = key === "__status" ? r.status ?? "" : r.values[key] ?? ""; if (v) values.add(v); if (values.size > 40) break; }
    return [...values].sort(collator.compare);
  };

  return (
    <div className="space-y-2" data-testid="smart-grid">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[12rem] flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search these records…" aria-label="Search records"
            className="h-8 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-xs outline-none focus:border-primary/40" />
        </label>
        <button type="button" onClick={() => setShowFilters((v) => !v)} aria-pressed={showFilters}
          className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium ${showFilters ? "border-primary/40 bg-primary/10" : "border-border hover:bg-surface-soft"}`}>
          <Filter className="h-3.5 w-3.5" aria-hidden="true" />Filters{activeFilters.length ? ` (${activeFilters.length})` : ""}
        </button>
        <div className="relative">
          <button type="button" onClick={() => setMenuOpen((v) => !v)} aria-expanded={menuOpen} aria-haspopup="menu"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium hover:bg-surface-soft">
            <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />Columns
            <span className="tabular-nums text-text-muted">{visible.length}/{columns.length}</span>
          </button>
          {menuOpen && (
            <div role="menu" aria-label="Columns" className="absolute right-0 z-40 mt-1 max-h-80 w-72 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg">
              {ordered.map((c) => (
                <div key={c.key} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-surface-soft">
                  <input type="checkbox" checked={isVisible(c)} aria-label={`Show ${c.label}`} onChange={() => {
                    const on = isVisible(c);
                    update({
                      hidden: on ? [...prefs.hidden, c.key] : prefs.hidden.filter((k) => k !== c.key),
                      shown: on ? prefs.shown.filter((k) => k !== c.key) : [...prefs.shown, c.key],
                    });
                  }} />
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {!filled.has(c.key) && <span className="text-[10px] text-text-muted">empty</span>}
                  <button type="button" aria-label={isPinned(c) ? `Unpin ${c.label}` : `Pin ${c.label}`} title={isPinned(c) ? "Unpin" : "Pin left"}
                    onClick={() => update(isPinned(c)
                      ? { pinned: prefs.pinned.filter((k) => k !== c.key), unpinned: [...prefs.unpinned, c.key] }
                      : { pinned: [...prefs.pinned, c.key], unpinned: prefs.unpinned.filter((k) => k !== c.key) })}
                    className="text-text-muted hover:text-foreground">
                    {isPinned(c) ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => update(COLUMN_PREFS)}
                className="mt-1 w-full border-t border-border px-2 py-1.5 text-left text-xs text-primary">Reset columns</button>
            </div>
          )}
        </div>
        {showAll ? (
          <button type="button" onClick={() => update({ showAll: false })} aria-pressed={false}
            className="inline-flex h-8 items-center rounded-lg border border-border px-2.5 text-xs font-medium hover:bg-surface-soft">
            Hide empty columns
          </button>
        ) : (
          <button type="button" onClick={() => update({ showAll: true })} disabled={autoHidden.length === 0}
            title={autoHidden.length ? `${autoHidden.length} column${autoHidden.length === 1 ? " is" : "s are"} empty for these records or hidden by default` : "Every column is already shown"}
            className="inline-flex h-8 items-center rounded-lg border border-border px-2.5 text-xs font-medium hover:bg-surface-soft disabled:opacity-50">
            Show all fields{autoHidden.length ? ` (+${autoHidden.length})` : ""}
          </button>
        )}
        <button type="button" onClick={() => update(COLUMN_PREFS)}
          title="Restore the default columns, order, widths and pins for this table"
          className="inline-flex h-8 items-center rounded-lg px-2 text-xs font-medium text-text-secondary hover:bg-surface-soft hover:text-foreground">
          Reset columns
        </button>
        <select value={prefs.text} onChange={(e) => update({ text: e.target.value as TextMode })} aria-label="Text display" className="h-8 rounded-lg border border-border bg-background px-1.5 text-xs">
          <option value="single">One line</option>
          <option value="two">Two lines</option>
          <option value="wrap">Full text</option>
        </select>
        <select value={prefs.density} onChange={(e) => update({ density: e.target.value as Density })} aria-label="Density" className="h-8 rounded-lg border border-border bg-background px-1.5 text-xs">
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
        </select>
        {toolbar}
        <span className="ml-auto text-xs tabular-nums text-text-secondary" aria-live="polite">
          {sorted.length.toLocaleString()} of {rows.length.toLocaleString()}
        </span>
      </div>

      {/* Filter chips */}
      {chipCount > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" data-testid="filter-chips">
          <span className="text-[11px] text-text-muted">{chipCount} filter{chipCount === 1 ? "" : "s"}:</span>
          {query.trim() && (
            <button type="button" onClick={() => setQuery("")} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-foreground">
              “{query.trim()}” <X className="h-3 w-3" aria-label="Remove search" />
            </button>
          )}
          {activeFilters.map(([key, value]) => (
            <button key={key} type="button" onClick={() => setFilters((f) => ({ ...f, [key]: "" }))} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-foreground">
              {key === "__status" ? statusLabel : columns.find((c) => c.key === key)?.label}: {value} <X className="h-3 w-3" aria-label={`Remove ${value}`} />
            </button>
          ))}
          {activeRanges.map((range) => (
            <button key={range.key} type="button" onClick={() => setRanges((r) => ({ ...r, [range.key]: { min: "", max: "" } }))} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-foreground">
              {columns.find((c) => c.key === range.key)?.label}: {rangeText(range)} <X className="h-3 w-3" aria-label={`Remove ${columns.find((c) => c.key === range.key)?.label} range`} />
            </button>
          ))}
          <button type="button" onClick={() => { setQuery(""); setFilters({}); setRanges({}); }} className="text-[11px] font-medium text-primary hover:underline">Clear all</button>
        </div>
      )}

      {/* Bulk bar */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-soft px-3 py-1.5 text-xs" role="region" aria-label="Selection">
          <span className="font-medium">{selected.size} selected</span>
          <button type="button" onClick={() => setSelected(new Set(sorted.map((r) => r.id)))} className="text-primary hover:underline">Select all {sorted.length} results</button>
          <button type="button" onClick={() => downloadBlob(new Blob([csv(exportCols, sorted.filter((r) => selected.has(r.id)))], { type: "text/csv" }), `${exportName}-selected.csv`, "text/csv")}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 hover:bg-surface"><Download className="h-3 w-3" />Export selected</button>
          <button type="button" onClick={() => void copy(csv(exportCols, sorted.filter((r) => selected.has(r.id))).replaceAll(",", "\t"), "selection")}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 hover:bg-surface"><Copy className="h-3 w-3" />{copied === "selection" ? "Copied" : "Copy"}</button>
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto text-text-secondary hover:text-foreground">Clear</button>
        </div>
      )}

      {/* Table */}
      {sorted.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-text-muted">{rows.length ? "No records match these filters." : emptyMessage}</p>
      ) : (
        <div className="max-h-[68vh] overflow-auto rounded-xl border border-border bg-surface" onKeyDown={onKeyDown}>
          <table ref={tableRef} role="grid" aria-rowcount={sorted.length} className={`grid-divided table-fixed border-separate border-spacing-0 ${prefs.density === "compact" ? "text-[13px]" : "text-sm"}`} style={{ width: tableWidth, minWidth: "100%" }}>
            <colgroup>
              <col style={{ width: CHECK }} />
              {renderExpanded && <col style={{ width: EXPAND }} />}
              {display.map((c) => <col key={c.key} style={{ width: widthOf(c) }} />)}
              {hasStatus && <col style={{ width: 140 }} />}
            </colgroup>
            <thead>
              <tr>
                <th className="sticky left-0 top-0 z-30 border-b border-border bg-surface-soft text-center">
                  <input type="checkbox" aria-label="Select all on this page" checked={allPageSelected}
                    onChange={() => setSelected((s) => { const n = new Set(s); pageRows.forEach((r) => (allPageSelected ? n.delete(r.id) : n.add(r.id))); return n; })} />
                </th>
                {renderExpanded && <th className="sticky top-0 z-30 border-b border-border bg-surface-soft" style={{ left: CHECK }} aria-label="Expand" />}
                {display.map((c) => {
                  const active = sort?.key === c.key;
                  const pinned = isPinned(c);
                  return (
                    <th
                      key={c.key}
                      scope="col"
                      aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none"}
                      draggable
                      onDragStart={() => { dragColumn.current = c.key; }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => dropColumn(c.key)}
                      className={`relative sticky top-0 border-b border-border bg-surface-soft px-2.5 py-2 text-left text-[12px] font-semibold text-text-secondary ${pinned ? "z-30" : "z-20"}`}
                      style={pinned ? { left: offsets[c.key] } : undefined}
                      title={c.label}
                    >
                      <button type="button" onClick={() => setSort(active && sort!.dir === "desc" ? null : { key: c.key, dir: active ? "desc" : "asc" })}
                        className="flex w-full items-center gap-1 text-left" aria-label={`Sort by ${c.label}`}>
                        <span className="line-clamp-2 min-w-0">{c.label}</span>
                        {active ? (sort!.dir === "asc" ? <ArrowUp className="h-3 w-3 shrink-0 text-primary" /> : <ArrowDown className="h-3 w-3 shrink-0 text-primary" />) : <ArrowUpDown className="h-3 w-3 shrink-0 text-text-muted" />}
                      </button>
                      {showFilters && (
                        c.filter === "range" ? (
                          <span className="mt-1 flex gap-1">
                            {(["min", "max"] as const).map((bound) => (
                              <input key={bound} inputMode="decimal" value={ranges[c.key]?.[bound] ?? ""}
                                onChange={(e) => setRanges((r) => ({ ...r, [c.key]: { min: r[c.key]?.min ?? "", max: r[c.key]?.max ?? "", [bound]: e.target.value } }))}
                                placeholder={bound === "min" ? "Min" : "Max"} aria-label={`${c.label} ${bound === "min" ? "minimum" : "maximum"}`}
                                className="h-7 w-full min-w-0 rounded border border-border bg-background px-1.5 text-[11px] font-normal" />
                            ))}
                          </span>
                        ) : c.filter === "options" ? (
                          <select value={filters[c.key] ?? ""} onChange={(e) => setFilters((f) => ({ ...f, [c.key]: e.target.value }))} aria-label={`Filter ${c.label}`}
                            className="mt-1 h-7 w-full rounded border border-border bg-background px-1 text-[11px] font-normal">
                            <option value="">All</option>
                            {optionsFor(c.key).map((v) => <option key={v} value={v}>{v}</option>)}
                          </select>
                        ) : (
                          <input value={filters[c.key] ?? ""} onChange={(e) => setFilters((f) => ({ ...f, [c.key]: e.target.value }))} placeholder="Filter…" aria-label={`Filter ${c.label}`}
                            className="mt-1 h-7 w-full rounded border border-border bg-background px-1.5 text-[11px] font-normal" />
                        )
                      )}
                      <span role="separator" aria-orientation="vertical" aria-label={`Resize ${c.label}`} onPointerDown={(e) => startResize(e, c)}
                        className="absolute right-0 top-0 h-full w-2 cursor-col-resize hover:bg-primary/30" />
                    </th>
                  );
                })}
                {hasStatus && (
                  <th scope="col" className="sticky top-0 z-20 border-b border-border bg-surface-soft px-2.5 py-2 text-left text-[12px] font-semibold text-text-secondary">
                    <button type="button" onClick={() => setSort(sort?.key === "__status" && sort.dir === "desc" ? null : { key: "__status", dir: sort?.key === "__status" ? "desc" : "asc" })} aria-label={`Sort by ${statusLabel}`}>{statusLabel}</button>
                    {showFilters && (
                      <select value={filters.__status ?? ""} onChange={(e) => setFilters((f) => ({ ...f, __status: e.target.value }))} aria-label={`Filter ${statusLabel}`} className="mt-1 h-7 w-full rounded border border-border bg-background px-1 text-[11px] font-normal">
                        <option value="">All</option>
                        {optionsFor("__status").map((v) => <option key={v} value={v}>{v}</option>)}
                      </select>
                    )}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row, r) => {
                const isSelected = selectedId === row.id;
                const isOpen = expanded.has(row.id);
                return (
                  <Fragment key={row.id}>
                    <tr className={`group ${isSelected ? "bg-primary/[0.07]" : "hover:bg-surface-soft"} ${onOpen ? "cursor-pointer" : ""}`} onClick={() => onOpen?.(row)} data-testid="smart-row" data-row-id={row.id}>
                      <td className="sticky left-0 z-10 border-b border-border/60 bg-surface text-center group-hover:bg-surface-soft" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={selected.has(row.id)} onChange={() => toggleRow(row.id)} aria-label={`Select ${row.values[display[0]?.key] ?? row.id}`} />
                      </td>
                      {renderExpanded && (
                        <td className="sticky z-10 border-b border-border/60 bg-surface text-center group-hover:bg-surface-soft" style={{ left: CHECK }} onClick={(e) => e.stopPropagation()}>
                          <button type="button" aria-expanded={isOpen} aria-label={isOpen ? "Collapse row" : "Expand row"}
                            onClick={() => setExpanded((s) => { const n = new Set(s); if (n.has(row.id)) n.delete(row.id); else n.add(row.id); return n; })}
                            className="text-text-muted hover:text-foreground">
                            {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          </button>
                        </td>
                      )}
                      {display.map((c, ci) => {
                        const value = row.values[c.key] ?? "";
                        const pinned = isPinned(c);
                        const key = `${row.id}:${c.key}`;
                        return (
                          <td key={c.key} data-cell={`${r}:${ci}`} tabIndex={r === 0 && ci === 0 ? 0 : -1}
                            className={`relative border-b border-border/60 align-top outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 ${cellPad} ${pinned ? "sticky z-10 bg-surface group-hover:bg-surface-soft" : ""} ${ci === 0 ? "font-medium" : ""}`}
                            style={pinned ? { left: offsets[c.key] } : undefined}
                            title={prefs.text !== "wrap" && value.length > 40 ? value.slice(0, 500) : undefined}>
                            <span className={`block ${textClass} ${value ? "text-foreground" : "text-text-muted/50"}`}>{value || "—"}</span>
                            {value && (
                              <button type="button" onClick={(e) => { e.stopPropagation(); void copy(value, key); }} aria-label={`Copy ${c.label}`}
                                className="absolute right-1 top-1 hidden rounded bg-surface p-0.5 text-text-muted shadow-sm hover:text-foreground group-hover:block">
                                <Copy className="h-3 w-3" />
                              </button>
                            )}
                            {copied === key && <span className="absolute right-1 top-1 rounded bg-success/10 px-1 text-[10px] text-success">Copied</span>}
                          </td>
                        );
                      })}
                      {hasStatus && <td className={`border-b border-border/60 align-top ${cellPad}`}>{renderStatus ? renderStatus(row.status) : row.status}</td>}
                    </tr>
                    {renderExpanded && isOpen && (
                      <tr className="bg-surface-soft/50">
                        <td colSpan={display.length + 2 + (hasStatus ? 1 : 0)} className="border-b border-border/60 px-4 py-3">{renderExpanded(row)}</td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Footer */}
      {sorted.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-secondary">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => downloadBlob(new Blob([csv(exportCols, sorted)], { type: "text/csv" }), `${exportName}.csv`, "text/csv")}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 hover:bg-surface-soft"><Download className="h-3 w-3" />Export {sorted.length === rows.length ? "all" : "filtered"} ({sorted.length})</button>
            <label className="flex items-center gap-1">Rows
              <select value={prefs.pageSize} onChange={(e) => update({ pageSize: Number(e.target.value) })} aria-label="Rows per page" className="h-7 rounded border border-border bg-background px-1">
                {[25, 50, 100, 250].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          </div>
          {pages > 1 && (
            <div className="flex items-center gap-2">
              <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)} className="rounded border border-border px-2 py-1 disabled:opacity-40">Previous</button>
              <span className="tabular-nums">Page {current + 1} of {pages}</span>
              <button type="button" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} className="rounded border border-border px-2 py-1 disabled:opacity-40">Next</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
