import { STATUS_LABELS, STATUS_STYLES } from "@/lib/document-status";
import type {
  DocumentStatus,
  RepositoryStatus,
  ReviewStatus,
} from "@/types/document";

const FIELD_STATUS_STYLES: Record<ReviewStatus, string> = {
  pending: "bg-surface-soft text-text-secondary",
  accepted: "bg-success/10 text-success",
  edited: "bg-primary-soft text-primary",
  rejected: "bg-danger/10 text-danger",
  unknown: "bg-warning/10 text-warning",
};

/** Metadata governance labels — never "Verified" (that is Staging QA). */
const FIELD_STATUS_LABELS: Record<ReviewStatus, string> = {
  pending: "Metadata Pending",
  accepted: "Metadata Accepted",
  edited: "Metadata Edited",
  rejected: "Metadata Rejected",
  unknown: "Metadata Unknown",
};

const REPOSITORY_STATUS_STYLES: Record<RepositoryStatus, string> = {
  not_approved: "bg-warning/10 text-warning",
  approved: "bg-success/10 text-success",
  repository: "bg-primary-soft text-primary",
};

const REPOSITORY_STATUS_LABELS: Record<RepositoryStatus, string> = {
  not_approved: "Needs Review",
  approved: "Verified",
  repository: "In Repository",
};

type StatusBadgeProps =
  | {
      kind: "document";
      status: DocumentStatus;
      size?: "sm" | "md";
    }
  | {
      kind: "field";
      status: ReviewStatus;
      verified?: boolean;
      size?: "sm" | "md";
    }
  | {
      kind: "repository";
      status: RepositoryStatus;
      size?: "sm" | "md";
    };

export default function StatusBadge(props: StatusBadgeProps) {
  const size = props.size ?? "md";
  const sizeClass =
    size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-0.5 text-xs";

  // Do not map metadata `verified` to "Verified" — that word is reserved for
  // Staging QA (Staging Verified). Always render the review_status label.

  if (props.kind === "document") {
    return (
      <span
        className={[
          "rounded-full font-medium",
          sizeClass,
          STATUS_STYLES[props.status],
        ].join(" ")}
      >
        {STATUS_LABELS[props.status]}
      </span>
    );
  }

  if (props.kind === "field") {
    return (
      <span
        className={[
          "rounded-full font-medium",
          sizeClass,
          FIELD_STATUS_STYLES[props.status],
        ].join(" ")}
      >
        {FIELD_STATUS_LABELS[props.status]}
      </span>
    );
  }

  return (
    <span
      className={[
        "rounded-full font-medium",
        sizeClass,
        REPOSITORY_STATUS_STYLES[props.status],
      ].join(" ")}
    >
      {REPOSITORY_STATUS_LABELS[props.status]}
    </span>
  );
}
