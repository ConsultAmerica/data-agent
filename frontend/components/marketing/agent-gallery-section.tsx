import Link from "next/link";
import {
  ArrowRight,
  CalendarClock,
  ClipboardList,
  FileBarChart2,
  GitCompareArrows,
  ListChecks,
  Wallet,
} from "lucide-react";

/** Finished outputs built on reviewed, source-grounded data — each one
 * cites the page it came from instead of generating new facts. */
const AGENTS = [
  {
    title: "Obligations tracker",
    description:
      "Deliverables, reporting duties, option windows and performance end dates, pulled from schedules, clauses and contract text, with what's due soon at the top.",
    href: "/obligations",
    icon: CalendarClock,
    tag: "Track",
  },
  {
    title: "Clause playbook",
    description:
      "Set which FAR and DFARS clauses you expect, flag for review or prohibit. Every contract is checked against the playbook and deviations are flagged.",
    href: "/playbook",
    icon: ListChecks,
    tag: "Govern",
  },
  {
    title: "Document compare",
    description:
      "Put a modification next to its base award: changed CLINs, funding, periods and clauses, with the dollar and quantity deltas.",
    href: "/compare",
    icon: GitCompareArrows,
    tag: "Compare",
  },
  {
    title: "Executive summary",
    description:
      "A one-page brief: parties, ceiling, periods, clause mix, obligations due and open review items.",
    href: "/actions",
    icon: FileBarChart2,
    tag: "Action",
  },
  {
    title: "Risk register",
    description:
      "Playbook deviations, low-confidence fields, missing key data and funding gaps, each with severity and source page.",
    href: "/actions",
    icon: ClipboardList,
    tag: "Action",
  },
  {
    title: "Funding reconciliation",
    description:
      "Compares priced CLINs with funded lines and the ceiling, and flags unfunded or overfunded lines before they reach Oracle.",
    href: "/actions",
    icon: Wallet,
    tag: "Action",
  },
] as const;

export default function AgentGallerySection() {
  return (
    <section id="agents" className="scroll-mt-24">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <p className="section-eyebrow">Agents that finish the work</p>
          <h2 className="section-title">Go from extracted fields to a decision.</h2>
          <p className="section-lede">
            Each agent reads the verified staging data, not raw model output,
            and produces something a contracting team can act on.
            Exports to CSV or Markdown.
          </p>
        </div>
        <Link
          href="/actions"
          className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
        >
          Browse all actions
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {AGENTS.map((agent) => (
          <Link key={agent.title} href={agent.href} className="pillar-card group block transition hover:border-primary/40">
            <div className="flex items-start justify-between gap-3">
              <agent.icon className="h-5 w-5 text-primary" strokeWidth={1.75} />
              <span className="rounded-full border border-border bg-surface-soft px-2 py-0.5 text-[11px] font-semibold text-text-secondary">
                {agent.tag}
              </span>
            </div>
            <h3 className="pillar-title flex items-center gap-1.5">
              {agent.title}
              <ArrowRight className="h-3.5 w-3.5 opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
            </h3>
            <p className="pillar-body">{agent.description}</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
