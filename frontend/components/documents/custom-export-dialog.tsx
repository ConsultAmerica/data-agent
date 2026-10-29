"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Download, Plus, Save, Search, Trash2, X } from "lucide-react";

import {
  downloadCustomExport,
  previewCustomExport,
  type CustomExportManifest,
  type CustomExportPreview,
  type CustomExportTransform,
  type CustomExportSource,
  type SelectedExportFormat,
  type StagingCell,
  type StagingDataset,
  type StagingWorkbook,
} from "@/lib/staging-workbook";

/**
 * Custom export: the reviewer picks fields, renames them, combines several
 * into one column and orders them, then downloads a plain table ready for
 * importing into another system. Mappings can be saved per document type
 * (in this browser) so every file has the same columns.
 */

// Mirrors backend app/staging/selection_export.py: never exported.
const TECHNICAL_KEYS = new Set([
  "record_id", "field_id", "database_id", "bbox", "source_bbox", "confidence",
  "extraction_method", "ocr_method", "provenance", "provenance_json", "dom_path",
]);
const TECHNICAL_SUFFIXES = ["_bbox", "_confidence", "_provenance"];
const NAME_KEYS = new Set(["name", "field"]);
const VALUE_KEYS = ["value", "printed"];
const SEPARATORS: { value: string; label: string }[] = [
  { value: " ", label: "Space" },
  { value: ", ", label: "Comma" },
  { value: " - ", label: "Dash" },
  { value: " / ", label: "Slash" },
  { value: "; ", label: "Semicolon" },
  { value: "", label: "None" },
];
const FORMATS: { id: SelectedExportFormat; label: string }[] = [
  { id: "xlsx", label: "Excel" },
  { id: "csv", label: "CSV" },
  { id: "json", label: "JSON" },
];
const PREVIEW_ROWS = 3;
const MAX_DEFAULT_COLUMNS = 40;

type Kind = "single" | "pair" | "column";

/** How a field is found again in another document of the same type. */
interface FieldRef {
  dataset_id: string;
  field: string;
  kind: Kind;
  pair_name?: string;
}

interface FieldOption {
  key: string;
  group: string;
  label: string;
  kind: Kind;
  source: CustomExportSource;
  ref: FieldRef;
  sample: string;
}

interface ColumnState {
  id: string;
  label: string;
  sources: string[];
  separator: string;
  transform?: CustomExportTransform;
}

const TRANSFORMS: { value: CustomExportTransform; label: string }[] = [
  { value: "as_is", label: "As extracted" },
  { value: "trim", label: "Trim spaces" },
  { value: "upper", label: "UPPER CASE" },
  { value: "lower", label: "lower case" },
  { value: "date_iso", label: "Date as YYYY-MM-DD" },
];

interface Template {
  name: string;
  rowTable: string;
  format: SelectedExportFormat;
  includeHeader: boolean;
  columns: { label: string; separator: string; refs: FieldRef[]; transform?: CustomExportTransform }[];
  /** Bumped each time the template is saved again under its name. */
  version?: number;
  /** The document type it was made for (its staging profile). */
  category?: string;
  updatedAt?: string;
}

function exportable(key: string): boolean {
  const lower = key.toLowerCase();
  return !TECHNICAL_KEYS.has(lower) && !TECHNICAL_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function text(cell: StagingCell | undefined): string {
  const value = cell?.value;
  if (value === null || value === undefined) return "";
  return typeof value === "boolean" ? (value ? "Yes" : "No") : String(value);
}

function pairColumns(dataset: StagingDataset): [string, string] | null {
  const name = dataset.columns.find((column) => NAME_KEYS.has(column.key));
  const value = VALUE_KEYS.map((key) => dataset.columns.find((column) => column.key === key)).find(Boolean);
  return name && value ? [name.canonical_field, value.canonical_field] : null;
}

export function fieldCatalogue(workbook: StagingWorkbook): { options: FieldOption[]; tables: StagingDataset[] } {
  const options: FieldOption[] = [];
  const tables: StagingDataset[] = [];
  for (const dataset of workbook.datasets) {
    if ((dataset.role !== "business" && dataset.role !== "transform") || dataset.records.length === 0) continue;
    const columns = dataset.columns.filter((column) => exportable(column.key));
    const pair = pairColumns(dataset);
    if (dataset.cardinality === "single") {
      const record = dataset.records[0];
      for (const column of columns) {
        options.push({
          key: `single:${dataset.dataset_id}:${column.canonical_field}`,
          group: dataset.display_name,
          label: column.display_label,
          kind: "single",
          source: { dataset_id: dataset.dataset_id, field: column.canonical_field, record_id: record.record_id },
          ref: { dataset_id: dataset.dataset_id, field: column.canonical_field, kind: "single" },
          sample: text(record.cells[column.canonical_field]),
        });
      }
    } else if (pair) {
      const [nameField, valueField] = pair;
      for (const record of dataset.records) {
        const name = text(record.cells[nameField]).trim();
        if (!name) continue;
        options.push({
          key: `pair:${dataset.dataset_id}:${record.record_id}`,
          group: dataset.display_name,
          label: name,
          kind: "pair",
          source: { dataset_id: dataset.dataset_id, field: valueField, record_id: record.record_id },
          ref: { dataset_id: dataset.dataset_id, field: valueField, kind: "pair", pair_name: name },
          sample: text(record.cells[valueField]),
        });
      }
    } else {
      tables.push(dataset);
      for (const column of columns) {
        options.push({
          key: `column:${dataset.dataset_id}:${column.canonical_field}`,
          group: `${dataset.display_name} (table)`,
          label: column.display_label,
          kind: "column",
          source: { dataset_id: dataset.dataset_id, field: column.canonical_field, record_id: null },
          ref: { dataset_id: dataset.dataset_id, field: column.canonical_field, kind: "column" },
          sample: text(dataset.records[0]?.cells[column.canonical_field]),
        });
      }
    }
  }
  return { options, tables };
}

/** Output label from a field label: "Date of Birth" → "Date of Birth" (kept
 * readable; the reviewer renames to the importer's own header). */
function uniqueLabel(label: string, taken: Set<string>): string {
  let candidate = label;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${label} ${n}`;
  return candidate;
}

let nextId = 0;
function newId(): string {
  nextId += 1;
  return `col-${nextId}`;
}

function templateKey(profileId: string): string {
  return `dataomatix.customExport.v1.${profileId}`;
}

function loadTemplates(profileId: string): Template[] {
  try {
    const raw = window.localStorage.getItem(templateKey(profileId));
    return raw ? (JSON.parse(raw) as Template[]) : [];
  } catch {
    return [];
  }
}

function storeTemplates(profileId: string, templates: Template[]): void {
  try {
    window.localStorage.setItem(templateKey(profileId), JSON.stringify(templates));
  } catch {
    // Storage unavailable (private window): templates just aren't kept.
  }
}

function sameRef(a: FieldRef, b: FieldRef): boolean {
  if (a.dataset_id !== b.dataset_id || a.kind !== b.kind) return false;
  if (a.kind === "pair") return (a.pair_name ?? "").toLowerCase() === (b.pair_name ?? "").toLowerCase();
  return a.field === b.field;
}

export default function CustomExportDialog({
  documentId,
  workbook,
  filename,
  onClose,
  onDownloaded,
}: {
  documentId: string;
  workbook: StagingWorkbook;
  filename: string;
  onClose: () => void;
  onDownloaded: (message: string) => void;
}) {
  const { options, tables } = useMemo(() => fieldCatalogue(workbook), [workbook]);
  const byKey = useMemo(() => new Map(options.map((option) => [option.key, option])), [options]);
  const profileId = workbook.profile.profile_id;

  const [rowTable, setRowTable] = useState("");
  const [columns, setColumns] = useState<ColumnState[]>(() => {
    // Start from the structured document fields, one per label. Key/value
    // scans (All Fields) also hold flattened line items ("Line 1 / …"),
    // which would repeat on every row; they stay available to add by hand,
    // and are the starting point only for types with no structured fields.
    const taken = new Set<string>();
    const filled = options.filter((option) => option.kind !== "column" && option.sample.trim());
    const kind = filled.some((option) => option.kind === "single") ? "single" : "pair";
    return filled
      .filter((option) => option.kind === kind)
      .filter((option) => !taken.has(option.label) && Boolean(taken.add(option.label)))
      .slice(0, MAX_DEFAULT_COLUMNS)
      .map((option) => ({ id: newId(), label: option.label, sources: [option.key], separator: " " }));
  });
  const [format, setFormat] = useState<SelectedExportFormat>("xlsx");
  const [includeHeader, setIncludeHeader] = useState(true);
  const [fileName, setFileName] = useState("");
  const [search, setSearch] = useState("");
  // The dialog only opens in the browser, so storage is readable here.
  const [templates, setTemplates] = useState<Template[]>(() => loadTemplates(profileId));
  const [templateName, setTemplateName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [serverPreview, setServerPreview] = useState<CustomExportPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const labels = columns.map((column) => column.label.trim());
  const duplicate = labels.find((label, index) => label && labels.indexOf(label) !== index);
  const tableInUse = columns
    .flatMap((column) => column.sources)
    .map((key) => byKey.get(key))
    .find((option) => option?.kind === "column")?.source.dataset_id;
  const activeTable = tables.find((table) => table.dataset_id === (tableInUse ?? rowTable));
  const problems = [
    columns.length === 0 ? "Add at least one column." : "",
    labels.some((label) => !label) ? "Every column needs a label." : "",
    duplicate ? `Column labels must be unique: "${duplicate}".` : "",
  ].filter(Boolean);

  function available(option: FieldOption): boolean {
    // Table columns only from the chosen table, so every row is one record.
    return option.kind !== "column" || !activeTable || option.source.dataset_id === activeTable.dataset_id;
  }

  function addColumn(option: FieldOption) {
    const taken = new Set(labels);
    setColumns((current) => [
      ...current,
      { id: newId(), label: uniqueLabel(option.label, taken), sources: [option.key], separator: " " },
    ]);
    if (option.kind === "column") setRowTable(option.source.dataset_id);
  }

  function update(id: string, patch: Partial<ColumnState>) {
    setColumns((current) => current.map((column) => (column.id === id ? { ...column, ...patch } : column)));
  }

  function move(index: number, delta: number) {
    setColumns((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function chooseRows(datasetId: string) {
    setRowTable(datasetId);
    // Columns from another table can't share rows with this one.
    setColumns((current) =>
      current
        .map((column) => ({
          ...column,
          sources: column.sources.filter((key) => {
            const option = byKey.get(key);
            return option?.kind !== "column" || option.source.dataset_id === datasetId;
          }),
        }))
        .filter((column) => column.sources.length > 0),
    );
    if (datasetId) {
      const taken = new Set(labels);
      const added = options
        .filter((option) => option.kind === "column" && option.source.dataset_id === datasetId)
        .filter((option) => !columns.some((column) => column.sources.includes(option.key)))
        .map((option) => {
          const label = uniqueLabel(option.label, taken);
          taken.add(label);
          return { id: newId(), label, sources: [option.key], separator: " " };
        });
      setColumns((current) => [...current, ...added]);
    }
  }

  const preview = useMemo(() => {
    const records = activeTable ? activeTable.records.slice(0, PREVIEW_ROWS) : [null];
    return records.map((record) =>
      columns.map((column) => {
        const values = column.sources.map((key) => {
          const option = byKey.get(key);
          if (!option) return "";
          if (option.kind === "column") return record ? text(record.cells[option.source.field]) : "";
          return option.sample;
        });
        return values.length === 1 ? values[0] : values.filter((value) => value.trim()).join(column.separator);
      }),
    );
  }, [activeTable, byKey, columns]);

  // The preview comes from the server's own export builder, so it shows
  // exactly what the file will hold (and how many rows).
  const manifestKey = JSON.stringify([rowTable, columns.map((c) => [c.label, c.separator, c.transform, c.sources]), includeHeader]);
  useEffect(() => {
    if (columns.length === 0 || problems.length) {
      queueMicrotask(() => setServerPreview(null));
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      previewCustomExport(documentId, manifest())
        .then((result) => active && (setServerPreview(result), setPreviewError("")))
        .catch((err: unknown) => active && (setServerPreview(null), setPreviewError(err instanceof Error ? err.message : "Preview failed.")));
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- manifestKey captures the inputs
  }, [manifestKey, documentId]);

  function manifest(): CustomExportManifest {
    return {
      format,
      include_header: includeHeader,
      file_name: fileName.trim() || null,
      columns: columns.map((column) => ({
        label: column.label.trim(),
        separator: column.separator,
        transform: column.transform ?? "as_is",
        sources: column.sources.map((key) => byKey.get(key)!.source),
      })),
    };
  }

  async function download() {
    if (problems.length) return;
    setBusy(true);
    setError("");
    try {
      await downloadCustomExport(documentId, manifest(), filename);
      onDownloaded(`Custom ${format.toUpperCase()} download started.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  }

  function saveTemplate() {
    const name = templateName.trim();
    if (!name) return;
    const previous = templates.find((item) => item.name === name);
    const version = (previous?.version ?? (previous ? 1 : 0)) + 1;
    const template: Template = {
      name,
      rowTable: activeTable?.dataset_id ?? "",
      format,
      includeHeader,
      version,
      category: workbook.profile.display_name,
      updatedAt: new Date().toISOString(),
      columns: columns.map((column) => ({
        label: column.label.trim(),
        separator: column.separator,
        transform: column.transform ?? "as_is",
        refs: column.sources.map((key) => byKey.get(key)!.ref),
      })),
    };
    const next = [...templates.filter((item) => item.name !== name), template];
    setTemplates(next);
    storeTemplates(profileId, next);
    setEditing(name);
    setNotice(
      previous
        ? `Updated template "${name}" to version ${version}.`
        : `Saved template "${name}" for ${workbook.profile.display_name} documents.`,
    );
  }

  function applyTemplate(name: string) {
    const template = templates.find((item) => item.name === name);
    if (!template) return;
    let missing = 0;
    const next: ColumnState[] = template.columns
      .map((column) => {
        const sources = column.refs
          .map((ref) => options.find((option) => sameRef(option.ref, ref))?.key)
          .filter((key): key is string => {
            if (!key) missing += 1;
            return Boolean(key);
          });
        return { id: newId(), label: column.label, separator: column.separator, transform: column.transform ?? "as_is", sources };
      })
      .filter((column) => column.sources.length > 0);
    setColumns(next);
    setRowTable(template.rowTable);
    setFormat(template.format);
    setIncludeHeader(template.includeHeader);
    // Editing this template: saving again under its name makes a new version.
    setEditing(name);
    setTemplateName(name);
    setNotice(
      missing
        ? `Applied "${name}". ${missing} field${missing === 1 ? " isn't" : "s aren't"} in this document and were left out.`
        : `Applied "${name}".`,
    );
  }

  function deleteTemplate(name: string) {
    const next = templates.filter((item) => item.name !== name);
    setTemplates(next);
    storeTemplates(profileId, next);
  }

  const needle = search.trim().toLowerCase();
  const groups = useMemo(() => {
    const map = new Map<string, FieldOption[]>();
    for (const option of options) {
      if (needle && !`${option.group} ${option.label} ${option.sample}`.toLowerCase().includes(needle)) continue;
      map.set(option.group, [...(map.get(option.group) ?? []), option]);
    }
    return [...map.entries()];
  }, [options, needle]);

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-slate-950/40 p-4" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-export-title"
        className="flex h-[88vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
        data-testid="custom-export-dialog"
      >
        <header className="flex items-start justify-between gap-4 border-b border-border bg-primary-soft/50 px-5 py-4">
          <div>
            <h2 id="custom-export-title" className="text-lg font-semibold text-foreground">Custom export</h2>
            <p className="mt-0.5 text-sm text-text-secondary">
              Choose fields, rename them to your import headers, combine fields into one column, and download a plain
              table ready for importing.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close custom export" className="rounded-md p-1.5 text-text-secondary hover:bg-surface">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[18rem_minmax(0,1fr)]">
          {/* Available fields */}
          <aside className="flex min-h-0 flex-col border-b border-border md:border-b-0 md:border-r" aria-label="Available fields">
            <div className="border-b border-border p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Available fields</p>
              <label className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 text-sm">
                <Search className="h-4 w-4 text-text-muted" aria-hidden="true" />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a field…"
                       className="w-full bg-transparent outline-none" aria-label="Find a field" />
              </label>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {groups.map(([group, items]) => (
                <div key={group} className="mb-3">
                  <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{group}</p>
                  <ul>
                    {items.map((option) => (
                      <li key={option.key}>
                        <button
                          type="button"
                          disabled={!available(option)}
                          onClick={() => addColumn(option)}
                          title={available(option) ? `Add ${option.label} as a column` : "Rows already come from another table"}
                          className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-primary-soft/60 disabled:cursor-not-allowed disabled:opacity-40"
                          aria-label={`Add ${option.label} from ${option.group}`}
                        >
                          <Plus className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-foreground">{option.label}</span>
                            {option.sample && <span className="block truncate text-[11px] text-text-muted">{option.sample}</span>}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {groups.length === 0 && <p className="p-3 text-sm text-text-muted">No fields match.</p>}
            </div>
          </aside>

          {/* Mapping */}
          <section className="flex min-h-0 flex-col" aria-label="Export columns">
            <div className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
              <label className="text-xs font-medium text-text-secondary">
                Rows
                <select value={activeTable?.dataset_id ?? ""} onChange={(event) => chooseRows(event.target.value)}
                        className="mt-1 block rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground">
                  <option value="">One row (document fields)</option>
                  {tables.map((table) => (
                    <option key={table.dataset_id} value={table.dataset_id}>
                      One row per {table.display_name} record ({table.records.length})
                    </option>
                  ))}
                </select>
              </label>
              <div className="text-xs font-medium text-text-secondary">
                Format
                <div className="mt-1 flex overflow-hidden rounded-lg border border-border" role="radiogroup" aria-label="Format">
                  {FORMATS.map((item) => (
                    <button key={item.id} type="button" role="radio" aria-checked={format === item.id} onClick={() => setFormat(item.id)}
                            className={`px-3 py-1.5 text-sm ${format === item.id ? "bg-primary text-white" : "bg-surface text-foreground hover:bg-surface-soft"}`}>
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <label className="text-xs font-medium text-text-secondary">
                File name
                <input value={fileName} onChange={(event) => setFileName(event.target.value)}
                       placeholder={`${filename.replace(/\.[A-Za-z0-9]{2,5}$/, "")}_custom`}
                       className="mt-1 block w-56 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground" />
              </label>
              {format !== "json" && (
                <label className="flex items-center gap-2 pb-2 text-sm text-text-secondary">
                  <input type="checkbox" checked={includeHeader} onChange={(event) => setIncludeHeader(event.target.checked)} />
                  Header row
                </label>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
              {columns.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-text-muted">
                  Add fields from the left. Each becomes a column of the exported file.
                </p>
              ) : (
                <ol className="space-y-2" aria-label="Columns">
                  {columns.map((column, index) => (
                    <li key={column.id} className="rounded-xl border border-border bg-surface p-3 shadow-sm" data-testid="custom-export-column">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="w-6 text-right text-xs tabular-nums text-text-muted">{index + 1}</span>
                        <input
                          value={column.label}
                          onChange={(event) => update(column.id, { label: event.target.value })}
                          aria-label={`Column ${index + 1} label`}
                          className={`min-w-[12rem] flex-1 rounded-lg border px-2.5 py-1.5 text-sm font-medium ${
                            !column.label.trim() || (duplicate && column.label.trim() === duplicate) ? "border-danger" : "border-border"
                          }`}
                        />
                        <button type="button" onClick={() => move(index, -1)} disabled={index === 0} aria-label={`Move ${column.label} up`}
                                className="rounded-md p-1 text-text-secondary hover:bg-surface-soft disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
                        <button type="button" onClick={() => move(index, 1)} disabled={index === columns.length - 1} aria-label={`Move ${column.label} down`}
                                className="rounded-md p-1 text-text-secondary hover:bg-surface-soft disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
                        <button type="button" onClick={() => setColumns((current) => current.filter((item) => item.id !== column.id))}
                                aria-label={`Remove ${column.label}`} className="rounded-md p-1 text-danger hover:bg-danger/10"><Trash2 className="h-4 w-4" /></button>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-8">
                        {column.sources.map((key) => {
                          const option = byKey.get(key);
                          return (
                            <span key={key} className="inline-flex items-center gap-1 rounded-md bg-primary-soft px-2 py-0.5 text-xs text-primary">
                              {option ? `${option.group} › ${option.label}` : key}
                              {column.sources.length > 1 && (
                                <button type="button" aria-label={`Remove ${option?.label ?? key} from ${column.label}`}
                                        onClick={() => update(column.id, { sources: column.sources.filter((item) => item !== key) })}>
                                  <X className="h-3 w-3" />
                                </button>
                              )}
                            </span>
                          );
                        })}
                        <select
                          value=""
                          onChange={(event) => event.target.value && update(column.id, { sources: [...column.sources, event.target.value] })}
                          aria-label={`Combine another field into ${column.label}`}
                          className="rounded-md border border-dashed border-border bg-surface px-2 py-0.5 text-xs text-text-secondary"
                        >
                          <option value="">+ Combine with…</option>
                          {options.filter((option) => available(option) && !column.sources.includes(option.key)).map((option) => (
                            <option key={option.key} value={option.key}>{option.group} › {option.label}</option>
                          ))}
                        </select>
                        <select value={column.transform ?? "as_is"} onChange={(event) => update(column.id, { transform: event.target.value as CustomExportTransform })}
                                aria-label={`Format of ${column.label}`} className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs text-text-secondary">
                          {TRANSFORMS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                        </select>
                        {column.sources.length > 1 && (
                          <label className="flex items-center gap-1 text-xs text-text-secondary">
                            joined by
                            <select value={column.separator} onChange={(event) => update(column.id, { separator: event.target.value })}
                                    aria-label={`Separator for ${column.label}`} className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-xs">
                              {SEPARATORS.map((item) => <option key={item.label} value={item.value}>{item.label}</option>)}
                            </select>
                          </label>
                        )}
                      </div>
                    </li>
                  ))}
                </ol>
              )}

              {columns.length > 0 && (
                <div className="mt-4">
                  <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted" data-testid="custom-export-preview-caption">
                    {serverPreview
                      ? `Preview · first ${serverPreview.rows.length} of ${serverPreview.total_rows.toLocaleString()} row${serverPreview.total_rows === 1 ? "" : "s"} in the file`
                      : `Preview ${activeTable ? `(first ${Math.min(PREVIEW_ROWS, activeTable.records.length)} of ${activeTable.records.length} rows)` : "(1 row)"} · checking with the export…`}
                  </p>
                  {previewError && <p className="mb-1 text-xs text-danger">{previewError}</p>}
                  <div className="overflow-auto rounded-lg border border-border">
                    <table className="min-w-full text-xs" data-testid="custom-export-preview">
                      {includeHeader && (
                        <thead className="bg-surface-soft">
                          <tr>{columns.map((column) => <th key={column.id} className="whitespace-nowrap px-2.5 py-1.5 text-left font-semibold">{column.label}</th>)}</tr>
                        </thead>
                      )}
                      <tbody>
                        {(serverPreview ? serverPreview.rows : preview).map((row, rowIndex) => (
                          <tr key={rowIndex} className="border-t border-border/60">
                            {row.map((value, cellIndex) => <td key={cellIndex} className="max-w-[16rem] truncate px-2.5 py-1.5" title={value}>{value || "—"}</td>)}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>

        <footer className="flex flex-wrap items-center gap-3 border-t border-border bg-surface-soft/60 px-5 py-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select
              value=""
              onChange={(event) => event.target.value && applyTemplate(event.target.value)}
              aria-label="Apply a saved template"
              className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm"
              disabled={templates.length === 0}
            >
              <option value="">{templates.length ? "Apply template…" : "No saved templates"}</option>
              {templates.map((template) => (
                <option key={template.name} value={template.name}>
                  {template.name}{template.version ? ` · v${template.version}` : ""}
                </option>
              ))}
            </select>
            {templates.length > 0 && (
              <select value="" onChange={(event) => event.target.value && deleteTemplate(event.target.value)}
                      aria-label="Delete a saved template" className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-text-secondary">
                <option value="">Delete template…</option>
                {templates.map((template) => <option key={template.name} value={template.name}>{template.name}</option>)}
              </select>
            )}
            <input value={templateName} onChange={(event) => setTemplateName(event.target.value)} placeholder="Template name"
                   aria-label="Template name" className="w-40 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm" />
            <button type="button" onClick={saveTemplate} disabled={!templateName.trim() || columns.length === 0}
                    className="btn-secondary px-3 py-1.5 text-sm disabled:opacity-50">
              <Save className="h-4 w-4" aria-hidden="true" />
              {editing && templateName.trim() === editing ? "Update template" : "Save template"}
            </button>
          </div>
          <div className="ml-auto flex items-center gap-3">
            {(problems[0] || error) && <p className="max-w-xs text-xs text-danger" role="alert">{problems[0] || error}</p>}
            {!problems[0] && !error && notice && <p className="max-w-xs text-xs text-text-secondary" role="status">{notice}</p>}
            <button type="button" onClick={onClose} className="btn-secondary px-4 py-2 text-sm">Cancel</button>
            <button type="button" onClick={() => void download()} disabled={busy || problems.length > 0}
                    className="btn-primary px-4 py-2 text-sm disabled:opacity-50" data-testid="custom-export-download">
              <Download className="h-4 w-4" aria-hidden="true" />
              {busy ? "Preparing…" : `Download ${FORMATS.find((item) => item.id === format)?.label}`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
