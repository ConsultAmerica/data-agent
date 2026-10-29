"use client";

import { LIFECYCLE_LABELS, LIFECYCLE_TONE, type LifecycleStatus } from "@/lib/document-intelligence";

/** A lifecycle status in words (not colour alone). */
export default function LifecycleBadge({ status, title }: { status: LifecycleStatus | string | null | undefined; title?: string }) {
  if (!status) return <span className="text-text-muted">—</span>;
  const known = status as LifecycleStatus;
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${LIFECYCLE_TONE[known] ?? "bg-surface-soft text-text-secondary"}`}
      title={title} data-testid="lifecycle-badge" data-status={status}>
      {LIFECYCLE_LABELS[known] ?? status}
    </span>
  );
}
