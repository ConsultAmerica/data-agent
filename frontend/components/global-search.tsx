"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BookCheck,
  CalendarClock,
  Clock,
  FileText,
  GitCompareArrows,
  ListChecks,
  Loader2,
  Plus,
  ScrollText,
  Search,
  Sparkles,
  Bot,
  Archive,
  type LucideIcon,
} from "lucide-react";

import { useShortcutLabel } from "@/components/navigation/client-env";
import { searchDocuments } from "@/lib/documents";
import { emptyFilters, searchInsights } from "@/lib/insights-search";
import { dueLabel, getPortfolioObligations, type Obligation } from "@/lib/obligations";
import type { DocumentSummary } from "@/types/document";

interface GlobalSearchProps {
  open: boolean;
  onClose: () => void;
}

type Section = "Commands" | "Recent searches" | "Documents" | "Clauses" | "Obligations";

interface PaletteItem {
  id: string;
  section: Section;
  title: string;
  subtitle?: string;
  icon: LucideIcon;
  /** Navigate here; or run `select` instead (e.g. reuse a recent search). */
  href?: string;
  select?: () => void;
}

interface ClauseHit {
  key: string;
  documentId: string;
  documentName: string;
  clauseNumber: string;
  title: string | null;
  page: number | null;
}

const SECTION_ORDER: Section[] = ["Commands", "Recent searches", "Documents", "Clauses", "Obligations"];

/** Pages and actions the palette can jump to, matched on title + keywords. */
const COMMANDS: { title: string; subtitle: string; href: string; icon: LucideIcon; keywords: string }[] = [
  { title: "New extraction", subtitle: "Upload a document", href: "/extraction/new", icon: Plus, keywords: "upload add new document extract" },
  { title: "Review queue", subtitle: "Values waiting for a decision", href: "/review-queue", icon: ListChecks, keywords: "review approve reject queue" },
  { title: "Documents", subtitle: "Every document in the workspace", href: "/documents", icon: Archive, keywords: "documents repository files" },
  { title: "Obligations", subtitle: "Deliverables, reports and deadlines", href: "/obligations", icon: CalendarClock, keywords: "obligations deadlines due deliverables" },
  { title: "Clause playbook", subtitle: "Expected and prohibited clauses", href: "/playbook", icon: BookCheck, keywords: "playbook rules clauses validation" },
  { title: "Compare documents", subtitle: "Modification against its base award", href: "/compare", icon: GitCompareArrows, keywords: "compare diff modification" },
  { title: "FAR / DFARS clauses", subtitle: "Clauses across every agreement", href: "/clauses", icon: ScrollText, keywords: "far dfars clauses" },
  { title: "Agent actions", subtitle: "Summaries, risk and funding reports", href: "/actions", icon: Bot, keywords: "actions reports summary risk funding" },
];

const RECENT_KEY = "da-recent-searches";
const RECENT_LIMIT = 5;

function loadRecent(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string").slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function rememberSearch(query: string) {
  const trimmed = query.trim();
  if (!trimmed) return;
  try {
    const next = [trimmed, ...loadRecent().filter((item) => item.toLowerCase() !== trimmed.toLowerCase())].slice(0, RECENT_LIMIT);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private mode / blocked storage: recents are a convenience only.
  }
}

function tokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesAll(text: string, words: string[]): boolean {
  const haystack = text.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The text with every query word wrapped in <mark>. */
export function highlight(text: string, query: string): ReactNode {
  const words = tokens(query).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return text;
  const pattern = new RegExp(`(${words.join("|")})`, "ig");
  return text.split(pattern).map((part, index) =>
    index % 2 === 1 ? (
      <mark key={index} className="rounded-sm bg-primary/15 px-0.5 text-foreground">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

export default function GlobalSearch({ open, onClose }: GlobalSearchProps) {
  // Mounted only while open, so every opening starts with a clean query.
  return open ? <CommandPalette onClose={onClose} /> : null;
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const shortcut = useShortcutLabel();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>(() => (typeof window === "undefined" ? [] : loadRecent()));
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [clauses, setClauses] = useState<ClauseHit[]>([]);
  const [allObligations, setAllObligations] = useState<Obligation[] | null>(null);
  const [pending, setPending] = useState(0);
  const [active, setActive] = useState(0);
  const trimmed = query.trim();

  // Obligations: loaded once per opening, filtered as you type.
  useEffect(() => {
    let alive = true;
    getPortfolioObligations()
      .then((result) => {
        if (alive) setAllObligations(result.obligations);
      })
      .catch(() => {
        if (alive) setAllObligations([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Documents and clauses come from the server, debounced; a newer query
  // always wins over a slower older one.
  useEffect(() => {
    if (!trimmed) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      // Every request that counts up counts down, even when superseded.
      setPending((count) => count + 2);
      searchDocuments({ q: trimmed, limit: 5 })
        .then((result) => {
          if (alive) setDocuments(result.documents);
        })
        .catch(() => {
          if (alive) setDocuments([]);
        })
        .finally(() => setPending((count) => count - 1));
      (trimmed.length >= 2
        ? searchInsights({ q: trimmed, filters: emptyFilters(), sort: "relevance", page: 1 })
        : Promise.resolve(null)
      )
        .then((result) => {
          if (!alive) return;
          const hits: ClauseHit[] = [];
          for (const doc of result?.results ?? []) {
            for (const clause of doc.matched_clauses) {
              hits.push({
                key: `${doc.document_id}:${clause.clause_number}`,
                documentId: doc.document_id,
                documentName: doc.document_name,
                clauseNumber: clause.clause_number,
                title: clause.title,
                page: clause.page,
              });
            }
          }
          setClauses(hits.slice(0, 6));
        })
        .catch(() => {
          if (alive) setClauses([]);
        })
        .finally(() => setPending((count) => count - 1));
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [trimmed]);

  const items = useMemo<PaletteItem[]>(() => {
    const words = tokens(trimmed);
    const out: PaletteItem[] = [];
    if (trimmed) {
      out.push(
        {
          id: "cmd-ask",
          section: "Commands",
          title: `Ask DataoAI: “${trimmed}”`,
          subtitle: "Cited answer from your documents",
          icon: Sparkles,
          href: `/ask?q=${encodeURIComponent(trimmed)}`,
        },
        {
          id: "cmd-search",
          section: "Commands",
          title: `Search everything for “${trimmed}”`,
          subtitle: "Full text, filters and highlighted passages",
          icon: Search,
          href: `/search?q=${encodeURIComponent(trimmed)}`,
        },
      );
    }
    for (const command of COMMANDS) {
      if (!words.length || matchesAll(`${command.title} ${command.keywords}`, words)) {
        out.push({ id: `page-${command.href}`, section: "Commands", title: command.title, subtitle: command.subtitle, icon: command.icon, href: command.href });
      }
    }
    if (!trimmed) {
      for (const item of recent) {
        out.push({ id: `recent-${item}`, section: "Recent searches", title: item, icon: Clock, select: () => setQuery(item) });
      }
      return out;
    }
    for (const doc of documents) {
      out.push({
        id: `doc-${doc.document_id}`,
        section: "Documents",
        title: doc.original_filename,
        subtitle: [doc.document_type, doc.counterparty].filter(Boolean).join(" · ") || "Document",
        icon: FileText,
        href: `/documents/${doc.document_id}`,
      });
    }
    for (const clause of clauses) {
      out.push({
        id: `clause-${clause.key}`,
        section: "Clauses",
        title: `${clause.clauseNumber}${clause.title ? ` ${clause.title}` : ""}`,
        subtitle: `${clause.documentName}${clause.page ? ` · p. ${clause.page}` : ""}`,
        icon: ScrollText,
        href: clause.page
          ? `/documents/${clause.documentId}?view=source&page=${clause.page}&hl=${encodeURIComponent(clause.clauseNumber)}`
          : `/documents/${clause.documentId}`,
      });
    }
    const obligations = (allObligations ?? [])
      .filter((item) => matchesAll(`${item.title} ${item.source_reference} ${item.document_name} ${item.description}`, words))
      .slice(0, 5);
    for (const item of obligations) {
      out.push({
        id: `obligation-${item.obligation_id}`,
        section: "Obligations",
        title: item.title,
        subtitle: [item.source_reference, item.document_name, dueLabel(item)].filter(Boolean).join(" · "),
        icon: CalendarClock,
        href: `/obligations?document_id=${encodeURIComponent(item.document_id)}`,
      });
    }
    return out;
  }, [trimmed, recent, documents, clauses, allObligations]);

  const activeIndex = items.length ? Math.min(active, items.length - 1) : -1;

  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView?.({ block: "nearest" });
  }, [activeIndex]);

  function choose(item: PaletteItem | undefined) {
    if (!item) {
      if (trimmed) {
        rememberSearch(trimmed);
        onClose();
        router.push(`/search?q=${encodeURIComponent(trimmed)}`);
      }
      return;
    }
    if (item.select) {
      item.select();
      setActive(0);
      inputRef.current?.focus();
      return;
    }
    if (trimmed) {
      rememberSearch(trimmed);
      setRecent(loadRecent());
    }
    onClose();
    if (item.href) router.push(item.href);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!items.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (Math.min(current, items.length - 1) + step + items.length) % items.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(items[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  const loading = Boolean(trimmed) && pending > 0;
  const grouped = SECTION_ORDER.map((section) => ({
    section,
    entries: items.map((item, index) => ({ item, index })).filter(({ item }) => item.section === section),
  })).filter((group) => group.entries.length > 0);
  const optionId = (index: number) => `${listId}-option-${index}`;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-start justify-center bg-navy/30 px-3 pt-[8vh] backdrop-blur-[2px] sm:px-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="animate-fade-in flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-[var(--shadow-elevated)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 sm:px-5">
          {loading ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-text-secondary" aria-hidden="true" />
          ) : (
            <Search className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
          )}
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            aria-autocomplete="list"
            aria-label="Search documents, clauses, obligations or jump to a page"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search documents, clauses, obligations… or jump to a page"
            autoFocus
            // The palette itself is the focus context; the global focus ring
            // would draw a second frame inside it.
            style={{ outline: "none", boxShadow: "none" }}
            className="min-w-0 flex-1 bg-transparent py-4 text-[15px] outline-none placeholder:text-text-secondary"
          />
          <kbd className="hidden rounded-md border border-border px-1.5 py-0.5 text-[10px] text-text-secondary sm:inline">Esc</kbd>
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-2">
          {grouped.map(({ section, entries }) => (
            <div key={section} role="group" aria-label={section} className="mb-1">
              <p className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-text-muted">{section}</p>
              {entries.map(({ item, index }) => {
                const selected = index === activeIndex;
                return (
                  <div
                    key={item.id}
                    id={optionId(index)}
                    role="option"
                    aria-selected={selected}
                    data-index={index}
                    onMouseMove={() => setActive(index)}
                    onClick={() => choose(item)}
                    className={[
                      "flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5",
                      selected ? "bg-primary-soft" : "",
                    ].join(" ")}
                  >
                    <span
                      className={[
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                        selected ? "bg-primary text-white" : "bg-surface-soft text-primary",
                      ].join(" ")}
                    >
                      <item.icon className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {item.section === "Commands" && item.id.startsWith("cmd-") ? item.title : highlight(item.title, trimmed)}
                      </span>
                      {item.subtitle && <span className="block truncate text-xs text-text-secondary">{item.subtitle}</span>}
                    </span>
                    {selected && <ArrowRight className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
                  </div>
                );
              })}
            </div>
          ))}
          {trimmed && !loading && items.length <= 2 + COMMANDS.length && grouped.every((group) => group.section === "Commands") && (
            <p className="px-3 py-4 text-center text-xs text-text-secondary">
              No documents, clauses or obligations match “{trimmed}”. Press Enter to search the full text.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border px-4 py-2 text-[11px] text-text-secondary">
          <span><kbd className="font-sans">↑</kbd> <kbd className="font-sans">↓</kbd> to move</span>
          <span><kbd className="font-sans">Enter</kbd> to open</span>
          <span><kbd className="font-sans">Esc</kbd> to close</span>
          <span className="ml-auto hidden sm:inline">{shortcut} anywhere</span>
        </div>
      </div>
    </div>
  );
}

export function useGlobalSearchShortcut(onOpen: () => void) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpen();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onOpen]);
}
