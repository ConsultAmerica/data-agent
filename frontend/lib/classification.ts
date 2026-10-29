import { apiFetch } from "@/lib/api";

/** Mirrors backend app/api/classification.py. */

export type ClassificationStatus = "classified" | "review_recommended" | "review_required" | "confirmed";
export type ConfidenceLevel = "high" | "medium" | "low" | "none";

export interface ClassificationCandidate {
  family: string;
  label: string;
  category: string;
  category_label: string;
  profile_id: string;
  subtype: string | null;
  score: number;
  evidence: string[];
  sources: string[];
}

export interface ClassificationEvent {
  id: number;
  kind: "prediction" | "confirmation" | "override";
  family: string;
  family_label: string;
  subtype: string | null;
  confidence: number | null;
  status: ClassificationStatus;
  method: string;
  actor_name: string | null;
  reason: string | null;
  created_at: string;
}

export interface ClassificationState {
  document_id: string;
  family: string;
  family_label: string;
  category: string;
  category_label: string;
  subtype: string | null;
  subtypes: string[];
  profile_id: string;
  profile_label: string;
  confidence: number | null;
  confidence_level: ConfidenceLevel;
  status: ClassificationStatus;
  method: string;
  evidence: string[];
  candidates: ClassificationCandidate[];
  thresholds: { high?: number; low?: number };
  engine_version: string;
  decided: boolean;
  decided_by: string | null;
  predicted: ClassificationEvent | null;
  history: ClassificationEvent[];
  staged_profile_id: string | null;
  needs_restage: boolean;
  mappings_to_review: { id: number; name: string; staging_profile_id: string }[];
}

export interface DocumentTypeOption {
  family: string;
  label: string;
  profile_id: string;
  profile_label: string;
  subtypes: string[];
  datasets: { dataset_id: string; display_name: string; cardinality: string; fields: number }[];
}

export interface CategoryOption {
  category: string;
  label: string;
  types: DocumentTypeOption[];
}

export interface ClassificationQueueItem {
  document_id: string;
  original_filename: string;
  page_count: number;
  family_label: string;
  subtype: string | null;
  category_label: string;
  confidence: number | null;
  status: ClassificationStatus;
  top_alternatives: ClassificationCandidate[];
  classified_at: string;
}

export interface DecisionInput {
  action: "confirm" | "override";
  family?: string | null;
  subtype?: string | null;
  custom_label?: string | null;
  reason?: string | null;
  apply?: boolean;
}

export const STATUS_LABELS: Record<ClassificationStatus, string> = {
  classified: "Classified",
  review_recommended: "Review recommended",
  review_required: "Classification review required",
  confirmed: "Confirmed",
};

export const LEVEL_LABELS: Record<ConfidenceLevel, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
  none: "—",
};

export async function getClassification(documentId: string): Promise<ClassificationState> {
  return apiFetch(`/api/documents/${documentId}/classification`);
}

export async function reclassify(documentId: string): Promise<ClassificationState> {
  return apiFetch(`/api/documents/${documentId}/classification/classify`, { method: "POST" });
}

export async function decideClassification(documentId: string, decision: DecisionInput): Promise<ClassificationState> {
  return apiFetch(`/api/documents/${documentId}/classification/decision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(decision),
  });
}

export async function listDocumentTypes(): Promise<CategoryOption[]> {
  return apiFetch("/api/classification/types");
}

export async function classificationQueue(
  status: "pending" | "review_required" | "review_recommended" = "pending",
): Promise<ClassificationQueueItem[]> {
  return apiFetch(`/api/classification/queue?status=${status}`);
}
