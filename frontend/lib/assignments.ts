import { apiFetch } from "@/lib/api";
import type { ReviewQueueFieldItem } from "@/types/document";

/** Mirrors backend app/api/assignments.py and the extra Review Queue item
 * columns from app/api/dashboard.py. */

export interface ReviewQueueFieldDetail extends ReviewQueueFieldItem {
  /** Reviewer display name (there is no user directory). */
  assignee?: string | null;
  assigned_at?: string | null;
  /** ISO date (YYYY-MM-DD). */
  due_date?: string | null;
  /** The document's upload time. */
  uploaded_at?: string | null;
  /** Raw extracted contract type / pricing model, when the document has one. */
  contract_type?: string | null;
  /** The source text the value was read from, when it was stored. */
  source_snippet?: string | null;
}

export interface AssignmentTarget {
  document_id: string;
  metadata_field_id?: number | null;
  field_key: string;
}

export interface Assignment extends AssignmentTarget {
  assignee: string;
  due_date: string | null;
  assigned_by: string;
  assigned_at: string | null;
}

export interface AssigneesResult {
  assignees: string[];
  current_actor: string;
}

const BASE = "/api/review-assignments";

export function assignmentTarget(item: ReviewQueueFieldItem): AssignmentTarget {
  return {
    document_id: item.document_id,
    metadata_field_id: item.metadata_field_id ?? null,
    field_key: item.field_key,
  };
}

export function assignFields(
  items: AssignmentTarget[],
  assignee: string,
  dueDate?: string | null,
): Promise<{ assigned: Assignment[] }> {
  return apiFetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items, assignee, due_date: dueDate || null }),
  });
}

export function unassignFields(items: AssignmentTarget[]): Promise<{ unassigned: number }> {
  return apiFetch(`${BASE}/unassign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });
}

export function getAssignees(): Promise<AssigneesResult> {
  return apiFetch<AssigneesResult>(`${BASE}/assignees`);
}

/** Up to two initials for an avatar ("Dana Reyes" → "DR"). */
export function initials(name: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const letters = words.length === 1 ? words[0].slice(0, 2) : `${words[0][0]}${words[words.length - 1][0]}`;
  return letters.toUpperCase();
}

export type ContractTypeGroup = "FFP" | "T&M" | "Cost-Plus" | "Other";

/** Common contract-type strings grouped as FFP / T&M / Cost-Plus, other
 * recognizable types as "Other"; anything unrecognized stays as written. */
export function normalizeContractType(raw: string | null | undefined): string | null {
  const text = (raw ?? "").trim();
  if (!text) return null;
  const lowered = text.toLowerCase();
  if (/\bffp\b|firm[\s-]*fixed[\s-]*price/.test(lowered)) return "FFP";
  if (/\bt\s*&\s*m\b|\bt\s*and\s*m\b|time[\s-]*(and|&)[\s-]*materials?|labor[\s-]*hours?\b|\blh\b/.test(lowered)) return "T&M";
  if (/cost[\s-]*plus|\bcp(ff|if|af)\b|cost[\s-]*reimburs/.test(lowered)) return "Cost-Plus";
  if (/fixed[\s-]*price|\bfp(i|if|epa|-epa|-?loe)\b|\bidiq\b|indefinite[\s-]*delivery|\bbpa\b|letter[\s-]*contract|cost[\s-]*shar|cost[\s-]*no[\s-]*fee|requirements[\s-]*contract/.test(lowered)) {
    return "Other";
  }
  return text;
}
