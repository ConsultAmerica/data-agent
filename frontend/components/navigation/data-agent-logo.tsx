import Image from "next/image";

/**
 * Brand mark + wordmark from the cyan document-stack lockup.
 * Mark uses the real logo art; type adapts for dark/light chrome.
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
    const markSize = Math.round(size * 0.95);
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
        <BrandMark size={markSize} title={title} />
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
    <Image
      src="/brand/data-agent-mark.png"
      alt={title}
      width={size}
      height={size}
      className={["da-logo-mark", className].filter(Boolean).join(" ")}
      style={{ width: size, height: size, objectFit: "contain" }}
      priority
    />
  );
}
