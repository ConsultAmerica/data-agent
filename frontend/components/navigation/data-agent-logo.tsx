/**
 * Brand mark + wordmark.
 * Teal document mark + type lockup for dark/light chrome (no JPG white box).
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
  /** `onDark` for teal chrome; `onLight` for drawers / light surfaces */
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
      <rect width="40" height="40" rx="10" fill="#0d5b61" />
      <path
        d="M12 9.5h11.2L28 14.2V30.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 12 30.5v-21A1.5 1.5 0 0 1 13.5 8"
        fill="#f7fafa"
      />
      <path d="M23.2 9.5V14H28L23.2 9.5Z" fill="#b8cfd1" />
      <rect x="15.5" y="17" width="9" height="1.6" rx="0.8" fill="#0d5b61" opacity="0.55" />
      <rect x="15.5" y="20.5" width="12" height="1.6" rx="0.8" fill="#0d5b61" opacity="0.4" />
      <rect x="15.5" y="24" width="7" height="1.6" rx="0.8" fill="#0d5b61" opacity="0.4" />
      <path
        d="M8.5 22.5h3.2M31.5 18.5h-2.8"
        stroke="#a33eb2"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="30.2" cy="25.8" r="2.2" fill="#a33eb2" />
      <circle cx="30.2" cy="25.8" r="0.9" fill="#f7fafa" />
    </svg>
  );
}
