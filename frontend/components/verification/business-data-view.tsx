"use client";

import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useState } from "react";

import { TableView, TriCheckbox } from "@/components/original-structure/original-structure-view";
import type { SourceViewRequest } from "@/components/source-verification-panel";
import FieldCard, { Chip, ConfidenceChip, type Density } from "@/components/verification/field-card";
import type { LayoutTable } from "@/lib/original-structure";
import { layoutId } from "@/lib/record-selection";
import { useWindowedRows } from "@/lib/use-windowed-rows";
import {
  findValue,
  type BusinessCandidate,
  type BusinessData,
  type BusinessField,
  type BusinessSection,
  type BusinessTable,
  type FindResult,
} from "@/lib/verification";

export { ConfidenceChip };

function toTable(table: BusinessTable): LayoutTable {
  return {
    kind: "table", id: table.record_key, record_key: table.record_key, title: table.label, headers: table.headers,
    headers_printed: true, pages: table.pages, continued: table.pages.length > 1, detection_method: "", rows: table.rows,
    row_count: table.row_count,
  };
}

function matches(needle: string, ...texts: (string | null | undefined)[]): boolean {
  return texts.some((text) => (text ?? "").toLowerCase().includes(needle));
}

/** A section with only what contains `filter`; the whole section when the
 * section's own name matches. */
function filterSection(section: BusinessSection, filter: string): BusinessSection {
  const needle = filter.trim().toLowerCase();
  if (!needle || matches(needle, section.label)) return section;
  const fieldMatches = (f: BusinessField) => matches(needle, f.label, f.value, f.source_label, ...f.candidates.map((c) => c.value));
  return {
    ...section,
    fields: section.fields.filter(fieldMatches),
    values: section.values.filter((v) => matches(needle, v.label, v.value, v.source_section)),
    tables: section.tables
      .map((t) => ({ ...t, rows: t.rows.filter((r) => matches(needle, ...r.cells)) }))
      .filter((t) => t.rows.length > 0 || matches(needle, t.label, ...t.headers))
      .map((t) => ({ ...t, row_count: t.rows.length })),
  };
}

/** Smart Review: the document's values in its business categories, one
 * intelligent field card per field. The same records as Original Structure
 * (same keys, same selection, same review decisions). */
export default function BusinessDataView({ documentId, business, onViewRecord, onViewSource, onChanged, density = "comfortable", filter = "", focusedKey = null }: {
  documentId: string;
  business: BusinessData | null;
  /** Opens a record's source and details. */
  onViewRecord: (key: string) => void;
  onViewSource: (request: SourceViewRequest) => void;
  onChanged: () => void;
  density?: Density;
  filter?: string;
  focusedKey?: string | null;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  if (!business) return <p className="mt-4 text-sm text-text-muted" role="status">Organizing the document&apos;s data…</p>;

  const all: BusinessSection[] = [
    ...business.sections,
    ...(business.other.values.length || business.other.tables.length
      ? [{ key: "other", label: "Other Extracted Data", canonical: false, fields: [], values: business.other.values, tables: business.other.tables }]
      : []),
  ];
  const searching = filter.trim().length > 0;
  const sections = all
    .map((section) => filterSection(section, filter))
    .filter((section) => !searching || section.fields.length || section.values.length || section.tables.length);
  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="mt-4 space-y-3" data-testid="business-data" data-density={density}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-text-secondary">
        <p>
          <span className="font-semibold text-foreground">{business.document_class_label ?? "Document"}</span>
          {business.document_type && ` · ${business.document_type}`}
          {business.subtype && ` · ${business.subtype}`}
          {business.skill ? ` · ${business.skill.name} v${business.skill.version}` : " · organized by the document's own sections"}
          {" · "}{business.stats.found} of {business.stats.fields} fields found
        </p>
        <button type="button" className="hover:text-foreground" onClick={() => setCollapsed(new Set(all.map((s) => s.key)))}>Collapse all</button>
      </div>
      <FindBox documentId={documentId} onViewRecord={onViewRecord} onViewSource={onViewSource} />
      {searching && sections.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-muted">Nothing matches “{filter.trim()}”.</p>
      )}
      {sections.map((section) => {
        const open = searching || !collapsed.has(section.key);
        const ids = [
          ...section.fields.flatMap((f) => (f.record_key ? [layoutId(f.record_key)] : [])),
          ...section.values.map((v) => layoutId(v.record_key)),
          ...section.tables.flatMap((t) => t.rows.map((r) => layoutId(r.record_key))),
        ];
        const found = section.fields.filter((f) => f.value).length;
        if (section.canonical && section.fields.length === 0 && section.tables.length === 0) return null;
        return (
          <section key={section.key} className="rounded-xl border border-border bg-surface" aria-label={section.label} data-testid="business-section">
            <div className="flex items-center gap-2 px-4 py-2.5">
              <TriCheckbox ids={ids} label={`Select all records in ${section.label}`} />
              <button type="button" onClick={() => toggle(section.key)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                {open ? <ChevronDown className="h-4 w-4 text-text-muted" aria-hidden="true" /> : <ChevronRight className="h-4 w-4 text-text-muted" aria-hidden="true" />}
                <span className="text-sm font-semibold text-foreground">{section.label}</span>
                <span className="text-xs text-text-muted">
                  {section.fields.length > 0 && `${found} / ${section.fields.length} fields`}
                  {section.values.length > 0 && `${section.values.length} values`}
                  {section.tables.length > 0 && ` · ${section.tables.length} table${section.tables.length === 1 ? "" : "s"}`}
                </span>
              </button>
            </div>
            {open && (
              <div className={`space-y-3 border-t border-border ${density === "compact" ? "p-1" : "p-3"}`}>
                {section.fields.length > 0 && (
                  <div className={density === "compact" ? "" : "grid gap-2 md:grid-cols-2 2xl:grid-cols-3"}>
                    {section.fields.map((field) => (
                      <FieldCard key={field.key} documentId={documentId} field={field} density={density}
                        focused={!!focusedKey && field.candidates.some((c) => c.record_key === focusedKey)}
                        onFocus={onViewRecord} onChanged={onChanged} />
                    ))}
                  </div>
                )}
                {section.values.length > 0 && <ValueList values={section.values} onViewRecord={onViewRecord} density={density} focusedKey={focusedKey} />}
                {section.tables.map((table) => (
                  <div key={table.record_key}>
                    {table.source_section && <p className="mb-1 text-[11px] text-text-muted">Printed under {table.source_section}</p>}
                    <TableView table={toTable(table)} reviewEnabled density={density} selectedId={focusedKey} onSelect={(row) => onViewRecord(row.record_key)} />
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function ValueList({ values, onViewRecord, density, focusedKey }: {
  values: BusinessCandidate[];
  onViewRecord: (key: string) => void;
  density: Density;
  focusedKey: string | null;
}) {
  const [windowRef, rows] = useWindowedRows(values.length, density === "compact" ? 24 : 34);
  const pad = density === "compact" ? "py-0.5" : "py-1";
  return (
    <div ref={windowRef} className={rows.windowed ? "max-h-[60vh] overflow-y-auto" : ""}>
      <table className="w-full text-xs">
        <thead className="sticky top-0 bg-surface">
          <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-text-secondary">
            <td className="w-6 px-2 py-1" />
            <th scope="col" className="px-2 py-1 font-semibold">Field</th>
            <th scope="col" className="px-2 py-1 font-semibold">Value</th>
            <th scope="col" className="px-2 py-1 font-semibold">Confidence</th>
            <th scope="col" className="px-2 py-1 font-semibold">Review</th>
            <th scope="col" className="px-2 py-1 font-semibold">Page</th>
          </tr>
        </thead>
        <tbody>
          {rows.before > 0 && <tr aria-hidden="true" style={{ height: rows.before }} />}
          {values.slice(rows.start, rows.end).map((value) => (
            <tr key={value.record_key} data-window-row onClick={() => onViewRecord(value.record_key)}
              className={`cursor-pointer border-b border-border/60 hover:bg-surface-soft ${focusedKey === value.record_key ? "bg-primary/[0.06]" : ""}`}>
              <td className={`w-6 px-2 ${pad}`}><TriCheckbox ids={[layoutId(value.record_key)]} label={`Select ${value.label}`} /></td>
              <td className={`px-2 ${pad} text-text-secondary`}>{value.label}{value.source_section && density !== "compact" && <span className="block text-[11px] text-text-muted">{value.source_section}</span>}</td>
              <td className={`px-2 ${pad} text-foreground`}>{value.value || <span className="text-text-muted">(blank)</span>}</td>
              <td className={`px-2 ${pad}`}><ConfidenceChip value={value.confidence} /></td>
              <td className={`px-2 ${pad} text-text-secondary`}>{value.review_status}</td>
              <td className={`px-2 ${pad} text-text-secondary`}>{value.page ?? "—"}</td>
            </tr>
          ))}
          {rows.after > 0 && <tr aria-hidden="true" style={{ height: rows.after }} />}
        </tbody>
      </table>
    </div>
  );
}

/** Targeted extraction: ask for one value by name. */
function FindBox({ documentId, onViewRecord, onViewSource }: {
  documentId: string;
  onViewRecord: (key: string) => void;
  onViewSource: (request: SourceViewRequest) => void;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<FindResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(event: React.FormEvent) {
    event.preventDefault();
    if (query.trim().length < 2) return;
    setBusy(true);
    setError("");
    try {
      setResult(await findValue(documentId, query.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The search failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-3 text-xs" data-testid="find-box">
      <form onSubmit={run} className="flex flex-wrap items-center gap-2">
        <Search className="h-4 w-4 text-text-muted" aria-hidden="true" />
        <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Find a value"
          placeholder="Find a value — e.g. Extract Contract Number, Find Expiration Date, Identify FAR Clauses"
          className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1.5 text-sm" />
        <button type="submit" disabled={busy || query.trim().length < 2} className="btn-primary px-3 py-1.5 text-xs">{busy ? "Finding…" : "Find"}</button>
      </form>
      {error && <p className="mt-2 text-danger" role="alert">{error}</p>}
      {result && (
        <div className="mt-2" data-testid="find-result" role="status">
          <p className={result.found ? "text-foreground" : "text-text-secondary"}>{result.message}</p>
          {(result.answers ?? []).slice(0, 25).map((answer, index) => (
            <button key={index} type="button"
              onClick={() => answer.record_key ? onViewRecord(answer.record_key) : answer.page && onViewSource({ pageNumber: answer.page, highlightText: answer.value, label: result.label, value: answer.value })}
              className="mt-1 flex w-full flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1 text-left hover:border-primary">
              <span className="font-medium text-foreground">{answer.value}</span>
              {answer.basis === "inferred" && <Chip tone="bg-warning/10 text-warning">Inferred</Chip>}
              <span className="text-text-muted">{answer.source_label ? `“${answer.source_label}”` : ""}{answer.page ? ` · page ${answer.page}` : ""}</span>
              <span className="ml-auto flex gap-1">
                <ConfidenceChip value={answer.confidence} />
                <Chip tone={answer.validation_status === "failed" ? "bg-danger/10 text-danger" : "bg-success/10 text-success"}>{answer.validation_status === "failed" ? "Invalid" : "Valid"}</Chip>
              </span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
