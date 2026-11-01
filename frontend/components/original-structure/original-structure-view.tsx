"use client";

import Link from "next/link";
import { Check, ChevronDown, ChevronRight, Crosshair, Download, Pencil, Plus, Table2, X } from "lucide-react";
import { Fragment, useEffect, useMemo, useState } from "react";

import type { SourceViewRequest } from "@/components/source-verification-panel";
import { MAPPING_LABEL, MAPPING_TONE, useOracleMappings } from "@/components/smart-view/oracle-status";
import DocumentViewer from "@/components/viewers/document-viewer";
import { checkState, layoutId, useRecordSelection } from "@/lib/record-selection";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import {
  getOriginalStructure,
  reviewStructureRecords,
  type StructureAction,
  type LayoutField,
  type LayoutMetadata,
  type LayoutSection,
  type LayoutTable,
  type LayoutTableRow,
  type OriginalStructure,
} from "@/lib/original-structure";
import { downloadExport } from "@/lib/staging-workbook";

/** More fields than this: sections start collapsed except the first. */
const COLLAPSE_ABOVE_FIELDS = 400;

/** The source region to highlight, when the layout recorded one. */
export function regionOf(box: number[] | null | undefined): [number, number, number, number] | null {
  return box && box.length === 4 ? [box[0], box[1], box[2], box[3]] : null;
}

/** Text to search for a row: none when its printed region is recorded (the
 * row itself is boxed); else its first filled cell. */
export function rowHighlight(row: { bbox?: number[] | null; cells: string[] }): string | null {
  return regionOf(row.bbox) ? null : row.cells.find((c) => c.trim()) ?? null;
}

/** A tri-state checkbox (the mixed state can't be set in markup). */
export function TriCheckbox({ ids, label, className = "" }: { ids: string[]; label: string; className?: string }) {
  const shared = useRecordSelection();
  if (!shared) return null;
  const state = checkState(ids, shared.selected);
  return (
    <input
      type="checkbox"
      aria-label={label}
      className={`h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--primary)] ${className}`}
      checked={state === "checked"}
      ref={(element) => {
        if (element) element.indeterminate = state === "indeterminate";
      }}
      onClick={(event) => event.stopPropagation()}
      onChange={() => shared.toggle(ids, state !== "checked")}
      disabled={ids.length === 0}
    />
  );
}

/** Every record key of a list of layout items (fields and table rows). */
export function itemRecordIds(items: (LayoutField | LayoutTable)[]): string[] {
  return items.flatMap((item) => (item.kind === "field" ? [layoutId(item.record_key)] : item.rows.map((row) => layoutId(row.record_key))));
}

/** Fields grid: the Original File export's columns first (Item # | Field
 * Name | Extracted Value), then review detail; Type, Found By and Source
 * Page are always the last three. */
export const FIELD_COLUMNS = [
  "Item #",
  "Field Name",
  "Extracted Value",
  "Evidence",
  "Review Status",
  "Type",
  "Found By",
  "Source Page",
] as const;

export type Selection =
  | { kind: "field"; field: LayoutField; section: string | null }
  | { kind: "row"; table: LayoutTable; row: LayoutTableRow; section: string | null };

const STATUS_TONE: Record<string, string> = {
  "Needs review": "bg-danger/10 text-danger",
  Approved: "bg-success/10 text-success",
  Corrected: "bg-primary-soft text-primary",
  Rejected: "bg-danger/10 text-danger",
  "Pending review": "bg-warning/10 text-warning",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[status] ?? "bg-surface-soft text-text-secondary"}`}>
      {status}
    </span>
  );
}

/** A section's printed heading; the few fields printed before any heading
 * (and with no document title above them) say so rather than invent one. */
export function sectionTitle(section: Pick<LayoutSection, "title">): string {
  return section.title ?? "Before the first heading";
}

/** A table's own caption, or "Table" when it would only repeat its
 * section's heading (as the Excel export writes it). */
export function tableTitle(table: Pick<LayoutTable, "title">, section?: string | null): string {
  return table.title && table.title !== section ? table.title : "Table";
}

function sectionPath(section: string | null, group: string | null): string {
  return [section, group].filter(Boolean).join(" › ") || "—";
}

export interface FieldLine {
  /** The item's own row (number and name) to print before this field: an
   * item with sub-fields, at its first field. */
  caption: { id: string; number: string; name: string } | null;
  /** The Item # cell: only on an item's first row when it has no caption. */
  number: string;
  /** The field's own name, without the form's instructions. */
  name: string;
  /** Set in under its item. */
  indent: boolean;
}

/** How a field reads in Item # | Field Name | Extracted Value, as the
 * backend layout decided its item (never re-derived here) and exactly as
 * the Excel export writes it. `previous` is the item of the row above. */
export function fieldLine(field: Pick<LayoutField, "item" | "field_name" | "label">, previous: string | null): FieldLine {
  const item = field.item;
  const name = field.field_name ?? field.label;
  if (!item) return { caption: null, number: "", name, indent: false };
  const first = item.id !== previous;
  if (item.has_subfields && item.name) {
    return { caption: first ? { id: item.id, number: item.number, name: item.name } : null, number: "", name, indent: true };
  }
  return { caption: null, number: first ? item.number : "", name, indent: !first };
}

/** Where a form box's item number comes from, for its tooltip. */
export function numberNote(field: Pick<LayoutField, "form_item" | "label" | "label_info">, name: string): string | undefined {
  const notes = [field.label !== name ? `Printed: ${field.label}` : ""];
  // The label written out for this document type, and the field it means.
  const info = field.label_info;
  if (info?.display && info.display !== name) notes.push(`Reads as: ${info.display}`);
  if (info?.meaning && info.meaning !== name && info.meaning !== info.display) notes.push(`Means: ${info.meaning}`);
  const form = field.form_item;
  if (form?.described_as) notes.push(`Item ${form.number} as printed on the form; the box's own description says ${form.described_as}`);
  else if (form?.number_source === "form_field") notes.push(`Item ${form.number} from the box's own description (no printed caption found in its cell)`);
  else if (form?.number_source === "none") notes.push("No printed item number");
  const text = notes.filter(Boolean).join(" · ");
  return text || undefined;
}

/** The value shown: a form choice box reads Selected or Not Selected. */
export function shownValue(field: Pick<LayoutField, "choice" | "extracted_value" | "structure_review">): string {
  return field.choice && !field.structure_review ? field.choice : field.extracted_value;
}

export const QUALITY_TONE: Record<string, string> = {
  unreadable: "bg-danger/10 text-danger",
  conflicting: "bg-danger/10 text-danger",
  missing_extraction: "bg-warning/10 text-warning",
  unverified_ocr: "bg-warning/10 text-warning",
  extracted: "bg-surface-soft text-text-secondary",
  blank: "bg-surface-soft text-text-muted",
};

/** Where a record can be shown on the source; said apart from its quality. */
export const SOURCE_LOCATION_LABEL: Record<string, string> = {
  exact: "Exact region on the page",
  page: "Source page only (no exact position recorded)",
  none: "No source position recorded",
};

/** A value's data quality, apart from its review status. A confirmed
 * source value needs no chip. */
export function QualityChip({ quality, label, confidence }: { quality?: string; label?: string; confidence?: number | null }) {
  if (!quality || quality === "confirmed") return <span className="text-text-muted">—</span>;
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${QUALITY_TONE[quality] ?? "bg-surface-soft text-text-secondary"}`}
      title={confidence != null ? `OCR confidence ${Math.round(confidence * 100)}%` : undefined} data-testid="quality-chip">
      {label ?? quality}
    </span>
  );
}

/** Short names for how a field was found; anything else is shown as sent. */
const FOUND_BY_LABEL: Record<string, string> = {
  "ruled form row": "Form line",
  "form fill in": "Fill-in blank",
  "same line separator": "Label: value",
  "left right separator": "Label: value",
  "left right typography": "Bold label",
  "left right whitespace": "Label  value",
  "same line filler": "Leader line",
  "table key value grid": "Key/value grid",
  "label above value": "Label above",
  "form widget": "Form field",
  "label value": "Label/value",
};

/** The document's fields and tables in the order and shape they're printed,
 * each with what extraction read and where review stands. */
export default function OriginalStructureView({
  documentId,
  documentName,
  pageCount,
  stagingProfileId,
  onViewSource,
  structure,
  onChanged,
  reviewEnabled = false,
  onFocusRecord,
  focusedKey = null,
  filter = "",
  density = "comfortable",
}: {
  documentId: string;
  documentName: string;
  pageCount: number;
  stagingProfileId: string | null;
  /** The page's own source panel; without it the view shows the source itself. */
  onViewSource?: (request: SourceViewRequest) => void;
  /** The layout, when the page already loaded it (else it's fetched here). */
  structure?: OriginalStructure | null;
  /** Called after a review decision, so the page reloads its data. */
  onChanged?: () => void;
  /** Approve / Reject / Correct / Add row in the record details. */
  reviewEnabled?: boolean;
  /** The page's own details drawer and source: a click hands the record
   * over by key instead of opening this view's panel. */
  onFocusRecord?: (recordKey: string) => void;
  focusedKey?: string | null;
  /** Shows only fields and rows containing this text. */
  filter?: string;
  density?: "comfortable" | "compact";
}) {
  const [fetched, setData] = useState<OriginalStructure | null>(null);
  const data = structure !== undefined ? structure : fetched;
  const [error, setError] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [collapsedFor, setCollapsedFor] = useState<OriginalStructure | null>(null);
  const [picked, setSelected] = useState<Selection | null>(null);
  const [source, setSource] = useState<SourceViewRequest | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const mappings = useOracleMappings(documentId, stagingProfileId);

  useEffect(() => {
    if (structure !== undefined) return;
    let active = true;
    getOriginalStructure(documentId)
      .then((result) => active && setData(result))
      .catch((err: unknown) => active && setError(err instanceof Error ? err.message : "The document structure couldn't be loaded."));
    return () => {
      active = false;
    };
  }, [documentId, structure]);

  // After a reload the selected record is shown with its new data.
  const selected = liveSelection(data, picked);

  const allSections = useMemo(() => {
    if (!data) return [];
    const extra: LayoutSection[] = data.unplaced.length
      ? [{ id: "unplaced", title: "Extracted fields without a printed position", page: 0, items: data.unplaced }]
      : [];
    // The text extractor's second readings of a form are records, not rows
    // of the Original File: the form's own boxes are shown (as in the export).
    // A grid read over the form's ruled cells is hidden the same way, and a
    // section left with nothing else isn't listed.
    return [...data.sections, ...extra]
      .map((section) => ({ ...section, items: section.items.filter((item) => !item.form_duplicate) }))
      .filter((section, index) => section.items.length > 0 || [...data.sections, ...extra][index].items.length === 0);
  }, [data]);
  const sections = useMemo(() => filterSections(allSections, filter), [allSections, filter]);

  // A very large layout opens with only its first section expanded.
  if (data && collapsedFor !== data) {
    setCollapsedFor(data);
    if (data.stats.fields > COLLAPSE_ABOVE_FIELDS) setCollapsed(new Set(allSections.slice(1).map((s) => s.id)));
  }

  if (error) return <p className="mt-4 rounded-lg border border-danger/30 bg-danger/5 p-3 text-sm text-danger" role="alert">{error}</p>;
  if (!data) {
    return (
      <div className="mt-4 rounded-xl border border-border bg-surface p-4 text-sm text-text-secondary" role="status" data-testid="original-structure-loading">
        <p className="font-medium text-foreground">Reading the document layout…</p>
        <p className="mt-1 text-xs text-text-muted">
          {pageCount > 50
            ? `A ${pageCount}-page document's layout is built once, right after processing (about a minute for 300 pages); after that it opens at once.`
            : "This takes a few seconds the first time."}
        </p>
      </div>
    );
  }

  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function viewSource(page: number | null, text: string | null, label: string, value: string, region?: [number, number, number, number] | null) {
    if (!page) return;
    // The exact region when the layout recorded it; else the page is
    // searched for the value's text.
    const request = { pageNumber: page, highlightText: text || value || null, label, value, region: region ?? null };
    if (onViewSource) onViewSource(request);
    else setSource(request);
  }

  async function exportExcel() {
    setExporting(true);
    setExportError("");
    try {
      await downloadExport(
        { capability_id: "original_structure", label: "Original File export", format: "xlsx", href: `/api/documents/${documentId}/original-structure/export.xlsx`, dataset_id: null },
        `${documentName.replace(/\.[A-Za-z0-9]{2,5}$/, "")} - original file.xlsx`,
      );
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "The export failed.");
    } finally {
      setExporting(false);
    }
  }

  const { stats } = data;
  return (
    <div className={`mt-4 grid gap-4 ${!onFocusRecord && (selected || source) ? "xl:grid-cols-[minmax(0,1fr)_380px]" : ""}`} data-testid="original-structure" data-density={density}>
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-secondary">
          <p data-testid="original-structure-stats" className="flex flex-wrap items-center gap-2">
            <TriCheckbox ids={sections.flatMap((s) => itemRecordIds(s.items))} label="Select all fields and table rows" />
            {stats.fields} fields ({stats.blank_fields} blank on the page) · {stats.tables} tables · {stats.table_rows} table rows
            {stats.needs_review > 0 && <span className="ml-1 font-medium text-danger">· {stats.needs_review} need review</span>}
            {stats.unplaced > 0 && <> · {stats.unplaced} without a printed position</>}
            {(stats.artifacts_hidden ?? 0) > 0 && (
              <span className="text-text-muted" title="Empty entries with no printed label, made while reading the layout. Nothing is deleted.">
                · {stats.artifacts_hidden} empty layout artifact{stats.artifacts_hidden === 1 ? "" : "s"} hidden
              </span>
            )}
            {(stats.form_duplicates_hidden ?? 0) > 0 && (
              <span className="text-text-muted" data-testid="form-duplicates-hidden"
                title="Rows the text extractor read from a form's boxes or printed wording. The form's own boxes are shown instead; the records are kept.">
                · {stats.form_duplicates_hidden} repeated form reading{stats.form_duplicates_hidden === 1 ? "" : "s"} hidden
              </span>
            )}
            {data.document_title && <span className="text-text-muted">· {data.document_title}</span>}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {!selected && !focusedKey && (
              <span className="text-text-muted" data-testid="original-structure-hint">
                Click a field or table row for its source, values, validation and Oracle mapping.
              </span>
            )}
            <button type="button" className="hover:text-foreground" onClick={() => setCollapsed(new Set())}>Expand all</button>
            <button type="button" className="hover:text-foreground" onClick={() => setCollapsed(new Set(sections.map((s) => s.id)))}>Collapse all</button>
            <button type="button" onClick={exportExcel} disabled={exporting}
              title="Sections, numbered items and tables in document order, every value exactly as printed"
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 font-medium text-foreground hover:bg-surface-soft disabled:opacity-60">
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              {exporting ? "Exporting…" : "Export Excel"}
            </button>
          </div>
        </div>
        {exportError && <p className="text-xs text-danger" role="alert">{exportError}</p>}
        {sections.length === 0 && (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-muted">
            {filter.trim() ? `Nothing in the layout matches “${filter.trim()}”.` : "No labelled fields or tables were found in this document's layout."}
          </p>
        )}
        {sections.map((section) => {
          // A search opens every section with a match.
          const open = filter.trim() ? true : !collapsed.has(section.id);
          const fields = section.items.filter((i): i is LayoutField => i.kind === "field");
          const tables = section.items.filter((i): i is LayoutTable => i.kind === "table");
          return (
            <section key={section.id} className={`rounded-xl border border-border bg-surface ${(section.level ?? 1) > 1 ? "ml-4" : ""}`} aria-label={sectionTitle(section)} data-testid="layout-section">
              <div className="flex w-full items-center gap-2 px-4 py-2.5">
                <TriCheckbox ids={itemRecordIds(section.items)} label={`Select all records in ${sectionTitle(section)}`} />
              <button type="button" onClick={() => toggle(section.id)} aria-expanded={open}
                className="flex min-w-0 flex-1 items-center gap-2 text-left">
                {open ? <ChevronDown className="h-4 w-4 text-text-muted" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 text-text-muted" aria-hidden="true" />}
                {(section.level ?? 1) > 1 && section.parent && <span className="truncate text-xs text-text-muted">{section.parent} ›</span>}
                <span className={`text-sm font-semibold ${section.title ? "text-foreground" : "italic text-text-secondary"}`}>{sectionTitle(section)}</span>
                <span className="text-xs text-text-muted">
                  {section.page > 0 && `p. ${section.page} · `}
                  {fields.length} field{fields.length === 1 ? "" : "s"}{tables.length > 0 && ` · ${tables.length} table${tables.length === 1 ? "" : "s"}`}
                </span>
              </button>
              </div>
              {open && (
                <div className="space-y-3 border-t border-border px-2 pb-3 pt-2">
                  {groupRuns(section.items).map((run, index) =>
                    run.kind === "fields" ? (
                      <FieldGrid key={index} fields={run.fields} section={section.title} density={density}
                        selectedId={focusedKey ?? (selected?.kind === "field" ? selected.field.record_key : null)}
                        onSelect={(field) => {
                          if (onFocusRecord) return onFocusRecord(field.record_key);
                          setSelected({ kind: "field", field, section: section.title });
                          viewSource(field.page, field.document_value || field.extracted_value, field.label, field.document_value ?? field.extracted_value, regionOf(field.value_bbox ?? field.bbox));
                        }} />
                    ) : (
                      <TableView key={run.table.id} table={run.table} reviewEnabled={reviewEnabled} density={density}
                        sectionTitle={section.title} groupShared
                        selectedId={focusedKey ?? (selected?.kind === "row" ? selected.row.record_key : null)}
                        onSelect={(row) => {
                          if (onFocusRecord) return onFocusRecord(row.record_key);
                          setSelected({ kind: "row", table: run.table, row, section: section.title });
                          viewSource(row.page, rowHighlight(row), tableTitle(run.table, section.title), row.cells.join(" "), regionOf(row.bbox));
                        }} />
                    ),
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {!onFocusRecord && (selected || source) && (
      <aside className="space-y-3 xl:sticky xl:top-4 xl:self-start" aria-label="Record details">
        {selected && (
          <RecordPanel selection={selected} documentId={documentId} mappings={mappings}
            reviewEnabled={reviewEnabled}
            onReviewed={(nextSelection) => {
              setSelected(nextSelection);
              onChanged?.();
            }}
            onClose={() => setSelected(null)}
            onViewSource={() => {
              if (selected.kind === "field") viewSource(selected.field.page, selected.field.document_value || selected.field.extracted_value, selected.field.label, selected.field.extracted_value, regionOf(selected.field.value_bbox ?? selected.field.bbox));
              else viewSource(selected.row.page, rowHighlight(selected.row), selected.table.title ?? "Table row", selected.row.cells.join(" "), regionOf(selected.row.bbox));
            }} />
        )}
        {source && (
          <div className="h-[60vh] overflow-hidden rounded-xl border border-border" data-testid="original-structure-source">
            <DocumentViewer documentId={documentId} documentName={documentName} pageCount={pageCount} request={source} />
          </div>
        )}
      </aside>
      )}
    </div>
  );
}

/** Sections with only the fields and rows containing `filter` (label,
 * item, values or evidence); every section when it's empty. */
function filterSections(sections: LayoutSection[], filter: string): LayoutSection[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) return sections;
  const has = (...texts: (string | null | undefined)[]) => texts.some((t) => (t ?? "").toLowerCase().includes(needle));
  return sections
    .map((section) => ({
      ...section,
      items: section.items.flatMap((item): (LayoutField | LayoutTable)[] => {
        if (item.kind === "field") {
          return has(item.label, item.group, item.document_value, item.extracted_value, item.effective_value, item.evidence) ? [item] : [];
        }
        if (has(item.title, ...item.headers)) return [item];
        const rows = item.rows.filter((row) => has(...row.cells, ...(row.reviewed_cells ?? [])));
        return rows.length ? [{ ...item, rows, row_count: rows.length }] : [];
      }),
    }))
    .filter((section) => section.items.length > 0 || has(section.title));
}

function liveSelection(data: OriginalStructure | null, picked: Selection | null): Selection | null {
  if (!data || !picked) return picked;
  for (const section of [...data.sections, { items: data.unplaced, title: null }]) {
    for (const item of section.items) {
      if (picked.kind === "field" && item.kind === "field" && item.record_key === picked.field.record_key) return { ...picked, field: item };
      if (picked.kind === "row" && item.kind === "table") {
        const row = item.rows.find((r) => r.record_key === picked.row.record_key);
        if (row) return { ...picked, table: item, row };
      }
    }
  }
  return picked;
}

type Run = { kind: "fields"; fields: LayoutField[] } | { kind: "table"; table: LayoutTable };

/** Consecutive fields share one grid; each table stands where it's printed. */
function groupRuns(items: (LayoutField | LayoutTable)[]): Run[] {
  const runs: Run[] = [];
  for (const item of items) {
    if (item.kind === "table") runs.push({ kind: "table", table: item });
    else {
      const last = runs[runs.length - 1];
      if (last?.kind === "fields") last.fields.push(item);
      else runs.push({ kind: "fields", fields: [item] });
    }
  }
  return runs;
}

function FieldGrid({ fields, section, selectedId, onSelect, density = "comfortable" }: {
  fields: LayoutField[];
  section: string | null;
  /** The focused record's key. */
  selectedId: string | null;
  onSelect: (field: LayoutField) => void;
  density?: "comfortable" | "compact";
}) {
  const shared = useRecordSelection();
  const pad = density === "compact" ? "py-0.5" : "py-1.5";
  // Thousands of fields (a 288-page contract): only the rows in view render.
  const [windowRef, windowRows] = useWindowedRows(fields.length, density === "compact" ? 24 : 40);
  const shown = fields.slice(windowRows.start, windowRows.end);
  // An item's number and name once: on its own caption row when it has
  // sub-fields, else on its first row.
  const lines = shown.map((field, index) =>
    fieldLine(field, (index > 0 ? shown[index - 1] : fields[windowRows.start - 1])?.item?.id ?? null));
  const ofItem = (id: string) => fields.filter((f) => f.item?.id === id).map((f) => layoutId(f.record_key));
  return (
    <div ref={windowRef} className={`overflow-x-auto ${windowRows.windowed ? "max-h-[70vh] overflow-y-auto" : ""}`}>
      <table className="w-full min-w-[860px] text-xs" data-testid="layout-field-grid">
        <thead>
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-text-secondary">
            {shared && <td className="w-6 px-2 py-1.5"><TriCheckbox ids={fields.map((f) => layoutId(f.record_key))} label="Select these fields" /></td>}
            {FIELD_COLUMNS.map((column) => <th key={column} scope="col" className="px-2 py-1.5 font-semibold">{column}</th>)}
          </tr>
        </thead>
        <tbody>
          {windowRows.before > 0 && <tr aria-hidden="true" style={{ height: windowRows.before }} />}
          {shown.map((field, index) => {
            const line = lines[index];
            const parts = field.parts ?? [];
            const value = field.effective_value || field.extracted_value;
            const shownText = shownValue(field);
            const nameCell = `px-2 py-1.5 font-medium text-foreground ${line.indent ? "pl-6" : ""}`;
            return (
            <Fragment key={field.id}>
            {line.caption && (
              <tr data-testid="item-parent" className="border-b border-border/60 bg-surface-soft/60 align-top">
                {shared && <td className={`w-6 px-2 ${pad}`}><TriCheckbox ids={ofItem(line.caption.id)} label={`Select all of ${line.caption.number} ${line.caption.name}`} /></td>}
                <td className="w-12 px-2 py-1.5 font-semibold text-foreground" data-testid="item-number">{line.caption.number}</td>
                <td className="px-2 py-1.5 font-semibold text-foreground" title={sectionPath(section, field.group)} data-testid="item-category">{line.caption.name}</td>
                <td colSpan={FIELD_COLUMNS.length - 2} />
              </tr>
            )}
            <tr data-testid="layout-field-row" data-window-row data-record-key={field.record_key}
              className={`cursor-pointer border-b border-border/60 align-top hover:bg-surface-soft ${selectedId === field.record_key ? "bg-primary/[0.06]" : ""} ${field.flags.length ? "border-l-2 border-l-danger" : ""}`}
              onClick={() => onSelect(field)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(field);
                }
              }}
              tabIndex={0} aria-selected={selectedId === field.record_key}>
              {shared && <td className={`w-6 px-2 ${pad}`}><TriCheckbox ids={[layoutId(field.record_key)]} label={`Select ${field.label}`} /></td>}
              <td className="w-12 px-2 py-1.5 font-semibold text-foreground" data-testid="item-number">{line.number}</td>
              <td className={nameCell} title={numberNote(field, line.name)} data-testid="field-name">{line.name}</td>
              <td className="px-2 py-1.5">
                {parts.length > 0 ? (
                  // The printed text, kept; its parts carry the values below.
                  <span className="block text-[11px] text-text-muted" data-testid="composite-source">Printed as {value}</span>
                ) : shownText ? (
                  <span className="whitespace-pre-wrap break-words text-foreground">{shownText}</span>
                ) : (
                  <span className="text-text-muted">{field.quality_label ?? (field.blank ? "Blank in source" : "Not extracted")}</span>
                )}
                {field.effective_value !== field.extracted_value && field.effective_value && (
                  <span className="block text-[11px] text-primary">Reviewed: {field.effective_value}</span>
                )}
                {field.placed_by_page && (
                  <span className="block text-[11px] text-text-muted">Placed by page; exact position not recorded</span>
                )}
                {field.repeated_header && (
                  <span className="block text-[11px] text-text-muted">Repeated in the header of page {field.page}</span>
                )}
                {field.other_metadata.length > 0 && (
                  <span className="block text-[11px] text-text-muted" data-testid="candidate-count">
                    {field.other_metadata.length + 1} candidates
                  </span>
                )}
              </td>
              <td className="max-w-[240px] px-2 py-1.5 text-text-secondary"><span className="line-clamp-2 break-words">{field.evidence || "—"}</span></td>
              <td className="px-2 py-1.5">
                <StatusBadge status={field.review_status} />
                {field.flags.map((flag) => <span key={flag.code} className="mt-0.5 block text-[11px] text-danger">{flag.message}</span>)}
              </td>
              <td className="px-2 py-1.5 text-text-secondary">{field.value_type}</td>
              <td className="whitespace-nowrap px-2 py-1.5 text-text-secondary" title={field.found_by || undefined}>
                {field.found_by ? FOUND_BY_LABEL[field.found_by] ?? field.found_by : "—"}
              </td>
              <td className="px-2 py-1.5 text-text-secondary">{field.page ?? "—"}</td>
            </tr>
            {parts.map((part) => (
              // Part of the field above: it opens the same record and source.
              <tr key={part.label} data-testid="composite-part" onClick={() => onSelect(field)}
                className={`cursor-pointer border-b border-border/60 align-top hover:bg-surface-soft ${selectedId === field.record_key ? "bg-primary/[0.06]" : ""}`}>
                {shared && <td className={`w-6 px-2 ${pad}`} />}
                <td />
                <td className="px-2 py-1.5 pl-6 text-text-secondary">{part.label}</td>
                <td className="px-2 py-1.5 text-foreground">{part.value}</td>
                <td colSpan={FIELD_COLUMNS.length - 4} className="px-2 py-1.5 text-[11px] text-text-muted">Split from the printed value</td>
                <td className="px-2 py-1.5 text-text-secondary">{field.page ?? "—"}</td>
              </tr>
            ))}
            </Fragment>
            );
          })}
          {windowRows.after > 0 && <tr aria-hidden="true" style={{ height: windowRows.after }} />}
        </tbody>
      </table>
    </div>
  );
}

/** Columns worth a place on screen: every printed header, and any column
 * with a value in some row. An unlabelled column empty in every row is
 * hidden here only; exports keep the table whole. */
export function shownColumns(table: LayoutTable): number[] {
  const generic = /^Column \d+$/;
  return table.headers
    .map((header, index) => index)
    .filter((index) => {
      const header = (table.headers[index] ?? "").trim();
      if (table.headers_printed && header && !generic.test(header)) return true;
      return table.rows.some((row) => (row.reviewed_cells ?? row.cells)[index]?.trim() || row.cells[index]?.trim());
    });
}

export function TableView({ table, selectedId, onSelect, reviewEnabled = false, density = "comfortable", sectionTitle: section, groupShared = false }: {
  table: LayoutTable;
  /** Its section's heading: a title that only repeats it reads "Table". */
  sectionTitle?: string | null;
  /** Shows a column holding one contract or item for every row once above
   * the table instead of in each row (the Original File tab). */
  groupShared?: boolean;
  /** The focused row's key. */
  selectedId: string | null;
  onSelect: (row: LayoutTableRow) => void;
  /** Adds a Review column (status per row). */
  reviewEnabled?: boolean;
  density?: "comfortable" | "compact";
}) {
  const selection = useRecordSelection();
  // Thousands of invoice lines: only the rows in view render.
  const shared = groupShared ? table.shared_columns ?? [] : [];
  const sharedIndexes = new Set(shared.map((entry) => entry.column));
  const columns = shownColumns(table).filter((index) => !sharedIndexes.has(index));
  const hidden = table.headers.length - columns.length - sharedIndexes.size;
  // A row with nothing in any column is a gap in the ruling, not a record.
  const filled = useMemo(
    () => table.rows.filter((row) => row.added || columns.some((index) => (row.reviewed_cells ?? row.cells)[index]?.trim())),
    [table, columns],
  );
  const emptyRows = table.rows.length - filled.length;
  const [windowRef, windowRows] = useWindowedRows(filled.length, density === "compact" ? 22 : 28);
  const rows = filled.slice(windowRows.start, windowRows.end);
  const pad = density === "compact" ? "py-0.5" : "py-1";
  const loose = !table.headers_printed && table.detection_method === "pdf_column_alignment";
  const flagged = table.rows.filter((row) => row.flags?.length).length;
  return (
    <div className="rounded-lg border border-border" data-testid="layout-table">
      <p className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-soft px-3 py-1.5 text-xs text-text-secondary">
        <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
        <TriCheckbox ids={table.rows.map((row) => layoutId(row.record_key))} label={`Select all rows of ${table.title ?? "this table"}`} />
        {table.item?.number && <span className="font-semibold text-foreground" data-testid="table-item-number">{table.item.number}</span>}
        <span className="font-medium text-foreground">{section === undefined ? table.title ?? "Table" : tableTitle(table, section)}</span>
        {table.form_table?.folded && <span title="Printed in two halves side by side; read left half, then right half">· read left, then right</span>}
        <span>
          {table.row_count} row{table.row_count === 1 ? "" : "s"}
          {/* A web page or text file has no pages to cite. */}
          {table.pages.length > 1 ? ` · pages ${table.pages.join("–")}` : table.pages.length === 1 ? ` · page ${table.pages[0]}` : ""}
          {table.continued && " · continued across pages"}
          {!table.headers_printed && " · no header row printed"}
          {hidden > 0 && ` · ${hidden} empty column${hidden === 1 ? "" : "s"} hidden`}
          {emptyRows > 0 && ` · ${emptyRows} empty row${emptyRows === 1 ? "" : "s"} hidden`}
        </span>
        {flagged > 0 && <span className="text-danger">{flagged} row{flagged === 1 ? "" : "s"} need review</span>}
      </p>
      {((table.context_source === "inherited" && table.context && table.context.length > 0) || shared.length > 0) && (
        // What every row belongs to, once above it: the contract (when the
        // document printed no block of its own here) and any column with one
        // value for every row.
        <p className="flex flex-wrap gap-x-4 gap-y-0.5 border-b border-border px-3 py-1.5 text-[11px] text-text-secondary" data-testid="table-context">
          {table.context_source === "inherited" && (table.context ?? []).map((entry) => (
            <span key={entry.record_key} title={entry.printed_label && entry.printed_label !== entry.label ? entry.label : undefined}>
              <span className="text-text-muted">{entry.printed_label ?? entry.label}:</span> <span className="font-medium text-foreground">{entry.value}</span>
            </span>
          ))}
          {shared.map((entry) => (
            <span key={`column-${entry.column}`} data-testid="shared-column">
              <span className="text-text-muted">{entry.label}:</span> <span className="font-medium text-foreground">{entry.value}</span>
            </span>
          ))}
        </p>
      )}
      {loose && (
        <p className="border-b border-border bg-warning/5 px-3 py-1 text-[11px] text-warning">
          Found by text alignment (no ruling or printed header): a cell may be split across columns or rows. Check it against the source.
        </p>
      )}
      <div ref={windowRef} className="max-h-[520px] overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-surface">
            <tr className="border-b border-border text-left text-text-secondary">
              {selection && <td className="w-6 px-2 py-1.5" />}
              {columns.map((index) => <th key={index} scope="col" className="whitespace-nowrap px-2 py-1.5 font-semibold">{table.headers[index]}</th>)}
              {reviewEnabled && <th scope="col" className="whitespace-nowrap px-2 py-1.5 font-semibold">Review</th>}
            </tr>
          </thead>
          <tbody>
            {windowRows.before > 0 && <tr aria-hidden="true" style={{ height: windowRows.before }} />}
            {rows.map((row, offset) => {
              const rowIndex = windowRows.start + offset;
              const bad = new Set((row.flags ?? []).map((flag) => flag.column));
              const issues = new Map((row.cell_issues ?? []).map((issue) => [issue.column, issue]));
              const cells = row.reviewed_cells ?? row.cells;
              return (
                <tr key={row.id} data-testid="layout-table-row" data-window-row data-record-key={row.record_key} tabIndex={0} aria-selected={selectedId === row.record_key}
                  onClick={() => onSelect(row)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onSelect(row);
                    }
                  }}
                  className={`cursor-pointer border-b border-border/60 hover:bg-surface-soft ${selectedId === row.record_key ? "bg-primary/[0.06]" : ""}`}>
                  {selection && <td className={`w-6 px-2 ${pad}`}><TriCheckbox ids={[layoutId(row.record_key)]} label={`Select row ${rowIndex + 1} of ${table.title ?? "the table"}`} /></td>}
                  {columns.map((index) => {
                    const corrected = row.reviewed_cells && row.reviewed_cells[index] !== row.cells[index] && !row.added;
                    const issue = issues.get(index);
                    return (
                      <td key={index} title={corrected ? `Printed: ${row.cells[index] || "(blank)"}` : issue?.message}
                        data-quality={issue?.quality}
                        className={`whitespace-pre-wrap px-2 ${pad} ${bad.has(index) || issue?.quality === "unreadable" ? "bg-danger/10 text-danger" : issue ? "bg-warning/10 text-foreground" : corrected ? "text-primary" : "text-foreground"}`}>
                        {cells[index] ?? ""}
                      </td>
                    );
                  })}
                  {reviewEnabled && (
                    <td className="px-2 py-1">
                      {row.added && <span className="mr-1 text-[11px] font-medium text-primary">Added</span>}
                      {row.review_status && row.review_status !== "Added" && <StatusBadge status={row.review_status} />}
                    </td>
                  )}
                </tr>
              );
            })}
            {windowRows.after > 0 && <tr aria-hidden="true" style={{ height: windowRows.after }} />}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const REVIEW_WORDS: Record<string, string> = {
  pending: "Pending",
  accepted: "Approved",
  edited: "Corrected",
  rejected: "Rejected",
  unknown: "Marked unknown",
};

/** Every extraction candidate for one printed field, with extraction
 * confidence, validation and human review kept apart. */
function CandidateList({ candidates }: { candidates: LayoutMetadata[] }) {
  return (
    <div className="border-t border-border pt-2" data-testid="layout-candidates">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
        Candidates ({candidates.length})
      </p>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-left text-text-secondary">
            <th scope="col" className="py-0.5 pr-2 font-medium">Field</th>
            <th scope="col" className="py-0.5 pr-2 font-medium">Value</th>
            <th scope="col" className="py-0.5 pr-2 font-medium">Confidence</th>
            <th scope="col" className="py-0.5 pr-2 font-medium">Validation</th>
            <th scope="col" className="py-0.5 font-medium">Review</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((candidate) => {
            const empty = !candidate.original_value.trim() && !candidate.value.trim();
            const corrected = candidate.review_status === "edited" && candidate.value !== candidate.original_value;
            return (
              <tr key={candidate.id} className="border-t border-border/60 align-top" data-testid="layout-candidate">
                <td className="py-0.5 pr-2 text-text-secondary">{candidate.label}</td>
                <td className="py-0.5 pr-2">
                  {empty ? <span className="text-text-muted">(empty)</span> : candidate.original_value || candidate.value}
                  {corrected && <span className="block text-primary">Corrected to {candidate.value}</span>}
                </td>
                <td className={`py-0.5 pr-2 tabular-nums ${candidate.confidence < 0.6 ? "text-danger" : ""}`}>
                  {Math.round(candidate.confidence * 100)}%
                </td>
                <td className={`py-0.5 pr-2 ${candidate.validation_status === "failed" ? "text-danger" : ""}`}>
                  {candidate.validation_status ?? "Not checked"}
                </td>
                <td className="py-0.5">{REVIEW_WORDS[candidate.review_status] ?? candidate.review_status}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground">{children}</dd>
    </div>
  );
}

function RecordPanel({ selection, documentId, mappings, onClose, onViewSource, reviewEnabled = false, onReviewed }: {
  selection: Selection;
  documentId: string;
  mappings: ReturnType<typeof useOracleMappings>;
  onClose: () => void;
  onViewSource: () => void;
  reviewEnabled?: boolean;
  onReviewed?: (selection: Selection) => void;
}) {
  const category = selection.kind === "field" ? "header" : "lines";
  const relevant = (mappings ?? []).filter((m) => m.category === category);
  const none = <span className="text-text-muted">Not recorded</span>;
  return (
    <section className="space-y-3 rounded-xl border border-border bg-surface p-4 text-xs" data-testid="layout-record-details">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-primary">{selection.kind === "field" ? "Field" : "Table row"}</p>
          <h3 className="break-words text-sm font-semibold text-foreground">
            {selection.kind === "field" ? selection.field.label : `${selection.table.title ?? "Table"} · row ${selection.table.rows.indexOf(selection.row) + 1}`}
          </h3>
        </div>
        <button type="button" onClick={onClose} aria-label="Close details" className="rounded-md p-1 text-text-muted hover:bg-surface-soft"><X className="h-4 w-4" aria-hidden="true" /></button>
      </div>

      {selection.kind === "field" ? (
        <dl className="space-y-1.5">
          <Detail label="Original label">{selection.field.label}</Detail>
          <Detail label="Section">{sectionPath(selection.section, selection.field.group)}</Detail>
          <Detail label="Data quality"><QualityChip quality={selection.field.quality} label={selection.field.quality_label} confidence={selection.field.ocr_confidence} /></Detail>
          <Detail label="Original source text">{selection.field.evidence || <span className="text-text-muted">Original source text unavailable.</span>}</Detail>
          <Detail label="Printed value">{selection.field.document_value === null ? none : selection.field.document_value || <span className="text-text-muted">Blank in source</span>}</Detail>
          <Detail label="Extracted value">{selection.field.metadata ? selection.field.extracted_value || <span className="text-text-muted">Nothing extracted</span> : <span className="text-text-muted">Read from the layout; no extraction record</span>}</Detail>
          <Detail label="Reviewed value">{selection.field.metadata ? selection.field.effective_value || none : <span className="text-text-muted">Not reviewed</span>}</Detail>
          <Detail label="Validation">{selection.field.metadata?.validation_status ?? none}</Detail>
          <Detail label="Review status"><StatusBadge status={selection.field.review_status} /></Detail>
          {selection.field.flags.length > 0 && (
            <Detail label="Needs review because">
              <ul className="list-disc pl-4 text-danger">{selection.field.flags.map((flag) => <li key={flag.code}>{flag.message}</li>)}</ul>
            </Detail>
          )}
          <Detail label="Source page">{selection.field.page ?? none}</Detail>
          {selection.field.source_location && <Detail label="Source location">{SOURCE_LOCATION_LABEL[selection.field.source_location]}</Detail>}
          <Detail label="Extraction method">
            {selection.field.found_by || none}
            {selection.field.metadata && ` · ${selection.field.metadata.extraction_method}`}
          </Detail>
          {selection.field.other_metadata.length > 0 && (
            <Detail label="Other extractions">
              {selection.field.other_metadata.map((m) => `${m.label}: ${m.original_value || "(empty)"}`).join("; ")}
            </Detail>
          )}
        </dl>
      ) : (
        <dl className="space-y-1.5">
          {selection.table.headers.map((header, index) => (
            <Detail key={index} label={header}>
              <span className={selection.row.flags?.some((f) => f.column === index) ? "text-danger" : ""}>{selection.row.cells[index] || <span className="text-text-muted">—</span>}</span>
            </Detail>
          ))}
          <Detail label="Review status"><StatusBadge status={selection.row.review_status ?? "Not reviewed"} /></Detail>
          {selection.row.flags?.length ? (
            <Detail label="Needs review because">
              <ul className="list-disc pl-4 text-danger">{selection.row.flags.map((flag, index) => <li key={index}>{selection.table.headers[flag.column ?? 0]}: {flag.message}</li>)}</ul>
            </Detail>
          ) : null}
          <Detail label="Source page">{selection.row.page ?? none}</Detail>
          {selection.row.source_location && <Detail label="Source location">{SOURCE_LOCATION_LABEL[selection.row.source_location]}</Detail>}
          <Detail label="Extraction method">{selection.table.detection_method.replace(/_/g, " ")}{selection.table.continued && " · merged across pages"}</Detail>
        </dl>
      )}

      {selection.kind === "field" && selection.field.metadata && (
        <CandidateList candidates={[selection.field.metadata, ...selection.field.other_metadata]} />
      )}

      {reviewEnabled && <RecordReview key={selection.kind === "field" ? selection.field.record_key : selection.row.record_key}
        documentId={documentId} selection={selection} onDone={() => onReviewed?.(selection)} />}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-2">
        {(selection.kind === "field" ? selection.field.page : selection.row.page) ? (
          <button type="button" onClick={onViewSource} className="btn-secondary inline-flex items-center gap-1.5 px-2.5 py-1 text-xs">
            <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />View in source
          </button>
        ) : (
          <span className="text-text-muted">No source page was recorded.</span>
        )}
        {selection.kind === "field" && selection.field.metadata && (
          <Link href={`/documents/${documentId}/review`} className="font-medium text-primary hover:underline">Correct or approve in Metadata review</Link>
        )}
      </div>

      <div className="border-t border-border pt-2" data-testid="layout-oracle">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Oracle mapping</p>
        {mappings === null ? (
          <p className="text-text-muted">Checking saved mappings…</p>
        ) : relevant.length === 0 ? (
          <p className="text-text-muted">No Oracle mapping configured.</p>
        ) : (
          <ul className="space-y-1">
            {relevant.map((m) => (
              <li key={m.profile.id} className="flex flex-wrap items-center gap-2">
                <span className="text-foreground">{m.template.object_name} v{m.template.version}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${MAPPING_TONE[m.state]}`}>{MAPPING_LABEL[m.state]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}


/** Approve, reject or correct one record; a table can gain a missing row.
 * The printed value is never overwritten: a correction is kept beside it
 * (and on the extraction row, for extracted fields). */
export function RecordReview({ documentId, selection, onDone }: {
  documentId: string;
  selection: Selection;
  onDone: () => void;
}) {
  const field = selection.kind === "field" ? selection.field : null;
  const row = selection.kind === "row" ? selection.row : null;
  const headers = selection.kind === "row" ? selection.table.headers : [];
  const [mode, setMode] = useState<"idle" | "correct" | "add">("idle");
  const [value, setValue] = useState(field ? field.effective_value || field.extracted_value || field.document_value || "" : "");
  const [cells, setCells] = useState<string[]>(row ? [...(row.reviewed_cells ?? row.cells)] : []);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const key = field ? field.record_key : row!.record_key;

  async function act(action: StructureAction, records = [key], options: { value?: string; cells?: string[] } = {}) {
    setBusy(true);
    setMessage("");
    try {
      const result = await reviewStructureRecords(documentId, records, action, { ...options, reason: reason || undefined });
      const failed = result.results.find((r) => !r.ok);
      if (failed) setMessage(failed.error ?? "The decision wasn't saved.");
      else {
        setMode("idle");
        onDone();
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "The decision wasn't saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-border pt-2" data-testid="record-review">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Review</p>
      {mode === "correct" && field && (
        <label className="block">
          <span className="text-text-secondary">Corrected value (the printed value is kept)</span>
          <input value={value} onChange={(event) => setValue(event.target.value)} className="mt-1 w-full rounded-md border border-border bg-surface px-2 py-1" aria-label="Corrected value" />
        </label>
      )}
      {(mode === "correct" || mode === "add") && row && (
        <div className="grid grid-cols-[8rem_1fr] gap-1">
          {headers.map((header, index) => (
            <label key={index} className="contents">
              <span className="truncate text-text-secondary">{header}</span>
              <input value={cells[index] ?? ""} aria-label={header}
                onChange={(event) => setCells((current) => current.map((c, i) => (i === index ? event.target.value : c)))}
                className="rounded-md border border-border bg-surface px-2 py-0.5" />
            </label>
          ))}
        </div>
      )}
      {mode !== "idle" && (
        <input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason (optional)" aria-label="Reason"
          className="w-full rounded-md border border-border bg-surface px-2 py-1" />
      )}
      <div className="flex flex-wrap gap-2">
        {mode === "idle" ? (
          <>
            <button type="button" disabled={busy} onClick={() => void act("accept")} className="btn-primary inline-flex items-center gap-1 px-2.5 py-1 text-xs">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />Approve
            </button>
            <button type="button" disabled={busy} onClick={() => setMode("correct")} className="btn-secondary inline-flex items-center gap-1 px-2.5 py-1 text-xs">
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />Correct
            </button>
            <button type="button" disabled={busy} onClick={() => void act("reject")} className="btn-secondary px-2.5 py-1 text-xs text-danger">Reject</button>
            {row && selection.kind === "row" && (
              <button type="button" disabled={busy} onClick={() => { setCells(headers.map(() => "")); setMode("add"); }}
                className="btn-secondary inline-flex items-center gap-1 px-2.5 py-1 text-xs">
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />Add row
              </button>
            )}
          </>
        ) : (
          <>
            <button type="button" disabled={busy}
              onClick={() => void (mode === "add" && selection.kind === "row"
                ? act("add_row", [selection.table.record_key], { cells })
                : act("correct", [key], field ? { value } : { cells }))}
              className="btn-primary px-2.5 py-1 text-xs">
              {mode === "add" ? "Add row" : "Save correction"}
            </button>
            <button type="button" onClick={() => setMode("idle")} className="btn-secondary px-2.5 py-1 text-xs">Cancel</button>
          </>
        )}
      </div>
      <p className="text-[11px] text-text-muted">A correction is saved for review; it is not approved until someone approves it.</p>
      {message && <p className="text-danger" role="alert">{message}</p>}
    </div>
  );
}
