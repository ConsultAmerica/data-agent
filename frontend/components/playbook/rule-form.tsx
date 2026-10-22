"use client";

import { useState, type FormEvent } from "react";

import type {
  PlaybookAppliesTo,
  PlaybookExpectation,
  PlaybookRule,
  PlaybookRuleInput,
  PlaybookSeverity,
} from "@/lib/playbook";

const FIELD = "w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground";

/** Add a custom rule, or edit an existing one (a built-in rule's edit is
 * saved as an override that "Reset" undoes). */
export default function RuleForm({
  rule,
  categories = [],
  onSubmit,
  onCancel,
}: {
  rule?: PlaybookRule;
  /** Existing categories, offered as suggestions. */
  categories?: string[];
  onSubmit: (input: PlaybookRuleInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [clause, setClause] = useState(rule?.clause_number ?? "");
  const [title, setTitle] = useState(rule?.title ?? "");
  const [expectation, setExpectation] = useState<PlaybookExpectation>(rule?.expectation ?? "required");
  const [severity, setSeverity] = useState<PlaybookSeverity>(rule?.severity ?? "medium");
  const [appliesTo, setAppliesTo] = useState<PlaybookAppliesTo>(rule?.applies_to ?? "all");
  const [rationale, setRationale] = useState(rule?.rationale ?? "");
  const [category, setCategory] = useState(rule?.category ?? "");
  const [agency, setAgency] = useState(rule?.agency ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSubmit({
        clause_number: clause.trim(),
        title: title.trim(),
        expectation,
        severity,
        applies_to: appliesTo,
        rationale: rationale.trim(),
        category: category.trim(),
        agency: agency.trim(),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save the rule.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-border bg-surface-soft p-4" aria-label={rule ? "Edit rule" : "Add rule"}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <label className="text-xs text-text-secondary lg:col-span-1">
          Clause number
          <input
            required
            value={clause}
            onChange={(event) => setClause(event.target.value)}
            placeholder="52.204-21"
            className={`${FIELD} mt-1`}
          />
        </label>
        <label className="text-xs text-text-secondary lg:col-span-2">
          Title
          <input value={title} onChange={(event) => setTitle(event.target.value)} className={`${FIELD} mt-1`} />
        </label>
        <label className="text-xs text-text-secondary">
          Expectation
          <select value={expectation} onChange={(event) => setExpectation(event.target.value as PlaybookExpectation)} className={`${FIELD} mt-1`}>
            <option value="required">Required</option>
            <option value="prohibited">Prohibited</option>
            <option value="review">Review if present</option>
          </select>
        </label>
        <label className="text-xs text-text-secondary">
          Severity
          <select value={severity} onChange={(event) => setSeverity(event.target.value as PlaybookSeverity)} className={`${FIELD} mt-1`}>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </label>
        <label className="text-xs text-text-secondary">
          Applies to
          <select value={appliesTo} onChange={(event) => setAppliesTo(event.target.value as PlaybookAppliesTo)} className={`${FIELD} mt-1`}>
            <option value="all">All contracts</option>
            <option value="dod">DoD only</option>
          </select>
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-text-secondary">
          Category
          <input
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            list="playbook-rule-categories"
            placeholder="e.g. Cybersecurity & supply chain"
            maxLength={120}
            className={`${FIELD} mt-1`}
          />
          <datalist id="playbook-rule-categories">
            {categories.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </label>
        <label className="text-xs text-text-secondary">
          Agency (leave empty for all)
          <input
            value={agency}
            onChange={(event) => setAgency(event.target.value)}
            placeholder="e.g. Navy, DLA"
            maxLength={80}
            className={`${FIELD} mt-1`}
          />
        </label>
      </div>
      <label className="block text-xs text-text-secondary">
        Rationale / key obligation
        <textarea value={rationale} onChange={(event) => setRationale(event.target.value)} rows={2} className={`${FIELD} mt-1`} />
      </label>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="btn-primary disabled:opacity-50">
          {busy ? "Saving…" : rule ? "Save rule" : "Add rule"}
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg border border-border px-3 py-1.5 text-sm text-text-secondary hover:text-foreground">
          Cancel
        </button>
      </div>
    </form>
  );
}
