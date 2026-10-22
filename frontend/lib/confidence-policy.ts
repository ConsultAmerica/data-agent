/**
 * Public description of how extraction confidence and review routing work.
 * Mirrors backend/app/services/confidence_engine.py (band thresholds) and
 * backend/app/services/review_routing.py (routing reasons). Keep in sync.
 */

export type ConfidenceBand = "high" | "medium" | "low";

export const HIGH_BAND_MIN = 0.85;
export const MEDIUM_BAND_MIN = 0.6;
/** A field that fails validation is capped below the medium band. */
export const VALIDATION_FAILED_CAP = 0.59;

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= HIGH_BAND_MIN) return "high";
  if (confidence >= MEDIUM_BAND_MIN) return "medium";
  return "low";
}

export const BAND_COPY: Record<
  ConfidenceBand,
  { label: string; range: string; outcome: string }
> = {
  high: {
    label: "High",
    range: `${Math.round(HIGH_BAND_MIN * 100)}% and above`,
    outcome: "Ready to accept. A reviewer still signs off unless auto-accept is enabled.",
  },
  medium: {
    label: "Medium",
    range: `${Math.round(MEDIUM_BAND_MIN * 100)}–${Math.round(HIGH_BAND_MIN * 100)}%`,
    outcome: "Ready to accept, flagged for a spot-check.",
  },
  low: {
    label: "Low",
    range: `Below ${Math.round(MEDIUM_BAND_MIN * 100)}%`,
    outcome: "Routed to the review queue with the reason attached.",
  },
};

/** Any one of these sends a field to the review queue, whatever its score. */
export const ROUTING_REASONS = [
  { label: "Low confidence", detail: `Score below ${Math.round(MEDIUM_BAND_MIN * 100)}%.` },
  {
    label: "Validation failed",
    detail: `The value doesn't match its expected shape (date, amount, UEI, PIID). Capped at ${Math.round(VALIDATION_FAILED_CAP * 100)}%.`,
  },
  { label: "Not source-grounded", detail: "The value can't be located on the cited page." },
  { label: "Ambiguous candidates", detail: "Two or more plausible values compete for the same field." },
  { label: "AI escalation", detail: "Rules couldn't resolve it, so a model did. A person confirms it." },
] as const;
