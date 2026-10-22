"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import ContentSection from "@/components/layout/ContentSection";
import PageHero from "@/components/layout/PageHero";
import { topMenu, type NavTile, type TopMenu } from "@/components/navigation/nav-config";
import { getPortfolio, type Portfolio } from "@/lib/portfolio";

/** A live figure for a tile, when the portfolio has one for its page. */
function metricFor(href: string, portfolio: Portfolio): string | null {
  const path = href.split(/[?#]/)[0];
  const family = new URLSearchParams(href.split("?")[1] ?? "").get("family");
  const n = (value: number) => value.toLocaleString();
  if (family) {
    const label: Record<string, RegExp> = {
      invoice: /invoice/i,
      academic_transcript: /transcript/i,
      government_contract: /government contract/i,
      far_regulation: /far/i,
      correspondence: /correspondence/i,
    };
    const match = portfolio.document_mix.find((item) => label[family]?.test(item.name));
    return match ? `${n(match.count)} documents` : null;
  }
  if (href === "/documents?filter=failed") return `${n(portfolio.totals.failed)} failed`;
  if (href === "/documents?filter=review") return `${n(portfolio.review.low_confidence_documents)} with low-confidence values`;
  switch (path) {
    case "/documents":
      return `${n(portfolio.totals.documents)} documents`;
    case "/review-queue":
      return `${n(portfolio.review.pending)} values awaiting a decision`;
    case "/analytics":
      return `${n(portfolio.totals.processed)} processed`;
    case "/risk":
      return `${n(portfolio.risks.by_severity.high + portfolio.risks.by_severity.medium)} findings to act on`;
    case "/clauses":
      return `${n(portfolio.clauses.references)} clause references`;
    case "/insights":
      return `${n(portfolio.contracts.count)} contracts`;
    case "/audit-log":
    case "/activity": {
      const decided = portfolio.review.accepted + portfolio.review.edited + portfolio.review.rejected;
      return `${n(decided)} review decisions`;
    }
    default:
      return null;
  }
}

function Tile({ tile, metric }: { tile: NavTile; metric: string | null }) {
  return (
    <Link
      href={tile.href}
      className="group flex items-start gap-3 rounded-xl border border-border bg-surface p-4 transition-colors hover:border-primary/40"
    >
      <span className="file-icon-wrap h-9 w-9 shrink-0">
        <tile.icon className="h-4.5 w-4.5" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">{tile.label}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-text-muted opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
        </span>
        {tile.description && <span className="mt-0.5 block text-xs leading-5 text-text-secondary">{tile.description}</span>}
        {metric && <span className="mt-2 block text-xs font-medium tabular-nums text-primary">{metric}</span>}
      </span>
    </Link>
  );
}

/** Landing page for a top-menu item: every tool it contains, with live
 * figures where the portfolio has them. */
export default function MenuHub({ id }: { id: TopMenu["id"] }) {
  const menu = topMenu(id);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  useEffect(() => {
    let active = true;
    getPortfolio()
      .then((data) => active && setPortfolio(data))
      .catch(() => {
        /* Figures are optional; the tiles work without them. */
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <PageHero compact eyebrow="Dataomatix" title={menu.label} description={menu.description} />
      <ContentSection>
        <div className="space-y-8">
          {menu.sections.map((section) => (
            <section key={section.title} className="space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-text-teal">{section.title}</h2>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {section.tiles.map((tile) => (
                  <Tile key={`${tile.href}-${tile.label}`} tile={tile} metric={portfolio ? metricFor(tile.href, portfolio) : null} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </ContentSection>
    </>
  );
}
