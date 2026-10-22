import { useMemo, useSyncExternalStore } from "react";

import { normalizeConfidence } from "@/components/ui/confidence-meter";
import { normalizeContractType, type ReviewQueueFieldDetail } from "@/lib/assignments";
import { toCsv } from "@/lib/export";
import type { ReviewQueueFieldItem } from "@/types/document";

export type IssueKind = "extraction" | "validation" | "missing" | "conflicts";
export type IssueFilter = "all" | IssueKind;
export type ConfidenceFilter = "all" | "below80" | "below60";
export type UrgencyFilter = "all" | "overdue" | "due7" | "none";
/** "all", UNASSIGNED, or an assignee's name. */
export type AssigneeFilter = string;
export const UNASSIGNED = "__unassigned__";

export interface QueueFilters {
  issue: IssueFilter;
  confidence: ConfidenceFilter;
  assignee: AssigneeFilter;
  /** "all" or a normalized contract type (see normalizeContractType). */
  contractType: string;
  urgency: UrgencyFilter;
  query: string;
}

export const DEFAULT_FILTERS: QueueFilters = {
  issue: "all",
  confidence: "all",
  assignee: "all",
  contractType: "all",
  urgency: "all",
  query: "",
};

export const ISSUE_TABS: [IssueFilter, string][] = [
  ["all", "All"],
  ["extraction", "Extraction"],
  ["validation", "Validation"],
  ["missing", "Missing"],
  ["conflicts", "Conflicts"],
];

export function issueKind(item: ReviewQueueFieldItem): IssueKind {
  const text = [...(item.reason_labels ?? []), ...(item.reasons ?? []), item.review_status]
    .join(" ")
    .toLowerCase();
  if (/missing|unknown|empty|blank|not found/.test(text)) return "missing";
  if (/conflict|disagree|reject/.test(text)) return "conflicts";
  if (/validat|type|format|failed|mismatch/.test(text)) return "validation";
  return "extraction";
}

export function issueLabel(item: ReviewQueueFieldItem): string {
  return item.reason_labels?.[0] || issueKind(item);
}

/** Validation failures and conflicts are critical compliance items (red
 * accent); low confidence, missing and other extraction issues are standard
 * (amber). */
export function severity(item: ReviewQueueFieldItem): "critical" | "standard" {
  const kind = issueKind(item);
  return kind === "validation" || kind === "conflicts" ? "critical" : "standard";
}

function todayIso(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** From the assignment's due date: overdue, due within 7 days, later, or none. */
export function urgencyOf(
  item: Pick<ReviewQueueFieldDetail, "due_date">,
  today: string = todayIso(),
): "overdue" | "due7" | "later" | "none" {
  if (!item.due_date) return "none";
  if (item.due_date < today) return "overdue";
  if (item.due_date <= addDays(today, 7)) return "due7";
  return "later";
}

export function matchesFilters(
  item: ReviewQueueFieldDetail,
  filters: QueueFilters,
  today: string = todayIso(),
): boolean {
  if (filters.issue !== "all" && issueKind(item) !== filters.issue) return false;
  const confidence = normalizeConfidence(item.confidence);
  if (filters.confidence === "below80" && confidence >= 0.8) return false;
  if (filters.confidence === "below60" && confidence >= 0.6) return false;
  if (filters.assignee === UNASSIGNED && item.assignee) return false;
  if (filters.assignee !== "all" && filters.assignee !== UNASSIGNED && item.assignee !== filters.assignee) return false;
  if (filters.contractType !== "all" && normalizeContractType(item.contract_type) !== filters.contractType) return false;
  if (filters.urgency !== "all" && urgencyOf(item, today) !== filters.urgency) return false;
  const needle = filters.query.trim().toLowerCase();
  if (needle) {
    const haystack = [item.original_filename, item.label, item.field_key, item.value].join(" ").toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

export function filtersActive(filters: QueueFilters): boolean {
  return (Object.keys(DEFAULT_FILTERS) as (keyof QueueFilters)[]).some(
    (key) => filters[key] !== DEFAULT_FILTERS[key],
  );
}

/** Where Inspect goes: the value highlighted on its source page when the page
 * is known, otherwise the document's review screen. */
export function inspectHref(item: ReviewQueueFieldItem): string {
  if (item.page_number) {
    const params = new URLSearchParams({ view: "source", page: String(item.page_number) });
    if (item.value) params.set("hl", item.value.slice(0, 80));
    return `/documents/${item.document_id}?${params.toString()}`;
  }
  return `/documents/${item.document_id}/review`;
}

export function formatQueueDate(value: string | null | undefined, withTime = false): string {
  if (!value) return "";
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return value;
  return withTime
    ? date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// --- saved filter chips (per browser) ---------------------------------------

export interface SavedFilter {
  id: string;
  name: string;
  filters: QueueFilters;
}

const SAVED_KEY = "dataomatix.review-queue.saved-filters";
const SAVED_EVENT = "dx:review-queue-saved-filters";
/** Fallback when storage is blocked: chips then last for this visit only. */
let memorySaved = "[]";

function readSavedRaw(): string {
  try {
    return window.localStorage.getItem(SAVED_KEY) ?? "[]";
  } catch {
    return memorySaved;
  }
}

function subscribeSaved(onChange: () => void) {
  window.addEventListener(SAVED_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(SAVED_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function parseSavedFilters(raw: string): SavedFilter[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (entry): entry is SavedFilter =>
          Boolean(entry) && typeof entry.id === "string" && typeof entry.name === "string",
      )
      .map((entry) => ({ ...entry, filters: { ...DEFAULT_FILTERS, ...entry.filters } }));
  } catch {
    return [];
  }
}

export function storeSavedFilters(saved: SavedFilter[]): void {
  memorySaved = JSON.stringify(saved);
  try {
    window.localStorage.setItem(SAVED_KEY, memorySaved);
  } catch {
    // Storage unavailable (private window, blocked): kept in memory instead.
  }
  window.dispatchEvent(new Event(SAVED_EVENT));
}

/** Named filter combinations saved in this browser. The server renders
 * none; the browser then reads them, so there is no hydration mismatch. */
export function useSavedFilters(): [SavedFilter[], (next: SavedFilter[]) => void] {
  const raw = useSyncExternalStore(subscribeSaved, readSavedRaw, () => "[]");
  const saved = useMemo(() => parseSavedFilters(raw), [raw]);
  return [saved, storeSavedFilters];
}

// --- CSV export --------------------------------------------------------------

/** Spreadsheet apps run cells starting with = + - @ as formulas; values
 * extracted from documents are untrusted, so such cells get a leading
 * apostrophe (plain numbers like -5 or +1 555 stay as they are). */
function safeCell(value: string | number | null | undefined): string {
  const text = value == null ? "" : String(value);
  return /^[=@\t\r]/.test(text) || /^[+-](?![\d\s(])/.test(text) ? `'${text}` : text;
}

export const CSV_HEADERS = [
  "Document",
  "Document ID",
  "Field",
  "Field key",
  "Value",
  "Issue",
  "Confidence",
  "Assignee",
  "Due date",
  "Contract type",
  "Uploaded",
  "Page",
];

export function queueCsv(items: ReviewQueueFieldDetail[]): string {
  return toCsv(
    CSV_HEADERS,
    items.map((item) => {
      const row: Record<string, string> = {
        Document: safeCell(item.original_filename),
        "Document ID": item.document_id,
        Field: safeCell(item.label),
        "Field key": item.field_key,
        Value: safeCell(item.value),
        Issue: safeCell(issueLabel(item)),
        Confidence: `${Math.round(normalizeConfidence(item.confidence) * 100)}%`,
        Assignee: safeCell(item.assignee),
        "Due date": item.due_date ?? "",
        "Contract type": safeCell(item.contract_type),
        Uploaded: item.uploaded_at ?? "",
        Page: item.page_number != null ? String(item.page_number) : "",
      };
      return row;
    }),
  );
}
