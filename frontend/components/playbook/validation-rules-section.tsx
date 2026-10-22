"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import ValidationRuleForm from "@/components/playbook/validation-rule-form";
import { EmptyNote, Panel, SeverityBadge } from "@/components/portfolio/portfolio-parts";
import { ValidationCounts, ValidationResultList } from "@/components/validation/validation-results";
import {
  RULE_TYPE_LABELS,
  createValidationRule,
  deleteValidationRule,
  getValidationPortfolio,
  listValidationRules,
  resetValidationRule,
  updateValidationRule,
  type ValidationPortfolio,
  type ValidationRule,
  type ValidationRuleInput,
} from "@/lib/validation-rules";

function money(value: number | null): string {
  return value == null ? "" : `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

/** What the rule checks, in one line. */
function ruleSummary(rule: ValidationRule): string {
  const field = (rule.field_label ?? "").split("|")[0]?.trim();
  switch (rule.rule_type) {
    case "regex":
      return `${field} matches ${rule.pattern}`;
    case "required_field":
      return `${field} is present`;
    case "funding_gap":
      return `Priced vs funded within ${money(rule.threshold)}`;
    case "max_amount":
      return `${field} at most ${money(rule.threshold)}`;
    case "field_match":
      return `${field} equals ${(rule.pattern ?? "").split("|")[0]?.trim()}`;
  }
}

/** Batch validation rules on the playbook page: templates (off until
 * enabled), custom rules with a live test, and portfolio failures. Loads
 * its own data so the clause playbook above it is unaffected. */
export default function ValidationRulesSection() {
  const [rules, setRules] = useState<ValidationRule[] | null>(null);
  const [portfolio, setPortfolio] = useState<ValidationPortfolio | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<ValidationRule | "new" | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.all([listValidationRules(), getValidationPortfolio()])
      .then(([nextRules, nextPortfolio]) => {
        if (!active) return;
        setRules(nextRules);
        setPortfolio(nextPortfolio);
      })
      .catch((err: unknown) => active && setError(err instanceof Error ? err.message : "Unable to load validation rules."));
    return () => {
      active = false;
    };
  }, [tick]);

  function load() {
    setError("");
    setTick((value) => value + 1);
  }

  async function mutate(task: () => Promise<unknown>, message: string) {
    setNotice("");
    try {
      await task();
      setNotice(message);
      load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "The change could not be saved.");
    }
  }

  async function save(input: ValidationRuleInput) {
    if (editing === "new") {
      await createValidationRule(input);
    } else if (editing) {
      await updateValidationRule(editing.rule_id, input);
    }
    setEditing(null);
    await mutate(async () => undefined, "Validation rule saved.");
  }

  if (error) {
    return (
      <div id="validation-rules" className="space-y-3">
        <p className="text-sm text-danger">{error}</p>
        <button type="button" onClick={load} className="btn-primary">
          Retry
        </button>
      </div>
    );
  }
  if (!rules || !portfolio) {
    return (
      <p id="validation-rules" className="text-sm text-text-secondary">
        Loading validation rules…
      </p>
    );
  }

  const enabled = rules.filter((rule) => rule.enabled).length;

  return (
    <div id="validation-rules" className="scroll-mt-24 space-y-6">
      <Panel
        title="Validation rules"
        description="Pattern, required-field, amount and funding checks run against every staged document's extracted values. Templates start switched off — turn on the ones you want."
        action={
          <button type="button" onClick={() => setEditing("new")} className="btn-primary">
            Add validation rule
          </button>
        }
      >
        {notice && (
          <p className="mb-3 text-sm text-text-secondary" role="status">
            {notice}
          </p>
        )}
        {editing && (
          <div className="mb-4">
            <ValidationRuleForm
              key={editing === "new" ? "new" : editing.rule_id}
              rule={editing === "new" ? undefined : editing}
              onSubmit={save}
              onCancel={() => setEditing(null)}
            />
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                <th className="py-2 pr-4">Rule</th>
                <th className="py-2 pr-4">Type</th>
                <th className="py-2 pr-4">Severity</th>
                <th className="py-2 pr-4">Enabled</th>
                <th className="py-2 pr-4">Source</th>
                <th className="py-2" aria-label="Actions" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rules.map((rule) => (
                <tr key={rule.rule_id} className={`align-top ${rule.enabled ? "" : "opacity-60"}`}>
                  <td className="max-w-[30rem] py-2.5 pr-4">
                    <p className="font-medium text-foreground">{rule.name}</p>
                    <p className="font-mono text-xs text-text-secondary">{ruleSummary(rule)}</p>
                    {rule.description && <p className="mt-0.5 text-xs text-text-muted">{rule.description}</p>}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-4 text-foreground">{RULE_TYPE_LABELS[rule.rule_type]}</td>
                  <td className="py-2.5 pr-4">
                    <SeverityBadge severity={rule.severity} />
                  </td>
                  <td className="py-2.5 pr-4">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
                      onChange={() =>
                        mutate(
                          () => updateValidationRule(rule.rule_id, { enabled: !rule.enabled }),
                          `${rule.name} ${rule.enabled ? "disabled" : "enabled"}.`,
                        )
                      }
                    />
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-4 text-xs text-text-secondary">
                    {rule.source === "template" ? "Template" : rule.source === "override" ? "Template (edited)" : "Custom"}
                  </td>
                  <td className="whitespace-nowrap py-2.5 text-right text-xs">
                    <button type="button" onClick={() => setEditing(rule)} className="text-text-secondary hover:text-primary">
                      Edit
                    </button>
                    {rule.source === "override" && (
                      <button
                        type="button"
                        onClick={() => mutate(() => resetValidationRule(rule.rule_id), `${rule.name} reset to its template.`)}
                        className="ml-3 text-text-secondary hover:text-primary"
                      >
                        Reset
                      </button>
                    )}
                    {rule.source === "custom" && (
                      <button
                        type="button"
                        onClick={() => mutate(() => deleteValidationRule(rule.rule_id), `${rule.name} removed.`)}
                        className="ml-3 text-text-secondary hover:text-danger"
                      >
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        title="Validation failures"
        description={`${enabled} rule${enabled === 1 ? "" : "s"} enabled · ${portfolio.totals.documents} staged document${portfolio.totals.documents === 1 ? "" : "s"} checked · ${portfolio.totals.with_failures} with failures.`}
      >
        {enabled === 0 ? (
          <EmptyNote>No validation rules are enabled. Turn on a template above to check your documents.</EmptyNote>
        ) : portfolio.documents.length === 0 ? (
          <EmptyNote>No failures or missing fields across your staged documents.</EmptyNote>
        ) : (
          <ul className="divide-y divide-border" role="list">
            {portfolio.documents.map((document) => (
              <li key={document.document_id}>
                <details className="group py-2.5">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground" title={document.filename ?? undefined}>
                        {document.filename || document.document_id}
                      </span>
                      <span className="text-xs text-text-secondary">{document.document_type ?? "Document"}</span>
                    </span>
                    <span className="flex items-center gap-3">
                      <ValidationCounts summary={document.summary} />
                      <Link
                        href={`/documents/${document.document_id}?view=overview`}
                        className="text-xs text-text-secondary hover:text-primary"
                        onClick={(event) => event.stopPropagation()}
                      >
                        Open
                      </Link>
                    </span>
                  </summary>
                  <div className="mt-2 pl-1">
                    <ValidationResultList results={document.results} documentId={document.document_id} />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
