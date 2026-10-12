/**
 * Brand mark + wordmark.
 * Forest-green / gold document stack — rendered as SVG + type so it sits
 * cleanly on dark chrome (no JPG white box).
 */
export default function DataAgentLogo({
  size = 36,
  className,
  title = "Data Agent",
  variant = "mark",
  tone = "onDark",
}: {
  size?: number;
  className?: string;
  title?: string;
  /** `mark` = compact icon; `wordmark` = icon + DataAgent + tagline */
  variant?: "mark" | "wordmark";
  /** `onDark` for teal/forest chrome; `onLight` for drawers / light surfaces */
  tone?: "onDark" | "onLight";
}) {
  if (variant === "wordmark") {
    const markSize = Math.round(size * 0.92);
    const onDark = tone === "onDark";
    return (
      <span
        className={["da-logo-lockup", onDark ? "da-logo-on-dark" : "da-logo-on-light", className]
          .filter(Boolean)
          .join(" ")}
        role="img"
        aria-label={title}
        style={{ ["--da-logo-size" as string]: `${size}px` }}
      >
        <BrandMark size={markSize} />
        <span className="da-logo-text">
          <span className="da-logo-word">
            <span className="da-logo-data">Data</span>
            <span className="da-logo-agent">
              <span className="da-logo-a" aria-hidden="true">
                A
              </span>
              <span className="da-logo-gent">gent</span>
            </span>
          </span>
          <span className="da-logo-tag">Document Intelligence</span>
        </span>
      </span>
    );
  }

  return <BrandMark size={size} className={className} title={title} />;
}

function BrandMark({
  size,
  className,
  title = "Data Agent",
}: {
  size: number;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={["da-logo-mark", className].filter(Boolean).join(" ")}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <rect width="40" height="40" rx="10" fill="#1f3f32" />
      <rect
        x="9"
        y="10"
        width="14"
        height="18"
        rx="2"
        transform="rotate(-12 16 19)"
        fill="#2d4f3c"
        opacity="0.95"
      />
      <rect
        x="13"
        y="9"
        width="14"
        height="18"
        rx="2"
        transform="rotate(-4 20 18)"
        fill="#c4af8a"
        opacity="0.92"
      />
      <rect x="16" y="8" width="14" height="18" rx="2" fill="#f4f1ea" />
      <rect x="18.5" y="12.5" width="9" height="1.4" rx="0.7" fill="#2d4f3c" opacity="0.55" />
      <rect x="18.5" y="16" width="9" height="1.4" rx="0.7" fill="#2d4f3c" opacity="0.4" />
      <rect x="18.5" y="19.5" width="6.5" height="1.4" rx="0.7" fill="#2d4f3c" opacity="0.4" />
      <rect x="6" y="14" width="2.2" height="2.2" rx="0.4" fill="#c4af8a" />
      <rect x="4.5" y="18.5" width="1.6" height="1.6" rx="0.3" fill="#2d4f3c" />
      <rect x="7" y="21.5" width="1.8" height="1.8" rx="0.3" fill="#c4af8a" opacity="0.85" />
    </svg>
  );
}
