"use client";

import { useMemo, useState } from "react";
import { ChevronRight, Plus, Search } from "lucide-react";

import RuleForm from "@/components/playbook/rule-form";
import RuleInspector, { ExpectationBadge } from "@/components/playbook/rule-inspector";
import { EmptyNote } from "@/components/portfolio/portfolio-parts";
import {
  createPlaybookRule,
  deletePlaybookRule,
  resetPlaybookRule,
  updatePlaybookRule,
  type PlaybookRule,
  type PlaybookRuleInput,
} from "@/lib/playbook";

const QUICK_FILTERS = [
  { id: "all", label: "All rules", test: () => true },
  { id: "far", label: "FAR clauses (52.*)", test: (rule: PlaybookRule) => rule.clause_number.startsWith("52.") },
  { id: "dfars", label: "DFARS clauses (252.*)", test: (rule: PlaybookRule) => rule.clause_number.startsWith("252.") },
  { id: "agency", label: "Agency-specific", test: (rule: PlaybookRule) => Boolean(rule.agency) },
  { id: "custom", label: "Custom corporate playbook", test: (rule: PlaybookRule) => rule.source !== "default" },
] as const;

type QuickFilter = (typeof QUICK_FILTERS)[number]["id"];

const UNCATEGORIZED = "Uncategorized";

/** Clause library: a searchable, categorized clause index on the left and
 * the selected rule's inspector on the right. */
export default function ClauseLibrary({
  rules,
  mutate,
}: {
  rules: PlaybookRule[];
  mutate: (task: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<QuickFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<PlaybookRule | "new" | null>(null);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const test = QUICK_FILTERS.find((item) => item.id === filter)?.test ?? (() => true);
    return rules.filter(
      (rule) =>
        test(rule) &&
        (!needle ||
          `${rule.clause_number} ${rule.title} ${rule.category} ${rule.agency} ${rule.rationale}`.toLowerCase().includes(needle)),
    );
  }, [rules, query, filter]);

  const groups = useMemo(() => {
    const byCategory = new Map<string, PlaybookRule[]>();
    for (const rule of shown) {
      const category = rule.category || UNCATEGORIZED;
      byCategory.set(category, [...(byCategory.get(category) ?? []), rule]);
    }
    return [...byCategory.entries()].sort(([a], [b]) =>
      a === UNCATEGORIZED ? 1 : b === UNCATEGORIZED ? -1 : a.localeCompare(b),
    );
  }, [shown]);

  const categories = useMemo(() => [...new Set(rules.map((rule) => rule.category).filter(Boolean))].sort(), [rules]);
  // The selection survives filtering only while it is still shown.
  const selected = shown.find((rule) => rule.rule_id === selectedId) ?? shown[0] ?? null;

  async function save(input: PlaybookRuleInput) {
    if (editing === "new") {
      const created = await createPlaybookRule(input);
      setSelectedId(created.rule_id);
    } else if (editing) {
      await updatePlaybookRule(editing.rule_id, input);
    }
    setEditing(null);
    await mutate(async () => undefined, "Rule saved.");
  }

  async function saveChanges(rule: PlaybookRule, changes: PlaybookRuleInput) {
    // Errors propagate so the editor can show the server's message.
    await updatePlaybookRule(rule.rule_id, changes);
    await mutate(async () => undefined, `${rule.clause_number} saved.`);
  }

  return (
    <section className="space-y-4" aria-label="Clause library">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[16rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search clauses, titles, categories, agencies…"
            aria-label="Search clauses and rules"
            className="w-full rounded-xl border border-border bg-surface py-2.5 pl-9 pr-3 text-sm text-foreground outline-none focus:border-primary/30"
          />
        </div>
        <button type="button" onClick={() => setEditing("new")} className="btn-primary inline-flex items-center gap-1.5">
          <Plus className="h-4 w-4" aria-hidden="true" />
          Add new clause / rule
        </button>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Quick filters">
        {QUICK_FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={filter === item.id}
            onClick={() => setFilter(item.id)}
            className={[
              "rounded-full border px-3 py-1.5 text-xs font-medium transition duration-200",
              filter === item.id
                ? "border-primary/30 bg-primary-soft text-primary"
                : "border-border bg-surface text-text-secondary hover:border-primary/20",
            ].join(" ")}
          >
            {item.label}
            <span className="ml-1 tabular-nums opacity-70">{rules.filter(item.test).length}</span>
          </button>
        ))}
      </div>

      {editing && (
        <RuleForm
          key={editing === "new" ? "new" : editing.rule_id}
          rule={editing === "new" ? undefined : editing}
          categories={categories}
          onSubmit={save}
          onCancel={() => setEditing(null)}
        />
      )}

      {shown.length === 0 ? (
        <EmptyNote>No clauses or rules match this search and filter.</EmptyNote>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,21rem)_minmax(0,1fr)]">
          <nav aria-label="Clause index" className="space-y-2 lg:max-h-[46rem] lg:overflow-y-auto lg:pr-1">
            {groups.map(([category, items]) => (
              <details key={category} open className="group rounded-xl border border-border bg-surface">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-2.5">
                  <span className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-foreground">
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-secondary transition-transform group-open:rotate-90" aria-hidden="true" />
                    <span className="truncate">{category}</span>
                  </span>
                  <span className="text-[11px] tabular-nums text-text-muted">{items.length}</span>
                </summary>
                <ul className="border-t border-border py-1" role="list">
                  {items.map((rule) => {
                    const active = selected?.rule_id === rule.rule_id;
                    return (
                      <li key={rule.rule_id}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(rule.rule_id)}
                          aria-current={active ? "true" : undefined}
                          className={[
                            "flex w-full items-start justify-between gap-2 px-4 py-2 text-left transition-colors",
                            active ? "bg-primary-soft/60" : "hover:bg-surface-soft",
                            rule.enabled ? "" : "opacity-60",
                          ].join(" ")}
                        >
                          <span className="min-w-0">
                            <span className="font-id block text-sm font-medium text-foreground">{rule.clause_number}</span>
                            <span className="block truncate text-xs text-text-secondary" title={rule.title}>
                              {rule.title || "Untitled rule"}
                            </span>
                          </span>
                          <span className="flex shrink-0 flex-col items-end gap-1">
                            <ExpectationBadge expectation={rule.expectation} />
                            {!rule.enabled && <span className="text-[10px] text-text-muted">Disabled</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </details>
            ))}
          </nav>
          {selected && (
            <RuleInspector
              rule={selected}
              onToggle={() =>
                mutate(
                  () => updatePlaybookRule(selected.rule_id, { enabled: !selected.enabled }),
                  `${selected.clause_number} ${selected.enabled ? "disabled" : "enabled"}.`,
                )
              }
              onEdit={() => setEditing(selected)}
              onReset={() => mutate(() => resetPlaybookRule(selected.rule_id), `${selected.clause_number} reset to default.`)}
              onDelete={() => mutate(() => deletePlaybookRule(selected.rule_id), `${selected.clause_number} removed.`)}
              onSave={(changes) => saveChanges(selected, changes)}
            />
          )}
        </div>
      )}
    </section>
  );
}
