import { apiFetch } from "@/lib/api";

/** Mirrors backend app/api/document_intelligence.py. */

export type LifecycleStatus =
  | "active"
  | "not_yet_effective"
  | "expiring_soon"
  | "expires_today"
  | "expired"
  | "no_expiration_date"
  | "needs_review"
  | "not_applicable";

export interface DateCandidate {
  /** Canonical concept: effective_date, start_date, expiration_date… */
  date_type: string;
  kind: string;
  /** As printed in the document. */
  original_text: string | null;
  /** Only when unambiguous (or confirmed by a person). */
  normalized_date: string | null;
  /** Both readings of an ambiguous numeric date. */
  interpretations: string[];
  /** mrz · text · contract_schedule · metadata_review */
  source: string;
  page: number | null;
  evidence_text: string | null;
  confidence: number | null;
  validation_status: "valid" | "ambiguous" | "unreadable";
  review_status: "approved" | "not_reviewed";
  option_period: boolean;
}

export interface DocumentIntelligence {
  document_id: string;
  file_format: string;
  classification: {
    category: string;
    category_label: string;
    document_type: string;
    document_type_label: string;
    subtype: string | null;
    secondary_categories: string[];
    confidence: number | null;
    confidence_level: "high" | "medium" | "low" | "none";
    status: string;
    evidence: string[];
    method: string;
    engine_version: string;
    decided: boolean;
    decided_by: string | null;
    requires_confirmation: boolean;
  };
  date_candidates: DateCandidate[];
  lifecycle_dates: {
    start: DateCandidate | null;
    expiration: DateCandidate | null;
    renewal: DateCandidate | null;
    payment_due: DateCandidate | null;
  };
  lifecycle: {
    status: LifecycleStatus;
    label: string;
    reasons: string[];
    days_remaining: number | null;
    review_required: string[];
    evaluated_on: string;
    warning_days: number;
    timezone: string;
  };
  review_required: string[];
}

export const WARNING_PERIODS = [30, 60, 90] as const;

/** A calendar date ("2026-01-31") as text, the same day in every timezone
 * (parsing it as a Date would shift it a day west of UTC). */
export function formatCalendarDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export function getDocumentIntelligence(documentId: string, warningDays?: number): Promise<DocumentIntelligence> {
  const query = warningDays ? `?warning_days=${warningDays}` : "";
  return apiFetch(`/api/documents/${documentId}/intelligence${query}`);
}

export const LIFECYCLE_LABELS: Record<LifecycleStatus, string> = {
  active: "Active",
  not_yet_effective: "Not Yet Effective",
  expiring_soon: "Expiring Soon",
  expires_today: "Expires Today",
  expired: "Expired",
  no_expiration_date: "No Expiration Date",
  needs_review: "Needs Review",
  not_applicable: "Not Applicable",
};

export const LIFECYCLE_TONE: Record<LifecycleStatus, string> = {
  active: "bg-success/10 text-success",
  not_yet_effective: "bg-primary-soft text-primary",
  expiring_soon: "bg-warning/10 text-warning",
  expires_today: "bg-warning/20 text-warning",
  expired: "bg-danger/10 text-danger",
  no_expiration_date: "bg-surface-soft text-text-secondary",
  needs_review: "bg-warning/10 text-warning",
  not_applicable: "bg-surface-soft text-text-muted",
};

/** Document list filters (backend _LIFECYCLE_FILTERS). */
export const LIFECYCLE_FILTERS = [
  { id: "", label: "All lifecycles" },
  { id: "expired", label: "Expired" },
  { id: "expiring_soon", label: "Expiring soon" },
  { id: "missing_dates", label: "Missing dates" },
  { id: "needs_review", label: "Needs review" },
  { id: "active", label: "Active" },
  { id: "not_yet_effective", label: "Not yet effective" },
] as const;

export const DATE_TYPE_LABELS: Record<string, string> = {
  issue_date: "Issue date",
  award_date: "Award date",
  effective_date: "Effective date",
  start_date: "Start date",
  end_date: "End date",
  expiration_date: "Expiration date",
  renewal_date: "Renewal date",
  payment_due_date: "Payment due date",
  termination_date: "Termination date",
};

export const DATE_SOURCE_LABELS: Record<string, string> = {
  mrz: "Machine-readable zone",
  text: "Document text",
  contract_schedule: "Contract schedule",
  metadata_review: "Approved in Metadata review",
};
