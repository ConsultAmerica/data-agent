"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Check, Eye, Plus, X } from "lucide-react";

import sample from "@/lib/sample/sample-extraction.json";

type Expectation = "required" | "prohibited" | "review";

interface Rule {
  clause: string;
  expectation: Expectation;
}

/** The sample contract's cited clauses, as "52.204-21" -> title. */
const CITED = new Map(
  sample.fields
    .filter((field) => field.kind === "clause")
    .map((field) => [normalize(field.label), field.value ?? ""] as const),
);

const STARTER: Rule[] = [
  { clause: "52.204-21", expectation: "required" },
  { clause: "252.204-7019", expectation: "required" },
  { clause: "52.212-4", expectation: "review" },
];

const EXPECTATION_LABEL: Record<Expectation, string> = {
  required: "Required",
  prohibited: "Prohibited",
  review: "Review if present",
};

function normalize(value: string) {
  return value.replace(/^(FAR|DFARS)\s+/i, "").replace(/\s+/g, "").trim();
}

function evaluate(rule: Rule) {
  const present = CITED.has(rule.clause);
  if (rule.expectation === "required") {
    return present
      ? { tone: "ok" as const, text: "Present: satisfied" }
      : { tone: "bad" as const, text: "Missing: deviation" };
  }
  if (rule.expectation === "prohibited") {
    return present
      ? { tone: "bad" as const, text: "Present: deviation" }
      : { tone: "ok" as const, text: "Absent: satisfied" };
  }
  return present
    ? { tone: "warn" as const, text: "Present: flagged for review" }
    : { tone: "ok" as const, text: "Absent: nothing to review" };
}

const TONE = {
  ok: "bg-success/10 text-success",
  bad: "bg-danger/10 text-danger",
  warn: "bg-warning/10 text-warning",
};

export default function PlaybookPreview() {
  const [rules, setRules] = useState<Rule[]>(STARTER);
  const [clause, setClause] = useState("");
  const [expectation, setExpectation] = useState<Expectation>("prohibited");
  const [error, setError] = useState("");

  function add(event: React.FormEvent) {
    event.preventDefault();
    const number = normalize(clause);
    if (!/^2?52\.\d{3}-\d{1,4}$/.test(number)) {
      setError("Enter a FAR or DFARS clause number, like 52.204-23 or 252.204-7012.");
      return;
    }
    setError("");
    setRules((current) => [...current.filter((rule) => rule.clause !== number), { clause: number, expectation }]);
    setClause("");
  }

  const flagged = new Set(rules.filter((rule) => evaluate(rule).tone !== "ok").map((rule) => rule.clause));

  return (
    <section id="playbook-preview" className="scroll-mt-24">
      <div className="mb-6 max-w-2xl">
        <p className="section-eyebrow">Clause playbook</p>
        <h2 className="section-title">Write the rule, see the deviation.</h2>
        <p className="section-lede">
          Add a clause you expect, prohibit, or want a second look at. It&apos;s checked against
          the clauses the sample contract actually cites, the same way every processed contract is.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="editorial-card p-5">
          <form onSubmit={add} className="flex flex-wrap gap-2">
            <input
              value={clause}
              onChange={(event) => setClause(event.target.value)}
              placeholder="e.g. 52.204-23"
              aria-label="Clause number"
              className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            />
            <select
              value={expectation}
              onChange={(event) => setExpectation(event.target.value as Expectation)}
              aria-label="Expectation"
              className="rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            >
              <option value="required">Required</option>
              <option value="prohibited">Prohibited</option>
              <option value="review">Review if present</option>
            </select>
            <button type="submit" className="btn-primary inline-flex items-center gap-1 px-3 py-2 text-sm">
              <Plus className="h-4 w-4" />
              Add rule
            </button>
          </form>
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}

          <ul className="mt-4 divide-y divide-border">
            {rules.map((rule) => {
              const result = evaluate(rule);
              return (
                <li key={rule.clause} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                  <span className="w-24 shrink-0 sm:w-28 font-medium tabular-nums text-foreground">{rule.clause}</span>
                  <span className="w-28 shrink-0 sm:w-32 text-xs text-text-secondary">{EXPECTATION_LABEL[rule.expectation]}</span>
                  <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${TONE[result.tone]}`}>
                    {result.text}
                  </span>
                  <button
                    type="button"
                    onClick={() => setRules((current) => current.filter((item) => item.clause !== rule.clause))}
                    aria-label={`Remove rule ${rule.clause}`}
                    className="ml-auto text-text-muted hover:text-foreground"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div className="editorial-card p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Clauses cited in the sample contract
          </p>
          <ul className="mt-3 space-y-2">
            {[...CITED.entries()].map(([number, title]) => {
              const rule = rules.find((item) => item.clause === number);
              const deviates = flagged.has(number);
              return (
                <li
                  key={number}
                  className={[
                    "flex items-start gap-3 rounded-lg border px-3 py-2 text-sm transition-colors",
                    rule ? (deviates ? "border-warning/40 bg-warning/5" : "border-success/30 bg-success/5") : "border-border",
                  ].join(" ")}
                >
                  <span className="w-28 shrink-0 font-medium tabular-nums text-foreground">{number}</span>
                  <span className="min-w-0 flex-1 text-text-secondary">{title}</span>
                  {rule &&
                    (deviates ? (
                      <Eye className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-label="Matches a rule: flagged" />
                    ) : (
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Matches a rule: satisfied" />
                    ))}
                </li>
              );
            })}
          </ul>
          <Link
            href="/playbook"
            className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            Open the full playbook
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </div>
    </section>
  );
}
