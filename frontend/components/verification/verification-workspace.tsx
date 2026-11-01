"use client";

import Link from "next/link";
import { ChevronDown, ChevronLeft, Download, ExternalLink, PanelLeftOpen, Rows3, Rows4, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import ClassificationPanel from "@/components/classification/classification-panel";
import OracleIntegrationPanel from "@/components/oracle-integration-panel";
import OriginalStructureView, { regionOf, rowHighlight, TableView } from "@/components/original-structure/original-structure-view";
import DocumentAuditTrail from "@/components/review/document-audit-trail";
import { MAPPING_LABEL, MAPPING_TONE, useOracleMappings } from "@/components/smart-view/oracle-status";
import type { SourceViewRequest } from "@/components/source-verification-panel";
import BusinessDataView from "@/components/verification/business-data-view";
import DocumentCheckSummary from "@/components/verification/document-check-summary";
import type { Density } from "@/components/verification/field-card";
import RecordDetails from "@/components/verification/record-details";
import ReviewSelectedBar from "@/components/verification/review-selected-bar";
import SummaryView from "@/components/verification/summary-view";
import ValidationView from "@/components/verification/validation-view";
import DocumentViewer from "@/components/viewers/document-viewer";
import { getOriginalStructure, layoutRecords, reviewStructureRecords, type OriginalStructure } from "@/lib/original-structure";
import { RecordSelectionProvider, layoutId, useRecordSelection, type EvidenceAnchor } from "@/lib/record-selection";
import type { SelectedExportFormat, StagingWorkbook } from "@/lib/staging-workbook";
import { isSelected, setCells, storeKey, type SelectionStore } from "@/lib/table-selection";
import { downloadSelectedRecords, getBusinessData, getValidationSummary, type BusinessData, type ValidationSummary } from "@/lib/verification";

export type VerificationTab = "original" | "business" | "advanced" | "tables" | "validation" | "oracle" | "history" | "summary";
export type WorkspaceView = VerificationTab | "smart";

/** The tab order; Summary stays last. */
export const VERIFICATION_TABS: [VerificationTab, string][] = [
  ["original", "Original File"],
  ["business", "Smart Review"],
  ["advanced", "Advanced Grid"],
  ["tables", "Tables"],
  ["validation", "Validation"],
  ["oracle", "Oracle / Mapping"],
  ["history", "History"],
  ["summary", "Summary"],
];

const SOURCE_WIDTH_KEY = "dx-verification-source-width";
const DETAILS_WIDTH_KEY = "dx-verification-details-width";
const SOURCE_OPEN_KEY = "dx-verification-source-open";
const DENSITY_KEY = "dx-verification-density";

function readStored(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // a per-browser convenience only
  }
}

function storedNumber(key: string, fallback: number, min: number, max: number): number {
  const value = Number(readStored(key));
  return value >= min && value <= max ? value : fallback;
}

/** Which tabs this document uses: tables only when it has some, Oracle /
 * Mapping not for identity or academic documents. Data never hides. */
export function visibleTabs(structure: OriginalStructure | null, business: BusinessData | null): VerificationTab[] {
  const hasTables = (structure?.stats.tables ?? 0) > 0 || (business?.other.tables.length ?? 0) > 0;
  const noOracle = business?.document_class === "identity" || business?.document_class === "academic";
  return VERIFICATION_TABS.map(([id]) => id).filter((id) => (id === "tables" ? hasTables : id === "oracle" ? !noOracle : true));
}

const PENDING = new Set(["Not reviewed", "Pending review", "Needs review", "Added"]);

/** What needs a person, counted separately (never one "need attention"). */
export function reviewCounts(structure: OriginalStructure | null, business: BusinessData | null, validation: ValidationSummary | null) {
  const group = (...kinds: string[]) =>
    (validation?.groups ?? []).filter((g) => kinds.includes(g.kind)).reduce((sum, g) => sum + g.issues.length, 0);
  let pending = 0;
  if (structure) {
    for (const record of layoutRecords(structure).values()) {
      if (record.field && !record.field.blank && PENDING.has(record.field.review_status)) pending += 1;
      if (record.row && PENDING.has(record.row.review_status ?? "Not reviewed")) pending += 1;
    }
  }
  return {
    missing: (business?.stats.missing_required ?? 0) + group("missing_value"),
    failures: group("invalid_date", "invalid_identifier", "invalid_number", "incorrect_total", "cross_field", "invalid_cell"),
    conflicts: group("conflicting_values", "duplicate_candidates", "incorrect_association"),
    pending,
  };
}

/** The layout record printed at a point of a page: the smallest recorded
 * box containing it. Only real coordinates count; none are made up. */
export function recordAtPoint(structure: OriginalStructure | null, page: number, x: number, y: number): string | null {
  if (!structure) return null;
  let best: { key: string; area: number } | null = null;
  for (const [key, record] of layoutRecords(structure)) {
    const field = record.field;
    if (!field || field.page !== page) continue;
    for (const box of [field.value_bbox, field.bbox]) {
      if (!box || box.length !== 4) continue;
      const [x0, y0, x1, y1] = box;
      if (x >= x0 - 2 && x <= x1 + 2 && y >= y0 - 2 && y <= y1 + 2) {
        const area = (x1 - x0) * (y1 - y0);
        if (!best || area < best.area) best = { key, area };
      }
    }
  }
  return best?.key ?? null;
}

/** The verification workspace of one document: tabs over one set of
 * records (the original layout joined to extraction and review), the
 * source document beside them, record details on demand, and one
 * selection shared by every tab — the Advanced Grid included. */
export default function VerificationWorkspace({
  documentId,
  documentName,
  pageCount,
  stagingProfileId,
  view,
  onViewChange,
  onClassificationChanged,
  workbook = null,
  gridSelection = null,
  children,
}: {
  documentId: string;
  documentName: string;
  pageCount: number;
  stagingProfileId: string | null;
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  onClassificationChanged?: () => void;
  /** The staging workbook and its grid selection, so the Advanced Grid
   * shares the selection (by evidence) with every other tab. */
  workbook?: StagingWorkbook | null;
  gridSelection?: SelectionStore | null;
  /** Advanced Grid (and legacy Smart View) content. */
  children?: ReactNode;
}) {
  const [structure, setStructure] = useState<OriginalStructure | null>(null);
  const [business, setBusiness] = useState<BusinessData | null>(null);
  const [validation, setValidation] = useState<ValidationSummary | null>(null);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    getOriginalStructure(documentId)
      .then((data) => active && setStructure(data))
      .catch((err: unknown) => active && setError(err instanceof Error ? err.message : "The document layout couldn't be loaded."));
    getBusinessData(documentId).then((data) => active && setBusiness(data)).catch(() => undefined);
    getValidationSummary(documentId).then((data) => active && setValidation(data)).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [documentId, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  // Layout records the Staging Workbook and Advanced Grid link to by evidence.
  const anchors = useMemo<EvidenceAnchor[]>(() => {
    if (!structure) return [];
    return [...layoutRecords(structure).entries()]
      .filter(([, record]) => record.field)
      .map(([key, record]) => ({ id: layoutId(key), page: record.field!.page, value: record.field!.effective_value || record.field!.document_value }));
  }, [structure]);

  return (
    <RecordSelectionProvider scalars={[]} tables={[]} anchors={anchors}>
      {workbook && gridSelection && <GridSelectionBridge documentId={documentId} workbook={workbook} grid={gridSelection} anchors={anchors} />}
      <Workspace
        documentId={documentId}
        documentName={documentName}
        pageCount={pageCount}
        stagingProfileId={stagingProfileId}
        view={view}
        onViewChange={onViewChange}
        structure={structure}
        business={business}
        validation={validation}
        error={error}
        reload={reload}
        onClassificationChanged={() => {
          reload();
          onClassificationChanged?.();
        }}
      >
        {children}
      </Workspace>
    </RecordSelectionProvider>
  );
}

const GRID = "grid:";

function normValue(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Keeps the Advanced Grid's cell selection and the shared record selection
 * in step. A grid cell and a layout record are the same record only when
 * their page and value match uniquely on both sides; anything less certain
 * stays unlinked. Selecting never approves.
 */
function GridSelectionBridge({ documentId, workbook, grid, anchors }: {
  documentId: string;
  workbook: StagingWorkbook;
  grid: SelectionStore;
  anchors: EvidenceAnchor[];
}) {
  const shared = useRecordSelection()!;
  const setLinks = shared.setLinks;

  // grid id → [dataset, record, field, dataset name]
  const cells = useMemo(() => {
    const out = new Map<string, [string, string, string, string]>();
    const byKey = new Map<string, string[]>();
    for (const dataset of workbook.datasets) {
      for (const record of dataset.records) {
        for (const [field, cell] of Object.entries(record.cells)) {
          const page = cell.provenance?.source_page;
          const value = normValue(cell.value);
          if (page == null || value.length < 2) continue;
          const id = `${GRID}${dataset.dataset_id}\u0001${record.record_id}\u0001${field}`;
          out.set(id, [dataset.dataset_id, record.record_id, field, dataset.display_name]);
          const k = `${page}|${value}`;
          byKey.set(k, [...(byKey.get(k) ?? []), id]);
        }
      }
    }
    const left = new Map<string, string[]>();
    for (const anchor of anchors) {
      const value = normValue(anchor.value);
      if (anchor.page == null || value.length < 2) continue;
      const k = `${anchor.page}|${value}`;
      left.set(k, [...(left.get(k) ?? []), anchor.id]);
    }
    const pairs: [string, string][] = [];
    for (const [k, ids] of left) {
      const matches = byKey.get(k);
      if (ids.length === 1 && matches?.length === 1) pairs.push([ids[0], matches[0]]);
    }
    return { pairs, cells: out };
  }, [workbook, anchors]);

  // Links can arrive after a record was selected (data still loading, a
  // reload): its linked half joins the selection then.
  const selectedNow = useRef(shared.selected);
  useEffect(() => {
    selectedNow.current = shared.selected;
  }, [shared.selected]);
  const toggleLinked = shared.toggle;
  useEffect(() => {
    setLinks("grid", cells.pairs);
    const half = cells.pairs.flatMap(([a, b]) => {
      const sel = selectedNow.current;
      return sel.has(a) && !sel.has(b) ? [b] : sel.has(b) && !sel.has(a) ? [a] : [];
    });
    if (half.length) toggleLinked(half, true);
  }, [cells.pairs, setLinks, toggleLinked]);

  // Shared → grid: linked cells follow the shared selection.
  const previousShared = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const before = previousShared.current;
    const now = shared.selected;
    previousShared.current = now;
    const changed: [string, boolean][] = [];
    for (const id of now) if (id.startsWith(GRID) && !before.has(id)) changed.push([id, true]);
    for (const id of before) if (id.startsWith(GRID) && !now.has(id)) changed.push([id, false]);
    for (const [id, on] of changed) {
      const cell = cells.cells.get(id);
      if (!cell) continue;
      const [datasetId, recordId, field, datasetName] = cell;
      grid.set(storeKey(documentId, datasetId), (current) => (isSelected(current, recordId, field) === on ? current : setCells(current, [recordId], [field], on)),
        { documentId, datasetId, datasetName });
    }
  }, [shared.selected, cells, grid, documentId]);

  // Grid → shared: a linked cell picked in the grid selects its record.
  const previousGrid = useRef<ReadonlySet<string>>(new Set());
  const gridGet = grid.get;
  const toggle = shared.toggle;
  useEffect(() => {
    const now = new Set<string>();
    for (const [, gridId] of cells.pairs) {
      const cell = cells.cells.get(gridId);
      if (cell && isSelected(gridGet(storeKey(documentId, cell[0])), cell[1], cell[2])) now.add(gridId);
    }
    const before = previousGrid.current;
    previousGrid.current = now;
    const on = [...now].filter((id) => !before.has(id));
    const off = [...before].filter((id) => !now.has(id));
    if (on.length) toggle(on, true);
    if (off.length) toggle(off, false);
  }, [gridGet, cells, documentId, toggle]);

  return null;
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** A drag handle between two panels; reports the pointer's movement. */
function ResizeHandle({ label, onDrag, onDone }: { label: string; onDrag: (dx: number) => void; onDone: () => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      tabIndex={0}
      className="hidden w-1.5 shrink-0 cursor-col-resize touch-none rounded bg-border/60 hover:bg-primary/40 focus-visible:bg-primary/50 lg:sticky lg:top-2 lg:block lg:h-[calc(100vh-7rem)]"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onDrag(-24);
        if (event.key === "ArrowRight") onDrag(24);
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") onDone();
      }}
      onPointerDown={(event) => {
        event.preventDefault();
        let last = event.clientX;
        const move = (e: PointerEvent) => {
          onDrag(e.clientX - last);
          last = e.clientX;
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          onDone();
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    />
  );
}

function Workspace({
  documentId,
  documentName,
  pageCount,
  stagingProfileId,
  view,
  onViewChange,
  structure,
  business,
  validation,
  error,
  reload,
  onClassificationChanged,
  children,
}: {
  documentId: string;
  documentName: string;
  pageCount: number;
  stagingProfileId: string | null;
  view: WorkspaceView;
  onViewChange: (view: WorkspaceView) => void;
  structure: OriginalStructure | null;
  business: BusinessData | null;
  validation: ValidationSummary | null;
  error: string;
  reload: () => void;
  onClassificationChanged: () => void;
  children?: ReactNode;
}) {
  const selection = useRecordSelection()!;
  const mappings = useOracleMappings(documentId, stagingProfileId);
  const [source, setSource] = useState<SourceViewRequest | null>(null);
  const [sourceOpen, setSourceOpen] = useState(() => readStored(SOURCE_OPEN_KEY) !== "closed");
  const [sourceWidth, setSourceWidth] = useState(() => storedNumber(SOURCE_WIDTH_KEY, 480, 280, 1100));
  const [detailsWidth, setDetailsWidth] = useState(() => storedNumber(DETAILS_WIDTH_KEY, 380, 300, 720));
  const [density, setDensity] = useState<Density>(() => (readStored(DENSITY_KEY) === "compact" ? "compact" : "comfortable"));
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const filter = useDebounced(query, 250);
  const [reviewing, setReviewing] = useState<string[] | null>(null);
  const [exportFormat, setExportFormat] = useState<SelectedExportFormat>("xlsx");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmApprove, setConfirmApprove] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const tabs = visibleTabs(structure, business);
  const active: WorkspaceView = view === "smart" || tabs.includes(view) ? view : "original";
  // Panels stay mounted once opened: switching back costs no request and
  // keeps their state (scroll, expanded sections, review in progress).
  const [visited, setVisited] = useState<ReadonlySet<WorkspaceView>>(() => new Set([active]));
  if (!visited.has(active)) setVisited(new Set([...visited, active]));
  const external = active === "advanced" || active === "smart";
  const records = useMemo(() => (structure ? layoutRecords(structure) : new Map()), [structure]);
  const selectedKeys = useMemo(
    () => [...records.keys()].filter((key) => selection.selected.has(layoutId(key))),
    [records, selection.selected],
  );
  const counts = reviewCounts(structure, business, validation);

  const viewRecordSource = useCallback((key: string) => {
    const record = records.get(key);
    if (!record) return;
    if (record.field) {
      const field = record.field;
      if (!field.page) return;
      const box = field.value_bbox ?? field.bbox;
      // The exact region only from recorded coordinates; else the page is
      // searched for the value's text.
      setSource({ id: key, pageNumber: field.page, highlightText: field.document_value || field.extracted_value || null, label: field.label,
        value: field.effective_value || field.extracted_value, region: box && box.length === 4 ? [box[0], box[1], box[2], box[3]] : null });
    } else if (record.row?.page) {
      setSource({ id: key, pageNumber: record.row.page, highlightText: rowHighlight(record.row), label: record.table?.title ?? "Table row",
        value: record.row.cells.join(" "), region: regionOf(record.row.bbox) });
    }
    setSourceOpen(true);
  }, [records]);

  const focusRecord = useCallback((key: string) => {
    setFocusKey(key);
    viewRecordSource(key);
  }, [viewRecordSource]);

  const viewSource = useCallback((request: SourceViewRequest) => {
    setSource(request);
    setSourceOpen(true);
  }, []);

  function onPageClick(page: number, x: number, y: number) {
    const key = recordAtPoint(structure, page, x, y);
    if (!key) {
      setNotice("No extracted field is recorded at that spot.");
      return;
    }
    setNotice("");
    setFocusKey(key);
    if (active !== "original" && active !== "business") onViewChange("original");
    window.requestAnimationFrame(() => document.querySelector(`[data-record-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "center" }));
  }

  async function exportSelected() {
    setBusy(true);
    setNotice("");
    try {
      await downloadSelectedRecords(documentId, selectedKeys, exportFormat, documentName);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "The export failed.");
    } finally {
      setBusy(false);
    }
  }

  /** Approves each selected record on its own: permissions and validation
   * still apply per record, and what wasn't approved is reported. */
  async function approveSelected() {
    setConfirmApprove(false);
    setBusy(true);
    setNotice("");
    try {
      const result = await reviewStructureRecords(documentId, selectedKeys, "accept");
      const skipped = result.results.filter((r) => !r.ok);
      setNotice(
        skipped.length
          ? `${result.reviewed} approved; ${skipped.length} not approved (${skipped[0].error ?? "validation"}${skipped.length > 1 ? ", …" : ""}).`
          : `${result.reviewed} approved.`,
      );
      reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Approval failed.");
    } finally {
      setBusy(false);
    }
  }

  const label = (id: VerificationTab) => VERIFICATION_TABS.find(([tab]) => tab === id)![1];
  const panel = (id: WorkspaceView, node: ReactNode) =>
    visited.has(id) ? <div key={id} hidden={active !== id} data-panel={id}>{node}</div> : null;

  return (
    <div className="mt-4" data-testid="verification-workspace">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-border">
        <div className="scrollbar-none -mb-px flex min-w-0 flex-1 gap-1 overflow-x-auto" role="tablist" aria-label="Document workspace">
          {tabs.map((id) => (
            <button key={id} type="button" role="tab" aria-selected={active === id} onClick={() => onViewChange(id)}
              className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${active === id ? "border-primary font-semibold text-primary" : "border-transparent text-text-secondary hover:text-foreground"}`}>
              {label(id)}
              {id === "validation" && validation && validation.counts.errors + validation.counts.warnings > 0 && (
                <span className="ml-1.5 rounded-full bg-danger/10 px-1.5 text-[11px] font-medium text-danger">{validation.counts.errors + validation.counts.warnings}</span>
              )}
            </button>
          ))}
        </div>
        <div className="relative pb-1">
          <button type="button" onClick={() => setMoreOpen((open) => !open)} aria-expanded={moreOpen} aria-haspopup="menu"
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ${active === "smart" ? "font-semibold text-primary" : "text-text-secondary hover:text-foreground"}`}>
            {active === "smart" ? "Smart View" : "More views"}
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          {moreOpen && (
            <div role="menu" className="absolute right-0 z-40 mt-1 w-64 rounded-lg border border-border bg-surface py-1 shadow-sm">
              <button type="button" role="menuitem" onClick={() => { onViewChange("smart"); setMoreOpen(false); }}
                className="block w-full px-3 py-1.5 text-left text-sm hover:bg-surface-soft">
                <span className="font-medium text-foreground">Smart View</span>
                <span className="block text-[11px] text-text-muted">The earlier view organised by document type</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {error && <p className="mt-3 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger" role="alert">{error}</p>}

      {!external && (
        // Upload and extraction quality; reloads with the workspace's data.
        <DocumentCheckSummary documentId={documentId} refreshKey={structure} onClassificationChanged={onClassificationChanged} />
      )}

      {!external && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs" data-testid="review-counts">
          {([
            ["missing", "Missing values", counts.missing, "text-danger"],
            ["failures", "Validation failures", counts.failures, "text-danger"],
            ["conflicts", "Conflicting candidates", counts.conflicts, "text-warning"],
            ["pending", "Pending review", counts.pending, "text-text-secondary"],
          ] as const).map(([id, name, count, tone]) => (
            <button key={id} type="button" data-testid={`count-${id}`}
              onClick={() => onViewChange(id === "pending" ? "original" : "validation")}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 hover:border-primary">
              <span className={`font-semibold tabular-nums ${count ? tone : "text-text-muted"}`}>{structure && validation ? count : "…"}</span>
              <span className="text-text-secondary">{name}</span>
            </button>
          ))}
          <label className="ml-auto flex min-w-[220px] flex-1 items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1 sm:max-w-sm">
            <Search className="h-3.5 w-3.5 text-text-muted" aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search fields"
              placeholder="Search fields, values, rows…" className="min-w-0 flex-1 bg-transparent outline-none" />
          </label>
          <div className="inline-flex rounded-lg border border-border bg-surface p-0.5" role="radiogroup" aria-label="Density">
            {([["comfortable", "Comfortable", Rows3], ["compact", "Compact", Rows4]] as const).map(([id, name, Icon]) => (
              <button key={id} type="button" role="radio" aria-checked={density === id}
                onClick={() => { setDensity(id); store(DENSITY_KEY, id); }}
                className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 ${density === id ? "bg-primary text-white" : "text-text-secondary hover:text-foreground"}`}>
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />{name}
              </button>
            ))}
          </div>
        </div>
      )}

      {notice && <p className="mt-2 text-xs text-text-secondary" role="status">{notice}</p>}

      {selectedKeys.length > 0 && (
        <div className="sticky bottom-2 z-30 mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-surface px-3 py-2 text-xs shadow-sm" data-testid="selection-toolbar">
          <span className="font-semibold text-foreground" data-testid="selected-records">{selectedKeys.length} selected record{selectedKeys.length === 1 ? "" : "s"}</span>
          <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setReviewing(selectedKeys)}>Review selected</button>
          {confirmApprove ? (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-primary-soft px-2 py-0.5">
              Approve {selectedKeys.length} record{selectedKeys.length === 1 ? "" : "s"}? Values that fail validation stay unapproved.
              <button type="button" className="btn-primary px-2 py-0.5 text-xs" disabled={busy} onClick={() => void approveSelected()}>Approve</button>
              <button type="button" className="text-text-secondary hover:text-foreground" onClick={() => setConfirmApprove(false)}>Cancel</button>
            </span>
          ) : (
            <button type="button" className="btn-secondary px-2.5 py-1 text-xs" onClick={() => setConfirmApprove(true)}>Approve selected…</button>
          )}
          <select aria-label="Export format" value={exportFormat} onChange={(event) => setExportFormat(event.target.value as SelectedExportFormat)}
            className="rounded-md border border-border bg-surface px-1.5 py-1">
            <option value="xlsx">Excel</option>
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
          <button type="button" className="btn-secondary inline-flex items-center gap-1 px-2.5 py-1 text-xs" disabled={busy} onClick={() => void exportSelected()}>
            <Download className="h-3.5 w-3.5" aria-hidden="true" />Export selected
          </button>
          <button type="button" className="text-text-secondary hover:text-foreground" onClick={() => { selection.clear(); setReviewing(null); }}>Clear selection</button>
          <span className="text-text-muted">Selecting never approves a record.</span>
        </div>
      )}

      {reviewing && reviewing.length > 0 && (
        <ReviewSelectedBar documentId={documentId} keys={reviewing} records={records} onView={focusRecord}
          onChanged={reload} onClose={() => setReviewing(null)} />
      )}

      {external ? (
        <div data-panel={active}>{children}</div>
      ) : (
        <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:items-start lg:gap-2" data-testid="workspace-panels">
          {/* Left: the source document. */}
          {sourceOpen ? (
            <>
              <section className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface lg:sticky lg:top-2 lg:h-[calc(100vh-7rem)] lg:w-[var(--source-w)] lg:shrink-0"
                style={{ ["--source-w" as string]: `${sourceWidth}px` }} aria-label="Source document" data-testid="workspace-source">
                <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-xs">
                  <span className="font-semibold text-foreground">Source</span>
                  <span className="min-w-0 flex-1 truncate text-text-muted">
                    {source ? `Page ${source.pageNumber} · ${source.label ?? ""}${source.region ? " · exact region" : source.highlightText ? " · searched by text" : ""}` : "Select a field to see where it comes from; click the page to find a field"}
                  </span>
                  <button type="button" aria-label="Hide the source document" onClick={() => { setSourceOpen(false); store(SOURCE_OPEN_KEY, "closed"); }}
                    className="rounded p-0.5 text-text-muted hover:bg-surface-soft"><ChevronLeft className="h-4 w-4" aria-hidden="true" /></button>
                </div>
                <div className="h-[60vh] min-h-0 flex-1 lg:h-auto">
                  <DocumentViewer documentId={documentId} documentName={documentName} pageCount={pageCount} request={source} onPageClick={onPageClick} />
                </div>
              </section>
              <ResizeHandle label="Resize the source document"
                onDrag={(dx) => setSourceWidth((w) => Math.max(280, Math.min(1100, w + dx)))}
                onDone={() => store(SOURCE_WIDTH_KEY, String(sourceWidth))} />
            </>
          ) : (
            <button type="button" onClick={() => { setSourceOpen(true); store(SOURCE_OPEN_KEY, "open"); }}
              className="inline-flex items-center gap-1 self-start rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-text-secondary hover:text-foreground lg:sticky lg:top-2 lg:flex-col lg:py-3"
              aria-label="Show the source document">
              <PanelLeftOpen className="h-4 w-4" aria-hidden="true" /><span className="lg:[writing-mode:vertical-rl]">Source</span>
            </button>
          )}

          {/* Center: the extracted information. */}
          <div className="min-w-0 flex-1">
            {panel("original",
              <OriginalStructureView documentId={documentId} documentName={documentName} pageCount={pageCount}
                stagingProfileId={stagingProfileId} structure={structure} onViewSource={viewSource} onChanged={reload} reviewEnabled
                onFocusRecord={focusRecord} focusedKey={focusKey} filter={filter} density={density} />)}
            {panel("business",
              <BusinessDataView documentId={documentId} business={business} onViewRecord={focusRecord} onViewSource={viewSource}
                onChanged={reload} density={density} filter={filter} focusedKey={focusKey} />)}
            {panel("tables", structure && <TablesTab structure={structure} business={business} onViewRecord={focusRecord} focusedKey={focusKey} density={density} filter={filter} />)}
            {panel("validation", <ValidationView documentId={documentId} validation={validation} onViewRecord={focusRecord} onViewSource={viewSource} />)}
            {panel("oracle", <OracleTab documentId={documentId} documentName={documentName} mappings={mappings} />)}
            {panel("history", <HistoryTab documentId={documentId} />)}
            {panel("summary",
              <SummaryView documentId={documentId} business={business} structure={structure} validation={validation}
                onClassificationChanged={onClassificationChanged} onViewSource={viewSource} />)}
          </div>

          {/* Right: the focused record's details, on demand. */}
          {focusKey && (
            <>
              <ResizeHandle label="Resize the record details"
                onDrag={(dx) => setDetailsWidth((w) => Math.max(300, Math.min(720, w - dx)))}
                onDone={() => store(DETAILS_WIDTH_KEY, String(detailsWidth))} />
              <aside className="lg:sticky lg:top-2 lg:max-h-[calc(100vh-7rem)] lg:w-[var(--details-w)] lg:shrink-0 lg:overflow-y-auto"
                style={{ ["--details-w" as string]: `${detailsWidth}px` }}>
                <RecordDetails documentId={documentId} recordKey={focusKey} record={records.get(focusKey)} business={business} mappings={mappings}
                  onClose={() => setFocusKey(null)} onViewSource={viewRecordSource} onChanged={reload} />
              </aside>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TablesTab({ structure, business, onViewRecord, focusedKey, density, filter }: {
  structure: OriginalStructure;
  business: BusinessData | null;
  onViewRecord: (key: string) => void;
  focusedKey: string | null;
  density: Density;
  filter: string;
}) {
  // Each table under its business category when a skill names it.
  const categoryOf = new Map<string, string>();
  for (const section of business?.sections ?? []) for (const table of section.tables) categoryOf.set(table.record_key, section.label);
  const needle = filter.trim().toLowerCase();
  const tables = structure.sections.flatMap((section) =>
    section.items.flatMap((item) => {
      if (item.kind !== "table") return [];
      if (!needle) return [{ table: item, section: section.title }];
      const rows = item.rows.filter((row) => row.cells.some((cell) => cell.toLowerCase().includes(needle)));
      return rows.length ? [{ table: { ...item, rows, row_count: rows.length }, section: section.title }] : [];
    }),
  );
  return (
    <div className="mt-1 space-y-4" data-testid="tables-tab">
      <p className="text-xs text-text-secondary">
        {tables.length} table{tables.length === 1 ? "" : "s"} in printed order, each row as printed. Click a row for its source and details, where it can be approved, corrected, or a missing row added.
      </p>
      {tables.map(({ table, section }) => (
        <div key={table.record_key} className="space-y-1">
          <p className="text-xs text-text-muted">
            {categoryOf.get(table.record_key) ? <span className="font-medium text-foreground">{categoryOf.get(table.record_key)} · </span> : null}
            {section ?? "Document"}
          </p>
          <TableView table={table} reviewEnabled density={density} selectedId={focusedKey} onSelect={(row) => onViewRecord(row.record_key)} />
        </div>
      ))}
    </div>
  );
}

function OracleTab({ documentId, documentName, mappings }: { documentId: string; documentName: string; mappings: ReturnType<typeof useOracleMappings> }) {
  const [preview, setPreview] = useState(false);
  return (
    <div className="mt-1 space-y-4" data-testid="oracle-tab">
      <section className="rounded-xl border border-border bg-surface p-4 text-sm">
        <h3 className="font-semibold text-foreground">Oracle import mappings</h3>
        <p className="mt-1 text-xs text-text-secondary">
          Mappings use your configured Oracle Fusion import templates only; no column names are invented here.
        </p>
        {mappings === null ? (
          <p className="mt-2 text-xs text-text-muted">Checking saved mappings…</p>
        ) : mappings.length === 0 ? (
          <p className="mt-2 text-xs text-text-muted">No Oracle mapping configured for this document type.</p>
        ) : (
          <ul className="mt-2 space-y-1.5 text-xs">
            {mappings.map((m) => (
              <li key={m.profile.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-foreground">{m.template.object_name} v{m.template.version}</span>
                <span className="text-text-muted">{m.category} · {m.mapped} of {m.columns} columns mapped{m.errors ? ` · ${m.errors} errors` : ""}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${MAPPING_TONE[m.state]}`}>{MAPPING_LABEL[m.state]}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Link href={`/mapping/designer?document=${documentId}`} className="btn-secondary inline-flex items-center gap-1 px-2.5 py-1 text-xs">
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />Map to Oracle Fusion
          </Link>
          <button type="button" className="btn-secondary px-2.5 py-1 text-xs" aria-pressed={preview} onClick={() => setPreview((v) => !v)}>
            {preview ? "Hide Oracle preview" : "Preview / send to Oracle"}
          </button>
        </div>
      </section>
      {preview && <OracleIntegrationPanel documentId={documentId} documentFilename={documentName} />}
    </div>
  );
}

function HistoryTab({ documentId }: { documentId: string }) {
  return (
    <div className="mt-1 space-y-4" data-testid="history-tab">
      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="mb-2 text-sm font-semibold text-foreground">Review history</h3>
        <DocumentAuditTrail documentId={documentId} />
      </section>
      <section className="rounded-xl border border-border bg-surface p-4">
        <h3 className="mb-2 text-sm font-semibold text-foreground">Classification history</h3>
        <ClassificationPanel documentId={documentId} />
      </section>
    </div>
  );
}

