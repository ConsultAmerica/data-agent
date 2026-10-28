"use client";

import { useEffect, useState } from "react";

import { apiUrl } from "@/lib/api";

// The backend's review-mutation gate (core/feature_gates.py, reported by
// /ready). The backend enforces it either way; this only keeps the UI from
// offering actions that would be refused. Unknown (unreachable /ready)
// leaves controls enabled.

export const REVIEW_READ_ONLY_MESSAGE =
  "Review is read-only in this release: values can be inspected, but not accepted, edited, rejected or approved.";

let pending: Promise<boolean | null> | null = null;

export function fetchReviewMutationsEnabled(): Promise<boolean | null> {
  if (!pending) {
    pending = fetch(apiUrl("/ready"), { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as Record<string, unknown>;
        const flag = body.metadata_review_mutations_enabled;
        return typeof flag === "boolean" ? flag : null;
      })
      .catch(() => {
        pending = null; // retry on the next mount
        return null;
      });
  }
  return pending;
}

/** Test hook: forget the cached gate value. */
export function resetReviewGateCache(): void {
  pending = null;
}

export function useReviewMutationsEnabled(): boolean {
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    let live = true;
    void fetchReviewMutationsEnabled().then((flag) => {
      if (live && flag === false) setEnabled(false);
    });
    return () => {
      live = false;
    };
  }, []);
  return enabled;
}
