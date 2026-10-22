"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, ClipboardCheck, GitBranch, History, Lock } from "lucide-react";

import {
  BAND_COPY,
  ROUTING_REASONS,
  type ConfidenceBand,
} from "@/lib/confidence-policy";
import sample from "@/lib/sample/sample-extraction.json";

interface SampleValue {
  id: string;
  label: string;
  value: string | null;
  alternates: string[];
  confidence: number;
  band: ConfidenceBand;
  decision: "needs_review" | "ready_to_accept";
  reasons: string[];
}

const SAMPLE_VALUES = sample.fields as SampleValue[];

/** One illustrative log line, built from the sample contract's own candidates. */
const ISSUED_BY = SAMPLE_VALUES.find((value) => value.id === "f9");
const AUDIT_EXAMPLE = {
  at: "2026-08-20 14:32:07 UTC",
  reviewer: "reviewer-0042 · Contract Specialist",
  field: ISSUED_BY?.label ?? "ISSUED BY",
  before: "— (2 candidates)",
  after: ISSUED_BY?.alternates[0] ?? "Sample Contracting Activity",
  reason: "Corrected: chose the activity name over the street line, page 1",
};

const BANDS: ConfidenceBand[] = ["high", "medium", "low"];

const BAND_DOT: Record<ConfidenceBand, string> = {
  high: "bg-success",
  medium: "bg-text-muted",
  low: "bg-warning",
};

const LOOP = [
  {
    icon: GitBranch,
    title: "Route",
    body: "Each value gets a score and a band. Any routing reason sends it to the review queue with that reason attached.",
  },
  {
    icon: ClipboardCheck,
    title: "Decide",
    body: "A reviewer accepts, corrects, or rejects it with the source page beside the value. A correction never overwrites the original extraction.",
  },
  {
    icon: History,
    title: "Record",
    body: "Every decision goes into an append-only log with the reviewer's ID and role, the value before and after, and when it happened.",
  },
  {
    icon: Lock,
    title: "Gate",
    body: "Only accepted or corrected values reach the Oracle staging export. Pending values are skipped, and live sends are off by default.",
  },
] as const;

export default function ConfidenceReviewSection() {
  const [band, setBand] = useState<ConfidenceBand>("low");
  const inBand = SAMPLE_VALUES.filter((value) => value.band === band);
  const routed = inBand.filter((value) => value.decision === "needs_review").length;

  return (
    <section id="confidence" className="scroll-mt-24">
      <div className="mb-8 max-w-2xl">
        <p className="section-eyebrow">Confidence, plainly</p>
        <h2 className="section-title">
          A score tells you where to look. A person makes the call.
        </h2>
        <p className="section-lede">
          The score doesn&apos;t claim accuracy. It summarizes how the value
          was found: the extraction method, whether it validates, whether
          it&apos;s on the cited page, and whether anything competes with it.
          Nothing is auto-accepted unless an administrator turns that on.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="editorial-card p-6">
          <h3 className="font-medium text-foreground">What the bands mean</h3>
          <p className="mt-1 text-xs text-text-muted">
            Pick a band to see where the sample contract&apos;s values land.
          </p>
          <ul className="mt-3 divide-y divide-border">
            {BANDS.map((item) => (
              <li key={item}>
                <button
                  type="button"
                  onClick={() => setBand(item)}
                  aria-pressed={band === item}
                  className={[
                    "grid w-full grid-cols-[7rem_minmax(0,1fr)] gap-3 rounded-lg px-2 py-3 text-left transition-colors",
                    band === item
                      ? "bg-primary/8 shadow-[inset_3px_0_0_var(--primary)]"
                      : "hover:bg-surface-soft",
                  ].join(" ")}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <span className={`h-2 w-2 rounded-full ${BAND_DOT[item]}`} />
                    {BAND_COPY[item].label}
                    <span className="sr-only">,</span>
                  </span>
                  <span className="text-sm text-text-secondary">
                    <span className="font-medium text-foreground tabular-nums">
                      {BAND_COPY[item].range}.
                    </span>{" "}
                    {BAND_COPY[item].outcome}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-4 rounded-lg bg-surface-soft p-3" aria-live="polite">
            <p className="text-xs text-text-secondary">
              <span className="font-medium text-foreground">{inBand.length}</span> of{" "}
              {SAMPLE_VALUES.length} sample values are {BAND_COPY[band].label.toLowerCase()}
              {routed > 0
                ? `; ${routed} go to the review queue.`
                : "; none are routed to review."}
            </p>
            <ul className="mt-2 space-y-1.5">
              {inBand.slice(0, 5).map((value) => (
                <li key={value.id} className="flex items-center gap-2 text-xs">
                  <span className="w-10 shrink-0 font-semibold tabular-nums text-foreground">
                    {Math.round(value.confidence * 100)}%
                  </span>
                  <span className="min-w-0 flex-1 truncate text-text-secondary">
                    {value.label}
                    {value.value ? ` · ${value.value}` : ""}
                  </span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      value.decision === "needs_review"
                        ? "bg-warning/10 text-warning"
                        : "bg-success/10 text-success"
                    }`}
                  >
                    {value.decision === "needs_review" ? (value.reasons[0] ?? "Review") : "Ready"}
                  </span>
                </li>
              ))}
            </ul>
            {inBand.length > 5 && (
              <p className="mt-1.5 text-[11px] text-text-muted">
                +{inBand.length - 5} more in the sample
              </p>
            )}
          </div>
        </div>

        <div className="editorial-card p-6">
          <h3 className="font-medium text-foreground">
            What sends a field to review, whatever its score
          </h3>
          <ul className="mt-4 space-y-3">
            {ROUTING_REASONS.map((reason) => (
              <li key={reason.label} className="text-sm">
                <span className="font-medium text-foreground">{reason.label}.</span>{" "}
                <span className="text-text-secondary">{reason.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <ol className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {LOOP.map((step, i) => (
          <li key={step.title} className="pillar-card">
            <div className="flex items-center gap-2">
              <step.icon className="h-5 w-5 text-primary" strokeWidth={1.75} />
              <span className="text-xs font-semibold text-text-muted tabular-nums">
                0{i + 1}
              </span>
            </div>
            <h3 className="pillar-title">{step.title}</h3>
            <p className="pillar-body">{step.body}</p>
          </li>
        ))}
      </ol>

      <div className="mt-6 editorial-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3">
          <p className="flex items-center gap-2 text-sm font-medium text-foreground">
            <History className="h-4 w-4 text-primary" />
            What one audit entry records
          </p>
          <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-muted">
            Example · append-only, never edited
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[44rem] text-left text-xs">
            <thead className="text-[11px] uppercase tracking-wider text-text-muted">
              <tr>
                <th className="px-5 py-2 font-medium">Timestamp</th>
                <th className="px-5 py-2 font-medium">Reviewer</th>
                <th className="px-5 py-2 font-medium">Field</th>
                <th className="px-5 py-2 font-medium">Before → After</th>
                <th className="px-5 py-2 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border align-top">
                <td className="px-5 py-3 font-mono tabular-nums text-text-secondary">
                  {AUDIT_EXAMPLE.at}
                </td>
                <td className="px-5 py-3 text-foreground">{AUDIT_EXAMPLE.reviewer}</td>
                <td className="px-5 py-3 font-medium text-foreground">{AUDIT_EXAMPLE.field}</td>
                <td className="px-5 py-3">
                  <span className="text-text-muted line-through">{AUDIT_EXAMPLE.before}</span>{" "}
                  <span className="text-foreground">→ {AUDIT_EXAMPLE.after}</span>
                </td>
                <td className="px-5 py-3 text-text-secondary">{AUDIT_EXAMPLE.reason}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <Link
        href="/sample"
        className="mt-6 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
      >
        Try the loop on the sample contract
        <ArrowRight className="h-4 w-4" />
      </Link>
    </section>
  );
}
