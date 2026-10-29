"use client";

import { Crosshair, Info, SearchX } from "lucide-react";

import type { ResolvedLocation } from "@/lib/source-view";

/**
 * How precisely the selected value's location is known — said in words
 * (for screen readers too), never implied by a highlight alone.
 */
export default function EvidenceBanner({
  resolved,
  found = true,
  label,
}: {
  resolved: ResolvedLocation | null;
  /** False when an approximate match (by text) found nothing. */
  found?: boolean;
  label?: string | null;
}) {
  if (!resolved) return null;
  const exact = resolved.precision === "exact";
  const unavailable = resolved.precision === "unavailable" || !found;
  const Icon = unavailable ? SearchX : exact ? Crosshair : Info;
  const tone = unavailable
    ? "border-warning/30 bg-warning/10 text-text-secondary"
    : exact
      ? "border-primary/30 bg-primary-soft text-foreground"
      : "border-border bg-surface-soft text-text-secondary";
  return (
    <p className={`flex items-start gap-1.5 border-b px-3 py-1.5 text-[11px] ${tone}`} role="status" data-testid="evidence-banner" data-precision={unavailable ? "unavailable" : resolved.precision}>
      <Icon className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
      <span>
        {label && <span className="font-medium text-foreground">{label}: </span>}
        {resolved.description}
        {!found && resolved.precision === "approximate" && " The value wasn't found in this view."}
      </span>
    </p>
  );
}
