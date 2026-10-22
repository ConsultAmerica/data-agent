import { apiFetch } from "@/lib/api";

export type DocumentStatusValue = "processing" | "review_required" | "completed" | "failed";
export type InsightsSort = "relevance" | "newest";

export interface InsightsFilters {
  document_types: string[];
  families: string[];
  statuses: string[];
  clause_families: string[];
  years: string[];
  has_clauses: string[];
  uploaded_from: string | null;
  uploaded_to: string | null;
}

export type FacetKey = "document_types" | "families" | "statuses" | "clause_families" | "years";

export interface FacetValue {
  value: string;
  count: number;
}

export interface InsightsPassage {
  page: number;
  snippet: string;
  highlights: [number, number][];
  href: string;
}

export interface InsightsFact {
  label: string;
  value: string;
  page: number | null;
}

export interface InsightsClause {
  clause_number: string;
  title: string | null;
  page: number | null;
}

export interface InsightsResult {
  document_id: string;
  document_name: string;
  document_type: string;
  family_label: string;
  status: DocumentStatusValue | string;
  uploaded_at: string | null;
  score: number | null;
  facts: InsightsFact[];
  passages: InsightsPassage[];
  matched_clauses: InsightsClause[];
}

export interface InsightsResponse {
  query: string;
  total: number;
  results: InsightsResult[];
  facets: Record<FacetKey, FacetValue[]>;
  terms: string[];
  took_ms: number;
}

export interface InsightsQuery {
  q: string;
  filters: InsightsFilters;
  sort: InsightsSort;
  page: number;
}

export const PAGE_SIZE = 20;

export const FACET_GROUPS: { key: FacetKey; label: string }[] = [
  { key: "document_types", label: "Document type" },
  { key: "families", label: "Profile" },
  { key: "statuses", label: "Status" },
  { key: "clause_families", label: "Clause family" },
  { key: "years", label: "Upload year" },
];

export const STATUS_LABELS: Record<string, string> = {
  processing: "Processing",
  review_required: "Needs review",
  completed: "Ready",
  failed: "Failed",
};

export const EXAMPLE_QUERIES = [
  "DFARS cybersecurity clauses",
  "termination for convenience",
  "invoicing through WAWF",
  "insurance certificate notice",
];

export function emptyFilters(): InsightsFilters {
  return {
    document_types: [],
    families: [],
    statuses: [],
    clause_families: [],
    years: [],
    has_clauses: [],
    uploaded_from: null,
    uploaded_to: null,
  };
}

export function activeFilterCount(filters: InsightsFilters): number {
  const lists = [
    filters.document_types,
    filters.families,
    filters.statuses,
    filters.clause_families,
    filters.years,
    filters.has_clauses,
  ].reduce((sum, list) => sum + list.length, 0);
  return lists + (filters.uploaded_from ? 1 : 0) + (filters.uploaded_to ? 1 : 0);
}

export async function searchInsights(query: InsightsQuery): Promise<InsightsResponse> {
  return apiFetch<InsightsResponse>("/api/search/insights", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q: query.q,
      filters: query.filters,
      sort: query.sort,
      limit: PAGE_SIZE,
      offset: (query.page - 1) * PAGE_SIZE,
    }),
  });
}

// --- URL state: ?q=&type=&family=&status=&clauses=&year=&clause=&from=&to=&sort=&page= ---

const URL_LISTS: [keyof InsightsFilters, string][] = [
  ["document_types", "type"],
  ["families", "family"],
  ["statuses", "status"],
  ["clause_families", "clauses"],
  ["years", "year"],
  ["has_clauses", "clause"],
];

export function queryFromParams(params: URLSearchParams): InsightsQuery {
  const filters = emptyFilters();
  for (const [key, param] of URL_LISTS) {
    (filters[key] as string[]) = params.getAll(param).filter(Boolean);
  }
  filters.uploaded_from = params.get("from") || null;
  filters.uploaded_to = params.get("to") || null;
  const page = Number(params.get("page"));
  return {
    q: params.get("q")?.trim() ?? "",
    filters,
    sort: params.get("sort") === "newest" ? "newest" : "relevance",
    page: Number.isInteger(page) && page > 1 ? page : 1,
  };
}

export function paramsFromQuery(query: InsightsQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  for (const [key, param] of URL_LISTS) {
    for (const value of query.filters[key] as string[]) params.append(param, value);
  }
  if (query.filters.uploaded_from) params.set("from", query.filters.uploaded_from);
  if (query.filters.uploaded_to) params.set("to", query.filters.uploaded_to);
  if (query.sort === "newest") params.set("sort", "newest");
  if (query.page > 1) params.set("page", String(query.page));
  return params;
}

// --- Saved views (per browser; storage may be unavailable) ---

export interface SavedView {
  id: string;
  name: string;
  q: string;
  filters: InsightsFilters;
  sort: InsightsSort;
}

const VIEWS_KEY = "da-insights-saved-views";

export function loadSavedViews(): SavedView[] {
  try {
    const raw = window.localStorage.getItem(VIEWS_KEY);
    const parsed = raw ? (JSON.parse(raw) as SavedView[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function storeSavedViews(views: SavedView[]): void {
  try {
    window.localStorage.setItem(VIEWS_KEY, JSON.stringify(views));
  } catch {
    // Private windows and blocked storage: the views simply don't persist.
  }
}

// --- Highlights and export ---

export type SnippetPart = { text: string; mark: boolean };

/** Splits a snippet on the API's [start, end) highlight offsets. */
export function highlightParts(snippet: string, highlights: [number, number][]): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let cursor = 0;
  for (const [start, end] of [...highlights].sort((a, b) => a[0] - b[0])) {
    if (start < cursor || end <= start || end > snippet.length) continue;
    if (start > cursor) parts.push({ text: snippet.slice(cursor, start), mark: false });
    parts.push({ text: snippet.slice(start, end), mark: true });
    cursor = end;
  }
  if (cursor < snippet.length) parts.push({ text: snippet.slice(cursor), mark: false });
  return parts;
}

function csvCell(value: string | number | null | undefined): string {
  const text = value == null ? "" : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function resultsCsv(results: InsightsResult[], origin: string): string {
  const header = ["Document", "Type", "Profile", "Status", "Relevance", "Facts", "Top passage", "Page", "Link"];
  const rows = results.map((result) => {
    const passage = result.passages[0];
    return [
      result.document_name,
      result.document_type,
      result.family_label,
      STATUS_LABELS[result.status] ?? result.status,
      result.score == null ? "" : Math.round(result.score * 100),
      result.facts.map((fact) => `${fact.label}: ${fact.value}`).join("; "),
      passage?.snippet ?? "",
      passage?.page ?? "",
      `${origin}/documents/${result.document_id}`,
    ];
  });
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
