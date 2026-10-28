"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  KeyRound,
  ListChecks,
  Loader2,
  ScanText,
  Search,
  Table2,
} from "lucide-react";

import {
  getDocumentPages,
  getPageRender,
  getSourceStructure,
  type SourceBox,
  type SourceStructure,
  type SourceTableCandidate,
} from "@/lib/documents";
import type { StagingCell, StagingDataset, StagingWorkbook } from "@/lib/staging-workbook";
import type { DocumentPage, PageRender } from "@/types/document";

/**
 * Results: everything read from the document in one place — the page on
 * the left with the selected value outlined, and on the right the staged
 * Fields, every Key-value pair found, Tables and the OCR text. Nothing is
 * recomputed here; each tab shows what the backend stored.
 */

type ResultsTab = "fields" | "pairs" | "tables" | "ocr";
type Status = "Verified" | "Needs Review" | "Missing" | null;

interface Located {
  page: number | null;
  bbox: SourceBox | null;
}

interface FieldRow extends Located {
  id: string;
  group: string;
  /** From a label/value dataset (Key Fields, Licence Data…): also a pair. */
  pairLike: boolean;
  /** Platform details (file name, status), not read from the document. */
  system: boolean;
  label: string;
  value: string;
  status: Status;
  note: string | null;
}

interface PairRow extends Located {
  id: string;
  label: string;
  value: string;
  source: "layout" | "text";
  quality: number | null;
}

interface TableView extends Located {
  id: string;
  title: string;
  headers: string[];
  rows: string[][];
}

// A repeating dataset whose records are "field name → value" rows (Key
// Fields, Passport Data, Licence Data) lists as fields, not as a table.
const NAME_KEYS = new Set(["name", "field"]);
const VALUE_KEYS = ["value", "printed"];

function text(value: StagingCell["value"] | undefined): string {
  if (value === null || value === undefined) return "";
  return typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
}

function located(cell: StagingCell | undefined): Located {
  const provenance = cell?.provenance;
  return { page: provenance?.source_page ?? null, bbox: provenance?.source_bbox ?? null };
}

function nameValueColumns(dataset: StagingDataset): [string, string] | null {
  const keys = dataset.columns.map((column) => column.key);
  const name = keys.find((key) => NAME_KEYS.has(key));
  const value = VALUE_KEYS.find((key) => keys.includes(key));
  return name && value ? [name, value] : null;
}

function cellByKey(dataset: StagingDataset, cells: Record<string, StagingCell>, key: string) {
  const column = dataset.columns.find((item) => item.key === key);
  return column ? cells[column.canonical_field] : undefined;
}

export function deriveFields(workbook: StagingWorkbook): { fields: FieldRow[]; tables: TableView[] } {
  const fields: FieldRow[] = [];
  const tables: TableView[] = [];
  for (const dataset of workbook.datasets) {
    if (dataset.role !== "business" || dataset.records.length === 0) continue;
    const pair = nameValueColumns(dataset);
    if (dataset.cardinality === "single") {
      for (const record of dataset.records) {
        for (const column of dataset.columns) {
          const cell = record.cells[column.canonical_field];
          const value = text(cell?.value);
          if (!value) continue;
          fields.push({
            id: `${dataset.dataset_id}:${record.record_id}:${column.key}`,
            group: dataset.display_name,
            pairLike: false,
            system: cell?.provenance?.source_type === "system",
            label: column.display_label,
            value,
            status: cell?.review_status ?? null,
            note: null,
            ...located(cell),
          });
        }
      }
    } else if (pair) {
      const [nameKey, valueKey] = pair;
      const extra = dataset.columns.find((column) => column.key === "consistency");
      for (const record of dataset.records) {
        const valueCell = cellByKey(dataset, record.cells, valueKey);
        const value = text(valueCell?.value);
        const label = text(cellByKey(dataset, record.cells, nameKey)?.value);
        if (!label || !value) continue;
        fields.push({
          id: `${dataset.dataset_id}:${record.record_id}`,
          group: dataset.display_name,
          pairLike: true,
          system: valueCell?.provenance?.source_type === "system",
          label,
          value,
          status: valueCell?.review_status ?? record.record_status ?? null,
          note: extra ? text(record.cells[extra.canonical_field]?.value) || null : null,
          ...located(valueCell),
        });
      }
    } else {
      const columns = dataset.grid_fields?.length
        ? dataset.columns.filter((column) => dataset.grid_fields!.includes(column.canonical_field))
        : dataset.columns;
      const first = dataset.records[0]?.cells[columns[0]?.canonical_field];
      tables.push({
        id: dataset.dataset_id,
        title: dataset.display_name,
        headers: columns.map((column) => column.display_label),
        rows: dataset.records.map((record) => columns.map((column) => text(record.cells[column.canonical_field]?.value))),
        ...located(first),
      });
    }
  }
  return { fields, tables };
}

export function derivePairs(structure: SourceStructure | null, fields: FieldRow[]): PairRow[] {
  const pairs: PairRow[] = (structure?.field_candidates ?? [])
    .filter((candidate) => candidate.acceptance !== "rejected" && candidate.raw_value.trim())
    .map((candidate) => ({
      id: candidate.candidate_id,
      label: candidate.label_text,
      value: candidate.raw_value.trim(),
      source: "layout" as const,
      quality: candidate.quality_score,
      page: candidate.page,
      bbox: candidate.value_bbox ?? candidate.label_bbox,
    }));
  const seen = new Set(pairs.map((pair) => pair.label.toLowerCase()));
  for (const field of fields) {
    if (!field.pairLike || seen.has(field.label.toLowerCase())) continue;
    seen.add(field.label.toLowerCase());
    pairs.push({ id: `field:${field.id}`, label: field.label, value: field.value, source: "text", quality: null,
                 page: field.page, bbox: field.bbox });
  }
  return pairs;
}

function detectedTables(structure: SourceStructure | null): TableView[] {
  return (structure?.table_candidates ?? [])
    .filter((table: SourceTableCandidate) => table.acceptance === "accepted" && table.rows.length > 0)
    .map((table, index) => {
      const width = Math.max(table.headers.length, ...table.rows.map((row) => row.length));
      return {
        id: table.candidate_id,
        title: `Table ${index + 1}${table.page ? ` · page ${table.page}` : ""}`,
        headers: Array.from({ length: width }, (_, column) => table.headers[column] ?? ""),
        rows: table.rows.map((row) => {
          const cells = Array<string>(width).fill("");
          for (const cell of row) if (cell.column_index < width) cells[cell.column_index] = cell.text;
          return cells;
        }),
        page: table.page,
        bbox: table.bbox,
      };
    });
}

const STATUS_STYLE: Record<string, string> = {
  Verified: "bg-success/10 text-success",
  "Needs Review": "bg-warning/10 text-warning",
  Missing: "bg-surface-soft text-text-muted",
};

function StatusPill({ status }: { status: Status }) {
  if (!status) return null;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[status]}`}>
      {status === "Verified" ? <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> : null}
      {status === "Needs Review" ? <AlertTriangle className="h-3 w-3" aria-hidden="true" /> : null}
      {status}
    </span>
  );
}

function StatCard({ label, value, icon: Icon, tone }: { label: string; value: string; icon: typeof FileText; tone: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3.5 shadow-sm">
      <div className="min-w-0">
        <p className="text-xs text-text-muted">{label}</p>
        <p className="mt-0.5 truncate text-lg font-semibold tracking-tight text-foreground" title={value}>{value}</p>
      </div>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${tone}`}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </span>
    </div>
  );
}

function highlightMatches(content: string, query: string) {
  if (!query) return content;
  const lower = content.toLowerCase();
  const needle = query.toLowerCase();
  const parts: ReactNode[] = [];
  let index = 0;
  let at = lower.indexOf(needle);
  while (at !== -1) {
    parts.push(content.slice(index, at));
    parts.push(<mark key={at} className="rounded bg-warning/30 px-0.5 text-foreground">{content.slice(at, at + needle.length)}</mark>);
    index = at + needle.length;
    at = lower.indexOf(needle, index);
  }
  parts.push(content.slice(index));
  return parts;
}

function PageViewer({ documentId, page, pageCount, onPage, box }: {
  documentId: string;
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  box: SourceBox | null;
}) {
  const [renders, setRenders] = useState<Record<number, PageRender>>({});
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  const render = renders[page];

  useEffect(() => {
    if (renders[page] || failed[page]) return;
    let active = true;
    getPageRender(documentId, page)
      .then((result) => active && setRenders((current) => ({ ...current, [page]: result })))
      .catch(() => active && setFailed((current) => ({ ...current, [page]: true })));
    return () => {
      active = false;
    };
  }, [documentId, page, renders, failed]);

  const overlay = render && box && render.page_width > 0 && render.page_height > 0
    ? {
        left: `${(box[0] / render.page_width) * 100}%`,
        top: `${(box[1] / render.page_height) * 100}%`,
        width: `${((box[2] - box[0]) / render.page_width) * 100}%`,
        height: `${((box[3] - box[1]) / render.page_height) * 100}%`,
      }
    : null;

  return (
    <div className="flex h-full flex-col rounded-2xl border border-border bg-surface-soft/60">
      <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-text-secondary">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
          <FileText className="h-3.5 w-3.5" aria-hidden="true" /> Document
        </span>
        <span className="inline-flex items-center gap-1">
          <button type="button" className="rounded-md p-1 hover:bg-surface disabled:opacity-40" disabled={page <= 1}
                  onClick={() => onPage(page - 1)} aria-label="Previous page">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="tabular-nums">Page {page} of {pageCount}</span>
          <button type="button" className="rounded-md p-1 hover:bg-surface disabled:opacity-40" disabled={page >= pageCount}
                  onClick={() => onPage(page + 1)} aria-label="Next page">
            <ChevronRight className="h-4 w-4" />
          </button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {render ? (
          <div className="relative mx-auto w-full max-w-[640px] overflow-hidden rounded-lg bg-white shadow-md">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={render.image_data_url} alt={`Page ${page}`} className="block w-full" />
            {overlay && (
              <span
                className="pointer-events-none absolute rounded-sm border-2 border-primary bg-primary/15 shadow-[0_0_0_4px_rgba(37,99,235,0.15)] transition-all duration-300"
                style={overlay}
                data-testid="results-highlight"
              />
            )}
          </div>
        ) : failed[page] ? (
          <p className="p-6 text-center text-sm text-text-muted">This page could not be rendered.</p>
        ) : (
          <div className="flex h-64 items-center justify-center text-text-muted">
            <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading page" />
          </div>
        )}
      </div>
    </div>
  );
}

function DataTable({ table, filter }: { table: TableView; filter: string }) {
  const rows = filter
    ? table.rows.filter((row) => row.some((cell) => cell.toLowerCase().includes(filter)))
    : table.rows;
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="flex items-center justify-between bg-surface-soft/70 px-3 py-2">
        <p className="text-sm font-medium text-foreground">{table.title}</p>
        <p className="text-xs tabular-nums text-text-muted">{rows.length} of {table.rows.length} rows</p>
      </div>
      <div className="max-h-[420px] overflow-auto">
        <table className="w-full min-w-max text-left text-sm">
          <thead className="sticky top-0 bg-surface text-[11px] uppercase tracking-wide text-text-muted">
            <tr>
              {table.headers.map((header, index) => (
                <th key={index} className="border-b border-border px-3 py-2 font-medium">{header || `Column ${index + 1}`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-border/60 last:border-0 hover:bg-surface-soft/60">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}
                      className={`px-3 py-2 ${/^[\s$€£(-]*[\d,.]+\)?%?$/.test(cell) ? "text-right tabular-nums" : "text-foreground"}`}>
                    {cell || <span className="text-text-muted">—</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ResultsView({ documentId, workbook, typeLabel, pageCount }: {
  documentId: string;
  workbook: StagingWorkbook;
  typeLabel: string;
  pageCount: number;
}) {
  const [tab, setTab] = useState<ResultsTab>("fields");
  const [filter, setFilter] = useState("");
  const [structure, setStructure] = useState<SourceStructure | null>(null);
  const [pages, setPages] = useState<DocumentPage[] | null>(null);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<{ id: string; bbox: SourceBox | null } | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    getSourceStructure(documentId).then((result) => active && setStructure(result)).catch(() => undefined);
    getDocumentPages(documentId).then((result) => active && setPages(result)).catch(() => active && setPages([]));
    return () => {
      active = false;
    };
  }, [documentId]);

  const { fields, tables: stagedTables } = useMemo(() => deriveFields(workbook), [workbook]);
  const pairs = useMemo(() => derivePairs(structure, fields), [structure, fields]);
  const tables = useMemo(() => [...stagedTables, ...detectedTables(structure)], [stagedTables, structure]);
  const needle = filter.trim().toLowerCase();
  const matches = (...values: string[]) => !needle || values.some((value) => value.toLowerCase().includes(needle));
  const needsReview = fields.filter((field) => field.status === "Needs Review").length;
  const ocrPages = (pages ?? []).filter((item) => item.extraction_method?.toLowerCase().includes("ocr")).length;
  const totalPages = Math.max(1, pageCount, pages?.length ?? 0);

  function select(item: { id: string } & Located) {
    setSelected({ id: item.id, bbox: item.bbox });
    if (item.page) setPage(item.page);
  }

  const tabs: { id: ResultsTab; label: string; count: number; icon: typeof FileText }[] = [
    { id: "fields", label: "Fields", count: fields.length, icon: ListChecks },
    { id: "pairs", label: "Key-value pairs", count: pairs.length, icon: KeyRound },
    { id: "tables", label: "Tables", count: tables.length, icon: Table2 },
    { id: "ocr", label: "OCR text", count: pages?.length ?? 0, icon: ScanText },
  ];

  const groups = useMemo(() => {
    const byGroup = new Map<string, FieldRow[]>();
    for (const field of fields) {
      if (!matches(field.label, field.value, field.group)) continue;
      byGroup.set(field.group, [...(byGroup.get(field.group) ?? []), field]);
    }
    // The document's own values first; platform details last.
    return [...byGroup.entries()].sort(
      ([, a], [, b]) => Number(a.every((row) => row.system)) - Number(b.every((row) => row.system)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields, needle]);

  return (
    <section className="space-y-4" data-testid="results-view">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Document type" value={typeLabel} icon={FileText} tone="bg-primary-soft text-primary" />
        <StatCard label="Fields extracted" value={fields.length.toLocaleString()} icon={ListChecks} tone="bg-success/10 text-success" />
        <StatCard label="Needs review" value={needsReview.toLocaleString()} icon={AlertTriangle}
                  tone={needsReview ? "bg-warning/10 text-warning" : "bg-surface-soft text-text-muted"} />
        <StatCard label="Pages" value={`${totalPages}${ocrPages ? ` · ${ocrPages} OCR` : ""}`} icon={ScanText}
                  tone="bg-surface-soft text-text-secondary" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div className="h-[60vh] lg:sticky lg:top-4 lg:h-[calc(100vh-7rem)]">
          <PageViewer documentId={documentId} page={page} pageCount={totalPages} onPage={(next) => { setPage(next); setSelected(null); }}
                      box={selected?.bbox ?? null} />
        </div>

        <div className="min-w-0 rounded-2xl border border-border bg-surface shadow-sm">
          <div className="flex gap-1 overflow-x-auto border-b border-border px-2" role="tablist" aria-label="Results">
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                onClick={() => setTab(item.id)}
                className={[
                  "-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-3 text-sm transition-colors",
                  tab === item.id ? "border-primary font-medium text-primary" : "border-transparent text-text-secondary hover:text-foreground",
                ].join(" ")}
              >
                <item.icon className="h-4 w-4" aria-hidden="true" />
                {item.label}
                <span className="rounded-full bg-surface-soft px-1.5 text-[11px] tabular-nums text-text-muted">{item.count}</span>
              </button>
            ))}
          </div>

          <div className="border-b border-border px-4 py-2.5">
            <label className="flex items-center gap-2 text-sm text-text-muted">
              <Search className="h-4 w-4" aria-hidden="true" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={tab === "ocr" ? "Search the text…" : "Filter by label or value…"}
                className="w-full bg-transparent py-1 text-foreground outline-none placeholder:text-text-muted"
                aria-label="Filter results"
              />
            </label>
          </div>

          <div className="max-h-[calc(100vh-14rem)] overflow-auto p-4">
            {tab === "fields" && (
              groups.length === 0 ? (
                <p className="py-10 text-center text-sm text-text-muted">{fields.length ? "No fields match the filter." : "No fields were extracted from this document yet."}</p>
              ) : (
                <div className="space-y-5">
                  {groups.map(([group, rows]) => (
                    <div key={group}>
                      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{group}</p>
                      <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border">
                        {rows.map((field) => (
                          <li key={field.id}>
                            <button
                              type="button"
                              onClick={() => select(field)}
                              className={[
                                "grid w-full grid-cols-[minmax(0,2fr)_minmax(0,3fr)_9.5rem] items-center gap-3 px-3 py-2.5 text-left transition-colors",
                                selected?.id === field.id ? "bg-primary-soft/60" : "hover:bg-surface-soft/70",
                              ].join(" ")}
                              data-testid="results-field"
                            >
                              <span className="truncate text-sm text-text-secondary" title={field.label}>{field.label}</span>
                              <span className="min-w-0">
                                <span className="block break-words text-sm font-medium text-foreground">{field.value}</span>
                                {field.note && <span className="text-[11px] text-text-muted">{field.note}</span>}
                              </span>
                              <span className="flex items-center justify-end gap-2">
                                {field.page ? <span className="text-[11px] tabular-nums text-text-muted">p.{field.page}</span> : null}
                                <StatusPill status={field.status} />
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )
            )}

            {tab === "pairs" && (
              pairs.length === 0 ? (
                <p className="py-10 text-center text-sm text-text-muted">{structure ? "No label/value pairs were found." : "Reading the document's layout…"}</p>
              ) : (
                <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border">
                  {pairs.filter((pair) => matches(pair.label, pair.value)).map((pair) => (
                    <li key={pair.id}>
                      <button
                        type="button"
                        onClick={() => select(pair)}
                        className={[
                          "grid w-full grid-cols-[minmax(0,2fr)_minmax(0,3fr)_9.5rem] items-center gap-3 px-3 py-2.5 text-left transition-colors",
                          selected?.id === pair.id ? "bg-primary-soft/60" : "hover:bg-surface-soft/70",
                        ].join(" ")}
                        data-testid="results-pair"
                      >
                        <span className="truncate text-sm text-text-secondary" title={pair.label}>{pair.label}</span>
                        <span className="break-words text-sm font-medium text-foreground">{pair.value}</span>
                        <span className="flex items-center justify-end gap-2 text-[11px] text-text-muted">
                          {pair.page ? <span className="tabular-nums">p.{pair.page}</span> : null}
                          {pair.quality !== null ? (
                            <span className="flex items-center gap-1" title={`Layout quality ${Math.round(pair.quality * 100)}%`}>
                              <span className="h-1.5 w-10 overflow-hidden rounded-full bg-surface-soft">
                                <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.round(pair.quality * 100)}%` }} />
                              </span>
                            </span>
                          ) : (
                            <span className="rounded bg-surface-soft px-1.5 py-0.5">text</span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            )}

            {tab === "tables" && (
              tables.length === 0 ? (
                <p className="py-10 text-center text-sm text-text-muted">No tables were found in this document.</p>
              ) : (
                <div className="space-y-4">
                  {tables.map((table) => (
                    <div key={table.id} onClick={() => select(table)} role="presentation">
                      <DataTable table={table} filter={needle} />
                    </div>
                  ))}
                </div>
              )
            )}

            {tab === "ocr" && (
              pages === null ? (
                <div className="flex justify-center py-10 text-text-muted"><Loader2 className="h-5 w-5 animate-spin" aria-label="Loading text" /></div>
              ) : (
                <div className="space-y-4">
                  {pages.filter((item) => matches(item.final_text || "")).map((item) => {
                    const ocr = item.extraction_method?.toLowerCase().includes("ocr");
                    return (
                      <article key={item.page_number} className="overflow-hidden rounded-xl border border-border">
                        <header className="flex items-center justify-between gap-2 bg-surface-soft/70 px-3 py-2 text-xs">
                          <button type="button" className="font-medium text-foreground hover:text-primary" onClick={() => setPage(item.page_number)}>
                            Page {item.page_number}
                          </button>
                          <span className="flex items-center gap-2 text-text-muted">
                            <span className={`rounded-full px-2 py-0.5 font-medium ${ocr ? "bg-warning/10 text-warning" : "bg-success/10 text-success"}`}>
                              {ocr ? "OCR" : "Native text"}
                            </span>
                            <span className="tabular-nums">{item.word_count.toLocaleString()} words</span>
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-surface hover:text-foreground"
                              onClick={() => {
                                void navigator.clipboard?.writeText(item.final_text || "");
                                setCopied(item.page_number);
                              }}
                            >
                              <Copy className="h-3 w-3" aria-hidden="true" />
                              {copied === item.page_number ? "Copied" : "Copy"}
                            </button>
                          </span>
                        </header>
                        <pre className="max-h-[360px] overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12.5px] leading-6 text-foreground">
                          {item.final_text ? highlightMatches(item.final_text, filter.trim()) : <span className="text-text-muted">No text on this page.</span>}
                        </pre>
                      </article>
                    );
                  })}
                </div>
              )
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
