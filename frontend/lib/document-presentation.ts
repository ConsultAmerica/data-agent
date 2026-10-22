import type { DocumentStatus, DocumentSummary } from "@/types/document";

export type OperationalStatus =
  | "ready"
  | "verified"
  | "review"
  | "failed"
  | "processing";

export interface DocumentPresentation {
  typeLabel: string;
  profileLabel: string;
  /** Whether a staging resolution exists (else: Reprocess). */
  staged: boolean;
  status: OperationalStatus;
  statusLabel: string;
}

/** Type and Profile as Dataomatix resolved them — the persisted staging
 * resolution the server returns, never a guess from the filename. A
 * document that was never staged has neither (it can be reprocessed). */
export function presentDocument(document: DocumentSummary): DocumentPresentation {
  const staged = document.staging_status === "staged" && Boolean(document.profile_label);
  const status = operationalStatus(document);
  return {
    typeLabel: staged ? (document.type_label ?? document.profile_label ?? "") : "—",
    profileLabel: staged ? (document.profile_label ?? "") : "Not staged",
    staged,
    status,
    statusLabel: STATUS_LABEL[status],
  };
}

const STATUS_LABEL: Record<OperationalStatus, string> = {
  ready: "Ready",
  verified: "Verified",
  review: "Review",
  failed: "Failed",
  processing: "Processing",
};

export function operationalStatus(document: {
  status: DocumentStatus;
  repository_status?: string | null;
}): OperationalStatus {
  if (document.status === "failed") return "failed";
  if (document.status === "processing") return "processing";
  if (document.status === "review_required") return "review";
  if (document.repository_status === "approved") return "verified";
  return "ready";
}

export function statusMark(status: OperationalStatus): string {
  if (status === "review") return "!";
  if (status === "failed") return "×";
  if (status === "processing") return "●";
  return "✓";
}
