"use client";

import { Copy, Download, FileUp, GitBranch, LayoutTemplate, Plus, Search, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import ConsoleHeader from "@/components/layout/ConsoleHeader";
import { ErrorState, LoadingState } from "@/components/layout/StatusState";
import { searchDocuments } from "@/lib/documents";
import {
  STATUS_LABEL,
  STATUS_TONE,
  archiveSchema,
  createSchema,
  discoverFields,
  duplicateSchema,
  emptyDefinition,
  exportSchema,
  extendSchema,
  importSchema,
  listSchemas,
  type Definition,
  type Discovery,
  type SchemaSummary,
} from "@/lib/doc-schemas";
import type { DocumentSummary } from "@/types/document";

const CATEGORIES: [string, string][] = [
  ["", "All categories"], ["contracts", "Contracts & Awards"], ["procurement", "Procurement"],
  ["regulations", "FAR & Regulations"], ["financial", "Financial"], ["identity", "Identity"],
  ["people", "HR & Education"], ["technical", "Technical & Reports"], ["other", "Other"],
];
const STATUSES: [string, string][] = [
  ["", "All statuses"], ["draft", "Draft"], ["in_review", "In review"], ["published", "Published"], ["deprecated", "Deprecated"],
];

/** Document Intelligence → Schema & Label Designer: the schema library. */
export default function SchemaLibraryPage() {
  const router = useRouter();
  const [schemas, setSchemas] = useState<SchemaSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState("");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    listSchemas({ category, status })
      .then((rows) => {
        setError(null);
        setSchemas(rows);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load schemas."));
  }, [category, status]);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (schemas ?? []).filter((s) => !needle || `${s.name} ${s.schema_key} ${s.description ?? ""}`.toLowerCase().includes(needle));
  }, [schemas, query]);

  async function act(action: () => Promise<{ id: number }>, open = true) {
    try {
      const result = await action();
      if (open) router.push(`/schemas/${result.id}`);
      else load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "That didn't work.");
    }
  }

  async function onImport(file: File | undefined) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      await act(() => importSchema(payload));
    } catch (err) {
      setNotice(err instanceof SyntaxError ? "That file isn't valid JSON." : err instanceof Error ? err.message : "Import failed.");
    }
  }

  return (
    <div className="workspace-page w-full" data-testid="schema-library">
      <ConsoleHeader
        icon={LayoutTemplate}
        title="Schema & Label Designer"
        description="What Dataomatix extracts for each kind of document, and how it is labelled and validated. Built-in schemas describe the standard document types; create your own, extend one, or let Field Discovery propose one from a document."
        actions={
          <>
            <label className="btn-secondary h-9 cursor-pointer px-3 text-sm">
              <FileUp className="h-4 w-4" aria-hidden="true" />
              Import
              <input type="file" accept="application/json,.json" className="sr-only" onChange={(e) => void onImport(e.target.files?.[0])} aria-label="Import schema file" />
            </label>
            <button type="button" onClick={() => setCreating(true)} className="btn-primary h-9 px-4 text-sm">
              <Plus className="h-4 w-4" aria-hidden="true" />
              New schema
            </button>
          </>
        }
      />
      <div className="space-y-4 px-4 py-5 sm:px-6">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3">
          <label className="relative min-w-[16rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search schemas…" aria-label="Search schemas"
              className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-2 text-sm outline-none focus:border-primary/40" />
          </label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category" className="h-9 rounded-lg border border-border bg-background px-2 text-sm">
            {CATEGORIES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status" className="h-9 rounded-lg border border-border bg-background px-2 text-sm">
            {STATUSES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </div>
        {notice && (
          <p className="flex items-center justify-between rounded-lg border border-border bg-surface-soft px-3 py-2 text-sm text-text-secondary" role="status">
            {notice}
            <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}><X className="h-4 w-4" /></button>
          </p>
        )}
        {error ? (
          <ErrorState error={error} onRetry={load} />
        ) : schemas === null ? (
          <LoadingState title="Loading schemas…" compact />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-surface">
            <table className="w-full text-sm" data-testid="schema-table">
              <thead className="bg-surface-soft text-left text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                <tr>
                  <th className="px-3 py-2.5">Schema</th>
                  <th className="px-3 py-2.5">Category</th>
                  <th className="px-3 py-2.5">Version</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="hidden px-3 py-2.5 text-right md:table-cell">Documents</th>
                  <th className="px-3 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {visible.map((schema) => {
                  const version = schema.latest;
                  return (
                    <tr key={schema.id} className="cursor-pointer border-t border-border/70 hover:bg-surface-soft" onClick={() => router.push(`/schemas/${schema.id}`)}>
                      <td className="max-w-[22rem] px-3 py-2.5">
                        <p className="truncate font-medium text-foreground">
                          {schema.name}
                          {schema.is_system && <span className="ml-1.5 rounded bg-surface-soft px-1 text-[10px] font-medium text-text-secondary">Built-in</span>}
                        </p>
                        <p className="truncate text-xs text-text-muted">
                          {schema.parent ? `Inherits ${schema.parent}` : schema.description ?? schema.schema_key}
                        </p>
                      </td>
                      <td className="px-3 py-2.5 text-text-secondary">{CATEGORIES.find(([id]) => id === schema.category)?.[1] ?? schema.category}</td>
                      <td className="px-3 py-2.5 tabular-nums text-text-secondary">{version?.version ?? "—"}{schema.versions > 1 ? ` (${schema.versions})` : ""}</td>
                      <td className="px-3 py-2.5">
                        {version && <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_TONE[version.status]}`}>{STATUS_LABEL[version.status]}</span>}
                      </td>
                      <td className="hidden px-3 py-2.5 text-right tabular-nums text-text-secondary md:table-cell">{schema.documents}</td>
                      <td className="px-3 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                        <div className="flex justify-end gap-1">
                          <IconButton label="Duplicate" icon={Copy} onClick={() => void act(() => duplicateSchema(schema.id, `${schema.name} (copy)`))} />
                          {schema.published && <IconButton label="Extend (child schema)" icon={GitBranch} onClick={() => void act(() => extendSchema(schema.id, `${schema.name} — extended`))} />}
                          {version && <IconButton label="Export JSON" icon={Download} onClick={() => void exportSchema(schema.id, version.id)} />}
                          {!schema.is_system && (
                            <IconButton label="Archive" icon={X} onClick={() => {
                              if (window.confirm(`Archive ${schema.name}? Its versions stay on record.`)) void act(() => archiveSchema(schema.id), false);
                            }} />
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {visible.length === 0 && <p className="px-4 py-8 text-center text-sm text-text-muted">No schemas match.</p>}
          </div>
        )}
      </div>
      {creating && (
        <CreateDialog
          schemas={schemas ?? []}
          onClose={() => setCreating(false)}
          onCreate={(body) => act(() => createSchema(body))}
        />
      )}
    </div>
  );
}

function IconButton({ label, icon: Icon, onClick }: { label: string; icon: typeof Copy; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} className="rounded-md p-1.5 text-text-secondary hover:bg-surface-soft hover:text-foreground">
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

function CreateDialog({
  schemas,
  onClose,
  onCreate,
}: {
  schemas: SchemaSummary[];
  onClose: () => void;
  onCreate: (body: { name: string; category: string; parent_version_id?: number | null; definition?: Definition }) => Promise<void>;
}) {
  const [mode, setMode] = useState<"blank" | "extend" | "discover">("blank");
  const [name, setName] = useState("");
  const [category, setCategory] = useState("other");
  const [parent, setParent] = useState<number | "">("");
  const [docQuery, setDocQuery] = useState("");
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const published = schemas.filter((s) => s.published);

  useEffect(() => {
    if (mode !== "discover") return;
    const timer = setTimeout(() => {
      searchDocuments({ q: docQuery.trim() || undefined, limit: 15 }).then((r) => setDocuments(r.documents.filter((d) => d.staging_status === "staged"))).catch(() => setDocuments([]));
    }, 200);
    return () => clearTimeout(timer);
  }, [mode, docQuery]);

  async function analyze(document: DocumentSummary) {
    setBusy(true);
    setError(null);
    try {
      const result = await discoverFields(document.document_id);
      setDiscovery(result);
      setRejected(new Set(result.suggestions.filter((s) => s.origin === "category").map((s) => s.field_id)));
      if (!name) setName(`${document.type_label ?? "Document"} schema`);
      if (document.category && document.category !== "unclassified") setCategory(document.category);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Analysis failed.");
    } finally {
      setBusy(false);
    }
  }

  function approvedDefinition(): Definition {
    if (!discovery) return emptyDefinition();
    const groups = discovery.definition.groups
      .map((g) => ({ ...g, fields: g.fields.filter((f) => !rejected.has(f.field_id)) }))
      .filter((g) => g.fields.length > 0);
    return { ...emptyDefinition(), groups };
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4 pt-[6vh]" role="dialog" aria-modal="true" aria-label="New schema">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-surface shadow-xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">New schema</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1 text-text-secondary hover:bg-surface-soft"><X className="h-4 w-4" /></button>
        </header>
        <div className="space-y-3 p-5">
          <div className="flex gap-1 rounded-lg border border-border p-0.5" role="radiogroup" aria-label="Start from">
            {([["blank", "Blank"], ["extend", "Extend a schema"], ["discover", "Analyze a document"]] as const).map(([id, label]) => (
              <button key={id} type="button" role="radio" aria-checked={mode === id} onClick={() => setMode(id)}
                className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium ${mode === id ? "bg-primary/10 text-foreground" : "text-text-secondary"}`}>
                {id === "discover" && <Sparkles className="mr-1 inline h-3.5 w-3.5" aria-hidden="true" />}
                {label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <label className="flex-1 text-xs font-medium text-text-secondary">Name
              <input value={name} onChange={(e) => setName(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm" />
            </label>
            <label className="w-48 text-xs font-medium text-text-secondary">Category
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm">
                {CATEGORIES.slice(1).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </label>
          </div>
          {mode === "extend" && (
            <label className="block text-xs font-medium text-text-secondary">Parent schema (inherits its fields and rules)
              <select value={parent} onChange={(e) => setParent(e.target.value ? Number(e.target.value) : "")} aria-label="Parent schema" className="mt-1 h-9 w-full rounded-lg border border-border bg-background px-2 text-sm">
                <option value="">Choose…</option>
                {published.map((s) => <option key={s.id} value={s.published!.id}>{s.name} {s.published!.version}</option>)}
              </select>
            </label>
          )}
          {mode === "discover" && (
            <div className="space-y-2">
              {!discovery ? (
                <>
                  <input value={docQuery} onChange={(e) => setDocQuery(e.target.value)} placeholder="Search an extracted document…" aria-label="Search documents"
                    className="h-9 w-full rounded-lg border border-border bg-background px-2 text-sm" />
                  <ul className="max-h-56 overflow-y-auto rounded-lg border border-border" data-testid="discover-documents">
                    {documents.map((d) => (
                      <li key={d.document_id}>
                        <button type="button" disabled={busy} onClick={() => void analyze(d)} className="flex w-full justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-soft">
                          <span className="truncate">{d.original_filename}</span>
                          <span className="shrink-0 text-xs text-text-muted">{d.type_label}</span>
                        </button>
                      </li>
                    ))}
                    {documents.length === 0 && <li className="px-3 py-4 text-center text-xs text-text-muted">No extracted documents.</li>}
                  </ul>
                  {busy && <p className="text-xs text-text-muted">Analyzing…</p>}
                </>
              ) : (
                <div data-testid="discovery-review">
                  <p className="text-xs text-text-secondary">
                    {discovery.found} fields found in the document, {discovery.tables} tables, {discovery.category} more expected for its type
                    (not found — unticked). Untick anything you don&apos;t want.
                  </p>
                  <ul className="mt-2 max-h-72 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border text-xs">
                    {discovery.suggestions.map((s) => (
                      <li key={s.field_id} className="flex items-start gap-2 px-3 py-1.5">
                        <input type="checkbox" checked={!rejected.has(s.field_id)} aria-label={`Keep ${s.label}`}
                          onChange={() => setRejected((r) => { const n = new Set(r); if (n.has(s.field_id)) n.delete(s.field_id); else n.add(s.field_id); return n; })} />
                        <span className="min-w-0 flex-1">
                          <span className="font-medium text-foreground">{s.label}</span>
                          <span className="ml-1 text-text-muted">{s.type}</span>
                          <span className={`ml-1.5 rounded px-1 text-[10px] ${s.origin === "found" ? "bg-success/10 text-success" : "bg-surface-soft text-text-muted"}`}>
                            {s.origin === "found" ? "found" : s.origin === "category" ? "suggested for this type" : "not found"}
                          </span>
                          <span className="block truncate text-text-secondary">{s.value ?? s.evidence}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {error && <p className="text-xs text-danger" role="alert">{error}</p>}
        </div>
        <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onClose} className="btn-secondary px-3 py-1.5 text-sm">Cancel</button>
          <button
            type="button"
            disabled={!name.trim() || (mode === "extend" && !parent) || (mode === "discover" && !discovery) || busy}
            onClick={async () => {
              setBusy(true);
              await onCreate({
                name: name.trim(), category,
                parent_version_id: mode === "extend" && parent ? parent : null,
                definition: mode === "discover" ? approvedDefinition() : emptyDefinition(),
              });
              setBusy(false);
            }}
            className="btn-primary px-3 py-1.5 text-sm disabled:opacity-50"
          >
            Create draft
          </button>
        </footer>
      </div>
    </div>
  );
}
