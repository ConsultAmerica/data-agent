"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowUpRight } from "lucide-react";

import { EmptyNote, Panel } from "@/components/portfolio/portfolio-parts";
import {
  SAVED_QUERY_KIND_LABELS,
  createSavedQuery,
  deleteSavedQuery,
  listSavedQueries,
  savedQueryHref,
  updateSavedQuery,
  type SavedQuery,
  type SavedQueryInput,
  type SavedQueryKind,
} from "@/lib/playbook";

const KINDS = Object.keys(SAVED_QUERY_KIND_LABELS) as SavedQueryKind[];

/** The team's saved prompts and extraction criteria, so reviews ask the
 * same questions the same way across contracting teams. */
export default function SavedQueriesPanel() {
  const [queries, setQueries] = useState<SavedQuery[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<SavedQuery | "new" | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    listSavedQueries()
      .then((items) => active && setQueries(items))
      .catch((err: unknown) => active && setError(err instanceof Error ? err.message : "Unable to load saved queries."));
    return () => {
      active = false;
    };
  }, [tick]);

  async function mutate(task: () => Promise<unknown>, message: string) {
    setNotice("");
    try {
      await task();
      setNotice(message);
      setEditing(null);
      setTick((value) => value + 1);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "The change could not be saved.");
    }
  }

  return (
    <div id="saved-queries" className="scroll-mt-24">
      <Panel
        title="Saved queries"
        description="Prompts and extraction criteria your team reuses. Ask prompts show as Team prompts in DataoAI, clause searches on FAR / DFARS, and extraction criteria under Saved criteria in an extraction's custom instruction."
        action={
          <button type="button" onClick={() => setEditing("new")} className="btn-primary">
            Add query
          </button>
        }
      >
        {editing && (
          <div className="mb-4">
            <SavedQueryForm
              key={editing === "new" ? "new" : editing.id}
              initial={editing === "new" ? undefined : editing}
              onSubmit={(input) =>
                mutate(
                  () => (editing === "new" ? createSavedQuery(input) : updateSavedQuery(editing.id, input)),
                  `“${input.name}” saved.`,
                )
              }
              onCancel={() => setEditing(null)}
            />
          </div>
        )}
        {notice && (
          <p className="mb-3 text-sm text-text-secondary" role="status">
            {notice}
          </p>
        )}
        {error ? (
          <p className="text-sm text-danger">{error}</p>
        ) : !queries ? (
          <p className="text-sm text-text-secondary">Loading saved queries…</p>
        ) : queries.length === 0 ? (
          <EmptyNote>
            No saved queries yet. Use “Save to playbook” in DataoAI, on FAR / DFARS, or next to an
            extraction&apos;s custom instruction — or add one here.
          </EmptyNote>
        ) : (
          <ul className="divide-y divide-border" role="list" data-testid="saved-queries-list">
            {queries.map((saved) => (
              <li key={saved.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">
                    {saved.name}
                    <span className="ml-2 rounded-full bg-surface-soft px-2 py-0.5 text-[11px] font-normal text-text-secondary">
                      {SAVED_QUERY_KIND_LABELS[saved.kind]}
                    </span>
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-text-secondary">{saved.query}</p>
                  {saved.description && <p className="mt-0.5 text-xs text-text-muted">{saved.description}</p>}
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs">
                  <Link href={savedQueryHref(saved)} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
                    Run
                    <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </Link>
                  <button type="button" onClick={() => setEditing(saved)} className="text-text-secondary hover:text-primary">
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => mutate(() => deleteSavedQuery(saved.id), `“${saved.name}” removed.`)}
                    className="text-text-secondary hover:text-danger"
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function SavedQueryForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial?: SavedQuery;
  onSubmit: (input: SavedQueryInput) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<SavedQueryKind>(initial?.kind ?? "ask");
  const [query, setQuery] = useState(initial?.query ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSubmit({ name: name.trim(), kind, query: query.trim(), description: description.trim() });
    } finally {
      setSaving(false);
    }
  }

  const field = "mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground";
  return (
    <form onSubmit={submit} className="grid gap-3 rounded-lg border border-border bg-surface-soft p-4 sm:grid-cols-2">
      <label className="text-xs font-medium text-text-secondary">
        Name
        <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required className={field} />
      </label>
      <label className="text-xs font-medium text-text-secondary">
        Used in
        <select value={kind} onChange={(event) => setKind(event.target.value as SavedQueryKind)} className={field}>
          {KINDS.map((value) => (
            <option key={value} value={value}>
              {SAVED_QUERY_KIND_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
      <label className="text-xs font-medium text-text-secondary sm:col-span-2">
        {kind === "extraction" ? "Extraction criteria" : "Query"}
        <textarea
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          maxLength={2000}
          required
          rows={3}
          className={field}
        />
      </label>
      <label className="text-xs font-medium text-text-secondary sm:col-span-2">
        Note for reviewers (optional)
        <input value={description} onChange={(event) => setDescription(event.target.value)} maxLength={1000} className={field} />
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <button type="submit" disabled={saving || !name.trim() || !query.trim()} className="btn-primary disabled:opacity-50">
          {saving ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} className="btn-secondary">
          Cancel
        </button>
      </div>
    </form>
  );
}
