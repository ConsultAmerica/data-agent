import { confidenceBand, type ConfidenceBand } from "@/lib/confidence-policy";
import type { StagingCell } from "@/lib/staging-workbook";

/**
 * Inline highlight for an extracted value, so anomalies stand out without
 * reading a status column: green = verified / high confidence, amber =
 * needs review / medium, red = failed validation (FAR/DFARS format, type,
 * required) or low confidence.
 */
export type FieldTone = "ok" | "review" | "failed";

const BAND_TONE: Record<ConfidenceBand, FieldTone> = { high: "ok", medium: "review", low: "failed" };

/** From a confidence score (0-1 or 0-100) and/or its band; a failed
 * validation always wins. */
export function toneFromConfidence(
  confidence: number | null | undefined,
  band?: string | null,
  validationFailed = false,
): FieldTone | null {
  if (validationFailed) return "failed";
  if (band === "high" || band === "medium" || band === "low") return BAND_TONE[band];
  if (confidence == null || !Number.isFinite(confidence)) return null;
  return BAND_TONE[confidenceBand(confidence > 1 ? confidence / 100 : confidence)];
}

/** From a staging cell's QA status (staging never infers status from OCR
 * confidence alone). Empty values get no tone. */
export function toneFromStagingCell(cell: StagingCell | null | undefined): FieldTone | null {
  if (!cell || cell.value == null || cell.value === "") return null;
  if (cell.validation?.status === "failed") return "failed";
  if (cell.review_status === "Needs Review") return "review";
  if (cell.review_status === "Verified") return "ok";
  return null;
}

export const FIELD_TONE_LABELS: Record<FieldTone, string> = {
  ok: "Verified / high confidence",
  review: "Needs review",
  failed: "Failed validation / low confidence",
};

/** "cell": a left accent bar on a (position: relative) table cell, which
 * leaves the cell's hover/selection backgrounds alone. "text": a tint
 * behind an inline value. */
export function fieldToneClass(tone: FieldTone | null, variant: "cell" | "text" = "text"): string {
  return tone ? `field-tone field-tone-${tone} field-tone-${variant}` : "";
}
