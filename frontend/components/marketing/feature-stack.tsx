"use client";

import Link from "next/link";
import { useEffect, useRef, type ReactNode } from "react";
import {
  ArrowRight,
  CalendarClock,
  Check,
  Download,
  FileSpreadsheet,
  FileText,
  ListChecks,
  MessageSquareText,
  ShieldAlert,
  Sparkles,
  Wallet,
} from "lucide-react";

/** FloQast-style stacked feature cards: copy on one side, a product mockup on
 * a gradient panel on the other, alternating. Mockup data is the fictional
 * sample contract (lib/sample/sample-extraction.json). */

interface Feature {
  id: string;
  eyebrow: string;
  title: string;
  body: string;
  points: string[];
  cta: { label: string; href: string };
  links?: { label: string; href: string }[];
  tone: "teal" | "cyan" | "violet" | "deep";
  visual: ReactNode;
}

const FEATURES: Feature[] = [
  {
    id: "extract",
    eyebrow: "Extraction agent",
    title: "From PDF to reviewed records, step by step.",
    body: "The agent reads the form blocks, CLIN schedule and clause list with rules and page layout, scores every value, and hands you only the ones it can't stand behind.",
    points: [
      "Every value is boxed on its source page",
      "Low-confidence and ambiguous values route to a reviewer with the reason",
      "Repeating records stay one row each: CLINs, funding lines, clauses",
    ],
    cta: { label: "Walk through the sample contract", href: "/sample" },
    tone: "teal",
    visual: <ExtractionVisual />,
  },
  {
    id: "ask",
    eyebrow: "Ask Dataomatix",
    title: "Answers that cite the page they came from.",
    body: "Ask in plain English across one contract or the whole repository. Answers come from extracted fields, clause references and the contract text, and each citation opens the source page with the passage highlighted.",
    points: [
      "Clause shorthand understood: “cybersecurity” finds 252.204-7012",
      "No model writes the answer, so nothing is invented",
      "Prompt chips for common compliance questions",
    ],
    cta: { label: "Ask a question", href: "/ask" },
    tone: "cyan",
    visual: <AskVisual />,
  },
  {
    id: "govern",
    eyebrow: "Obligations, playbook and rules",
    title: "Know what you owe, and what's missing.",
    body: "Deadlines and duties come out of schedules, clauses and text. A clause playbook and validation rules check every contract the same way, and deviations are flagged before export.",
    points: [
      "Obligations tracker with due-soon and overdue views",
      "Required, prohibited and review-if-present clauses",
      "Regex, threshold and cross-field validation rules",
    ],
    cta: { label: "Open the obligations tracker", href: "/obligations" },
    links: [
      { label: "Clause playbook", href: "/playbook" },
      { label: "Compare documents", href: "/compare" },
    ],
    tone: "violet",
    visual: <GovernVisual />,
  },
  {
    id: "actions",
    eyebrow: "Agent actions",
    title: "One click to the report someone asked for.",
    body: "Executive summary, risk register, clause gap report, obligations register and funding reconciliation, built from the reviewed staging data and downloadable as CSV or Markdown.",
    points: [
      "Every row cites its page",
      "Built from the same values the document page shows",
      "Runs on any processed document",
    ],
    cta: { label: "Browse agent actions", href: "/actions" },
    tone: "deep",
    visual: <ActionsVisual />,
  },
];

/** Cards animate in as they scroll into view, once. The hidden starting
 * state only applies after this runs (motion-ready), so without JS or with
 * reduced motion every card is simply visible. */
function useRevealOnScroll() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const cards = Array.from(root.querySelectorAll<HTMLElement>(".feature-card"));
    if (reduce || typeof IntersectionObserver === "undefined") {
      cards.forEach((card) => card.classList.add("is-in-view"));
      return;
    }
    root.classList.add("motion-ready");
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in-view");
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.2, rootMargin: "0px 0px -8% 0px" },
    );
    cards.forEach((card) => observer.observe(card));
    return () => observer.disconnect();
  }, []);
  return ref;
}

export default function FeatureStack() {
  const ref = useRevealOnScroll();
  return (
    <div className="feature-stack" ref={ref}>
      {FEATURES.map((feature, index) => (
        <article
          key={feature.id}
          id={`feature-${feature.id}`}
          className={`feature-card ${index % 2 === 1 ? "is-reversed" : ""}`}
        >
          <div className="feature-card-copy">
            <p className="section-eyebrow">{feature.eyebrow}</p>
            <h3 className="feature-card-title">{feature.title}</h3>
            <p className="feature-card-body">{feature.body}</p>
            <ul className="mt-5 space-y-2.5">
              {feature.points.map((point) => (
                <li key={point} className="flex gap-2.5 text-sm text-text-secondary">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" strokeWidth={2.25} />
                  {point}
                </li>
              ))}
            </ul>
            <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
              <Link href={feature.cta.href} className="btn-primary inline-flex items-center gap-1.5 px-4 py-2.5 text-sm">
                {feature.cta.label}
                <ArrowRight className="h-4 w-4" />
              </Link>
              {feature.links?.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                >
                  {link.label}
                  <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              ))}
            </div>
          </div>
          <div className={`feature-visual is-${feature.tone}`} aria-hidden="true">
            {feature.visual}
          </div>
        </article>
      ))}
    </div>
  );
}

function ExtractionVisual() {
  const steps = [
    "Read SF 1449 form blocks",
    "Map the CLIN schedule",
    "Detect FAR / DFARS clauses",
    "Score confidence per value",
    "Route 3 values to a reviewer",
    "Stage reviewed values",
  ];
  return (
    <div className="relative mx-auto w-full max-w-[26rem]">
      <ol className="space-y-2">
        {steps.map((step, index) => (
          <li key={step} className="mock-step">
            <span className="mock-step-check">
              <Check className="h-3 w-3" strokeWidth={3} />
            </span>
            {index + 1}. {step}
          </li>
        ))}
      </ol>
      <div className="mock-float-card -right-2 bottom-2 w-[15.5rem] sm:-right-8">
        <p className="text-sm font-semibold text-[var(--text-dark)]">Results</p>
        <div className="mt-3 space-y-2">
          <p className="mock-file">
            <FileSpreadsheet className="h-4 w-4 text-[#1f7a55]" />
            <span className="truncate">Staging workbook.xlsx</span>
            <Download className="ml-auto h-3.5 w-3.5 text-[var(--text-muted)]" />
          </p>
          <p className="mock-file">
            <FileText className="h-4 w-4 text-[#0a6eb4]" />
            <span className="truncate">Clauses.csv</span>
            <Download className="ml-auto h-3.5 w-3.5 text-[var(--text-muted)]" />
          </p>
        </div>
        <div className="mt-3 flex items-center justify-between text-xs">
          <span className="text-[var(--text-muted)]">
            Run by <span className="font-semibold text-[var(--text-dark)]">Sample reviewer</span>
          </span>
          <span className="rounded-md bg-[#e6f4ee] px-2 py-1 font-semibold text-[#1f7a55]">Completed</span>
        </div>
        <p className="mt-2 text-[11px] tabular-nums text-[var(--text-muted)]">08/19/2026 · 9:15 AM</p>
      </div>
    </div>
  );
}

function AskVisual() {
  return (
    <div className="mx-auto w-full max-w-[26rem] space-y-3">
      <div className="mock-card ml-auto max-w-[19rem]">
        <p className="flex items-start gap-2 text-[13px] leading-5 text-[var(--text-dark)]">
          <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-muted)]" />
          Which DFARS cybersecurity clauses does this contract include?
        </p>
      </div>
      <div className="mock-card">
        <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#0a6eb4]">
          <Sparkles className="h-3.5 w-3.5" />
          Answer · cited from source pages
        </p>
        <p className="mt-2 text-[13px] leading-6 text-[var(--text-dark)]">
          DFARS 252.204-7012 (Safeguarding Covered Defense Information and Cyber Incident Reporting)
          appears in sample-contract.pdf<span className="mock-cite">1</span>. FAR 52.204-21 Basic
          Safeguarding is also{" "}
          <span className="whitespace-nowrap">
            cited<span className="mock-cite">2</span>.
          </span>
        </p>
        <div className="mt-3 space-y-1.5">
          {[
            ["1", "sample-contract.pdf · p. 2", "DFARS 252.204-7012 … Cyber Incident Reporting (MAY 2024)"],
            ["2", "sample-contract.pdf · p. 2", "FAR 52.204-21 Basic Safeguarding of Covered Contractor…"],
          ].map(([n, where, snippet]) => (
            <p key={n} className="flex items-center gap-2 rounded-lg bg-[#f2f7f7] px-2.5 py-1.5 text-[11px]">
              <span className="mock-cite !ml-0">{n}</span>
              <span className="shrink-0 text-[var(--text-muted)]">{where}</span>
              <span className="truncate text-[var(--text-dark)]">{snippet}</span>
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

function GovernVisual() {
  const obligations = [
    { title: "Report cyber incidents to DoD", due: "Within 72 hours", source: "DFARS 252.204-7012", tone: "warn" },
    { title: "Apply basic safeguarding controls", due: "Ongoing", source: "FAR 52.204-21", tone: "ok" },
    { title: "Keep EFT details current in SAM", due: "Ongoing", source: "FAR 52.232-33", tone: "ok" },
    { title: "Period of performance ends", due: "08/31/2027", source: "Period of performance · p. 1", tone: "info" },
  ] as const;
  return (
    <div className="relative mx-auto w-full max-w-[26rem] pb-16">
      <div className="mock-card">
        <p className="flex items-center gap-2 text-sm font-semibold text-[var(--text-dark)]">
          <CalendarClock className="h-4 w-4 text-[#0a6eb4]" />
          Obligations
        </p>
        <ul className="mt-3 divide-y divide-[#e3ecee]">
          {obligations.map((item) => (
            <li key={item.title} className="flex items-center gap-3 py-2 text-[12px]">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-[var(--text-dark)]">{item.title}</span>
                <span className="text-[var(--text-muted)]">{item.source}</span>
              </span>
              <span
                className={[
                  "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold",
                  item.tone === "warn"
                    ? "bg-[#fbf1df] text-[#9a6a17]"
                    : item.tone === "info"
                      ? "bg-[#e3f2f9] text-[#0a6eb4]"
                      : "bg-[#e6f4ee] text-[#1f7a55]",
                ].join(" ")}
              >
                {item.due}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="mock-float-card -left-2 bottom-0 w-[15rem] sm:-left-8">
        <p className="flex items-center gap-2 text-sm font-semibold text-[var(--text-dark)]">
          <ListChecks className="h-4 w-4 text-[var(--primary)]" />
          Clause playbook
        </p>
        <div className="mt-2.5 space-y-1.5 text-[12px]">
          <p className="flex items-center justify-between gap-2">
            <span className="tabular-nums">52.204-21</span>
            <span className="rounded bg-[#e6f4ee] px-1.5 py-0.5 text-[10px] font-semibold text-[#1f7a55]">Satisfied</span>
          </p>
          <p className="flex items-center justify-between gap-2">
            <span className="tabular-nums">252.204-7019</span>
            <span className="rounded bg-[#fbe7e7] px-1.5 py-0.5 text-[10px] font-semibold text-[#b33c3c]">Missing</span>
          </p>
        </div>
      </div>
    </div>
  );
}

function ActionsVisual() {
  const actions = [
    { icon: FileText, title: "Executive summary", note: "Parties, value, periods, clause mix" },
    { icon: ShieldAlert, title: "Risk register", note: "Deviations and flagged fields, with pages" },
    { icon: Wallet, title: "Funding reconciliation", note: "Priced CLINs vs funded lines" },
  ];
  return (
    <div className="mx-auto w-full max-w-[26rem] space-y-2.5">
      {actions.map((action, index) => (
        <div key={action.title} className="mock-card flex items-center gap-3 !py-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#e6eff0] text-[var(--primary)]">
            <action.icon className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold text-[var(--text-dark)]">{action.title}</span>
            <span className="block truncate text-[11px] text-[var(--text-muted)]">{action.note}</span>
          </span>
          {index === 0 ? (
            <span className="shrink-0 rounded-md bg-[#e6f4ee] px-2 py-1 text-[11px] font-semibold text-[#1f7a55]">
              CSV · MD
            </span>
          ) : (
            <span className="shrink-0 rounded-md border border-[#c8dadc] px-2.5 py-1 text-[11px] font-semibold text-[var(--primary)]">
              Run
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
