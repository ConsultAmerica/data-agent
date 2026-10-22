import type { CSSProperties } from "react";
import {
  Bot,
  Cloud,
  Container,
  Database,
  FileSpreadsheet,
  FileText,
  Landmark,
  Receipt,
  ScanText,
  ScrollText,
  Server,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

export interface MarqueeItem {
  name: string;
  /** Shown when there is no logo image. */
  icon?: LucideIcon;
  /** Accent for the icon and its chip (the system's own brand color, roughly). */
  color?: string;
  /** A logo you have the right to show (e.g. a customer who agreed to it). */
  logo?: string;
}

/** Systems Dataomatix actually runs on or exports to. Only list a customer
 * here once they've agreed to be shown. */
export const WORKS_WITH: MarqueeItem[] = [
  { name: "Oracle Fusion Cloud", icon: Landmark, color: "#c74634" },
  { name: "PostgreSQL", icon: Database, color: "#336791" },
  { name: "Docker", icon: Container, color: "#2496ed" },
  { name: "AWS GovCloud (US)", icon: Cloud, color: "#ff9900" },
  { name: "Azure Government", icon: Cloud, color: "#0078d4" },
  { name: "Supabase Storage", icon: Server, color: "#3ecf8e" },
  { name: "Tesseract OCR", icon: ScanText, color: "#5c6bc0" },
  { name: "Ollama (local models)", icon: Bot, color: "#475569" },
  { name: "Google Gemini", icon: Sparkles, color: "#8e75ff" },
  { name: "OpenAI", icon: Sparkles, color: "#10a37f" },
  { name: "Microsoft Excel", icon: FileSpreadsheet, color: "#217346" },
];

/** Document families the pipeline has profiles for. */
export const READS: MarqueeItem[] = [
  { name: "Contract awards", icon: FileText, color: "#0e7490" },
  { name: "Purchase orders", icon: FileText, color: "#0891b2" },
  { name: "FAR clauses", icon: ScrollText, color: "#7c3aed" },
  { name: "DFARS clauses", icon: ScrollText, color: "#b45309" },
  { name: "Line item schedules", icon: FileSpreadsheet, color: "#15803d" },
  { name: "Funding lines", icon: Landmark, color: "#ca8a04" },
  { name: "Invoices", icon: Receipt, color: "#db2777" },
  { name: "Regulations", icon: ScrollText, color: "#4f46e5" },
];

/** Seconds per item: rows of different lengths move at about the same speed. */
const SECONDS_PER_ITEM = 4.2;

function Track({
  items,
  reverse = false,
  label,
  caption,
}: {
  items: MarqueeItem[];
  reverse?: boolean;
  label: string;
  caption: string;
}) {
  const row = (hidden: boolean) => (
    <ul className="da-marquee-row" aria-hidden={hidden || undefined} aria-label={hidden ? undefined : label}>
      {items.map((item, index) => (
        <li
          key={item.name}
          className="da-marquee-item"
          style={{ "--da-accent": item.color ?? "currentColor", "--da-float-delay": `${(index % 5) * -0.6}s` } as CSSProperties}
        >
          {item.logo ? (
            // eslint-disable-next-line @next/next/no-img-element -- small static logos
            <img src={item.logo} alt={item.name} className="h-7 w-auto" />
          ) : (
            <>
              {item.icon && (
                <span className="da-marquee-chip" aria-hidden="true">
                  <item.icon className="h-5 w-5" strokeWidth={1.8} />
                </span>
              )}
              <span>{item.name}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="da-marquee-line">
      <span className="da-marquee-caption">{caption}</span>
      <div
        className={`da-marquee ${reverse ? "da-marquee-reverse" : ""}`}
        style={{ "--da-marquee-duration": `${items.length * SECONDS_PER_ITEM}s` } as CSSProperties}
      >
        <div className="da-marquee-track">
          {row(false)}
          {row(true)}
        </div>
      </div>
    </div>
  );
}

/** Two opposite-direction strips of colored chips. Each row slows to a stop
 * under the pointer; everything holds still for people who ask for reduced
 * motion. */
export default function LogoMarquee({
  heading = "Works with the systems federal teams already run",
  tone = "dark",
}: {
  heading?: string;
  tone?: "dark" | "light";
}) {
  return (
    <section className={`da-marquee-band ${tone === "dark" ? "da-marquee-dark" : "da-marquee-light"}`} aria-label={heading}>
      <style>{`
        .da-marquee-band { padding: 2.25rem 0 2.5rem; overflow: hidden; }
        .da-marquee-dark { background: #0b2530; color: rgba(247, 250, 250, 0.86); }
        .da-marquee-light { background: var(--surface, #ffffff); color: var(--text-dark, #0f2a33);
          border-top: 1px solid var(--border, #e2e8f0); border-bottom: 1px solid var(--border, #e2e8f0); }
        .da-marquee-heading { text-align: center; font-size: 0.8125rem; font-weight: 600; letter-spacing: 0.12em;
          text-transform: uppercase; margin-bottom: 1.4rem; padding: 0 1rem; }
        .da-marquee-light .da-marquee-heading { color: var(--text-muted, #64748b); }
        .da-marquee-dark .da-marquee-heading { color: #f7fafa; }

        .da-marquee-lines { margin: 0 auto; max-width: var(--layout-marketing-max, 100rem); padding: 0 1.5rem;
          display: grid; gap: 0.65rem; }
        .da-marquee-line { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr); align-items: center; gap: 1rem; }
        .da-marquee-caption { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase;
          text-align: right; color: var(--text-muted, #64748b); }
        .da-marquee-dark .da-marquee-caption { color: rgba(247, 250, 250, 0.6); }
        @media (max-width: 639px) {
          .da-marquee-lines { padding: 0; }
          .da-marquee-line { grid-template-columns: minmax(0, 1fr); gap: 0.25rem; }
          .da-marquee-caption { text-align: center; }
        }
        .da-marquee { position: relative; overflow: hidden; padding: 0.5rem 0;
          -webkit-mask-image: linear-gradient(90deg, transparent, #000 7%, #000 93%, transparent);
                  mask-image: linear-gradient(90deg, transparent, #000 7%, #000 93%, transparent); }
        /* Two identical rows, each ending in the same gap it uses between items,
           so -50% lands exactly where the second row began: no seam, no jump. */
        .da-marquee-track { display: flex; width: max-content; will-change: transform;
          animation: da-marquee var(--da-marquee-duration, 46s) linear infinite; }
        .da-marquee-reverse .da-marquee-track { animation-direction: reverse; }
        .da-marquee:hover .da-marquee-track { animation-play-state: paused; }
        .da-marquee-row { display: flex; align-items: center; gap: 0.85rem; padding-right: 0.85rem; margin: 0; list-style: none; }

        /* Each entry is a tile: colored icon chip + name. */
        .da-marquee-item { display: inline-flex; align-items: center; gap: 0.65rem; white-space: nowrap;
          padding: 0.4rem 1rem 0.4rem 0.45rem; border-radius: 999px;
          font-size: 0.95rem; font-weight: 600; letter-spacing: -0.01em;
          background: var(--surface, #fff); border: 1px solid var(--border, #e2e8f0);
          box-shadow: 0 1px 2px rgba(15, 42, 51, 0.05);
          transition: transform 0.25s ease, color 0.25s ease, border-color 0.25s ease, box-shadow 0.25s ease; }
        .da-marquee-dark .da-marquee-item { background: rgba(255, 255, 255, 0.05); border-color: rgba(255, 255, 255, 0.12); box-shadow: none; }
        .da-marquee-item:hover { transform: translateY(-2px); color: var(--da-accent);
          border-color: color-mix(in srgb, var(--da-accent) 45%, transparent);
          box-shadow: 0 8px 20px color-mix(in srgb, var(--da-accent) 18%, transparent); }
        .da-marquee-chip { display: inline-flex; align-items: center; justify-content: center;
          width: 2.1rem; height: 2.1rem; border-radius: 999px; color: var(--da-accent);
          background: color-mix(in srgb, var(--da-accent) 13%, transparent);
          box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--da-accent) 28%, transparent);
          animation: da-float 3.6s ease-in-out infinite; animation-delay: var(--da-float-delay, 0s);
          transition: transform 0.25s ease, box-shadow 0.25s ease, background 0.25s ease; }
        .da-marquee-item:hover .da-marquee-chip { transform: scale(1.08);
          background: color-mix(in srgb, var(--da-accent) 20%, transparent);
          box-shadow: inset 0 0 0 1px var(--da-accent); }
        .da-marquee-dark .da-marquee-chip { background: color-mix(in srgb, var(--da-accent) 22%, transparent); }

        @keyframes da-marquee { from { transform: translate3d(0, 0, 0); } to { transform: translate3d(-50%, 0, 0); } }
        @keyframes da-float { 0%, 100% { translate: 0 0; } 50% { translate: 0 -3px; } }

        @media (prefers-reduced-motion: reduce) {
          .da-marquee-track { animation: none; flex-wrap: wrap; width: auto; justify-content: center; }
          .da-marquee-row[aria-hidden] { display: none; }
          .da-marquee-row { flex-wrap: wrap; justify-content: center; row-gap: 1rem; padding: 0 1rem; }
          .da-marquee { -webkit-mask-image: none; mask-image: none; }
          .da-marquee-chip { animation: none; }
          .da-marquee-item, .da-marquee-chip { transition: none; }
          .da-marquee-item:hover { transform: none; }
          .da-marquee-line { grid-template-columns: minmax(0, 1fr); }
          .da-marquee-caption { text-align: center; }
        }
      `}</style>
      <p className="da-marquee-heading">{heading}</p>
      <div className="da-marquee-lines">
        <Track items={WORKS_WITH} caption="Runs on" label="Systems Dataomatix works with" />
        <Track items={READS} reverse caption="Reads" label="Documents Dataomatix reads" />
      </div>
    </section>
  );
}
