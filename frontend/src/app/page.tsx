"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, FileCheck2, ShieldCheck, Sparkles } from "lucide-react";

import DocumentResultsTable from "@/components/document-results-table";
import HeroShowcase from "@/components/illustrations/hero-showcase";
import ContentSection from "@/components/layout/ContentSection";
import ComparisonSection from "@/components/marketing/comparison-section";
import ConfidenceReviewSection from "@/components/marketing/confidence-review-section";
import FeatureStack from "@/components/marketing/feature-stack";
import LogoMarquee from "@/components/marketing/logo-marquee";
import NextStepBand from "@/components/marketing/next-step-band";
import PlaybookPreview from "@/components/marketing/playbook-preview";
import { getDashboardStats, listDocuments } from "@/lib/documents";
import type { DashboardStats, DocumentSummary } from "@/types/document";

const PILLARS = [
  {
    title: "Evidence, not guesswork",
    body: "Every field links back to the source page — so review is verification, not archaeology.",
    icon: FileCheck2,
  },
  {
    title: "AI that holds up in ops",
    body: "Extraction, confidence, and human review are governed so outputs are ready for downstream systems.",
    icon: Sparkles,
  },
  {
    title: "Built for enterprise control",
    body: "Audit trails, review queues, and Oracle-ready staging — designed for regulated workflows.",
    icon: ShieldCheck,
  },
] as const;

/** Rendered on first paint, and kept when the API is asleep or the workspace
 * is empty, so a first visitor sees a realistic state instead of skeletons. */
const EXAMPLE_STATS: DashboardStats = {
  total_documents: 1284,
  completed: 1197,
  review_required: 23,
  processing: 4,
  extraction_accuracy: 0.962,
  average_processing_seconds: 41,
  human_review_rate: 8.4,
  fields_extracted: 61870,
  review_completion_rate: null,
  ocr_accuracy: null,
  clause_extraction_accuracy: null,
  fields_extracted_today: 0,
  documents_requiring_manual_review: 23,
};

type WorkspaceSource = "connecting" | "live" | "example";

export default function HomePage() {
  const [liveStats, setLiveStats] = useState<DashboardStats | null>(null);
  const [recent, setRecent] = useState<DocumentSummary[]>([]);
  const [source, setSource] = useState<WorkspaceSource>("connecting");

  useEffect(() => {
    let active = true;

    Promise.all([getDashboardStats(), listDocuments(10)])
      .then(([statsResult, docs]) => {
        if (!active) return;
        if (statsResult.total_documents > 0) {
          setLiveStats(statsResult);
          setRecent(docs);
          setSource("live");
        } else {
          setSource("example");
        }
      })
      .catch(() => {
        if (active) setSource("example");
      });

    return () => {
      active = false;
    };
  }, []);

  const stats = liveStats ?? EXAMPLE_STATS;
  const isLive = source === "live";

  return (
    <>
      <HeroShowcase
        eyebrow="Federal contract agents"
        title={
          <>
            Extract with confidence.{" "}
            <span className="text-gradient-accent">Verify with evidence.</span>
          </>
        }
        description="Agents that read awards, solicitations and modifications: every CLIN, funding line, clause and award field is boxed on its page, sent to a reviewer when it can’t be trusted, and exported Oracle-ready."
      />

      <LogoMarquee tone="light" />

      <section className="marketing-band statement-band">
        <div className="marketing-band-inner">
          <h2 className="statement-title">
            Agents that read contracts the way a contract specialist does,{" "}
            <span className="text-gradient-accent-light">and show their work.</span>
          </h2>
          <div className="value-card-grid">
            {PILLARS.map((pillar) => (
              <article key={pillar.title} className="value-card">
                <span className="value-card-icon">
                  <pillar.icon className="h-5 w-5" strokeWidth={1.75} />
                </span>
                <h3 className="value-card-title">{pillar.title}</h3>
                <p className="value-card-body">{pillar.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="marketing-band feature-stack-band" aria-label="What the agents do">
        <div className="marketing-band-inner">
          <FeatureStack />
        </div>
      </section>

      <ContentSection>
        <div className="mb-20">
          <ConfidenceReviewSection />
        </div>

        <div className="mb-20">
          <PlaybookPreview />
        </div>

        <div className="mb-20">
          <ComparisonSection />
        </div>

        <section className="mt-4" aria-live="polite">
          <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl">
              <p className="section-eyebrow">Proof &amp; scale</p>
              <h2 className="section-title">
                Outcomes you can measure, delivered end-to-end.
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span
                className={[
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium",
                  isLive
                    ? "border-success/30 text-success"
                    : "border-border text-text-secondary",
                ].join(" ")}
              >
                <span
                  className={[
                    "h-1.5 w-1.5 rounded-full",
                    isLive ? "bg-success" : "bg-text-muted",
                  ].join(" ")}
                />
                {isLive ? "Live workspace" : "Example workspace"}
              </span>
              {isLive && stats.review_required > 0 && (
                <Link
                  href="/review-queue"
                  className="btn-primary inline-flex items-center gap-1.5 px-4 py-2 text-sm"
                >
                  Review {stats.review_required} pending now
                  <ArrowRight className="h-4 w-4" />
                </Link>
              )}
            </div>
          </div>
          <div className="metric-grid metric-grid-outcomes">
            <MetricCell label="Documents" value={stats.total_documents} />
            <MetricCell label="Completed" value={stats.completed} />
            <MetricCell
              label="Review required"
              value={stats.review_required}
              highlight
            />
            <MetricCell label="Processing" value={stats.processing} />
            <MetricCell
              label="Extraction accuracy"
              value={
                stats.extraction_accuracy !== null
                  ? `${Math.round(stats.extraction_accuracy * 100)}%`
                  : "—"
              }
            />
            <MetricCell
              label="Avg processing"
              value={
                stats.average_processing_seconds !== null
                  ? `${Math.round(stats.average_processing_seconds)}s`
                  : "—"
              }
            />
            <MetricCell
              label="Human review rate"
              value={
                stats.human_review_rate !== null
                  ? `${stats.human_review_rate.toFixed(1)}%`
                  : "—"
              }
            />
            <MetricCell
              label="Fields extracted"
              value={stats.fields_extracted}
            />
          </div>
          {source === "example" && (
            <p className="mt-4 text-sm text-text-secondary">
              Illustrative numbers. Run your own contract to see live metrics
              here.{" "}
              <Link
                href="/extraction/new"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                Start an extraction
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </p>
          )}
        </section>

        {isLive && (
          <section id="recent-extractions" className="mt-16 scroll-mt-24">
            <div className="mb-4 flex items-end justify-between gap-4">
              <div>
                <p className="section-eyebrow">Live workspace</p>
                <h2 className="section-title">Recent extractions</h2>
              </div>
              <Link
                href="/repository"
                className="inline-flex items-center gap-1 text-sm text-text-secondary hover:text-foreground"
              >
                View documents
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
            <div className="editorial-card overflow-hidden">
              <DocumentResultsTable
                documents={recent}
                emptyMessage="No documents yet. Upload a document to begin extraction."
                dashboardMode
              />
            </div>
          </section>
        )}

        {isLive && stats.review_required > 0 && (
          <section className="mt-14">
            <div className="editorial-card editorial-card-interactive flex flex-wrap items-center justify-between gap-6 p-8">
              <div>
                <p className="text-3xl font-medium tracking-tight text-foreground">
                  {stats.review_required}
                </p>
                <p className="mt-1 text-sm text-text-secondary">
                  contracts in the review queue
                </p>
              </div>
              <Link href="/review-queue" className="btn-primary">
                Open review queue
              </Link>
            </div>
          </section>
        )}
      </ContentSection>

      <NextStepBand />
    </>
  );
}

function MetricCell({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: number | string;
  highlight?: boolean;
}) {
  return (
    <div className="metric-cell">
      <p
        className={[
          "metric-value tabular-nums tracking-tight",
          highlight ? "text-warning" : "text-foreground",
        ].join(" ")}
      >
        {typeof value === "number" ? value.toLocaleString() : value}
      </p>
      <p className="mt-2 text-sm text-text-secondary">{label}</p>
    </div>
  );
}
