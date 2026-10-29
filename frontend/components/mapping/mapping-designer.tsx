"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Download,
  FileArchive,
  KeyRound,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Save,
  Search,
  Shuffle,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import SourceVerificationPanel, { type SourceViewRequest } from "@/components/source-verification-panel";
import { getDocument } from "@/lib/documents";
import {
  documentFields,
  exportBundle,
  exportCsv,
  getTemplate,
  listAllProfiles,
  listProfiles,
  previewMapping,
  saveProfile,
  sourceKey,
  suggestMapping,
  type ColumnMapping,
  type Issue,
  type MappingProfile,
  type MappingSpec,
  type OracleTemplate,
  type Preview,
  type SourceField,
  type SourceRef,
  type Transform,
} from "@/lib/oracle-templates";

type LabelMode = "document" | "dataomatix" | "oracle_label" | "oracle_technical";
const LABEL_MODES: { id: LabelMode; label: string }[] = [
  { id: "document", label: "Document labels" },
  { id: "dataomatix", label: "Dataomatix labels" },
  { id: "oracle_label", label: "Oracle display labels" },
  { id: "oracle_technical", label: "Oracle technical names" },
];
const TRANSFORMS: { id: Transform; label: string }[] = [
  { id: "as_is", label: "As extracted" },
  { id: "trim", label: "Trim spaces" },
  { id: "upper", label: "UPPER CASE" },
  { id: "date_iso", label: "Date → YYYY-MM-DD" },
  { id: "number", label: "Number (strip currency)" },
];

interface Row {
  mapping: ColumnMapping;
  /** Proposed by the suggester and not yet saved by a person. */
  suggested: boolean;
}

function emptyMapping(column: string): ColumnMapping {
  return { column, source: { kind: "none" }, transform: "as_is", method: null, confidence: null };
}

function confidenceTone(value: number | null | undefined): string {
  if (value == null) return "bg-surface-soft text-text-muted";
  if (value >= 0.85) return "bg-success/10 text-success";
  if (value >= 0.7) return "bg-primary-soft text-primary";
  return "bg-warning/10 text-warning";
}

export default function MappingDesigner() {
  const params = useSearchParams();
  const templateId = Number(params.get("template"));
  const documentId = params.get("document") ?? "";

  const [template, setTemplate] = useState<OracleTemplate | null>(null);
  const [fields, setFields] = useState<SourceField[]>([]);
  const [stagingProfileId, setStagingProfileId] = useState<string | null>(null);
  const [documentName, setDocumentName] = useState("");
  const [pageCount, setPageCount] = useState(1);
  const [profiles, setProfiles] = useState<MappingProfile[]>([]);
  const [otherProfiles, setOtherProfiles] = useState<MappingProfile[]>([]);
  const [profileId, setProfileId] = useState<number | null>(null);
  const [profileName, setProfileName] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [rowDataset, setRowDataset] = useState<string | null>(null);
  const [keyColumns, setKeyColumns] = useState<string[]>([]);
  const [parent, setParent] = useState<MappingSpec["parent"]>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [labelMode, setLabelMode] = useState<LabelMode>("document");
  const [showDocument, setShowDocument] = useState(true);
  const [request, setRequest] = useState<SourceViewRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const spec: MappingSpec = useMemo(
    () => ({
      row_dataset: rowDataset,
      mappings: rows.filter((row) => row.mapping.source.kind !== "none").map((row) => row.mapping),
      key_columns: keyColumns,
      parent,
    }),
    [rows, rowDataset, keyColumns, parent],
  );

  // ------------------------------------------------------------ loading

  const applySuggestions = useCallback(
    async (columns: OracleTemplate["columns"], forcedRowDataset?: string | null) => {
      const result = await suggestMapping(documentId, templateId, { row_dataset: forcedRowDataset ?? null });
      const byColumn = new Map(result.suggestions.map((s) => [s.column, s]));
      setRowDataset(result.row_dataset);
      setRows(
        columns.map((column) => {
          const suggestion = byColumn.get(column.technical_name);
          return suggestion
            ? {
                mapping: {
                  column: column.technical_name,
                  source: suggestion.source,
                  transform: "as_is",
                  method: suggestion.method,
                  confidence: suggestion.confidence,
                },
                suggested: true,
              }
            : { mapping: emptyMapping(column.technical_name), suggested: false };
        }),
      );
      setDirty(true);
    },
    [documentId, templateId],
  );

  const loadProfile = useCallback((profile: MappingProfile, columns: OracleTemplate["columns"]) => {
    const byColumn = new Map(profile.spec.mappings.map((m) => [m.column, m]));
    setProfileId(profile.id);
    setProfileName(profile.name);
    setRowDataset(profile.spec.row_dataset);
    setKeyColumns(profile.spec.key_columns);
    setParent(profile.spec.parent ?? null);
    setRows(
      columns.map((column) => ({
        mapping: { ...emptyMapping(column.technical_name), ...(byColumn.get(column.technical_name) ?? {}) },
        suggested: false,
      })),
    );
    setDirty(false);
  }, []);

  useEffect(() => {
    if (!templateId || !documentId) return;
    let active = true;
    (async () => {
      try {
        const [loadedTemplate, catalogue, document, saved] = await Promise.all([
          getTemplate(templateId),
          documentFields(documentId),
          getDocument(documentId),
          listProfiles(templateId),
        ]);
        if (!active) return;
        setTemplate(loadedTemplate);
        setFields(catalogue.fields);
        setStagingProfileId(catalogue.staging_profile_id);
        setDocumentName(document.original_filename);
        setPageCount(document.page_count || 1);
        setProfiles(saved);
        listAllProfiles(catalogue.staging_profile_id)
          .then((all) => active && setOtherProfiles(all.filter((p) => p.template_id !== templateId)))
          .catch(() => undefined);
        const match =
          saved.find((p) => p.staging_profile_id && p.staging_profile_id === catalogue.staging_profile_id) ?? saved[0];
        if (match) {
          loadProfile(match, loadedTemplate.columns);
        } else {
          setProfileName(`${loadedTemplate.object_name} — ${catalogue.staging_profile_id ?? "document"}`);
          await applySuggestions(loadedTemplate.columns);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Unable to open the mapping.");
      }
    })();
    return () => {
      active = false;
    };
  }, [templateId, documentId, loadProfile, applySuggestions]);

  // Preview (rows + validation) follows every change, debounced.
  const previewSeq = useRef(0);
  useEffect(() => {
    if (!template || rows.length === 0) return;
    const seq = ++previewSeq.current;
    const timer = setTimeout(() => {
      setPreviewing(true);
      previewMapping(documentId, template.id, spec)
        .then((result) => seq === previewSeq.current && setPreview(result))
        .catch((err) => seq === previewSeq.current && setError(err instanceof Error ? err.message : "Preview failed."))
        .finally(() => seq === previewSeq.current && setPreviewing(false));
    }, 450);
    return () => clearTimeout(timer);
  }, [documentId, template, spec, rows.length]);

  // ------------------------------------------------------------ derived

  const fieldByKey = useMemo(() => new Map(fields.map((f) => [sourceKey(f.ref), f])), [fields]);
  const columnByName = useMemo(() => new Map((template?.columns ?? []).map((c) => [c.technical_name, c])), [template]);
  const mappedBy = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const row of rows) {
      if (row.mapping.source.kind !== "field") continue;
      const key = sourceKey(row.mapping.source);
      map.set(key, [...(map.get(key) ?? []), row.mapping.column]);
    }
    return map;
  }, [rows]);
  const issuesByColumn = useMemo(() => {
    const map = new Map<string, Issue[]>();
    for (const issue of preview?.issues ?? []) {
      if (!issue.column) continue;
      for (const column of issue.column.split(", ")) map.set(column, [...(map.get(column) ?? []), issue]);
    }
    return map;
  }, [preview]);
  const rowTables = useMemo(() => {
    const tables = new Map<string, string>();
    for (const field of fields) {
      if (field.ref.shape === "column" && field.ref.dataset_id) tables.set(field.ref.dataset_id, field.group.replace(/ \(table\)$/, ""));
    }
    return [...tables.entries()];
  }, [fields]);

  // ------------------------------------------------------------ actions

  function updateRow(column: string, patch: Partial<ColumnMapping>) {
    setRows((current) =>
      current.map((row) =>
        row.mapping.column === column
          ? { mapping: { ...row.mapping, ...patch }, suggested: false }
          : row,
      ),
    );
    setDirty(true);
  }

  function chooseSource(column: string, source: SourceRef) {
    if (source.kind === "field" && source.shape === "column" && source.dataset_id !== rowDataset) {
      setRowDataset(source.dataset_id ?? null);
    }
    updateRow(column, { source, method: "manual", confidence: null });
  }

  function showSource(field: SourceField | undefined, label: string, value?: string) {
    if (!field?.page) return;
    setShowDocument(true);
    setRequest({
      id: sourceKey(field.ref),
      pageNumber: field.page,
      highlightText: field.highlight ?? value ?? field.sample,
      anchorText: field.anchor,
      label,
      value: value ?? field.sample,
      reviewStatus: field.review_status,
    });
  }

  async function save() {
    if (!template) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await saveProfile(template.id, profileId, {
        name: profileName.trim() || `${template.object_name} mapping`,
        staging_profile_id: stagingProfileId,
        spec,
      });
      setProfileId(saved.id);
      setProfiles((current) => [saved, ...current.filter((p) => p.id !== saved.id)]);
      setRows((current) => current.map((row) => ({ ...row, suggested: false })));
      setDirty(false);
      setNotice(`Mapping saved (version ${saved.version}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  async function runExport(force = false) {
    if (!template) return;
    setError(null);
    try {
      const { importReady } = await exportCsv(documentId, template.id, spec, force);
      setNotice(importReady ? "Import file generated." : "File generated with validation errors — not import-ready.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Export failed.";
      if (!force && /not import-ready|errors/i.test(message) && window.confirm(`${message}\n\nDownload it anyway?`)) {
        await runExport(true);
        return;
      }
      setError(message);
    }
  }

  async function chooseParent(value: string) {
    if (!value) {
      setParent(null);
      setDirty(true);
      return;
    }
    const parentId = Number(value);
    try {
      const result = await suggestMapping(documentId, templateId, { row_dataset: rowDataset, parent_profile_id: parentId });
      setParent({ profile_id: parentId, links: result.parent_links });
      setDirty(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to link the parent mapping.");
    }
  }

  // ------------------------------------------------------------ render

  if (!templateId || !documentId) {
    return (
      <div className="p-6 text-sm text-text-secondary">
        Open the designer from <Link href="/mapping" className="text-primary hover:underline">Mapping Studio</Link> with a template and a document.
      </div>
    );
  }

  const counts = preview?.issue_counts;
  const mappedCount = rows.filter((row) => row.mapping.source.kind !== "none").length;

  return (
    <div className="workspace-page flex w-full flex-col" data-testid="mapping-designer">
      <header className="border-b border-border bg-surface px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary-soft text-primary">
            <Shuffle className="h-4.5 w-4.5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold text-foreground">
              {template ? `${template.object_name} v${template.version}` : "Mapping Designer"}
              <span className="font-normal text-text-secondary"> ← {documentName || "document"}</span>
            </h1>
            <p className="text-xs text-text-secondary">
              {mappedCount} of {template?.columns.length ?? 0} columns mapped
              {preview ? ` · ${preview.total_rows} row${preview.total_rows === 1 ? "" : "s"}` : ""}
              {dirty ? " · unsaved changes" : profileId ? " · saved" : ""}
            </p>
          </div>
          <ReadyBadge preview={preview} busy={previewing} />
          <input
            value={profileName}
            onChange={(event) => {
              setProfileName(event.target.value);
              setDirty(true);
            }}
            aria-label="Mapping name"
            className="h-9 w-56 rounded-lg border border-border bg-background px-2.5 text-sm outline-none focus:border-primary/40"
          />
          <button type="button" onClick={() => void save()} disabled={saving || !template} className="btn-primary h-9 px-3 text-sm disabled:opacity-50">
            <Save className="h-4 w-4" aria-hidden="true" />
            {saving ? "Saving…" : "Save mapping"}
          </button>
          <button type="button" onClick={() => void runExport()} disabled={!template} className="btn-secondary h-9 px-3 text-sm">
            <Download className="h-4 w-4" aria-hidden="true" />
            {profileId && !dirty ? "Regenerate export" : "Export CSV"}
          </button>
          <BundleMenu documentId={documentId} profiles={[...profiles, ...otherProfiles]} onError={setError} onDone={setNotice} />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1.5 text-text-secondary">
            One row per
            <select
              value={rowDataset ?? ""}
              onChange={(event) => {
                setRowDataset(event.target.value || null);
                setDirty(true);
              }}
              className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground"
              aria-label="Row table"
            >
              <option value="">document (one row)</option>
              {rowTables.map(([id, name]) => (
                <option key={id} value={id}>{name} record</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-text-secondary">
            Parent file
            <select
              value={parent?.profile_id ?? ""}
              onChange={(event) => void chooseParent(event.target.value)}
              className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground"
              aria-label="Parent mapping"
            >
              <option value="">None</option>
              {otherProfiles.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          {parent?.links.map(([child, parentColumn]) => (
            <span key={child} className="rounded-full bg-surface-soft px-2 py-0.5 font-mono text-[11px] text-text-secondary">
              {child} → {parentColumn}
            </span>
          ))}
          <button
            type="button"
            onClick={() => template && void applySuggestions(template.columns, rowDataset)}
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 font-medium text-foreground hover:bg-surface-soft"
            title="Propose sources for every column again (replaces unsaved choices)"
          >
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            Suggest mappings
          </button>
          <div className="flex rounded-lg border border-border bg-surface p-0.5" role="radiogroup" aria-label="Field labels">
            {LABEL_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                role="radio"
                aria-checked={labelMode === mode.id}
                onClick={() => setLabelMode(mode.id)}
                className={`h-7 rounded-md px-2 text-[11px] font-medium ${labelMode === mode.id ? "bg-primary/10 text-foreground" : "text-text-secondary hover:text-foreground"}`}
              >
                {mode.label}
              </button>
            ))}
          </div>
        </div>
        {(error || notice) && (
          <p className={`mt-2 text-xs ${error ? "text-danger" : "text-success"}`} role={error ? "alert" : "status"}>
            {error ?? notice}
          </p>
        )}
      </header>

      <div
        className={`grid min-h-0 flex-1 gap-0 ${showDocument ? "xl:grid-cols-[minmax(320px,0.9fr)_minmax(280px,0.8fr)_minmax(460px,1.3fr)]" : "xl:grid-cols-[minmax(280px,0.7fr)_minmax(460px,1.3fr)]"}`}
      >
        {showDocument && (
          <section className="relative min-h-[420px] border-b border-border xl:border-b-0 xl:border-r" aria-label="Document">
            <button
              type="button"
              onClick={() => setShowDocument(false)}
              className="absolute right-2 top-2 z-10 rounded-md bg-surface/90 p-1 text-text-secondary shadow-sm hover:text-foreground"
              aria-label="Hide document"
            >
              <PanelLeftClose className="h-4 w-4" />
            </button>
            {request ? (
              <SourceVerificationPanel documentId={documentId} documentName={documentName} pageCount={pageCount} request={request} />
            ) : (
              <div className="flex h-full min-h-[420px] items-center justify-center px-6 text-center text-sm text-text-muted">
                Select a field or a mapped column to see where its value is on the page.
              </div>
            )}
          </section>
        )}

        <FieldsPanel
          fields={fields}
          labelMode={labelMode}
          mappedBy={mappedBy}
          columnByName={columnByName}
          selectedKey={request?.id ?? null}
          showDocumentToggle={!showDocument}
          onShowDocument={() => setShowDocument(true)}
          onSelect={(field) => showSource(field, field.label)}
        />

        <section className="min-w-0 border-t border-border xl:border-l xl:border-t-0" aria-label="Oracle mapping">
          <div className="max-h-[62vh] overflow-auto">
            <table className="w-full text-[13px]" data-testid="mapping-table">
              <thead className="sticky top-0 z-10 bg-surface-soft text-left text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-3 py-2">Oracle column</th>
                  <th className="px-3 py-2">Dataomatix source</th>
                  <th className="px-3 py-2">Value</th>
                  <th className="px-2 py-2">Match</th>
                  <th className="px-2 py-2">Check</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const column = columnByName.get(row.mapping.column);
                  const field = row.mapping.source.kind === "field" ? fieldByKey.get(sourceKey(row.mapping.source)) : undefined;
                  const position = template?.columns.findIndex((c) => c.technical_name === row.mapping.column) ?? -1;
                  const cell = preview?.rows[0]?.[position];
                  const columnIssues = issuesByColumn.get(row.mapping.column) ?? [];
                  const isKey = keyColumns.includes(row.mapping.column);
                  return (
                    <tr key={row.mapping.column} className="border-t border-border/70 align-top" data-testid="mapping-row">
                      <td className="px-3 py-2">
                        <p className="font-medium text-foreground">
                          {column?.display_label ?? row.mapping.column}
                          {column?.required && <span className="ml-1 text-danger" title="Required by the template">*</span>}
                        </p>
                        <p className="font-mono text-[11px] text-text-secondary">{row.mapping.column}</p>
                        <button
                          type="button"
                          onClick={() => {
                            setKeyColumns((current) =>
                              isKey ? current.filter((c) => c !== row.mapping.column) : [...current, row.mapping.column],
                            );
                            setDirty(true);
                          }}
                          className={`mt-1 inline-flex items-center gap-1 rounded px-1 text-[10px] font-medium ${isKey ? "bg-primary/10 text-primary" : "text-text-muted hover:text-foreground"}`}
                          aria-pressed={isKey}
                          title="Key columns identify a row: checked for blanks and duplicates"
                        >
                          <KeyRound className="h-3 w-3" aria-hidden="true" />
                          {isKey ? "Key" : "Set as key"}
                        </button>
                      </td>
                      <td className="min-w-[220px] px-3 py-2">
                        <SourcePicker
                          value={row.mapping.source}
                          fields={fields}
                          rowDataset={rowDataset}
                          labelMode={labelMode}
                          onChange={(source) => chooseSource(row.mapping.column, source)}
                        />
                        {row.mapping.source.kind !== "none" && (
                          <select
                            value={row.mapping.transform ?? "as_is"}
                            onChange={(event) => updateRow(row.mapping.column, { transform: event.target.value as Transform })}
                            className="mt-1 h-7 w-full rounded-md border border-border bg-background px-1.5 text-[11px] text-text-secondary"
                            aria-label={`Format for ${row.mapping.column}`}
                          >
                            {TRANSFORMS.map((t) => (
                              <option key={t.id} value={t.id}>{t.label}</option>
                            ))}
                          </select>
                        )}
                      </td>
                      <td className="max-w-[200px] px-3 py-2">
                        <button
                          type="button"
                          disabled={!field?.page}
                          onClick={() => showSource(field, column?.display_label ?? row.mapping.column, cell?.value)}
                          className="block max-w-full truncate text-left text-foreground enabled:hover:text-primary disabled:cursor-default"
                          title={cell?.value || undefined}
                        >
                          {cell?.value ? cell.value : <span className="text-text-muted/60">—</span>}
                        </button>
                        {preview && preview.total_rows > 1 && row.mapping.source.shape === "column" && (
                          <span className="text-[10px] text-text-muted">row 1 of {preview.total_rows}</span>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {row.mapping.source.kind === "none" ? null : (
                          <span
                            className={`inline-block whitespace-nowrap rounded-full px-1.5 py-0.5 text-[10px] font-medium ${confidenceTone(row.mapping.confidence)}`}
                            title={row.suggested ? "Suggested — review before saving" : undefined}
                          >
                            {row.mapping.method === "manual" || !row.mapping.method
                              ? "Manual"
                              : `${row.mapping.method}${row.mapping.confidence != null ? ` ${Math.round(row.mapping.confidence * 100)}%` : ""}`}
                          </span>
                        )}
                        {row.suggested && <span className="mt-0.5 block text-[10px] text-warning">Review</span>}
                      </td>
                      <td className="px-2 py-2">
                        <ColumnCheck issues={columnIssues} mapped={row.mapping.source.kind !== "none"} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {preview && <PreviewPanel preview={preview} counts={counts} />}
    </div>
  );
}

// ------------------------------------------------------------ pieces

function ReadyBadge({ preview, busy }: { preview: Preview | null; busy: boolean }) {
  if (busy && !preview) return <span className="text-xs text-text-muted">Checking…</span>;
  if (!preview) return null;
  return preview.import_ready ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success" data-testid="import-ready">
      <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
      Import-ready
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger" data-testid="import-ready">
      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
      {preview.issue_counts.error} error{preview.issue_counts.error === 1 ? "" : "s"}
    </span>
  );
}

function ColumnCheck({ issues, mapped }: { issues: Issue[]; mapped: boolean }) {
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  if (errors.length) {
    return (
      <span className="inline-block rounded-full bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger" title={errors.slice(0, 5).map((i) => i.message).join("\n")}>
        {errors.length} error{errors.length === 1 ? "" : "s"}
      </span>
    );
  }
  if (warnings.length) {
    return (
      <span className="inline-block rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-warning" title={warnings.slice(0, 5).map((i) => i.message).join("\n")}>
        Review
      </span>
    );
  }
  return mapped ? <span className="text-[10px] font-medium text-success">OK</span> : <span className="text-[10px] text-text-muted">Empty</span>;
}

function fieldLabel(field: SourceField, mode: LabelMode, mappedColumns: string[], columnByName: Map<string, OracleTemplate["columns"][number]>): string {
  if (mode === "document") return field.document_label ?? field.label;
  if (mode === "dataomatix") return field.label;
  const column = mappedColumns[0] ? columnByName.get(mappedColumns[0]) : undefined;
  if (!column) return field.label;
  return mode === "oracle_label" ? column.display_label ?? column.technical_name : column.technical_name;
}

function FieldsPanel({
  fields,
  labelMode,
  mappedBy,
  columnByName,
  selectedKey,
  showDocumentToggle,
  onShowDocument,
  onSelect,
}: {
  fields: SourceField[];
  labelMode: LabelMode;
  mappedBy: Map<string, string[]>;
  columnByName: Map<string, OracleTemplate["columns"][number]>;
  selectedKey: string | null;
  showDocumentToggle: boolean;
  onShowDocument: () => void;
  onSelect: (field: SourceField) => void;
}) {
  const [query, setQuery] = useState("");
  const [onlyMapped, setOnlyMapped] = useState(false);
  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const map = new Map<string, SourceField[]>();
    for (const field of fields) {
      const mapped = mappedBy.has(sourceKey(field.ref));
      if (onlyMapped && !mapped) continue;
      if (!field.sample && !mapped) continue;
      if (needle && !`${field.label} ${field.document_label ?? ""} ${field.sample}`.toLowerCase().includes(needle)) continue;
      map.set(field.group, [...(map.get(field.group) ?? []), field]);
    }
    return [...map.entries()];
  }, [fields, query, onlyMapped, mappedBy]);
  const oracleMode = labelMode === "oracle_label" || labelMode === "oracle_technical";

  return (
    <section className="flex min-h-[420px] min-w-0 flex-col" aria-label="Extracted fields">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        {showDocumentToggle && (
          <button type="button" onClick={onShowDocument} aria-label="Show document" className="rounded-md p-1 text-text-secondary hover:bg-surface-soft">
            <PanelLeftOpen className="h-4 w-4" />
          </button>
        )}
        <label className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search extracted fields…"
            aria-label="Search extracted fields"
            className="h-8 w-full rounded-lg border border-border bg-background pl-7 pr-2 text-xs outline-none focus:border-primary/40"
          />
        </label>
        <label className="flex items-center gap-1 text-[11px] text-text-secondary">
          <input type="checkbox" checked={onlyMapped} onChange={(event) => setOnlyMapped(event.target.checked)} />
          Mapped
        </label>
      </div>
      <div className="max-h-[62vh] flex-1 overflow-y-auto px-3 py-2" data-testid="fields-panel">
        {groups.length === 0 && <p className="py-8 text-center text-xs text-text-muted">No fields match.</p>}
        {groups.map(([group, items]) => (
          <details key={group} open className="mb-2 rounded-lg border border-border bg-surface">
            <summary className="flex cursor-pointer items-center justify-between px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              {group}
              <span className="font-normal tabular-nums text-text-muted">{items.length}</span>
            </summary>
            <ul className="divide-y divide-border/60">
              {items.map((field) => {
                const key = sourceKey(field.ref);
                const columns = mappedBy.get(key) ?? [];
                return (
                  <li key={key}>
                    <button
                      type="button"
                      onClick={() => onSelect(field)}
                      className={`w-full px-2.5 py-1.5 text-left hover:bg-surface-soft ${selectedKey === key ? "bg-primary/[0.07]" : ""}`}
                    >
                      <span className="flex items-baseline justify-between gap-2">
                        <span className={`truncate text-[12px] ${oracleMode && !columns.length ? "italic text-text-muted" : "font-medium text-foreground"} ${labelMode === "oracle_technical" && columns.length ? "font-mono" : ""}`}>
                          {fieldLabel(field, labelMode, columns, columnByName)}
                        </span>
                        {columns.length > 0 && (
                          <span className="shrink-0 rounded bg-primary/10 px-1 font-mono text-[10px] text-primary" title={columns.join(", ")}>
                            {columns[0]}{columns.length > 1 ? ` +${columns.length - 1}` : ""}
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-[12px] text-text-secondary">{field.sample || "—"}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </details>
        ))}
      </div>
    </section>
  );
}

function SourcePicker({
  value,
  fields,
  rowDataset,
  labelMode,
  onChange,
}: {
  value: SourceRef;
  fields: SourceField[];
  rowDataset: string | null;
  labelMode: LabelMode;
  onChange: (source: SourceRef) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [constant, setConstant] = useState(value.kind === "constant" ? value.constant ?? "" : "");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const current = value.kind === "field" ? fields.find((f) => sourceKey(f.ref) === sourceKey(value)) : undefined;
  const label =
    value.kind === "constant"
      ? `Constant: ${value.constant ?? ""}`
      : value.kind === "field"
        ? current
          ? labelMode === "document" ? current.document_label ?? current.label : current.label
          : "Field not in this document"
        : "Not mapped";
  const needle = query.trim().toLowerCase();
  const options = fields.filter(
    (f) =>
      (f.ref.shape !== "column" || !rowDataset || f.ref.dataset_id === rowDataset) &&
      (!needle || `${f.label} ${f.document_label ?? ""} ${f.group} ${f.sample}`.toLowerCase().includes(needle)),
  );

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex h-8 w-full items-center justify-between gap-1 rounded-md border px-2 text-left text-[12px] ${value.kind === "none" ? "border-dashed border-border text-text-muted" : "border-border bg-background text-foreground"}`}
      >
        <span className="truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute left-0 z-30 mt-1 w-[22rem] max-w-[80vw] rounded-lg border border-border bg-surface shadow-lg">
          <div className="border-b border-border p-2">
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search fields…"
              aria-label="Search source fields"
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary/40"
            />
          </div>
          <ul className="max-h-72 overflow-y-auto py-1 text-[12px]" role="listbox">
            <li>
              <button type="button" onClick={() => { onChange({ kind: "none" }); setOpen(false); }} className="w-full px-3 py-1.5 text-left text-text-muted hover:bg-surface-soft">
                — Not mapped
              </button>
            </li>
            {options.slice(0, 200).map((f) => (
              <li key={sourceKey(f.ref)}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(f.ref);
                    setOpen(false);
                  }}
                  className="w-full px-3 py-1.5 text-left hover:bg-surface-soft"
                >
                  <span className="flex justify-between gap-2">
                    <span className="truncate font-medium text-foreground">{f.label}</span>
                    <span className="shrink-0 text-[10px] text-text-muted">{f.group}</span>
                  </span>
                  <span className="block truncate text-text-secondary">{f.sample || "—"}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex gap-1.5 border-t border-border p-2">
            <input
              value={constant}
              onChange={(event) => setConstant(event.target.value)}
              placeholder="Constant value (e.g. ADD)"
              aria-label="Constant value"
              className="h-8 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus:border-primary/40"
            />
            <button
              type="button"
              disabled={!constant.trim()}
              onClick={() => {
                onChange({ kind: "constant", constant: constant.trim() });
                setOpen(false);
              }}
              className="btn-secondary px-2 py-1 text-xs disabled:opacity-50"
            >
              Use
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PreviewPanel({ preview, counts }: { preview: Preview; counts: Preview["issue_counts"] | undefined }) {
  const [tab, setTab] = useState<"file" | "issues" | "unmapped">("file");
  const [header, setHeader] = useState<"technical" | "label">("technical");
  const issues = preview.issues.filter((i) => i.code !== "unmapped");
  return (
    <section className="border-t border-border bg-surface" aria-label="Export preview" data-testid="export-preview">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-4 py-2">
        {(
          [
            ["file", `Export preview (${preview.total_rows} row${preview.total_rows === 1 ? "" : "s"})`],
            ["issues", `Validation (${counts?.error ?? 0} errors, ${counts?.warning ?? 0} warnings)`],
            ["unmapped", `Unmapped extracted data (${preview.unmapped_fields.length})`],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`h-8 rounded-md px-2.5 text-xs font-medium ${tab === id ? "bg-primary/10 text-foreground" : "text-text-secondary hover:text-foreground"}`}
          >
            {label}
          </button>
        ))}
        {tab === "file" && (
          <label className="ml-auto flex items-center gap-1.5 text-[11px] text-text-secondary">
            Header shows
            <select value={header} onChange={(event) => setHeader(event.target.value as "technical" | "label")} className="h-7 rounded-md border border-border bg-background px-1.5 text-[11px]">
              <option value="technical">technical names (as written to the file)</option>
              <option value="label">Oracle display labels (preview only)</option>
            </select>
          </label>
        )}
      </div>
      <div className="max-h-[36vh] overflow-auto">
        {tab === "file" && (
          <table className="min-w-full text-[12px]">
            <thead className="sticky top-0 bg-surface-soft">
              <tr>
                {preview.headers.map((name, index) => (
                  <th key={name} className="whitespace-nowrap px-2.5 py-1.5 text-left font-mono text-[11px] font-semibold text-text-secondary">
                    {header === "label" ? preview.display_labels[index] ?? name : name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, r) => (
                <tr key={r} className="border-t border-border/60">
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      className={`max-w-[16rem] truncate whitespace-nowrap px-2.5 py-1 ${cell.problem ? "bg-danger/5 text-danger" : "text-foreground"}`}
                      title={cell.problem ?? cell.value}
                    >
                      {cell.value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === "issues" && (
          <ul className="divide-y divide-border/60 text-xs">
            {issues.length === 0 && <li className="px-4 py-4 text-text-muted">No issues.</li>}
            {issues.map((issue, index) => (
              <li key={index} className="flex gap-2 px-4 py-1.5">
                <span
                  className={`w-16 shrink-0 font-medium ${issue.severity === "error" ? "text-danger" : issue.severity === "warning" ? "text-warning" : "text-text-muted"}`}
                >
                  {issue.severity}
                </span>
                <span className="w-40 shrink-0 truncate font-mono text-[11px] text-text-secondary">{issue.column ?? ""}{issue.row ? ` · row ${issue.row}` : ""}</span>
                <span className="text-foreground">{issue.message}</span>
              </li>
            ))}
          </ul>
        )}
        {tab === "unmapped" && (
          <div>
            <p className="px-4 py-2 text-xs text-text-secondary">
              Extracted data not used by this file. It stays in the document&apos;s staging workbook and its other exports.
            </p>
            <ul className="grid gap-x-4 px-4 pb-3 text-xs sm:grid-cols-2 xl:grid-cols-3">
              {preview.unmapped_fields.filter((f) => f.sample).slice(0, 300).map((f) => (
                <li key={sourceKey(f.ref)} className="flex justify-between gap-2 border-b border-border/50 py-1">
                  <span className="truncate text-text-secondary">{f.label}</span>
                  <span className="truncate text-foreground">{f.sample}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

function BundleMenu({
  documentId,
  profiles,
  onError,
  onDone,
}: {
  documentId: string;
  profiles: MappingProfile[];
  onError: (message: string) => void;
  onDone: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<number[]>([]);
  const unique = useMemo(() => [...new Map(profiles.map((p) => [p.id, p])).values()], [profiles]);
  if (unique.length < 2) return null;
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className="btn-secondary h-9 px-3 text-sm" aria-expanded={open}>
        <FileArchive className="h-4 w-4" aria-hidden="true" />
        Bundle
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-72 rounded-lg border border-border bg-surface p-2 shadow-lg">
          <p className="px-1 pb-1 text-[11px] text-text-secondary">Saved mappings to export together as one ZIP:</p>
          {unique.map((p) => (
            <label key={p.id} className="flex items-center gap-2 rounded px-1 py-1 text-xs hover:bg-surface-soft">
              <input
                type="checkbox"
                checked={chosen.includes(p.id)}
                onChange={() => setChosen((c) => (c.includes(p.id) ? c.filter((id) => id !== p.id) : [...c, p.id]))}
              />
              <span className="truncate">{p.name}</span>
              <span className="ml-auto text-[10px] text-text-muted">v{p.version}</span>
            </label>
          ))}
          <button
            type="button"
            disabled={chosen.length === 0}
            onClick={async () => {
              try {
                const { importReady } = await exportBundle(documentId, chosen, false).catch(async (err) => {
                  if (window.confirm(`${err instanceof Error ? err.message : "Validation errors"}\n\nDownload anyway?`)) {
                    return exportBundle(documentId, chosen, true);
                  }
                  throw err;
                });
                onDone(importReady ? "Import bundle generated." : "Bundle generated with validation errors — not import-ready.");
                setOpen(false);
              } catch (err) {
                onError(err instanceof Error ? err.message : "Bundle export failed.");
              }
            }}
            className="btn-primary mt-2 w-full justify-center py-1.5 text-xs disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            Generate ZIP
          </button>
        </div>
      )}
    </div>
  );
}
