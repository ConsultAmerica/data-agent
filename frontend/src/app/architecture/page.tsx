import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  Database,
  FileSearch,
  ShieldCheck,
  Workflow,
} from "lucide-react";

import ContentSection from "@/components/layout/ContentSection";
import PageHero from "@/components/layout/PageHero";

const LIFECYCLE = [
  "Upload",
  "Understand",
  "Discover Schema",
  "Retrieve",
  "Extract",
  "AI Escalate",
  "Validate",
  "Explain Confidence",
  "Source Ground",
  "Route for Review",
  "Accept / Edit / Reject",
  "Audit",
  "Persist",
  "Export authoritative value",
  "Controlled Oracle preview / send",
];

const TRUST_RULES = [
  {
    title: "Machine vs reviewed",
    body: "extracted_value is the machine result. value is the effective reviewed result. review_status is governance state.",
  },
  {
    title: "No silent overwrite",
    body: "Re-extraction stores a new machine_value but never clobbers an accepted or edited field. Divergent extracts reopen review.",
  },
  {
    title: "Oracle gate",
    body: "Preview only includes accepted/edited fields. Send requires oracle.send, a clean authoritative set, and confirm=true — with a persisted payload snapshot.",
  },
  {
    title: "Identity on audit",
    body: "Append-only MetadataFieldAuditLog and IntegrationAuditLog carry actor_id, actor_type, actor_role, and request_id.",
  },
];

const STACK = [
  { layer: "Frontend", items: "Next.js · Vercel · source verification workspace" },
  { layer: "API", items: "FastAPI · request IDs · RBAC · Entra JWT / service keys" },
  { layer: "Data", items: "PostgreSQL · Supabase object storage · durable field rows" },
  {
    layer: "Intelligence",
    items: "Retrieval → deterministic extract → AI escalation → validation → confidence",
  },
  {
    layer: "Governance",
    items: "Review queue · Accept/Edit/Reject · export · Oracle dry-run",
  },
];

function SectionHeading({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mb-5">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <p className="mt-1 max-w-2xl text-sm text-text-secondary">{description}</p>
    </div>
  );
}

export default function ArchitecturePage() {
  return (
    <div className="space-y-10 pb-16">
      <PageHero
        compact
        eyebrow="Platform"
        title="Architecture"
        description="Data Agent is an enterprise contract intelligence spine: retrieve evidence, extract with explainable confidence, govern at field level, and only then export or send downstream."
        actions={
          <div className="flex flex-wrap gap-3">
            <Link
              href="/extraction/new"
              className="btn-primary inline-flex items-center gap-2"
            >
              Open Extraction
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="/integrations"
              className="btn-secondary inline-flex items-center gap-2"
            >
              Integration Center
            </Link>
          </div>
        }
      />

      <ContentSection>
        <SectionHeading
          title="Lifecycle"
          description="The certified path from upload to controlled downstream integration."
        />
        <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {LIFECYCLE.map((step, index) => (
            <li
              key={step}
              className="flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-foreground"
            >
              <span className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-surface-soft text-[11px] font-semibold text-text-muted">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </ContentSection>

      <ContentSection>
        <SectionHeading
          title="Trust loop"
          description="Governance rules that keep human decisions authoritative."
        />
        <div className="grid gap-4 md:grid-cols-2">
          {TRUST_RULES.map((rule) => (
            <div
              key={rule.title}
              className="rounded-xl border border-border bg-surface p-5"
            >
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-foreground">
                <ShieldCheck className="h-4 w-4 text-text-teal" />
                {rule.title}
              </div>
              <p className="text-sm leading-relaxed text-text-secondary">
                {rule.body}
              </p>
            </div>
          ))}
        </div>
      </ContentSection>

      <ContentSection>
        <SectionHeading
          title="Deploy topology"
          description="What runs where for the live Data Agent demo."
        />
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-left text-sm">
            <thead className="bg-surface-soft text-text-muted">
              <tr>
                <th className="px-4 py-3 font-semibold">Layer</th>
                <th className="px-4 py-3 font-semibold">Stack</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-surface">
              {STACK.map((row) => (
                <tr key={row.layer}>
                  <td className="px-4 py-3 font-medium text-foreground">
                    {row.layer}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{row.items}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-border bg-surface p-4">
            <FileSearch className="mb-2 h-4 w-4 text-text-teal" />
            <p className="text-sm font-semibold text-foreground">Frontend</p>
            <p className="mt-1 text-xs text-text-secondary">
              Vercel · data-agent-ca.vercel.app
            </p>
          </div>
          <div className="rounded-xl border border-border bg-surface p-4">
            <Workflow className="mb-2 h-4 w-4 text-text-teal" />
            <p className="text-sm font-semibold text-foreground">API</p>
            <p className="mt-1 text-xs text-text-secondary">
              Render Docker · /health + /ready
            </p>
          </div>
          <div className="rounded-xl border border-border bg-surface p-4">
            <Database className="mb-2 h-4 w-4 text-text-teal" />
            <p className="text-sm font-semibold text-foreground">Persistence</p>
            <p className="mt-1 text-xs text-text-secondary">
              Render Postgres · Supabase files
            </p>
          </div>
        </div>
      </ContentSection>

      <ContentSection>
        <SectionHeading
          title="Five-minute demo"
          description="A reliable interview path that showcases governance, not just extraction."
        />
        <ul className="space-y-3">
          {[
            "Upload a contract PDF and run page extraction",
            "Discover schema → select targets → extract with source evidence",
            "Open Review Queue → Accept / Edit a field → confirm audit trail",
            "Export JSON/CSV and show extracted_value vs value",
            "Open Oracle payload preview — pending fields skipped, send gated",
          ].map((item) => (
            <li
              key={item}
              className="flex items-start gap-3 text-sm text-foreground"
            >
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-text-teal" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </ContentSection>
    </div>
  );
}
