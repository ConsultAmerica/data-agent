"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  CloudOff,
  FileCheck2,
  ShieldCheck,
  Sparkles,
  Upload,
} from "lucide-react";

import AnimatedWorkflowDiagram from "@/components/illustrations/animated-workflow-diagram";
import CapabilitySection from "@/components/capability-section";
import DocumentResultsTable from "@/components/document-results-table";
import HeroShowcase from "@/components/illustrations/hero-showcase";
import ContentSection from "@/components/layout/ContentSection";
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

export default function HomePage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [recent, setRecent] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    Promise.all([getDashboardStats(), listDocuments(10)])
      .then(([statsResult, docs]) => {
        if (!active) return;
        setStats(statsResult);
        setRecent(docs);
      })
      .catch(() => {
        if (active) {
          setStats(null);
          setRecent([]);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, []);

  return (
    <>
      <HeroShowcase
        brand={
          <p className="page-hero-brand-name">
            Data<span>Agent</span>
          </p>
        }
        title={
          <>
            Extract with confidence.
            <br />
            Verify with evidence.
          </>
        }
        description="Contracts and complex records become structured, reviewable intelligence — grounded in source evidence."
      />

      <section className="marketing-band marketing-band-light">
        <div className="marketing-band-inner">
          <div className="mb-8 max-w-2xl">
            <p className="section-eyebrow">Why Data Agent</p>
            <h2 className="section-title">
              Built where document AI meets production operations.
            </h2>
            <p className="section-lede">
              Not a demo chatbot — a governed workspace for extraction, review,
              and export with source-grounded evidence.
            </p>
          </div>
          <div className="pillar-grid">
            {PILLARS.map((pillar) => (
              <article key={pillar.title} className="pillar-card">
                <pillar.icon
                  className="h-5 w-5 text-primary"
                  strokeWidth={1.75}
                />
                <h3 className="pillar-title">{pillar.title}</h3>
                <p className="pillar-body">{pillar.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <ContentSection>
        <section className="mb-14">
          <p className="section-eyebrow">How it works</p>
          <h2 className="section-title">From upload to verified repository</h2>
          <div className="mt-6">
            <AnimatedWorkflowDiagram />
          </div>
        </section>

        <CapabilitySection />
      </ContentSection>

      <section className="marketing-band marketing-band-dark">
        <div className="marketing-band-inner marketing-band-dark-split">
          <div className="max-w-xl">
            <p className="section-eyebrow section-eyebrow-on-dark">
              Connected intelligence
            </p>
            <h2 className="section-title section-title-on-dark">
              Where documents become decisions — and decisions stay auditable.
            </h2>
            <p className="section-lede section-lede-on-dark">
              Ask across your portfolio, surface clauses and fields with
              evidence, then push reviewed data into staging and Oracle-ready
              export paths.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/ask" className="btn-hero-primary">
                Ask our AI
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link href="/documents" className="btn-hero-secondary">
                Open documents
              </Link>
            </div>
          </div>
          <ul className="dark-proof-list">
            <li>
              <span>Source-page grounding</span>
              <span>on every extracted field</span>
            </li>
            <li>
              <span>Human-in-the-loop review</span>
              <span>before downstream export</span>
            </li>
            <li>
              <span>Governance &amp; audit</span>
              <span>built into the workspace</span>
            </li>
          </ul>
        </div>
      </section>

      <ContentSection>
        {loading ? (
          <section className="mt-4" aria-busy="true" aria-label="Loading metrics">
            <div className="skeleton mb-4 h-5 w-48" />
            <div className="metric-grid">
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="metric-cell">
                  <div className="skeleton h-7 w-16" />
                  <div className="skeleton mt-3 h-4 w-28" />
                </div>
              ))}
            </div>
          </section>
        ) : stats ? (
          <>
            <section className="mt-4">
              <div className="mb-6 max-w-2xl">
                <p className="section-eyebrow">Proof &amp; scale</p>
                <h2 className="section-title">
                  Outcomes you can measure, delivered end-to-end.
                </h2>
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
            </section>

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

            {stats.review_required > 0 && (
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
          </>
        ) : (
          <section className="editorial-card mt-4 flex flex-wrap items-center justify-between gap-4 p-6 sm:p-8">
            <div className="flex items-start gap-3">
              <span className="file-icon-wrap h-10 w-10 shrink-0">
                <CloudOff className="h-5 w-5" />
              </span>
              <div>
                <p className="font-medium text-foreground">
                  Metrics are unavailable right now
                </p>
                <p className="mt-1 text-sm text-text-secondary">
                  The processing service may be waking up. You can still start a
                  new extraction.
                </p>
              </div>
            </div>
            <Link href="/extraction/new" className="btn-primary">
              <Upload className="h-4 w-4" />
              New extraction
            </Link>
          </section>
        )}
      </ContentSection>

      <section className="marketing-cta-finale">
        <div className="marketing-band-inner marketing-cta-finale-inner">
          <div className="max-w-2xl">
            <h2 className="section-title section-title-on-dark">
              Ready to put document intelligence in production?
            </h2>
            <p className="section-lede section-lede-on-dark mt-3">
              Start with a contract or financial document. Data Agent will
              extract, ground every field in evidence, and queue what needs a
              human eye.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/extraction/new" className="btn-hero-primary">
              <Upload className="h-4 w-4" />
              New extraction
            </Link>
            <Link href="/architecture" className="btn-hero-secondary">
              See how it works
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>
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
