import type { OperationalStatus } from "@/lib/document-presentation";

/**
 * Display helpers for the Documents repository table, grid and preview.
 */

/** What the repository search matches — keep in step with the backend
 * /api/documents/search (file name, contract number / title, supplier /
 * customer metadata, and page text). */
export const DOCUMENT_SEARCH_PLACEHOLDER = "Search name, number, vendor or text…";

/** "$1,250,000.00" for a dollar amount; a bare number is grouped without a
 * currency symbol (the currency isn't known); anything else (EUR 10.000,
 * "See Section B") is shown as extracted. */
export function formatContractValue(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) return "—";
  const dollars = /^(?:USD\s*)?\$\s*/i.test(text) || /^USD\s+/i.test(text);
  const numeric = text.replace(/^(?:USD\s*)?\$?\s*/i, "").replace(/,/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(numeric)) return text;
  const value = Number(numeric);
  if (!Number.isFinite(value)) return text;
  if (dollars) {
    return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

export function formatDocumentDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Extraction outcome as the repository lists it. */
export function extractedStatusLabel(status: OperationalStatus): string {
  if (status === "review") return "Review needed";
  if (status === "verified") return "Verified";
  if (status === "failed") return "Failed";
  if (status === "processing") return "Processing";
  return "Complete";
}

export const EXTRACTED_STATUS_TONE: Record<OperationalStatus, string> = {
  ready: "text-success",
  verified: "text-success",
  review: "text-warning",
  failed: "text-danger",
  processing: "text-text-secondary",
};
