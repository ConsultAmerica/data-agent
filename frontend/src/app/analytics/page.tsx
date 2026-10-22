"use client";

import ContentSection from "@/components/layout/ContentSection";
import PageHero from "@/components/layout/PageHero";
import {
  BarList,
  MonthBars,
  Panel,
  PortfolioGate,
  StatTile,
  percent,
  usePortfolio,
} from "@/components/portfolio/portfolio-parts";

export default function AnalyticsPage() {
  const { portfolio, error, retry } = usePortfolio();
  return (
    <>
      <PageHero
        compact
        eyebrow="Intelligence & AI"
        title="Portfolio analytics"
        description="Volume, document mix, extraction quality and review progress across every document in your workspace."
      />
      <ContentSection>
        <PortfolioGate portfolio={portfolio} error={error} retry={retry}>
          {(data) => {
            const { totals, review } = data;
            const reviewed = review.accepted + review.edited + review.rejected;
            return (
              <div className="space-y-6">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <StatTile label="Documents" value={totals.documents.toLocaleString()} hint={`${totals.pages.toLocaleString()} pages`} href="/documents" />
                  <StatTile
                    label="Processed"
                    value={totals.processed.toLocaleString()}
                    hint={`${totals.not_processed.toLocaleString()} not processed · ${totals.failed.toLocaleString()} failed`}
                  />
                  <StatTile
                    label="Values awaiting review"
                    value={review.pending.toLocaleString()}
                    hint={`of ${review.fields.toLocaleString()} extracted values`}
                    href="/review-queue"
                  />
                  <StatTile
                    label="Average confidence"
                    value={percent(review.average_confidence)}
                    hint={
                      totals.average_processing_seconds != null
                        ? `${totals.average_processing_seconds.toFixed(1)}s average processing`
                        : undefined
                    }
                  />
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <Panel title="Document mix" description="Staging profile where resolved, otherwise the document classification.">
                    <BarList items={data.document_mix} unit="documents" />
                  </Panel>
                  <Panel title="Uploads by month" description="Last 12 months with uploads.">
                    <MonthBars data={data.uploads_by_month} />
                  </Panel>
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <Panel title="Review outcomes" description={`${reviewed.toLocaleString()} of ${review.fields.toLocaleString()} values have a human decision.`}>
                    <BarList
                      items={[
                        { name: "Accepted", count: review.accepted },
                        { name: "Edited", count: review.edited },
                        { name: "Rejected", count: review.rejected },
                        { name: "Awaiting review", count: review.pending },
                      ]}
                      unit="values"
                    />
                  </Panel>
                  <Panel title="Processing coverage" description="How much of the repository has structured, staged data.">
                    <BarList
                      items={[
                        { name: "Processed", count: totals.processed },
                        { name: "Staged with a profile", count: totals.staged },
                        { name: "OCR pages", count: totals.ocr_pages },
                        { name: "Not yet processed", count: totals.not_processed },
                      ]}
                    />
                  </Panel>
                </div>
              </div>
            );
          }}
        </PortfolioGate>
      </ContentSection>
    </>
  );
}
