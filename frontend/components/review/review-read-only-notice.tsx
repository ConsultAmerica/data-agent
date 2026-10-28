"use client";

import { REVIEW_READ_ONLY_MESSAGE, useReviewMutationsEnabled } from "@/lib/review-gate";

/** Shown wherever review actions live, only when the backend gate is closed. */
export default function ReviewReadOnlyNotice({ className = "" }: { className?: string }) {
  const enabled = useReviewMutationsEnabled();
  if (enabled) return null;
  return (
    <p
      role="note"
      data-testid="review-read-only"
      className={`rounded-lg border border-warning/30 bg-warning/5 px-4 py-2 text-xs text-text-secondary ${className}`}
    >
      {REVIEW_READ_ONLY_MESSAGE}
    </p>
  );
}
