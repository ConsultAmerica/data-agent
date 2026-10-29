"use client";

import { AlertTriangle, Download, FileSpreadsheet, Search, Shuffle, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import ConsoleHeader from "@/components/layout/ConsoleHeader";
import { ErrorState, LoadingState } from "@/components/layout/StatusState";
import { searchDocuments } from "@/lib/documents";
import {
  downloadOriginalTemplate,
  listTemplates,
  retireTemplate,
  uploadTemplate,
  type OracleTemplate,
} from "@/lib/oracle-templates";
import type { DocumentSummary } from "@/types/document";

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Mapping Studio → Oracle Fusion → Template Manager. */
export default function MappingStudioPage() {
  const router = useRouter();
  const [templates, setTemplates] = useState<OracleTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [pickingFor, setPickingFor] = useState<OracleTemplate | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    listTemplates()
      .then((rows) => {
        setError(null);
        setTemplates(rows);
        setSelectedId((current) => current ?? rows[0]?.id ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load templates."));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const selected = templates?.find((template) => template.id === selectedId) ?? null;

  return (
    <div className="workspace-page w-full" data-testid="mapping-studio">
      <ConsoleHeader
        icon={Shuffle}
        title="Mapping Studio"
        description="Oracle Fusion → Template Manager. Upload templates downloaded from Oracle Import Management; Dataomatix reads their technical attributes, display labels and column order, and builds import files in exactly that shape."
      />
      <div className="space-y-5 px-4 py-5 sm:px-6">
        <UploadCard
          onUploaded={(template, reused) => {
            setNotice(
              reused
                ? `${template.filename} is already stored as ${template.object_name} v${template.version}.`
                : `${template.object_name} v${template.version}: ${template.columns.length} columns detected.`,
            );
            setSelectedId(template.id);
            load();
          }}
        />
        {notice && (
          <div className="flex items-center justify-between rounded-lg border border-border bg-surface-soft px-3 py-2 text-sm text-text-secondary" role="status">
            {notice}
            <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="text-text-muted hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {error ? (
          <ErrorState error={error} onRetry={load} />
        ) : templates === null ? (
          <LoadingState title="Loading templates…" compact />
        ) : templates.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-surface px-6 py-12 text-center">
            <FileSpreadsheet className="mx-auto h-8 w-8 text-text-muted" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium text-foreground">No templates yet</p>
            <p className="mt-1 text-xs text-text-muted">Upload a Contract, Contract Line, Contract Party or other import template to start mapping.</p>
          </div>
        ) : (
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <TemplateList
              templates={templates}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onMap={setPickingFor}
            />
            {selected && (
              <TemplateDetail
                template={selected}
                onMap={() => setPickingFor(selected)}
                onRetired={() => {
                  setSelectedId(null);
                  load();
                }}
              />
            )}
          </div>
        )}
      </div>
      {pickingFor && (
        <DocumentPicker
          template={pickingFor}
          onClose={() => setPickingFor(null)}
          onPick={(documentId) => router.push(`/mapping/designer?template=${pickingFor.id}&document=${documentId}`)}
        />
      )}
    </div>
  );
}

function UploadCard({ onUploaded }: { onUploaded: (template: OracleTemplate, reused: boolean) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [objectName, setObjectName] = useState("");
  const [environment, setEnvironment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const template = await uploadTemplate(file, { objectName, environment });
      onUploaded(template, Boolean(template.reused));
      setFile(null);
      setObjectName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-4 shadow-sm" aria-labelledby="upload-template-title">
      <h2 id="upload-template-title" className="text-sm font-semibold text-foreground">Upload an Oracle import template</h2>
      <p className="mt-0.5 text-xs text-text-secondary">
        CSV, XLSX or XLSM as downloaded from Import Management. The file is stored unchanged; macros are never run.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1 text-xs font-medium text-text-secondary">
          Template file
          <input
            type="file"
            accept=".csv,.xlsx,.xlsm"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary-soft file:px-2.5 file:py-1 file:text-xs file:font-medium file:text-primary"
            aria-label="Template file"
          />
        </label>
        <label className="flex w-48 flex-col gap-1 text-xs font-medium text-text-secondary">
          Import object <span className="font-normal text-text-muted">(optional)</span>
          <input
            value={objectName}
            onChange={(event) => setObjectName(event.target.value)}
            placeholder="From the file name"
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm text-foreground outline-none focus:border-primary/40"
          />
        </label>
        <label className="flex w-48 flex-col gap-1 text-xs font-medium text-text-secondary">
          Oracle environment <span className="font-normal text-text-muted">(optional)</span>
          <input
            value={environment}
            onChange={(event) => setEnvironment(event.target.value)}
            placeholder="e.g. TEST pod"
            className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm text-foreground outline-none focus:border-primary/40"
          />
        </label>
        <button type="button" disabled={!file || busy} onClick={() => void submit()} className="btn-primary h-9 px-4 text-sm disabled:opacity-50">
          <Upload className="h-4 w-4" aria-hidden="true" />
          {busy ? "Uploading…" : "Upload"}
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
    </section>
  );
}

function TemplateList({
  templates,
  selectedId,
  onSelect,
  onMap,
}: {
  templates: OracleTemplate[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onMap: (template: OracleTemplate) => void;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface" aria-label="Templates">
      <table className="w-full text-sm" data-testid="template-list">
        <thead className="bg-surface-soft text-left text-[11px] font-semibold uppercase tracking-wide text-text-muted">
          <tr>
            <th className="px-3 py-2.5">Import object</th>
            <th className="px-3 py-2.5">Columns</th>
            <th className="hidden px-3 py-2.5 md:table-cell">Uploaded</th>
            <th className="px-3 py-2.5 text-right">Mappings</th>
            <th className="w-28 px-3 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {templates.map((template) => {
            const active = template.id === selectedId;
            return (
              <tr
                key={template.id}
                onClick={() => onSelect(template.id)}
                className={`cursor-pointer border-t border-border/70 ${active ? "bg-primary/[0.06]" : "hover:bg-surface-soft"}`}
                aria-selected={active}
              >
                <td className="px-3 py-2.5">
                  <p className="font-medium text-foreground">
                    {template.object_name} <span className="font-normal text-text-muted">v{template.version}</span>
                  </p>
                  <p className="truncate text-xs text-text-secondary">{template.filename}{template.environment ? ` · ${template.environment}` : ""}</p>
                </td>
                <td className="px-3 py-2.5 text-text-secondary">
                  {template.columns.length}
                  <span className="ml-1.5 text-xs text-text-muted">{template.has_display_labels ? "with labels" : "names only"}</span>
                </td>
                <td className="hidden px-3 py-2.5 text-xs text-text-secondary md:table-cell">
                  {formatDate(template.uploaded_at)} · {template.uploaded_by}
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-text-secondary">{template.profile_count}</td>
                <td className="px-3 py-2.5 text-right">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onMap(template);
                    }}
                    className="btn-secondary whitespace-nowrap px-2.5 py-1 text-xs"
                  >
                    Map a document
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function TemplateDetail({ template, onMap, onRetired }: { template: OracleTemplate; onMap: () => void; onRetired: () => void }) {
  const [busy, setBusy] = useState(false);
  const required = template.columns.filter((column) => column.required).length;
  return (
    <section className="rounded-xl border border-border bg-surface" aria-label={`${template.object_name} columns`} data-testid="template-detail">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            {template.object_name} <span className="font-normal text-text-muted">v{template.version}</span>
          </h2>
          <p className="mt-0.5 text-xs text-text-secondary">
            {template.file_format.toUpperCase()}
            {template.sheet_name ? ` · sheet “${template.sheet_name}”` : ""} · technical names on row {template.technical_row + 1}
            {template.label_row != null ? ` · labels on row ${template.label_row + 1}` : ""} ·{" "}
            {required ? `${required} required` : "required not marked"}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void downloadOriginalTemplate(template)} className="btn-secondary px-2.5 py-1 text-xs">
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Original
          </button>
          <button type="button" onClick={onMap} className="btn-primary px-2.5 py-1 text-xs">Map a document</button>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              if (!window.confirm(`Retire ${template.object_name} v${template.version}? Its mappings are kept for history.`)) return;
              setBusy(true);
              try {
                await retireTemplate(template.id);
                onRetired();
              } finally {
                setBusy(false);
              }
            }}
            className="rounded-md px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-surface-soft hover:text-danger"
          >
            Retire
          </button>
        </div>
      </header>
      {template.warnings.length > 0 && (
        <ul className="space-y-1 border-b border-border bg-warning/5 px-4 py-2.5 text-xs text-text-secondary">
          {template.warnings.map((warning) => (
            <li key={warning} className="flex gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
              {warning}
            </li>
          ))}
        </ul>
      )}
      <div className="max-h-[60vh] overflow-auto">
        <table className="w-full text-sm" data-testid="template-columns">
          <thead className="sticky top-0 bg-surface-soft text-left text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            <tr>
              <th className="w-12 px-3 py-2">#</th>
              <th className="px-3 py-2">Technical attribute</th>
              <th className="px-3 py-2">Oracle display label</th>
              <th className="px-3 py-2">Required</th>
            </tr>
          </thead>
          <tbody>
            {template.columns.map((column) => (
              <tr key={column.position} className="border-t border-border/70">
                <td className="px-3 py-1.5 tabular-nums text-text-muted">{column.position + 1}</td>
                <td className="px-3 py-1.5 font-mono text-[12px] text-foreground">{column.technical_name}</td>
                <td className="px-3 py-1.5 text-text-secondary">{column.display_label ?? <span className="text-text-muted">—</span>}</td>
                <td className="px-3 py-1.5 text-xs">
                  {column.required ? <span className="font-medium text-danger">Required</span> : <span className="text-text-muted">Not marked</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DocumentPicker({
  template,
  onClose,
  onPick,
}: {
  template: OracleTemplate;
  onClose: () => void;
  onPick: (documentId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      searchDocuments({ q: query.trim() || undefined, limit: 25 })
        .then((result) => active && setDocuments(result.documents))
        .catch(() => active && setDocuments([]));
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query]);

  const staged = useMemo(() => (documents ?? []).filter((document) => document.staging_status === "staged"), [documents]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 p-4 pt-[10vh]" role="dialog" aria-modal="true" aria-label="Choose a document">
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Map a document to {template.object_name}</h2>
            <p className="text-xs text-text-secondary">Choose an extracted document.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-text-secondary hover:bg-surface-soft">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="p-3">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search documents…"
              className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-sm outline-none focus:border-primary/40"
            />
          </label>
        </div>
        <ul className="max-h-80 overflow-y-auto border-t border-border" data-testid="document-picker">
          {documents === null ? (
            <li className="px-4 py-6 text-center text-sm text-text-muted">Loading…</li>
          ) : staged.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-text-muted">No extracted documents match.</li>
          ) : (
            staged.map((document) => (
              <li key={document.document_id}>
                <button
                  type="button"
                  onClick={() => onPick(document.document_id)}
                  className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-surface-soft"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">{document.original_filename}</span>
                    <span className="block truncate text-xs text-text-secondary">{document.type_label ?? document.profile_label}</span>
                  </span>
                  <span className="shrink-0 text-xs text-text-muted">{document.page_count} p.</span>
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
