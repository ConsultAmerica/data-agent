import { apiFetch } from "@/lib/api";

// Key dates the backend detects for any document (app/key_dates/):
// MRZ expiry, contract period ends and labelled dates in the text.

export type KeyDateStatus = "expired" | "expiring" | "upcoming" | "past";

export interface KeyDate {
  document_id: string;
  document_name?: string | null;
  kind: string;
  date: string;
  label: string;
  source: "mrz" | "text" | "contract_schedule" | string;
  page: number | null;
  evidence_text: string | null;
  confidence: number;
  status: KeyDateStatus;
  days_remaining: number;
}

export interface DocumentKeyDates {
  document_id: string;
  expiry: KeyDate | null;
  key_dates: KeyDate[];
}

export const KIND_LABELS: Record<string, string> = {
  expiry: "Expiry",
  valid_until: "Valid until",
  renewal: "Renewal",
  termination: "Termination",
  period_end: "Period end",
  due: "Due",
  issue: "Issued",
  effective: "Effective",
};

export const SOURCE_LABELS: Record<string, string> = {
  mrz: "Machine-readable zone",
  text: "Document text",
  contract_schedule: "Contract schedule",
};

export function getDocumentKeyDates(documentId: string): Promise<DocumentKeyDates> {
  return apiFetch(`/api/documents/${documentId}/key-dates`);
}

export function listKeyDates(params: { status?: KeyDateStatus; withinDays?: number } = {}): Promise<KeyDate[]> {
  const query = new URLSearchParams();
  if (params.status) query.set("status", params.status);
  if (params.withinDays) query.set("within_days", String(params.withinDays));
  const qs = query.toString();
  return apiFetch(`/api/key-dates${qs ? `?${qs}` : ""}`);
}

/** "Expires in 45 days", "Expired 12 days ago", "Expires today". */
export function relativeLabel(item: Pick<KeyDate, "days_remaining" | "kind">): string {
  const verb = item.kind === "renewal" ? "Renews" : item.kind === "due" ? "Due" : "Expires";
  const days = item.days_remaining;
  if (days === 0) return `${verb} today`;
  if (days > 0) return `${verb} in ${days.toLocaleString()} day${days === 1 ? "" : "s"}`;
  const ago = Math.abs(days);
  return `${verb === "Expires" ? "Expired" : verb === "Renews" ? "Renewal was" : "Was due"} ${ago.toLocaleString()} day${ago === 1 ? "" : "s"} ago`;
}

export function formatKeyDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Deep link that opens the document's source page at the evidence. */
export function evidenceHref(item: Pick<KeyDate, "document_id" | "page" | "evidence_text">): string {
  const params = new URLSearchParams({ view: "source" });
  if (item.page) params.set("page", String(item.page));
  const firstLine = (item.evidence_text || "").split("\n")[0].trim();
  if (firstLine) params.set("hl", firstLine.slice(0, 80));
  return `/documents/${item.document_id}?${params.toString()}`;
}
