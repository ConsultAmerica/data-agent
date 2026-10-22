import { apiFetch } from "@/lib/api";

/** Mirrors backend app/services/obligations.py. */

export type ObligationStatus = "overdue" | "due_soon" | "upcoming" | "ongoing" | "undated";
export type ObligationCategory =
  | "deliverable"
  | "reporting"
  | "compliance"
  | "financial"
  | "option"
  | "performance"
  | "notification";
export type ResponsibleParty = "contractor" | "government" | "both" | "unknown";

/** Team workflow, set by people — never inferred from dates. */
export type WorkflowStatus = "upcoming" | "in_review" | "pending_co" | "completed";

export interface Subtask {
  title: string;
  done: boolean;
}

export interface Obligation {
  obligation_id: string;
  document_id: string;
  document_name: string;
  title: string;
  description: string;
  category: ObligationCategory;
  responsible_party: ResponsibleParty;
  due_date: string | null;
  recurrence: string | null;
  trigger: string | null;
  status: ObligationStatus;
  source_type: "clause" | "schedule" | "text";
  source_reference: string;
  page: number | null;
  evidence: string;
  confidence: number;
  /** Tracking merged from obligation_tracking (defaults when untracked). */
  obligation_key?: string;
  workflow_status?: WorkflowStatus;
  assignee?: string | null;
  subtasks?: Subtask[];
  tracking_updated_at?: string | null;
  tracking_updated_by?: string | null;
}

export interface ObligationsResult {
  obligations: Obligation[];
  counts: Record<ObligationStatus, number> & { total: number };
  by_category: { name: string; count: number }[];
  workflow_counts?: Record<WorkflowStatus, number>;
}

export const WORKFLOW_STATUSES: WorkflowStatus[] = ["upcoming", "in_review", "pending_co", "completed"];

export const WORKFLOW_LABELS: Record<WorkflowStatus, string> = {
  upcoming: "Upcoming deliverables",
  in_review: "In review",
  pending_co: "Pending CO approval",
  completed: "Completed / archived",
};

export function workflowOf(item: Obligation): WorkflowStatus {
  return item.workflow_status && WORKFLOW_STATUSES.includes(item.workflow_status) ? item.workflow_status : "upcoming";
}

export function obligationKey(item: Obligation): string {
  return item.obligation_key ?? item.obligation_id;
}

export interface TrackingPatch {
  workflow_status?: WorkflowStatus;
  /** null or "" clears it. */
  assignee?: string | null;
  subtasks?: Subtask[];
}

export interface TrackingResult {
  document_id: string;
  obligation_key: string;
  workflow_status: WorkflowStatus;
  assignee: string | null;
  subtasks: Subtask[];
  tracking_updated_at: string | null;
  tracking_updated_by: string | null;
}

export function updateObligationTracking(
  documentId: string,
  key: string,
  patch: TrackingPatch,
): Promise<TrackingResult> {
  return apiFetch<TrackingResult>(
    `/api/obligations/${encodeURIComponent(documentId)}/tracking/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
}

/** Today as YYYY-MM-DD in the viewer's time zone. */
export function localToday(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** Whole days from `today` to `due` (negative when past). */
export function daysUntil(due: string, today: string = localToday()): number {
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export type RiskLevel = "high" | "medium" | "low";

export const RISK_LABELS: Record<RiskLevel, string> = { high: "High", medium: "Medium", low: "Low" };

/** Risk from the due date alone: overdue or due within 7 days = high,
 * within 30 = medium, later = low; undated obligations have none. */
export function riskOf(item: Pick<Obligation, "due_date">, today: string = localToday()): RiskLevel | null {
  if (!item.due_date) return null;
  const days = daysUntil(item.due_date, today);
  if (days <= 7) return "high";
  if (days <= 30) return "medium";
  return "low";
}

export const OBLIGATION_STATUSES: ObligationStatus[] = ["overdue", "due_soon", "upcoming", "ongoing", "undated"];

export const STATUS_LABELS: Record<ObligationStatus, string> = {
  overdue: "Overdue",
  due_soon: "Due soon",
  upcoming: "Upcoming",
  ongoing: "Ongoing",
  undated: "Undated",
};

export function getPortfolioObligations(filters: { documentId?: string } = {}): Promise<ObligationsResult> {
  const params = new URLSearchParams();
  if (filters.documentId) params.set("document_id", filters.documentId);
  const query = params.toString();
  return apiFetch<ObligationsResult>(`/api/obligations${query ? `?${query}` : ""}`);
}

export function getDocumentObligations(documentId: string): Promise<ObligationsResult & { document_id: string }> {
  return apiFetch(`/api/documents/${encodeURIComponent(documentId)}/obligations`);
}

/** When it's due, in one short phrase: the date, else the cadence or trigger. */
export function dueLabel(item: Pick<Obligation, "due_date" | "recurrence" | "trigger">): string {
  if (item.due_date) {
    const date = new Date(`${item.due_date}T00:00:00`);
    const formatted = Number.isNaN(date.getTime())
      ? item.due_date
      : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
    return item.recurrence && item.recurrence !== "per occurrence" ? `${formatted} (${item.recurrence})` : formatted;
  }
  if (item.recurrence) return item.recurrence[0].toUpperCase() + item.recurrence.slice(1);
  return "—";
}

function csvCell(value: string | number | null): string {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function obligationsCsv(items: Obligation[]): string {
  const header = [
    "Title", "Document", "Category", "Responsible Party", "Due Date", "Recurrence", "Trigger",
    "Status", "Source", "Page", "Evidence", "Confidence", "Workflow", "Owner", "Sub-tasks done",
  ];
  const rows = items.map((item) => [
    item.title, item.document_name, item.category, item.responsible_party, item.due_date, item.recurrence,
    item.trigger, STATUS_LABELS[item.status], item.source_reference, item.page, item.evidence, item.confidence,
    WORKFLOW_LABELS[workflowOf(item)], item.assignee ?? "",
    item.subtasks?.length ? `${item.subtasks.filter((task) => task.done).length}/${item.subtasks.length}` : "",
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}
