import { apiFetch } from "@/lib/api";

export type CompareChange = "changed" | "added" | "removed" | "unchanged";

export interface CompareDocument {
  document_id: string;
  name: string;
  document_type: string | null;
  profile: string | null;
}

export interface CompareRow {
  key: string;
  label: string;
  /** The entity the row belongs to (a CLIN, a clause), when it has one. */
  group: string | null;
  left: string | null;
  right: string | null;
  change: CompareChange;
  /** Numeric/date delta for a changed value, e.g. "+$12,500.00", "+30 days". */
  detail: string | null;
}

export interface CompareSection {
  section_id: string;
  label: string;
  rows: CompareRow[];
  counts: Record<CompareChange, number>;
}

export interface CompareResult {
  left: CompareDocument;
  right: CompareDocument;
  summary: Record<CompareChange, number>;
  sections: CompareSection[];
}

export function compareDocuments(left: string, right: string): Promise<CompareResult> {
  const params = new URLSearchParams({ left, right });
  return apiFetch<CompareResult>(`/api/compare?${params.toString()}`);
}
