"use client";

import { Lock } from "lucide-react";

import { REVIEW_READ_ONLY_MESSAGE, useReviewMutationsEnabled } from "@/lib/review-gate";

/** Shown wherever review actions live, only when the backend gate is closed. */
export default function ReviewReadOnlyNotice({ className = "" }: { className?: string }) {
  const enabled = useReviewMutationsEnabled();
  if (enabled) return null;
  return (
    <p
      role="note"
      data-testid="review-read-only"
      className={`flex items-start gap-2 rounded-lg border border-warning/25 bg-warning/[0.06] px-3 py-2 text-xs leading-5 text-text-secondary ${className}`}
    >
      <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
      {REVIEW_READ_ONLY_MESSAGE}
    </p>
  );
}
