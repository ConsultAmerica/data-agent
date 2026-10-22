"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { AlertOctagon, AlertTriangle, ArrowUpRight, BookOpen, Info } from "lucide-react";

import EmptyState from "@/components/ui/empty-state";
import PatternEditor from "@/components/playbook/pattern-editor";
import {
  clauseFamily,
  getRuleStandardText,
  type PlaybookExpectation,
  type PlaybookRule,
  type PlaybookRuleInput,
  type PlaybookSeverity,
  type RuleStandardText,
} from "@/lib/playbook";

const FIELD = "w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground";

/** Clause-index status: what the rule expects of a contract. */
export const EXPECTATION_BADGES: Record<PlaybookExpectation, { label: string; tone: string }> = {
  required: { label: "Mandatory", tone: "bg-primary-soft text-primary" },
  review: { label: "Conditional", tone: "bg-warning/10 text-warning" },
  prohibited: { label: "Prohibited", tone: "bg-danger/10 text-danger" },
};

const RISK: Record<PlaybookSeverity, { label: string; tone: string; icon: typeof Info }> = {
  high: { label: "High liability", tone: "bg-danger/10 text-danger", icon: AlertOctagon },
  medium: { label: "Medium liability", tone: "bg-warning/10 text-warning", icon: AlertTriangle },
  low: { label: "Low liability", tone: "bg-surface-soft text-text-secondary", icon: Info },
};

export function ExpectationBadge({ expectation }: { expectation: PlaybookExpectation }) {
  const { label, tone } = EXPECTATION_BADGES[expectation];
  return <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{label}</span>;
}

function RiskBadge({ severity }: { severity: PlaybookSeverity }) {
  const { label, tone, icon: Icon } = RISK[severity];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {label}
    </span>
  );
}

export function sourceLabel(source: PlaybookRule["source"]): string {
  return source === "default" ? "Built-in" : source === "override" ? "Built-in (edited)" : "Custom";
}

type Tab = "standard" | "fallback" | "patterns";

const TABS: { id: Tab; label: string }[] = [
  { id: "standard", label: "Standard text" },
  { id: "fallback", label: "Corporate fallback / acceptable deviations" },
  { id: "patterns", label: "AI extraction rules" },
];

/** The right pane of the clause library: one rule, its verbatim text from
 * ingested regulation records, the team's fallback language and its
 * extraction patterns. */
export default function RuleInspector({
  rule,
  onToggle,
  onEdit,
  onReset,
  onDelete,
  onSave,
}: {
  rule: PlaybookRule;
  onToggle: () => void;
  onEdit: () => void;
  onReset: () => void;
  onDelete: () => void;
  /** Saves part of the rule; rejects with the server's message. */
  onSave: (changes: PlaybookRuleInput) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("standard");
  const family = clauseFamily(rule.clause_number);

  return (
    <section className="min-w-0 rounded-xl border border-border bg-surface" aria-label="Clause rule inspector">
      <header className={`border-b border-border p-5 ${rule.enabled ? "" : "opacity-70"}`}>
        <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-teal">Clause rule inspector</p>
        <h2 className="mt-1 text-base font-semibold text-foreground">
          <span className="font-id">
            {family ? `${family} ` : ""}
            {rule.clause_number}
          </span>
          {rule.title && ` — ${rule.title}`}
        </h2>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-secondary">
          <RiskBadge severity={rule.severity} />
          <ExpectationBadge expectation={rule.expectation} />
          <span>{sourceLabel(rule.source)}</span>
          {rule.category && <span>· {rule.category}</span>}
          <span>· {rule.agency ? `${rule.agency} only` : rule.applies_to === "dod" ? "DoD contracts" : "All agencies"}</span>
          {!rule.enabled && <span className="font-medium text-warning">· Disabled</span>}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
          <label className="inline-flex items-center gap-1.5 text-text-secondary">
            <input
              type="checkbox"
              checked={rule.enabled}
              aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.clause_number}`}
              onChange={onToggle}
            />
            Enabled
          </label>
          <button type="button" onClick={onEdit} className="text-text-secondary hover:text-primary">
            Edit
          </button>
          {rule.source === "override" && (
            <button type="button" onClick={onReset} className="text-text-secondary hover:text-primary">
              Reset
            </button>
          )}
          {rule.source === "custom" && (
            <button type="button" onClick={onDelete} className="text-text-secondary hover:text-danger">
              Delete
            </button>
          )}
        </div>
      </header>

      <div role="tablist" aria-label="Rule details" className="flex flex-wrap gap-1 border-b border-border px-3">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`rule-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`rule-panel-${item.id}`}
            onClick={() => setTab(item.id)}
            className={[
              "-mb-px border-b-2 px-3 py-2.5 text-xs font-medium transition-colors",
              tab === item.id ? "border-primary text-primary" : "border-transparent text-text-secondary hover:text-foreground",
            ].join(" ")}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`rule-panel-${tab}`} aria-labelledby={`rule-tab-${tab}`} className="p-5">
        {tab === "standard" && <StandardTextPanel key={rule.rule_id} rule={rule} onSave={onSave} />}
        {tab === "fallback" && (
          <TextBlockEditor
            key={`${rule.rule_id}:${rule.fallback_text}`}
            label="Corporate fallback / acceptable deviation language"
            hint="What your team will accept when the standard clause is negotiated, deviated from, or missing."
            value={rule.fallback_text}
            empty="No fallback language recorded for this clause yet."
            onSave={(value) => onSave({ fallback_text: value })}
          />
        )}
        {tab === "patterns" && (
          <PatternEditor
            key={`${rule.rule_id}:${JSON.stringify(rule.extraction_patterns)}`}
            patterns={rule.extraction_patterns}
            onSave={(patterns) => onSave({ extraction_patterns: patterns })}
          />
        )}
      </div>
    </section>
  );
}

function StandardTextPanel({ rule, onSave }: { rule: PlaybookRule; onSave: (changes: PlaybookRuleInput) => Promise<void> }) {
  const [data, setData] = useState<RuleStandardText | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    getRuleStandardText(rule.rule_id)
      .then((result) => active && setData(result))
      .catch((err: unknown) => active && setError(err instanceof Error ? err.message : "Unable to load the clause text."));
    return () => {
      active = false;
    };
  }, [rule.rule_id]);

  const ingested = data?.ingested ?? null;

  return (
    <div className="space-y-5">
      {rule.rationale && (
        <div className="rounded-lg border border-primary/20 bg-primary-soft/40 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">Key obligation note</p>
          <p className="mt-1 text-sm leading-6 text-foreground">{rule.rationale}</p>
        </div>
      )}

      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !data ? (
        <p className="text-sm text-text-secondary">Looking for ingested clause text…</p>
      ) : ingested ? (
        <div>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-text-secondary">
              Verbatim text · {ingested.version_date || "version date not recorded"}
            </p>
            <Link
              href={`/documents/${ingested.document_id}`}
              className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-primary"
            >
              Source: {ingested.filename || "ingested regulation"}
              <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
            </Link>
          </div>
          <blockquote
            className="max-h-[28rem] overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-surface-soft px-4 py-3 text-[13px] leading-6 text-foreground"
            data-testid="rule-verbatim-text"
          >
            {ingested.source_text}
          </blockquote>
          {data.versions.length > 1 && (
            <p className="mt-2 text-xs text-text-secondary">
              {data.versions.length} ingested versions on file (
              {data.versions.map((version) => version.version_date || "undated").join(", ")}).{" "}
              <Link
                href={`/clauses/compare?clause=${encodeURIComponent(rule.clause_number)}`}
                className="font-medium text-primary hover:underline"
              >
                Compare versions
              </Link>
            </p>
          )}
        </div>
      ) : (
        <EmptyState
          icon={BookOpen}
          title="Ingest FAR Part 52 / the DFARS XML to see verbatim text"
          description={`No ingested regulation record for ${rule.clause_number} is on file. Upload the FAR Part 52 (or DFARS) regulation source and its text appears here, exactly as published.`}
          action={
            <Link href="/extraction/new" className="btn-primary px-4 py-2 text-sm">
              Upload a regulation source
            </Link>
          }
          className="rounded-lg border border-dashed border-border py-8"
        />
      )}

      <TextBlockEditor
        key={`${rule.rule_id}:${rule.standard_text}`}
        label="Team standard text"
        hint="Text your team entered or copied from an ingested record — shown as your team's, never as regulation text."
        value={rule.standard_text}
        empty="No team standard text recorded."
        copyFrom={ingested?.source_text ? { label: "Copy ingested text", text: ingested.source_text } : undefined}
        onSave={(value) => onSave({ standard_text: value })}
      />
    </div>
  );
}

/** A read-then-edit text block saved through the rule. */
function TextBlockEditor({
  label,
  hint,
  value,
  empty,
  copyFrom,
  onSave,
}: {
  label: string;
  hint: string;
  value: string;
  empty: string;
  copyFrom?: { label: string; text: string };
  onSave: (value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    try {
      await onSave(draft.trim());
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The text could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  let body: ReactNode;
  if (editing) {
    body = (
      <>
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={8}
          aria-label={label}
          className={`${FIELD} font-mono text-[13px] leading-6`}
        />
        {error && <p className="mt-1 text-sm text-danger">{error}</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" onClick={save} disabled={busy || draft.trim() === value} className="btn-primary disabled:opacity-50">
            {busy ? "Saving…" : "Save"}
          </button>
          {copyFrom && (
            <button
              type="button"
              onClick={() => setDraft(copyFrom.text)}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-foreground"
            >
              {copyFrom.label}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setDraft(value);
              setEditing(false);
              setError("");
            }}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </>
    );
  } else if (value) {
    body = (
      <p className="whitespace-pre-wrap rounded-lg border border-border bg-surface-soft px-4 py-3 text-[13px] leading-6 text-foreground">
        {value}
      </p>
    );
  } else {
    body = <p className="rounded-lg bg-surface-soft px-3 py-4 text-center text-sm text-text-secondary">{empty}</p>;
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-foreground">{label}</p>
          <p className="text-xs text-text-secondary">{hint}</p>
        </div>
        {!editing && (
          <button type="button" onClick={() => setEditing(true)} className="text-xs font-medium text-primary hover:underline">
            {value ? "Edit" : "Add"} {label.toLowerCase()}
          </button>
        )}
      </div>
      {body}
    </div>
  );
}
