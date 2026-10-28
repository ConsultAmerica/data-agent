"use client";

import { ChevronDown, Columns3, Search, WrapText } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { SourceViewRequest } from "@/components/source-verification-panel";
import {
  ReviewStatusBadge,
  cellSourceRequest,
  formatCellValue,
} from "@/components/staging/review-status";
import ResizeHandle, { useGridSizes } from "@/components/staging/resize-handle";
import SelectCheckbox from "@/components/staging/select-checkbox";
import SelectionToolbar from "@/components/staging/selection-toolbar";
import SortableHeader from "@/components/staging/sortable-header";
import StagingRecordDrawer from "@/components/staging/staging-record-drawer";
import DensityToggle from "@/components/ui/density-toggle";
import FieldToneLegend from "@/components/ui/field-tone-legend";
import {
  MIN_COLUMN_WIDTH,
  TRAILING_MAX_WIDTH,
  arrangeColumns,
  columnWidth,
  frozenColumnCount,
  frozenOffsets,
} from "@/lib/data-grid";
import { fieldToneClass, toneFromStagingCell } from "@/lib/field-tone";
import type { StagingColumn, StagingDataset, StagingRecord } from "@/lib/staging-workbook";
import {
  allSelected,
  isSelected,
  rangeBlock,
  setCells,
  someSelected,
  toggleBlock,
  toggleCell,
  useTableSelection,
} from "@/lib/table-selection";
import { cycleSort, sortByText, type SortState } from "@/lib/table-sort";
import { useTableDensity } from "@/lib/table-density";

const STATUS_SORT_FIELD = "__status__";

type StatusFilter = "all" | "Verified" | "Needs Review" | "complete" | "partial";

interface StagingDatasetTableProps {
  dataset: StagingDataset;
  /** Needed to load full records of a compact dataset. */
  documentId?: string;
  onOpenSource?: (request: SourceViewRequest) => void;
  onOpenDataset?: (datasetId: string) => void;
  selectedId?: string | null;
  pageSize?: number;
  dense?: boolean;
  /** Excel-style cell / row / column selection with Export Selected
   * (needs documentId). On by default. */
  selectable?: boolean;
  /** Column header sort controls. Off for simple upload/read views. */
  sortable?: boolean;
  /** The source document's name, for export file names. */
  filename?: string;
}

const DEFAULT_PAGE_SIZE = 25;
const STATUS_WIDTH = 130;
const DETAILS_WIDTH = 80;
const LINK_WIDTH = 120;
const DENSE_MAX_WIDTH = 260;
const CHECK_WIDTH = 36;
// Below this width a wide grid becomes record cards.
const NARROW_QUERY = "(max-width: 767px)";

function resultTone(value: string): string {
  const upper = value.toUpperCase();
  if (upper.startsWith("PASS")) return "font-medium text-success";
  if (upper.startsWith("REVIEW") || upper.startsWith("NOT FOUND")) return "font-medium text-warning";
  return "text-foreground";
}

/** The dataset's grid columns, in its own order and under its own labels. */
function gridColumns(dataset: StagingDataset): StagingColumn[] {
  const grid = dataset.grid_fields ?? [];
  if (grid.length === 0) return dataset.columns;
  return grid
    .map((field) => dataset.columns.find((column) => column.canonical_field === field))
    .filter((column): column is StagingColumn => Boolean(column));
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return narrow;
}

/** Any repeating dataset of any profile as a compact data grid: one line per
 * record (long values ellipsized), sticky header, leading identifier columns
 * frozen, horizontal scroll only when the columns don't fit. A record opens
 * in full — every value with its evidence — in the details drawer. */
export default function StagingDatasetTable({
  dataset,
  documentId,
  onOpenSource,
  onOpenDataset,
  selectedId,
  pageSize = DEFAULT_PAGE_SIZE,
  dense: denseProp = false,
  selectable = true,
  sortable = true,
  filename,
}: StagingDatasetTableProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [columnQuery, setColumnQuery] = useState("");
  const [sort, setSort] = useState<SortState>(null);
  const [page, setPage] = useState(0);
  const [hiddenFields, setHiddenFields] = useState<Set<string>>(() => new Set());
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [wrapCells, setWrapCells] = useState(false);
  const columnsMenuRef = useRef<HTMLDivElement>(null);
  // A full-text dataset is a document's reading view: the reader picks
  // how many records a page holds (0 = all).
  const fullText = Boolean(dataset.full_text);
  const [chosenPageSize, setChosenPageSize] = useState(fullText ? 100 : pageSize);
  const effectivePageSize = fullText ? chosenPageSize || Math.max(dataset.records.length, 1) : pageSize;
  const [openRecord, setOpenRecord] = useState<StagingRecord | null>(null);
  const narrow = useNarrow();
  // A caller can force dense; otherwise the viewer's Comfortable / Compact choice.
  const [densityChoice, setDensity] = useTableDensity("staging");
  const dense = denseProp || densityChoice === "compact";

  const allColumns = useMemo(() => gridColumns(dataset), [dataset]);
  const columnKey = allColumns.map((column) => column.canonical_field).join("|");
  useEffect(() => {
    setHiddenFields((current) => (current.size === 0 ? current : new Set()));
  }, [columnKey]);
  const shownColumns = useMemo(
    () => allColumns.filter((column) => !hiddenFields.has(column.canonical_field)),
    [allColumns, hiddenFields],
  );
  // Excel-style column widths / row heights set by dragging an edge.
  const sizes = useGridSizes();
  // Selection needs the document (exports are read server-side by id).
  const selecting = selectable && Boolean(documentId);
  const checkWidth = selecting ? CHECK_WIDTH : 0;
  const [selection, setSelection] = useTableSelection(documentId, dataset.dataset_id, dataset.display_name);
  const [anchor, setAnchor] = useState<{ recordId: string; field: string } | null>(null);
  // Every record opens in full; a compact dataset loads it by id.
  const canOpen = !dataset.compact || Boolean(documentId);
  const isBusiness = dataset.role === "business";
  const hasStatus = isBusiness && dataset.records.some((r) => r.record_status != null);
  const hasLinks = dataset.records.some((r) => r.links_to_dataset);

  const isClin = dataset.dataset_id === "clins";

  useEffect(() => {
    if (!columnsOpen) return;
    function onDown(event: MouseEvent) {
      if (!columnsMenuRef.current?.contains(event.target as Node)) setColumnsOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setColumnsOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [columnsOpen]);

  function clinShape(record: StagingRecord): "complete" | "partial" {
    const value = (field: string) => record.cells[field]?.value;
    const described = Boolean(value("contract.clin.description"));
    const priced = Boolean(
      value("contract.clin.max_amount") ||
        value("contract.clin.unit_price") ||
        value("contract.clin.max_quantity") ||
        value("contract.clin.unit"),
    );
    return described && priced ? "complete" : "partial";
  }

  function toggleColumn(field: string) {
    setHiddenFields((current) => {
      const next = new Set(current);
      if (next.has(field)) next.delete(field);
      else if (allColumns.length - next.size > 1) next.add(field);
      return next;
    });
  }

  const filtered = useMemo(() => {
    const needle = columnQuery.trim().toLowerCase();
    return dataset.records.filter((record) => {
      if (statusFilter === "complete" || statusFilter === "partial") {
        if (clinShape(record) !== statusFilter) return false;
      } else if (statusFilter !== "all" && record.record_status !== statusFilter) {
        return false;
      }
      if (!needle) return true;
      return Object.values(record.cells).some((cell) =>
        formatCellValue(cell).toLowerCase().includes(needle),
      );
    });
  }, [dataset.records, statusFilter, columnQuery]);

  const sorted = useMemo(
    () =>
      sortByText(filtered, sort, (record, field) => {
        if (field === STATUS_SORT_FIELD) return record.record_status ?? "";
        const cell = record.cells[field];
        return cell ? formatCellValue(cell) : "";
      }),
    [filtered, sort],
  );

  // Reset to the first page when the filter, sort, or dataset changes (render-time
  // state adjustment, as in React's docs, instead of an extra effect pass).
  const [resetKey, setResetKey] = useState({ statusFilter, sort, records: dataset.records, columnQuery });
  if (
    resetKey.statusFilter !== statusFilter ||
    resetKey.sort !== sort ||
    resetKey.records !== dataset.records ||
    resetKey.columnQuery !== columnQuery
  ) {
    setResetKey({ statusFilter, sort, records: dataset.records, columnQuery });
    if (page !== 0) setPage(0);
  }

  const totalPages = Math.max(1, Math.ceil(sorted.length / effectivePageSize));
  const clampedPage = Math.min(page, totalPages - 1);
  const paged = useMemo(
    () => sorted.slice(clampedPage * effectivePageSize, clampedPage * effectivePageSize + effectivePageSize),
    [sorted, clampedPage, effectivePageSize],
  );
  // Columns that tell this page's rows apart lead; blank / repeated ones and
  // leading categories (Section, Record Type) trail, narrow.
  const { columns, trailing } = useMemo(
    () => arrangeColumns(shownColumns, paged, dataset.records),
    [shownColumns, paged, dataset.records],
  );
  // Dense grids trade width for more columns on screen (values ellipsize).
  const widths = useMemo(
    () =>
      columns.map((column) => {
        const set = sizes.columns[column.canonical_field];
        if (set) return set;
        let width = columnWidth(column, dataset.records);
        if (trailing.has(column.canonical_field)) width = Math.min(width, TRAILING_MAX_WIDTH);
        return dense ? Math.max(MIN_COLUMN_WIDTH, Math.min(DENSE_MAX_WIDTH, Math.round(width * 0.85))) : width;
      }),
    [columns, trailing, dataset.records, dense, sizes.columns],
  );
  const frozen = frozenColumnCount(columns, widths);
  const offsets = frozenOffsets(widths, frozen).map((offset) => offset + checkWidth);
  const fieldIds = useMemo(() => columns.map((column) => column.canonical_field), [columns]);
  const tableWidth =
    checkWidth +
    widths.reduce((sum, width) => sum + width, 0) +
    (isBusiness ? STATUS_WIDTH : 0) +
    (canOpen ? DETAILS_WIDTH : 0) +
    (hasLinks ? LINK_WIDTH : 0);
  // A column header selects the field for every record of the current
  // (searched / filtered / sorted) dataset — not just this page.
  const filteredIds = useMemo(() => sorted.map((record) => record.record_id), [sorted]);
  const pagedIds = paged.map((record) => record.record_id);

  function changeSort(field: string) {
    setSort((current) => cycleSort(current, field));
  }

  function selectCell(event: React.MouseEvent, recordId: string, field: string) {
    if (event.shiftKey && anchor) {
      const block = rangeBlock(filteredIds, fieldIds, anchor, { recordId, field });
      if (block) {
        setSelection((current) => setCells(current, block.recordIds, block.fields, true));
        return;
      }
    }
    setAnchor({ recordId, field });
    setSelection((current) =>
      // A click (or Ctrl/Cmd+click) toggles the cell, like its checkbox.
      toggleCell(current, recordId, field),
    );
  }

  if (dataset.records.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface-soft px-4 py-10 text-center text-sm text-text-secondary">
        No source-supported records found.
      </div>
    );
  }

  const statusOptions: StatusFilter[] = isClin ? ["all", "complete", "partial", "Needs Review"] : ["all", "Verified", "Needs Review"];
  const statusLabel = (value: StatusFilter) =>
    value === "all" ? "All" : value === "complete" ? "Complete" : value === "partial" ? "Partial" : value;

  function cellText(record: StagingRecord, column: StagingColumn): string {
    const cell = record.cells[column.canonical_field];
    return cell ? formatCellValue(cell) : "";
  }

  function renderValue(record: StagingRecord, column: StagingColumn) {
    const cell = record.cells[column.canonical_field];
    const text = cellText(record, column);
    if (!text) return <span className="text-text-muted">—</span>;
    const requestId = `${dataset.dataset_id}:${record.record_id}:${column.canonical_field}`;
    const request = cell ? cellSourceRequest(cell, requestId) : null;
    const display = wrapCells ? text : text.replace(/\s+/g, " ");
    const clip = wrapCells ? "whitespace-pre-wrap break-words" : "truncate";
    if (request && onOpenSource) {
      return (
        <button
          type="button"
          onClick={(event) => {
            // Ctrl/Cmd/Shift+click selects the cell instead.
            if (selecting && (event.ctrlKey || event.metaKey || event.shiftKey)) return;
            event.stopPropagation();
            onOpenSource(request);
          }}
          className={`block max-w-full text-left text-foreground underline decoration-dotted decoration-text-muted hover:text-primary hover:decoration-primary ${clip}`}
        >
          {display}
        </button>
      );
    }
    if (column.canonical_field === "qa.result") return <span className={`block ${clip} ${resultTone(text)}`}>{display}</span>;
    return <span className={`block ${clip} text-foreground`}>{display}</span>;
  }

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2" data-testid="grid-toolbar">
      <label className="relative min-w-[10rem] flex-1 sm:max-w-xs">
        <span className="sr-only">Search columns</span>
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" aria-hidden="true" />
        <input
          type="search"
          value={columnQuery}
          onChange={(event) => setColumnQuery(event.target.value)}
          placeholder="Search values…"
          aria-label="Search values in this table"
          className="h-8 w-full rounded-lg border border-border bg-background py-1.5 pl-8 pr-2 text-xs outline-none focus:border-primary/40"
        />
      </label>
      {(hasStatus || isClin) && (
        <label className="relative flex h-8 items-center gap-1 rounded-lg border border-border pl-3 pr-1 text-xs text-text-secondary">
          {isClin ? "Show:" : "Staging status:"}
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
            aria-label={isClin ? "CLIN completeness" : "Review status"}
            className="h-full appearance-none bg-transparent pl-1 pr-5 font-medium text-foreground outline-none"
          >
            {statusOptions.map((value) => (
              <option key={value} value={value}>
                {statusLabel(value)}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5" aria-hidden="true" />
        </label>
      )}
      <button
        type="button"
        aria-pressed={wrapCells}
        onClick={() => setWrapCells((value) => !value)}
        title={wrapCells ? "Show one line per cell" : "Wrap cell text to show full content"}
        className={[
          "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium",
          wrapCells
            ? "border-primary/40 bg-primary/10 text-foreground"
            : "border-border text-foreground hover:bg-surface-soft",
        ].join(" ")}
        data-testid="wrap-cells"
      >
        <WrapText className="h-3.5 w-3.5" aria-hidden="true" />
        Wrap text
      </button>
      {!denseProp && <DensityToggle value={densityChoice} onChange={setDensity} />}
      <div className="relative" ref={columnsMenuRef}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={columnsOpen}
          onClick={() => setColumnsOpen((open) => !open)}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium text-foreground hover:bg-surface-soft"
          data-testid="column-visibility"
        >
          <Columns3 className="h-3.5 w-3.5" aria-hidden="true" />
          Columns
          {hiddenFields.size > 0 && (
            <span className="tabular-nums text-text-muted">({allColumns.length - hiddenFields.size}/{allColumns.length})</span>
          )}
        </button>
        {columnsOpen && (
          <div
            role="menu"
            aria-label="Column visibility"
            className="absolute right-0 z-40 mt-1 max-h-72 w-64 overflow-y-auto rounded-lg border border-border bg-surface py-1 shadow-md"
          >
            {allColumns.map((column) => {
              const visible = !hiddenFields.has(column.canonical_field);
              return (
                <label
                  key={column.canonical_field}
                  role="menuitemcheckbox"
                  aria-checked={visible}
                  className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-surface-soft"
                >
                  <input
                    type="checkbox"
                    checked={visible}
                    onChange={() => toggleColumn(column.canonical_field)}
                    aria-label={`Show column ${column.display_label}`}
                  />
                  <span className="truncate">{column.display_label}</span>
                </label>
              );
            })}
            {hiddenFields.size > 0 && (
              <button
                type="button"
                className="mt-1 w-full border-t border-border px-3 py-1.5 text-left text-xs font-medium text-primary hover:bg-surface-soft"
                onClick={() => setHiddenFields(new Set())}
              >
                Show all columns
              </button>
            )}
          </div>
        )}
      </div>
      <span className="text-xs tabular-nums text-text-secondary" aria-live="polite">
        {sorted.length.toLocaleString()} of {dataset.records.length.toLocaleString()} record
        {dataset.records.length === 1 ? "" : "s"}
      </span>
      {hasStatus && <FieldToneLegend />}
      {fullText && (
        <label className="ml-auto flex items-center gap-1.5 text-xs text-text-secondary">
          Rows per page
          <select
            value={chosenPageSize}
            onChange={(event) => {
              setChosenPageSize(Number(event.target.value));
              setPage(0);
            }}
            className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-foreground"
          >
            {[25, 100, 250].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
            <option value={0}>All</option>
          </select>
        </label>
      )}
    </div>
  );

  return (
    <div className="space-y-2">
      {isClin && (
        <p className="text-xs text-text-secondary">
          {dataset.records.filter((record) => clinShape(record) === "complete").length} complete ·{" "}
          {dataset.records.filter((record) => clinShape(record) === "partial").length} partial. Partial rows
          only have a CLIN identifier in the source; missing description, quantity, unit, or amount is not filled in.
        </p>
      )}
      {toolbar}
      {selecting && (
        <SelectionToolbar
          documentId={documentId}
          datasetId={dataset.dataset_id}
          filename={filename ?? "export"}
          selection={selection}
          onClear={() => setSelection(new Map())}
          onSelectVisible={() => setSelection((current) => setCells(current, pagedIds, fieldIds, true))}
          resultCount={filteredIds.length}
          allResultsSelected={allSelected(selection, filteredIds, fieldIds)}
          onSelectAllResults={() => setSelection((current) => setCells(current, filteredIds, fieldIds, true))}
        />
      )}

      {sorted.length === 0 ? (
        <div className="rounded-xl border border-border bg-surface-soft px-4 py-10 text-center text-sm text-text-secondary">
          No records match this filter.
        </div>
      ) : narrow ? (
        <ul className="space-y-2" data-testid="record-cards">
          {paged.map((record) => (
            <li key={record.record_id} className="rounded-xl border border-border bg-surface p-3">
              <dl className="space-y-1 text-sm">
                {columns
                  .filter((column) => cellText(record, column))
                  .slice(0, 4)
                  .map((column) => (
                    <div key={column.canonical_field} className="grid grid-cols-[minmax(6rem,40%)_1fr] gap-2">
                      <dt className="truncate text-text-secondary">{column.display_label}</dt>
                      <dd className="line-clamp-2 break-words text-foreground">{cellText(record, column)}</dd>
                    </div>
                  ))}
              </dl>
              <div className="mt-2 flex items-center justify-between">
                {isBusiness ? <ReviewStatusBadge status={record.record_status} /> : <span />}
                {canOpen && (
                  <button type="button" onClick={() => setOpenRecord(record)} className="text-xs font-medium text-primary hover:underline">
                    View details
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="max-h-[70vh] w-full overflow-auto rounded-xl border border-border bg-surface" data-testid="data-grid">
          <table
            className={["table-fixed border-separate border-spacing-0 text-sm", wrapCells ? "grid-cells-wrap" : ""].join(" ")}
            style={{ width: tableWidth, minWidth: "100%" }}
          >
            <colgroup>
              {selecting && <col style={{ width: CHECK_WIDTH }} />}
              {widths.map((width, index) => (
                <col key={columns[index].canonical_field} style={{ width }} />
              ))}
              {isBusiness && <col style={{ width: STATUS_WIDTH }} />}
              {canOpen && <col style={{ width: DETAILS_WIDTH }} />}
              {hasLinks && <col style={{ width: LINK_WIDTH }} />}
            </colgroup>
            <thead>
              <tr>
                {selecting && (
                  <th
                    scope="col"
                    className={`sticky left-0 top-0 z-30 border-b border-border bg-surface-soft text-center ${dense ? "h-8" : "h-11"}`}
                  >
                    {/* The page only; "Select all N results" is offered in the toolbar. */}
                    <SelectCheckbox
                      checked={allSelected(selection, pagedIds, fieldIds)}
                      indeterminate={someSelected(selection, pagedIds, fieldIds)}
                      onChange={() => setSelection((current) => toggleBlock(current, pagedIds, fieldIds))}
                      label={`Select all ${pagedIds.length} records on this page`}
                    />
                  </th>
                )}
                {columns.map((column, index) => {
                  const active = sort?.field === column.canonical_field;
                  return (
                  <th
                    key={column.canonical_field}
                    scope="col"
                    aria-sort={
                      active && sort
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    title={column.display_label}
                    className={[
                      `relative sticky top-0 ${dense ? "h-8 px-2 pr-3" : "h-11 px-3 pr-4"} border-b border-border bg-surface-soft text-left align-middle text-[11px] font-semibold uppercase leading-tight tracking-wide text-text-secondary`,
                      index < frozen ? "z-30" : "z-20",
                      index === frozen - 1 ? "border-r" : "",
                    ].join(" ")}
                    style={index < frozen ? { left: offsets[index] } : undefined}
                  >
                    <ResizeHandle
                      axis="column"
                      label={`Resize column ${column.display_label}`}
                      onResize={(size) => sizes.setColumn(column.canonical_field, size)}
                      onReset={() => sizes.setColumn(column.canonical_field, null)}
                    />
                    {selecting || sortable ? (
                      <span className="flex items-center gap-1.5">
                        {selecting && (
                          <SelectCheckbox
                            checked={allSelected(selection, filteredIds, [column.canonical_field])}
                            indeterminate={someSelected(selection, filteredIds, [column.canonical_field])}
                            onChange={() =>
                              setSelection((current) => toggleBlock(current, filteredIds, [column.canonical_field]))
                            }
                            label={`Select column ${column.display_label}`}
                            className="col-check"
                          />
                        )}
                        {sortable ? (
                          <SortableHeader
                            label={column.display_label}
                            active={active}
                            direction={sort?.direction}
                            onSort={() => changeSort(column.canonical_field)}
                          />
                        ) : (
                          <span className="line-clamp-2 min-w-0 break-normal">{column.display_label}</span>
                        )}
                      </span>
                    ) : (
                      <span className="line-clamp-2 min-w-0 break-normal">{column.display_label}</span>
                    )}
                  </th>
                  );
                })}
                {isBusiness && (
                  <th
                    scope="col"
                    aria-sort={
                      sortable && sort?.field === STATUS_SORT_FIELD
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className={`sticky top-0 z-20 border-b border-border bg-surface-soft text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary ${dense ? "h-8 px-2" : "h-11 px-3"}`}
                  >
                    {sortable ? (
                      <SortableHeader
                        label="Status"
                        active={sort?.field === STATUS_SORT_FIELD}
                        direction={sort?.direction}
                        onSort={() => changeSort(STATUS_SORT_FIELD)}
                      />
                    ) : (
                      <span>Status</span>
                    )}
                  </th>
                )}
                {canOpen && (
                  <th scope="col" className={`sticky top-0 z-20 border-b border-border bg-surface-soft ${dense ? "h-8 px-2" : "h-11 px-3"}`}>
                    <span className="sr-only">Details</span>
                  </th>
                )}
                {hasLinks && <th scope="col" className={`sticky top-0 z-20 border-b border-border bg-surface-soft ${dense ? "h-8 px-2" : "h-11 px-3"}`} />}
              </tr>
            </thead>
            <tbody>
              {paged.map((record) => {
                const height = sizes.rows[record.record_id];
                const resizeRow = (key: string) => (
                  <ResizeHandle
                    key={key}
                    axis="row"
                    label={`Resize record ${cellText(record, columns[0]) || record.record_id}`}
                    onResize={(size) => sizes.setRow(record.record_id, size)}
                    onReset={() => sizes.setRow(record.record_id, null)}
                  />
                );
                return (
                <tr
                  key={record.record_id}
                  style={height && !wrapCells ? { height } : undefined}
                  tabIndex={canOpen ? 0 : undefined}
                  // With selection on, a click selects a cell; Details / Enter open the record.
                  onClick={canOpen && !selecting ? () => setOpenRecord(record) : undefined}
                  onKeyDown={
                    canOpen
                      ? (event) => {
                          if (event.key === "Enter" && event.target === event.currentTarget) setOpenRecord(record);
                        }
                      : undefined
                  }
                  className={[
                    "group",
                    height || wrapCells ? "grid-row-wrap" : "",
                    canOpen && !selecting ? "cursor-pointer" : "",
                    canOpen ? "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary" : "",
                  ].join(" ")}
                >
                  {selecting && (
                    <td
                      className={`relative sticky left-0 z-10 border-b border-border/70 bg-surface text-center align-middle ${
                        wrapCells ? (dense ? "px-1 py-1.5" : "px-1 py-2") : dense ? "h-8" : "h-11"
                      }`}
                    >
                      <SelectCheckbox
                        checked={allSelected(selection, [record.record_id], fieldIds)}
                        indeterminate={someSelected(selection, [record.record_id], fieldIds)}
                        onChange={() => setSelection((current) => toggleBlock(current, [record.record_id], fieldIds))}
                        label={`Select record ${cellText(record, columns[0]) || record.record_id}`}
                      />
                      {resizeRow("row-check")}
                    </td>
                  )}
                  {columns.map((column, columnIndex) => {
                    const requestId = `${dataset.dataset_id}:${record.record_id}:${column.canonical_field}`;
                    const text = cellText(record, column);
                    const picked = selecting && isSelected(selection, record.record_id, column.canonical_field);
                    return (
                      <td
                        key={column.canonical_field}
                        onMouseDown={selecting ? (event) => event.shiftKey && event.preventDefault() : undefined}
                        onClick={selecting ? (event) => selectCell(event, record.record_id, column.canonical_field) : undefined}
                        aria-selected={selecting ? picked : undefined}
                        className={[
                          "relative",
                          picked ? "cell-selected" : "",
                          selecting ? "cursor-cell" : "",
                          wrapCells ? (dense ? "px-2 py-1.5 text-[13px]" : "px-3 py-2") : dense ? "h-8 px-2 text-[13px]" : "h-11 px-3",
                          "border-b border-border/70 align-middle group-hover:bg-surface-soft",
                          selectedId === requestId ? "bg-primary/[0.08]" : "",
                          columnIndex < frozen ? "sticky z-10 bg-surface" : "",
                          columnIndex === frozen - 1 ? "border-r" : "",
                          fieldToneClass(toneFromStagingCell(record.cells[column.canonical_field]), "cell"),
                        ].join(" ")}
                        style={columnIndex < frozen ? { left: offsets[columnIndex] } : undefined}
                        title={!wrapCells && text.length > 30 ? text.slice(0, 300) : undefined}
                      >
                        {selecting ? (
                          <span className="flex min-w-0 items-center gap-1.5">
                            <SelectCheckbox
                              small
                              className="cell-check"
                              checked={picked}
                              onChange={() =>
                                setSelection((current) => toggleCell(current, record.record_id, column.canonical_field))
                              }
                              label={`Select ${column.display_label} of ${cellText(record, columns[0]) || record.record_id}`}
                            />
                            <span className="min-w-0 flex-1">{renderValue(record, column)}</span>
                          </span>
                        ) : (
                          renderValue(record, column)
                        )}
                        {resizeRow(`row-${column.canonical_field}`)}
                        <ResizeHandle
                          axis="column"
                          label={`Resize column ${column.display_label}`}
                          onResize={(size) => sizes.setColumn(column.canonical_field, size)}
                          onReset={() => sizes.setColumn(column.canonical_field, null)}
                        />
                      </td>
                    );
                  })}
                  {isBusiness && (
                    <td className={`relative border-b border-border/70 align-middle group-hover:bg-surface-soft ${dense ? "h-8 px-2" : "h-11 px-3"}`}>
                      <ReviewStatusBadge status={record.record_status} />
                      {resizeRow("row-status")}
                    </td>
                  )}
                  {canOpen && (
                    <td className={`relative border-b border-border/70 text-right align-middle group-hover:bg-surface-soft ${dense ? "h-8 px-2" : "h-11 px-3"}`}>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenRecord(record);
                        }}
                        className="text-xs font-medium text-primary hover:underline"
                      >
                        Details
                      </button>
                      {resizeRow("row-details")}
                    </td>
                  )}
                  {hasLinks && (
                    <td className={`relative border-b border-border/70 text-right align-middle group-hover:bg-surface-soft ${dense ? "h-8 px-2" : "h-11 px-3"}`}>
                      {record.links_to_dataset && onOpenDataset && (
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onOpenDataset(record.links_to_dataset as string);
                          }}
                          className="whitespace-nowrap text-xs font-medium text-primary hover:underline"
                        >
                          View dataset →
                        </button>
                      )}
                      {resizeRow("row-links")}
                    </td>
                  )}
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {openRecord && canOpen && (
        <StagingRecordDrawer
          documentId={documentId ?? ""}
          dataset={dataset}
          record={openRecord}
          onClose={() => setOpenRecord(null)}
          onOpenSource={onOpenSource}
        />
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-xs text-text-secondary">
          <button
            type="button"
            disabled={clampedPage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            className="rounded-md border border-border px-2.5 py-1 font-medium disabled:opacity-40"
          >
            Previous
          </button>
          <span>
            Page {clampedPage + 1} of {totalPages}
          </span>
          <button
            type="button"
            disabled={clampedPage >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            className="rounded-md border border-border px-2.5 py-1 font-medium disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
