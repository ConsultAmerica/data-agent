import type { ReactNode } from "react";

interface PageHeroProps {
  eyebrow?: string;
  /** Hero-level brand signal (product name). Prefer over a small eyebrow on marketing. */
  brand?: ReactNode;
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
  visual?: ReactNode;
  /** Small secondary line under the description (e.g. specialization link). */
  specialization?: ReactNode;
  /** Shorter hero for task pages, so the working surface sits above the fold. */
  compact?: boolean;
  /** Marketing home: quieter first viewport (hides preview earlier). */
  marketing?: boolean;
}

export default function PageHero({
  eyebrow,
  brand,
  title,
  description,
  actions,
  visual,
  specialization,
  compact = false,
  marketing = false,
}: PageHeroProps) {
  return (
    <section
      className={[
        compact ? "page-hero page-hero-compact" : "page-hero",
        brand ? "page-hero-branded" : "",
        marketing ? "page-hero-marketing" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="page-hero-atmosphere" aria-hidden="true" />
      <div
        className={[
          "page-hero-inner",
          visual ? "page-hero-split" : "",
        ].join(" ")}
      >
        <div className="page-hero-copy min-w-0 w-full">
          {brand && <div className="page-hero-brand reveal-up">{brand}</div>}
          {!brand && eyebrow && <p className="page-hero-eyebrow">{eyebrow}</p>}
          <h1 className="page-hero-title reveal-up reveal-up-delay-1">{title}</h1>
          {description && (
            <div className="page-hero-description-wrap max-w-2xl reveal-up reveal-up-delay-2">
              <p className="page-hero-description">{description}</p>
            </div>
          )}
          {specialization && (
            <div className="mt-3 reveal-up reveal-up-delay-2">{specialization}</div>
          )}
          {actions && (
            <div className="page-hero-actions reveal-up reveal-up-delay-3">{actions}</div>
          )}
        </div>
        {visual && (
          <div className="page-hero-visual reveal-up reveal-up-delay-2">{visual}</div>
        )}
      </div>
    </section>
  );
}
