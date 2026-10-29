"use client";

import { ChevronRight, Copy, Loader2, Search, Table2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import EvidenceBanner from "@/components/viewers/evidence-banner";
import { apiFetch } from "@/lib/api";
import type { ResolvedLocation } from "@/lib/source-view";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Children rendered per node before "Show more" (a 50,000-row array
 * shouldn't mount 50,000 rows to show the first screen). */
const PAGE = 200;
/** Nodes visited when searching. */
const SEARCH_LIMIT = 200_000;

type Step = string | number;

function scalarText(value: Json): string {
  if (value === null) return "null";
  return typeof value === "string" ? value : String(value);
}

function stepLabel(step: Step): string {
  return typeof step === "number" ? `[${step}]` : step;
}

/** The path (as in the page text: invoice.lines[2].amount) of a step list. */
export function pathText(steps: Step[]): string {
  return steps.reduce<string>(
    (text, step) => (typeof step === "number" ? `${text}[${step}]` : text ? `${text}.${step}` : step),
    "",
  );
}

/** Paths of leaves whose value is `needle` (exact), or — with `partial` —
 * of any key or value containing it. */
function find(data: Json, needle: string, partial = false): Step[][] {
  const target = needle.trim().toLowerCase();
  if (!target) return [];
  const found: Step[][] = [];
  const stack: [Json, Step[]][] = [[data, []]];
  let visited = 0;
  while (stack.length && visited < SEARCH_LIMIT && found.length < 500) {
    const [value, steps] = stack.pop()!;
    visited += 1;
    const last = steps[steps.length - 1];
    if (partial && typeof last === "string" && last.toLowerCase().includes(target)) found.push(steps);
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) stack.push([value[i], [...steps, i]]);
    } else if (value !== null && typeof value === "object") {
      for (const k of Object.keys(value).reverse()) stack.push([value[k], [...steps, k]]);
    } else {
      const text = scalarText(value).trim().toLowerCase();
      if (partial ? text.includes(target) && !found.some((f) => key(f) === key(steps)) : text === target) found.push(steps);
    }
  }
  return found;
}

const key = (steps: Step[]) => JSON.stringify(steps);

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/** An array of flat objects as rows. */
function tableOf(items: Json[]): { columns: string[]; rows: Json[] } | null {
  if (items.length < 2 || !items.every((i) => i !== null && typeof i === "object" && !Array.isArray(i))) return null;
  const columns: string[] = [];
  for (const item of items as Record<string, Json>[]) for (const k of Object.keys(item)) if (!columns.includes(k)) columns.push(k);
  return { columns, rows: items };
}

function Node({ name, value, steps, open: openPaths, match, marked }: {
  name: Step | null;
  value: Json;
  steps: Step[];
  open: Set<string>;
  match: string | null;
  marked: Set<string>;
}) {
  const id = key(steps);
  const container = value !== null && typeof value === "object";
  const [open, setOpen] = useState(steps.length === 0 || openPaths.has(id));
  const [shown, setShown] = useState(PAGE);
  const [asTable, setAsTable] = useState(false);
  const leafRef = useRef<HTMLDivElement>(null);
  const isMatch = match === id;

  // A newly highlighted value opens its ancestors and scrolls into view.
  useEffect(() => {
    if (openPaths.has(id)) queueMicrotask(() => setOpen(true));
  }, [openPaths, id]);
  useEffect(() => {
    if (isMatch) leafRef.current?.scrollIntoView?.({ block: "center" });
  }, [isMatch]);

  const label = name === null ? null : (
    <span className={typeof name === "number" ? "text-text-muted" : "font-medium text-text-secondary"}>{stepLabel(name)}</span>
  );
  const path = pathText(steps);
  const actions = (copyValue?: string) => (
    <span className="ml-auto hidden shrink-0 gap-0.5 group-hover:flex group-focus-within:flex">
      <button type="button" aria-label={`Copy path ${path || "(root)"}`} onClick={() => copy(path)} className="rounded p-0.5 text-text-muted hover:text-foreground"><Copy className="h-3 w-3" /></button>
      {copyValue != null && (
        <button type="button" aria-label={`Copy value of ${path}`} onClick={() => copy(copyValue)} className="rounded px-0.5 text-[10px] text-text-muted hover:text-foreground">value</button>
      )}
    </span>
  );

  if (!container) {
    return (
      <div ref={leafRef} className={`group flex min-w-0 gap-2 rounded px-1 py-0.5 ${isMatch ? "bg-warning/20 ring-1 ring-warning" : marked.has(id) ? "bg-primary-soft" : ""}`}
        title={path} data-testid={isMatch ? "json-match" : undefined}>
        {label}
        <span className={`min-w-0 break-words ${value === null ? "italic text-text-muted" : "text-foreground"}`}>{scalarText(value)}</span>
        {actions(scalarText(value))}
      </div>
    );
  }

  const entries: [Step, Json][] = Array.isArray(value)
    ? value.map((child, index) => [index, child])
    : Object.entries(value as Record<string, Json>);
  const summary = Array.isArray(value) ? `${entries.length} item${entries.length === 1 ? "" : "s"}` : `${entries.length} field${entries.length === 1 ? "" : "s"}`;
  const table = Array.isArray(value) ? tableOf(value) : null;

  return (
    <div>
      {name !== null && (
        <div className={`group flex items-center gap-1 rounded px-1 py-0.5 hover:bg-surface-soft ${marked.has(id) ? "bg-primary-soft" : ""}`}>
          <button type="button" className="flex min-w-0 items-center gap-1 text-left" aria-expanded={open} onClick={() => setOpen((current) => !current)} title={path}>
            <ChevronRight className={`h-3 w-3 shrink-0 text-text-muted transition-transform ${open ? "rotate-90" : ""}`} aria-hidden="true" />
            {label}
            <span className="text-[11px] text-text-muted">{summary}</span>
          </button>
          {table && (
            <button type="button" aria-pressed={asTable} aria-label={`Show ${path} as a table`} onClick={() => { setAsTable((v) => !v); setOpen(true); }}
              className="rounded p-0.5 text-text-muted hover:text-foreground"><Table2 className="h-3 w-3" /></button>
          )}
          {actions()}
        </div>
      )}
      {open && (
        <div className={name !== null ? "ml-2 border-l border-border pl-2" : ""}>
          {asTable && table ? (
            <div className="my-1 max-h-72 overflow-auto rounded border border-border font-sans" data-testid="json-table">
              <table className="w-full text-left text-[11px]">
                <thead className="sticky top-0 bg-surface-soft"><tr>{["#", ...table.columns].map((c) => <th key={c} className="px-1.5 py-1 font-medium">{c}</th>)}</tr></thead>
                <tbody>
                  {table.rows.slice(0, 1000).map((row, i) => (
                    <tr key={i} className="border-t border-border/60">
                      <td className="px-1.5 py-0.5 text-text-muted">{i}</td>
                      {table.columns.map((c) => {
                        const cell = (row as Record<string, Json>)[c];
                        return <td key={c} className="px-1.5 py-0.5">{cell === undefined ? "" : cell !== null && typeof cell === "object" ? "…" : scalarText(cell)}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <>
              {entries.slice(0, shown).map(([childName, child]) => (
                <Node key={String(childName)} name={childName} value={child} steps={[...steps, childName]} open={openPaths} match={match} marked={marked} />
              ))}
              {entries.length > shown && (
                <button type="button" className="px-1 py-0.5 text-[11px] text-primary hover:underline" onClick={() => setShown((n) => n + PAGE)}>
                  Show {Math.min(PAGE, entries.length - shown)} more of {entries.length - shown}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ancestorsOf(paths: Step[][]): Set<string> {
  const open = new Set<string>();
  for (const steps of paths) for (let depth = 0; depth < steps.length; depth += 1) open.add(key(steps.slice(0, depth)));
  return open;
}

/**
 * A JSON document as a collapsible tree, built from the file itself (not
 * the flattened page text). The highlighted value opens its branch, is
 * marked, and its path is shown as a breadcrumb. Search covers keys and
 * values; paths and values can be copied; arrays of objects can be shown
 * as tables.
 */
export default function JsonSourceTree({
  documentId,
  data: given,
  highlight,
  resolved = null,
  onUnavailable,
}: {
  documentId: string;
  /** The parsed file, when the caller already has it (no second download). */
  data?: Json;
  highlight?: string | null;
  resolved?: ResolvedLocation | null;
  /** The tree can't be shown (file too large or unreadable). */
  onUnavailable?: (reason: string) => void;
}) {
  const [fetched, setFetched] = useState<Json | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const data = given !== undefined ? given : fetched;

  useEffect(() => {
    if (given !== undefined) return;
    let active = true;
    apiFetch<{ data: Json }>(`/api/documents/${documentId}/source-json`)
      .then((response) => active && setFetched(response.data))
      .catch((failure: unknown) => {
        if (!active) return;
        const reason = failure instanceof Error && failure.message ? failure.message : "The JSON file could not be loaded.";
        setError(reason);
        onUnavailable?.(reason);
      });
    return () => {
      active = false;
    };
  }, [documentId, given, onUnavailable]);

  const matches = useMemo(() => (data === undefined || !highlight ? [] : find(data, highlight)), [data, highlight]);
  const first = matches[0] ?? null;
  const found = useMemo(() => (data === undefined || !query.trim() ? [] : find(data, query, true)), [data, query]);
  const marked = useMemo(() => new Set(found.map(key)), [found]);
  const openPaths = useMemo(() => {
    const open = ancestorsOf([...(first ? [first] : []), ...found.slice(0, 50)]);
    return open;
  }, [first, found]);

  if (error) return <p className="p-3 text-xs text-text-muted">{error}</p>;
  if (data === undefined) {
    return (
      <p className="flex items-center gap-2 p-3 text-xs text-text-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Loading the JSON file…
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-xs" data-testid="json-tree">
      <EvidenceBanner resolved={resolved} found={!highlight || first != null} />
      {highlight && (
        <p className="border-b border-border px-3 py-2 text-[11px] text-text-secondary" data-testid="json-breadcrumb">
          {first ? (
            <>
              {first.map(stepLabel).join(" › ")}
              {matches.length > 1 && <span className="text-text-muted"> · first of {matches.length} matches</span>}
            </>
          ) : (
            <span className="text-text-muted">“{highlight}” is not a value in this file.</span>
          )}
        </p>
      )}
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <label className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search keys and values…" aria-label="Search JSON" className="h-7 w-52 rounded-md border border-border bg-background pl-6 pr-1.5" />
        </label>
        {query.trim() && <span className="text-text-muted" aria-live="polite">{found.length} match{found.length === 1 ? "" : "es"}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2 font-mono" role="tree" aria-label="JSON document">
        <Node name={null} value={data} steps={[]} open={openPaths} match={first ? key(first) : null} marked={marked} />
      </div>
    </div>
  );
}
