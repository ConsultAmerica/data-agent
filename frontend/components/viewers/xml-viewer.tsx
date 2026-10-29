"use client";

import { ChevronRight, Copy, Search, Table2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import EvidenceBanner from "@/components/viewers/evidence-banner";
import type { ResolvedLocation, SourceView, XmlNode } from "@/lib/source-view";

const PAGE = 200;

function qualified(node: { name: string; prefix?: string | null }) {
  return node.prefix ? `${node.prefix}:${node.name}` : node.name;
}

/** Paths of every node and attribute containing the needle. */
function search(root: XmlNode, needle: string): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length && found.length < 500) {
    const node = stack.pop()!;
    if (node.name.toLowerCase().includes(needle) || (node.text ?? "").toLowerCase().includes(needle)) found.push(node.path);
    for (const a of node.attributes) if (a.name.toLowerCase().includes(needle) || a.value.toLowerCase().includes(needle)) found.push(a.path);
    for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]);
  }
  return found;
}

/** Element paths to open so `path` is visible (/a/b[2]/c → /a, /a/b[2]). */
function ancestors(path: string): string[] {
  const element = path.split("/@")[0];
  const parts = element.split("/").filter(Boolean);
  return parts.map((_, i) => `/${parts.slice(0, i + 1).join("/")}`);
}

/** Repeated child elements with the same name → table rows. */
function repeated(node: XmlNode): XmlNode[] | null {
  if (node.children.length < 2) return null;
  const name = node.children[0].name;
  return node.children.every((c) => c.name === name) ? node.children : null;
}

function copy(text: string) {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

function RecordTable({ items }: { items: XmlNode[] }) {
  const columns: string[] = [];
  for (const item of items) {
    for (const a of item.attributes) if (!columns.includes(`@${a.name}`)) columns.push(`@${a.name}`);
    for (const c of item.children) if (!columns.includes(c.name)) columns.push(c.name);
  }
  const cell = (item: XmlNode, column: string) =>
    column.startsWith("@") ? item.attributes.find((a) => `@${a.name}` === column)?.value ?? "" : item.children.find((c) => c.name === column)?.text ?? "";
  return (
    <div className="my-1 max-h-72 overflow-auto rounded border border-border" data-testid="xml-table">
      <table className="w-full text-left text-[11px]">
        <thead className="sticky top-0 bg-surface-soft"><tr>{["#", ...columns].map((c) => <th key={c} className="px-1.5 py-1 font-medium">{c}</th>)}</tr></thead>
        <tbody>
          {items.slice(0, 1000).map((item, i) => (
            <tr key={item.path} className="border-t border-border/60"><td className="px-1.5 py-0.5 text-text-muted">{i + 1}</td>{columns.map((c) => <td key={c} className="px-1.5 py-0.5">{cell(item, c)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Node({ node, open, toggle, target, matches }: {
  node: XmlNode;
  open: Set<string>;
  toggle: (path: string) => void;
  target: string | null;
  matches: Set<string>;
}) {
  const [shown, setShown] = useState(PAGE);
  const [asTable, setAsTable] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isOpen = open.has(node.path);
  const isTarget = target === node.path;
  const items = repeated(node);
  useEffect(() => {
    if (isTarget) ref.current?.scrollIntoView?.({ block: "center" });
  }, [isTarget]);
  const leaf = node.children.length === 0;
  return (
    <div>
      <div ref={ref} className={`group flex min-w-0 items-start gap-1 rounded px-1 py-0.5 ${isTarget ? "bg-warning/25 ring-1 ring-warning" : matches.has(node.path) ? "bg-primary-soft" : ""}`}
        data-path={node.path} data-testid={isTarget ? "xml-target" : undefined}>
        {leaf ? <span className="w-3 shrink-0" /> : (
          <button type="button" aria-expanded={isOpen} aria-label={`${isOpen ? "Collapse" : "Expand"} ${qualified(node)}`} onClick={() => toggle(node.path)} className="mt-0.5 shrink-0 text-text-muted">
            <ChevronRight className={`h-3 w-3 transition-transform ${isOpen ? "rotate-90" : ""}`} />
          </button>
        )}
        <span className="min-w-0 break-words">
          <span className="font-medium text-primary" title={node.namespace ?? undefined}>{qualified(node)}</span>
          {node.attributes.map((a) => (
            <span key={a.path} className={`ml-1.5 text-[11px] ${target === a.path ? "rounded bg-warning/25 px-0.5 ring-1 ring-warning" : matches.has(a.path) ? "bg-primary-soft" : ""}`}
              data-testid={target === a.path ? "xml-target" : undefined} title={a.namespace ?? undefined}>
              <span className="text-text-secondary">{a.name}</span>=<span className="text-foreground">“{a.value}”</span>
            </span>
          ))}
          {node.text && <span className="ml-1.5 text-foreground">{node.text}</span>}
          {!leaf && !isOpen && <span className="ml-1.5 text-[11px] text-text-muted">{node.children.length} child{node.children.length === 1 ? "" : "ren"}</span>}
        </span>
        <span className="ml-auto hidden shrink-0 gap-0.5 group-hover:flex group-focus-within:flex">
          {items && (
            <button type="button" aria-pressed={asTable} aria-label={`Show ${qualified(node)} children as a table`} onClick={() => { setAsTable((v) => !v); if (!isOpen) toggle(node.path); }} className="rounded p-0.5 text-text-muted hover:text-foreground"><Table2 className="h-3 w-3" /></button>
          )}
          <button type="button" aria-label={`Copy path ${node.path}`} onClick={() => copy(node.path)} className="rounded p-0.5 text-text-muted hover:text-foreground"><Copy className="h-3 w-3" /></button>
        </span>
      </div>
      {isOpen && !leaf && (
        <div className="ml-2 border-l border-border pl-2">
          {asTable && items ? <RecordTable items={items} /> : (
            <>
              {node.children.slice(0, shown).map((child) => <Node key={child.path} node={child} open={open} toggle={toggle} target={target} matches={matches} />)}
              {node.children.length > shown && (
                <button type="button" className="px-1 text-[11px] text-primary hover:underline" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, node.children.length - shown)} more of {node.children.length - shown}</button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * An XML file as its element tree: qualified names with their namespace,
 * attributes, text, and the same paths XML extraction records as evidence.
 * Parsed on the server with entities, DTDs and network access disabled.
 */
export default function XmlViewer({ view, resolved, label }: { view: SourceView; resolved: ResolvedLocation | null; label: string | null }) {
  const root = view.root!;
  const target = resolved?.location.kind === "xml_path" ? resolved.location.path : null;
  const [open, setOpen] = useState<Set<string>>(() => new Set([root.path]));
  const [query, setQuery] = useState("");
  const matches = useMemo(() => (query.trim() ? search(root, query.trim().toLowerCase()) : []), [root, query]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const known = useMemo(() => {
    const paths = new Set<string>();
    const stack = [root];
    while (stack.length) {
      const node = stack.pop()!;
      paths.add(node.path);
      node.attributes.forEach((a) => paths.add(a.path));
      stack.push(...node.children);
    }
    return paths;
  }, [root]);

  // Evidence and search results open their branch.
  useEffect(() => {
    const reveal = [...(target ? ancestors(target) : []), ...matches.slice(0, 50).flatMap(ancestors)];
    if (reveal.length) queueMicrotask(() => setOpen((current) => new Set([...current, ...reveal])));
  }, [target, matches]);

  const toggle = (path: string) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  return (
    <div className="flex h-full min-h-0 flex-col text-xs" data-testid="xml-viewer">
      <EvidenceBanner resolved={resolved} found={!target || known.has(target)} label={label} />
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-2 py-1.5">
        <label className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search names and values…" aria-label="Search XML" className="h-7 w-52 rounded-md border border-border bg-background pl-6 pr-1.5" />
        </label>
        {query.trim() && <span className="text-text-muted" aria-live="polite">{matches.length} match{matches.length === 1 ? "" : "es"}</span>}
        {view.truncated && <span className="text-warning">Only the first 20,000 nodes are shown.</span>}
      </div>
      {(view.namespaces ?? []).length > 0 && (
        <dl className="flex flex-wrap gap-x-3 gap-y-0.5 border-b border-border bg-surface-soft px-3 py-1 text-[11px]" data-testid="xml-namespaces" aria-label="Namespaces">
          {view.namespaces!.map((ns) => (
            <div key={`${ns.prefix}:${ns.uri}`} className="flex gap-1"><dt className="font-medium">{ns.prefix ?? "(default)"}</dt><dd className="text-text-secondary">{ns.uri}</dd></div>
          ))}
        </dl>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-2 font-mono" role="tree" aria-label="XML elements">
        <Node node={root} open={open} toggle={toggle} target={target} matches={matchSet} />
      </div>
    </div>
  );
}
