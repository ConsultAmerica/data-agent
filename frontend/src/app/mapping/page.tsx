"use client";

import { AlertTriangle, BadgeCheck, Database, Download, FileSpreadsheet, Search, Shuffle, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import ConsoleHeader from "@/components/layout/ConsoleHeader";
import { ErrorState, LoadingState } from "@/components/layout/StatusState";
import { searchDocuments } from "@/lib/documents";
import {
  downloadOriginalTemplate,
  getCatalog,
  listTemplates,
  registerAttributes,
  registerDiscovered,
  retireTemplate,
  updateCatalog,
  uploadTemplate,
  verifyTemplate,
  type IntegrationMethod,
  type OracleCatalog,
  type OracleTemplate,
} from "@/lib/oracle-templates";

/** The Oracle applications and integration methods the catalog knows (backend oracle_templates/catalog.py). */
const APPLICATIONS = ["Enterprise Contracts", "Procurement", "Financials", "Project Management", "Sales and Service", "Other"];
const METHODS: { id: IntegrationMethod; label: string }[] = [
  { id: "fbdi", label: "File-Based Data Import (FBDI)" },
  { id: "import_management", label: "Import Management" },
  { id: "rest", label: "REST API" },
  { id: "other", label: "Other" },
];

function StatusBadge({ template }: { template: OracleTemplate }) {
  const catalog = template.catalog;
  if (!catalog) return null;
  const tone =
    catalog.status === "verified" ? "bg-success/10 text-success" : catalog.status === "draft" ? "bg-warning/10 text-warning" : "bg-danger/10 text-danger";
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`} title={catalog.status_reason ?? undefined} data-testid="catalog-status">
      {catalog.status_label}
    </span>
  );
}
import type { DocumentSummary } from "@/types/document";

/** The target a link asked for (/mapping?template=12), e.g. from the Mapping Designer's draft-target note. */
function linkedTemplateId(): number | null {
  if (typeof window === "undefined") return null;
  const id = Number(new URLSearchParams(window.location.search).get("template"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

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
  const [catalog, setCatalog] = useState<OracleCatalog | null>(null);

  const load = useCallback(() => {
    listTemplates()
      .then((rows) => {
        setError(null);
        setTemplates(rows);
        const linked = linkedTemplateId();
        setSelectedId((current) => current ?? rows.find((row) => row.id === linked)?.id ?? rows[0]?.id ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load templates."));
    getCatalog().then(setCatalog).catch(() => setCatalog(null));
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
        description="Oracle Fusion → target catalog. Register official Oracle import templates (FBDI, Import Management) or discover REST objects from a connected environment; Dataomatix reads their attributes, required fields and column order, and maps extracted data to exactly that shape. Nothing is written to Oracle."
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
        {catalog && <DiscoveryCard catalog={catalog} onRegistered={(template) => { setNotice(`${template.object_name} v${template.version} discovered as a draft target.`); setSelectedId(template.id); load(); }} />}
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
          <div className="rounded-xl border border-dashed border-border bg-surface px-6 py-12 text-center" data-testid="not-configured">
            <FileSpreadsheet className="mx-auto h-8 w-8 text-text-muted" aria-hidden="true" />
            <p className="mt-3 text-sm font-medium text-foreground">Oracle import template not configured</p>
            <p className="mt-1 text-xs text-text-muted">Register an official Contract, Contract Line, Contract Party or other import template to start mapping. No target attributes are assumed.</p>
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
                onChanged={load}
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
  const [application, setApplication] = useState("");
  const [method, setMethod] = useState<string>("");
  const [release, setRelease] = useState("");
  const [objectCode, setObjectCode] = useState("");
  const [parentObject, setParentObject] = useState("");
  const [userKeys, setUserKeys] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const template = await uploadTemplate(file, {
        objectName, environment, application, integrationMethod: method, oracleRelease: release, objectCode, parentObject, userKeys,
      });
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
      <h2 id="upload-template-title" className="text-sm font-semibold text-foreground">Register an official Oracle import template</h2>
      <p className="mt-0.5 text-xs text-text-secondary">
        CSV, XLSX or XLSM as downloaded from Oracle (FBDI or Import Management). The file is stored unchanged; macros are never run.
        A workbook&apos;s attribute sheet (data type, length, required, lookup) is read too. It is a draft target until an administrator verifies it.
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
        <label className="flex w-48 flex-col gap-1 text-xs font-medium text-text-secondary">
          Oracle application
          <select value={application} onChange={(event) => setApplication(event.target.value)} aria-label="Oracle application"
            className="h-9 rounded-lg border border-border bg-background px-2 text-sm text-foreground">
            <option value="">Not set</option>
            {APPLICATIONS.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="flex w-52 flex-col gap-1 text-xs font-medium text-text-secondary">
          Integration method
          <select value={method} onChange={(event) => setMethod(event.target.value)} aria-label="Integration method"
            className="h-9 rounded-lg border border-border bg-background px-2 text-sm text-foreground">
            <option value="">Not set</option>
            {METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <button type="button" disabled={!file || busy} onClick={() => void submit()} className="btn-primary h-9 px-4 text-sm disabled:opacity-50">
          <Upload className="h-4 w-4" aria-hidden="true" />
          {busy ? "Uploading…" : "Upload"}
        </button>
      </div>
      <details className="mt-2 text-xs text-text-secondary">
        <summary className="cursor-pointer">Oracle release, object code, parent object and user keys</summary>
        <div className="mt-2 flex flex-wrap gap-3">
          {([
            ["Oracle release", release, setRelease, "e.g. 25A"],
            ["Object code", objectCode, setObjectCode, "Oracle object identifier"],
            ["Parent object", parentObject, setParentObject, "e.g. Contract"],
            ["User keys", userKeys, setUserKeys, "Attributes, comma-separated"],
          ] as const).map(([label, value, update, placeholder]) => (
            <label key={label} className="flex w-48 flex-col gap-1 font-medium">
              {label}
              <input value={value} onChange={(event) => update(event.target.value)} placeholder={placeholder}
                className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm text-foreground outline-none focus:border-primary/40" />
            </label>
          ))}
        </div>
      </details>
      {error && <p className="mt-2 text-xs text-danger" role="alert">{error}</p>}
    </section>
  );
}

/** Templates by Oracle application, in the catalog's order. */
function grouped(templates: OracleTemplate[]): [string, OracleTemplate[]][] {
  const map = new Map<string, OracleTemplate[]>();
  for (const template of templates) {
    const application = template.catalog?.application ?? "Not classified";
    map.set(application, [...(map.get(application) ?? []), template]);
  }
  const order = [...APPLICATIONS, "Not classified"];
  return [...map.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
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
            <th className="px-3 py-2.5">Target object</th>
            <th className="px-3 py-2.5">Status</th>
            <th className="px-3 py-2.5">Attributes</th>
            <th className="hidden px-3 py-2.5 md:table-cell">Uploaded</th>
            <th className="px-3 py-2.5 text-right">Mappings</th>
            <th className="w-28 px-3 py-2.5" />
          </tr>
        </thead>
        <tbody>
          {grouped(templates).flatMap(([application, rows]) => [
            <tr key={`group-${application}`} className="border-t border-border bg-surface-soft/60" data-testid="application-group">
              <td colSpan={6} className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">{application}</td>
            </tr>,
            ...rows.map((template) => {
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
                  <p className="truncate text-xs text-text-secondary">
                    {template.catalog?.integration_method_label ? `${template.catalog.integration_method_label} · ` : ""}
                    {template.filename}{template.environment ? ` · ${template.environment}` : ""}
                  </p>
                </td>
                <td className="px-3 py-2.5"><StatusBadge template={template} /></td>
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
            }),
          ])}
        </tbody>
      </table>
    </section>
  );
}

function TemplateDetail({ template, onMap, onRetired, onChanged }: { template: OracleTemplate; onMap: () => void; onRetired: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const required = template.columns.filter((column) => column.required).length;
  const documented = template.columns.some((column) => column.data_type || column.max_length != null || column.lookup_values?.length);

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setProblem(null);
    try {
      await work();
      onChanged();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }
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
      <CatalogPanel key={template.id} template={template} busy={busy}
        onSave={(body) => void act(() => updateCatalog(template.id, body))}
        onVerify={() => void act(() => verifyTemplate(template.id))}
        onAttributes={(file) => void act(() => registerAttributes(template.id, file))} />
      {problem && <p className="border-b border-border px-4 py-2 text-xs text-danger" role="alert">{problem}</p>}
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
              {documented && <th className="px-3 py-2">Type · length</th>}
              {documented && <th className="px-3 py-2">Lookup</th>}
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
                {documented && (
                  <td className="px-3 py-1.5 text-xs text-text-secondary" title={column.description ?? undefined}>
                    {column.data_type ?? "—"}
                    {column.data_type === "number" && column.precision != null ? `(${column.precision}${column.scale != null ? `,${column.scale}` : ""})` : ""}
                    {column.max_length != null ? ` · ${column.max_length}` : ""}
                  </td>
                )}
                {documented && (
                  <td className="max-w-[10rem] truncate px-3 py-1.5 text-xs text-text-secondary" title={column.lookup_values?.join(", ") ?? undefined}>
                    {column.lookup_values?.join(", ") ?? column.lookup_type ?? "—"}
                  </td>
                )}
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

function CatalogPanel({
  template,
  busy,
  onSave,
  onVerify,
  onAttributes,
}: {
  template: OracleTemplate;
  busy: boolean;
  onSave: (body: { application: string; integration_method: IntegrationMethod; oracle_release: string | null; object_code: string | null; parent_object: string | null; user_keys: string[] }) => void;
  onVerify: () => void;
  onAttributes: (file: File) => void;
}) {
  const catalog = template.catalog;
  // Opened from a link to set this target up: its details form is ready.
  const [editing, setEditing] = useState(() => linkedTemplateId() === template.id && !catalog?.application);
  const [form, setForm] = useState({
    application: catalog?.application ?? "",
    integration_method: (catalog?.integration_method ?? "") as IntegrationMethod | "",
    oracle_release: catalog?.oracle_release ?? "",
    object_code: catalog?.object_code ?? "",
    parent_object: catalog?.parent_object ?? "",
    user_keys: (catalog?.user_keys ?? []).join(", "),
  });
  const field = "h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground";
  return (
    <div className="border-b border-border px-4 py-2.5 text-xs" data-testid="catalog-panel">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge template={template} />
        <span className="text-text-secondary">
          {[catalog?.application, catalog?.integration_method_label, catalog?.oracle_release, catalog?.object_code].filter(Boolean).join(" · ") || "Oracle application and method not set"}
          {catalog?.parent_object ? ` · child of ${catalog.parent_object}` : ""}
          {catalog?.user_keys.length ? ` · user keys ${catalog.user_keys.join(", ")}` : ""}
          {catalog?.source === "metadata_api" ? " · from Oracle metadata" : ""}
        </span>
        <span className="ml-auto flex gap-1.5">
          <button type="button" onClick={() => setEditing((v) => !v)} className="btn-secondary px-2 py-1 text-xs">{editing ? "Cancel" : "Edit target details"}</button>
          <label className="btn-secondary cursor-pointer px-2 py-1 text-xs" title="Attribute definitions from Oracle's documentation: name, data type, length, precision, scale, required, lookup">
            <Database className="h-3.5 w-3.5" aria-hidden="true" />
            Attribute definitions
            <input type="file" accept=".csv,.xlsx,.xlsm" className="hidden" aria-label="Attribute definitions file"
              onChange={(event) => { const file = event.target.files?.[0]; if (file) onAttributes(file); event.target.value = ""; }} />
          </label>
          {catalog?.status === "draft" && catalog.application && catalog.integration_method && (
            <button type="button" disabled={busy} onClick={onVerify} className="btn-primary px-2 py-1 text-xs"
              title="Confirm this is Oracle's own schema for the stated application, method and release">
              <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />
              Verify
            </button>
          )}
        </span>
      </div>
      {catalog?.status_reason && <p className="mt-1 text-text-muted">{catalog.status_reason}</p>}
      {catalog?.verified && catalog.verified_by && <p className="mt-1 text-text-muted">Verified by {catalog.verified_by}{catalog.verified_at ? ` on ${formatDate(catalog.verified_at)}` : ""}.</p>}
      {editing && (
        <form className="mt-2 flex flex-wrap items-end gap-2" onSubmit={(event) => {
          event.preventDefault();
          if (!form.application || !form.integration_method) return;
          onSave({
            application: form.application, integration_method: form.integration_method,
            oracle_release: form.oracle_release || null, object_code: form.object_code || null, parent_object: form.parent_object || null,
            user_keys: form.user_keys.split(",").map((k) => k.trim()).filter(Boolean),
          });
          setEditing(false);
        }}>
          <select className={field} aria-label="Application" value={form.application} onChange={(e) => setForm({ ...form, application: e.target.value })}>
            <option value="">Application…</option>
            {APPLICATIONS.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <select className={field} aria-label="Method" value={form.integration_method} onChange={(e) => setForm({ ...form, integration_method: e.target.value as IntegrationMethod })}>
            <option value="">Integration method…</option>
            {METHODS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          {(["oracle_release", "object_code", "parent_object", "user_keys"] as const).map((key) => (
            <input key={key} className={`${field} w-36`} aria-label={key.replace("_", " ")} placeholder={{ oracle_release: "Release", object_code: "Object code", parent_object: "Parent object", user_keys: "User keys" }[key]}
              value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
          ))}
          <button type="submit" className="btn-primary px-2.5 py-1 text-xs" disabled={busy || !form.application || !form.integration_method}>Save</button>
          <span className="w-full text-text-muted">Changing the application, method, release or object code withdraws the verification.</span>
        </form>
      )}
    </div>
  );
}

function DiscoveryCard({ catalog, onRegistered }: { catalog: OracleCatalog; onRegistered: (template: OracleTemplate) => void }) {
  const [resource, setResource] = useState("");
  const [application, setApplication] = useState("Enterprise Contracts");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const discovery = catalog.discovery;
  return (
    <section className="rounded-xl border border-border bg-surface p-4" aria-labelledby="discovery-title" data-testid="discovery-card">
      <h2 id="discovery-title" className="text-sm font-semibold text-foreground">Oracle metadata discovery</h2>
      <p className="mt-0.5 text-xs text-text-secondary">{discovery.message}</p>
      {discovery.configured && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <input value={resource} onChange={(e) => setResource(e.target.value)} placeholder="REST resource, e.g. contracts" aria-label="REST resource"
            className="h-9 w-56 rounded-lg border border-border bg-background px-2.5 text-sm" />
          <select value={application} onChange={(e) => setApplication(e.target.value)} aria-label="Discovery application"
            className="h-9 rounded-lg border border-border bg-background px-2 text-sm">
            {APPLICATIONS.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
          <button type="button" disabled={!resource.trim() || busy} className="btn-secondary h-9 px-3 text-sm"
            onClick={async () => {
              setBusy(true);
              setProblem(null);
              try {
                onRegistered(await registerDiscovered({ resource: resource.trim(), application }));
                setResource("");
              } catch (err) {
                setProblem(err instanceof Error ? err.message : "Discovery failed.");
              } finally {
                setBusy(false);
              }
            }}>
            {busy ? "Reading metadata…" : "Discover attributes"}
          </button>
        </div>
      )}
      {problem && <p className="mt-2 text-xs text-danger" role="alert">{problem}</p>}
    </section>
  );
}
