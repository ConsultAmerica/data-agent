import { FIELD_TONE_LABELS, type FieldTone } from "@/lib/field-tone";

const ORDER: FieldTone[] = ["ok", "review", "failed"];

/** Key for the inline value highlights (see lib/field-tone). */
export default function FieldToneLegend({ className = "" }: { className?: string }) {
  return (
    <ul
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary ${className}`}
      aria-label="Value highlight key"
      data-testid="field-tone-legend"
    >
      {ORDER.map((tone) => (
        <li key={tone} className="inline-flex items-center gap-1.5">
          <span className={`field-tone-swatch field-tone-${tone}`} aria-hidden="true" />
          {FIELD_TONE_LABELS[tone]}
        </li>
      ))}
    </ul>
  );
}
