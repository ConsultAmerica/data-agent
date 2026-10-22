import { HIGH_BAND_MIN, MEDIUM_BAND_MIN, confidenceBand } from "@/lib/confidence-policy";

/** Accepts 0-1 or 0-100. */
export function normalizeConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const fraction = value > 1 ? value / 100 : value;
  return Math.min(1, Math.max(0, fraction));
}

const BAND_STYLE = {
  high: { bar: "bg-[var(--success)]", text: "text-[var(--success)]", label: "high" },
  medium: { bar: "bg-[var(--warning)]", text: "text-[var(--warning)]", label: "medium" },
  low: { bar: "bg-[var(--danger)]", text: "text-[var(--danger)]", label: "low" },
} as const;

/** A miniature color-coded confidence bar with its percent. Bands follow the
 * public confidence policy: green at or above HIGH_BAND_MIN, amber from
 * MEDIUM_BAND_MIN, red below. */
export default function ConfidenceMeter({
  value,
  size = "sm",
  showLabel = true,
  className = "",
}: {
  value: number;
  size?: "sm" | "md";
  showLabel?: boolean;
  className?: string;
}) {
  const fraction = normalizeConfidence(value);
  const percent = Math.round(fraction * 100);
  const band = confidenceBand(fraction);
  const style = BAND_STYLE[band];
  return (
    <span
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label={`Confidence ${percent}%`}
      title={`Confidence ${percent}% (${style.label}: high ≥ ${Math.round(HIGH_BAND_MIN * 100)}%, medium ≥ ${Math.round(MEDIUM_BAND_MIN * 100)}%)`}
      data-band={band}
      className={`inline-flex items-center gap-1.5 align-middle ${className}`}
    >
      <span
        className={`relative inline-block overflow-hidden rounded-full bg-[var(--border)] ${size === "md" ? "h-1.5 w-14" : "h-1 w-10"}`}
        aria-hidden="true"
      >
        <span className={`absolute inset-y-0 left-0 rounded-full ${style.bar}`} style={{ width: `${percent}%` }} />
      </span>
      {showLabel && (
        <span className={`tabular-nums font-medium ${style.text} ${size === "md" ? "text-xs" : "text-[11px]"}`}>
          {percent}%
        </span>
      )}
    </span>
  );
}
