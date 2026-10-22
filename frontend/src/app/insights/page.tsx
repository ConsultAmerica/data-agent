"use client";

import Link from "next/link";

import ContentSection from "@/components/layout/ContentSection";
import PageHero from "@/components/layout/PageHero";
import {
  BarList,
  EmptyNote,
  Panel,
  PortfolioGate,
  StatTile,
  usePortfolio,
} from "@/components/portfolio/portfolio-parts";

export default function InsightsPage() {
  const { portfolio, error, retry } = usePortfolio();
  return (
    <>
      <PageHero
        compact
        eyebrow="Intelligence & AI"
        title="Contract insights"
        description="Who you contract with, which vehicles and clauses recur, and which periods of performance end soon."
      />
      <ContentSection>
        <PortfolioGate portfolio={portfolio} error={error} retry={retry}>
          {(data) => {
            const { contracts, clauses, expiring } = data;
            const endingSoon = expiring.filter((item) => item.days_left >= 0 && item.days_left <= 90).length;
            return (
              <div className="space-y-6">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <StatTile label="Contracts analyzed" value={contracts.count.toLocaleString()} href="/documents?family=government_contract" />
                  <StatTile label="Clause references" value={clauses.references.toLocaleString()} href="/clauses" />
                  <StatTile label="Periods ending in 90 days" value={endingSoon.toLocaleString()} href="/risk" />
                  <StatTile label="Agencies / offices" value={contracts.agencies.length.toLocaleString()} hint="Top 8 shown below" />
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <Panel title="Agencies and contracting offices">
                    <BarList items={contracts.agencies} unit="contracts" />
                  </Panel>
                  <Panel title="Contractors">
                    <BarList items={contracts.contractors} unit="contracts" />
                  </Panel>
                  <Panel title="Contract vehicles">
                    <BarList items={contracts.vehicles} unit="contracts" />
                  </Panel>
                  <Panel title="NAICS codes">
                    <BarList items={contracts.naics} unit="contracts" />
                  </Panel>
                </div>

                <Panel title="Most cited clauses" description="Number of documents that cite each FAR / DFARS clause.">
                  <BarList
                    items={clauses.top.map((clause) => ({
                      name: `${clause.clause_number}${clause.title ? ` · ${clause.title}` : ""}`,
                      count: clause.documents,
                    }))}
                    unit="documents"
                    hrefFor={(item) => `/clauses?q=${encodeURIComponent(item.name.split(" · ")[0])}`}
                  />
                </Panel>

                <Panel title="Periods of performance ending" description="Ending within 180 days or ended in the last 30.">
                  {expiring.length === 0 ? (
                    <EmptyNote>No period of performance ends within the next 180 days.</EmptyNote>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                            <th className="py-2 pr-4">Contract</th>
                            <th className="py-2 pr-4">Period</th>
                            <th className="py-2 pr-4">Ends</th>
                            <th className="py-2 text-right">Days</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                          {expiring.map((item) => (
                            <tr key={`${item.document_id}:${item.period}:${item.end_date}`}>
                              <td className="py-2 pr-4">
                                <Link href={`/documents/${item.document_id}`} className="text-foreground hover:text-primary">
                                  {item.contract_number || item.filename}
                                </Link>
                              </td>
                              <td className="py-2 pr-4 text-text-secondary">{item.period}</td>
                              <td className="py-2 pr-4 tabular-nums text-text-secondary">{item.end_date}</td>
                              <td className={`py-2 text-right tabular-nums ${item.days_left < 0 ? "text-text-muted" : item.days_left <= 90 ? "font-medium text-warning" : "text-foreground"}`}>
                                {item.days_left < 0 ? `ended ${-item.days_left}d ago` : item.days_left}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Panel>
              </div>
            );
          }}
        </PortfolioGate>
      </ContentSection>
    </>
  );
}
