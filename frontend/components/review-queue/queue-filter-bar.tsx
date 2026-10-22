"use client";

import { useState } from "react";
import { Bookmark, Search, X } from "lucide-react";

import {
  DEFAULT_FILTERS,
  filtersActive,
  UNASSIGNED,
  type ConfidenceFilter,
  type QueueFilters,
  type SavedFilter,
  type UrgencyFilter,
} from "./queue-filters";

const SELECT =
  "rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary/40";

/** Confidence / reviewer / contract type / urgency filters, a search box and
 * named filter chips saved in this browser. */
export default function QueueFilterBar({
  filters,
  onChange,
  assignees,
  contractTypes,
  saved,
  onSave,
  onRemoveSaved,
}: {
  filters: QueueFilters;
  onChange: (next: QueueFilters) => void;
  assignees: string[];
  contractTypes: string[];
  saved: SavedFilter[];
  onSave: (name: string) => void;
  onRemoveSaved: (id: string) => void;
}) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const set = <K extends keyof QueueFilters>(key: K, value: QueueFilters[K]) => onChange({ ...filters, [key]: value });
  const active = filtersActive(filters);

  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Review filters">
        <label className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <input
            type="search"
            value={filters.query}
            onChange={(event) => set("query", event.target.value)}
            placeholder="Search filename, field or value…"
            aria-label="Search the review queue"
            className="w-full rounded-xl border border-border bg-surface py-2 pl-9 pr-3 text-sm text-foreground outline-none focus:border-primary/30"
          />
        </label>
        <select
          aria-label="Confidence level"
          value={filters.confidence}
          onChange={(event) => set("confidence", event.target.value as ConfidenceFilter)}
          className={SELECT}
        >
          <option value="all">Any confidence</option>
          <option value="below80">Below 80%</option>
          <option value="below60">Below 60%</option>
        </select>
        <select
          aria-label="Assigned reviewer"
          value={filters.assignee}
          onChange={(event) => set("assignee", event.target.value)}
          className={`${SELECT} max-w-[12rem]`}
        >
          <option value="all">Any reviewer</option>
          <option value={UNASSIGNED}>Unassigned</option>
          {assignees.map((assignee) => (
            <option key={assignee} value={assignee}>
              {assignee}
            </option>
          ))}
        </select>
        <select
          aria-label="Contract type"
          value={filters.contractType}
          onChange={(event) => set("contractType", event.target.value)}
          className={`${SELECT} max-w-[12rem]`}
        >
          <option value="all">Any contract type</option>
          {contractTypes.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <select
          aria-label="Urgency"
          value={filters.urgency}
          onChange={(event) => set("urgency", event.target.value as UrgencyFilter)}
          className={SELECT}
        >
          <option value="all">Any due date</option>
          <option value="overdue">Overdue</option>
          <option value="due7">Due within 7 days</option>
          <option value="none">No due date</option>
        </select>
        {active && (
          <button
            type="button"
            onClick={() => onChange({ ...DEFAULT_FILTERS })}
            className="text-xs font-medium text-text-secondary hover:text-foreground"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs" aria-label="Saved filters" role="group">
        {saved.map((entry) => (
          <span
            key={entry.id}
            className="inline-flex items-center overflow-hidden rounded-full border border-border bg-surface"
          >
            <button
              type="button"
              onClick={() => onChange({ ...entry.filters })}
              className="py-1 pl-3 pr-1.5 font-medium text-foreground hover:text-primary"
              title="Apply this saved filter"
            >
              {entry.name}
            </button>
            <button
              type="button"
              onClick={() => onRemoveSaved(entry.id)}
              aria-label={`Remove saved filter ${entry.name}`}
              className="py-1 pl-0.5 pr-2 text-text-muted hover:text-[var(--danger)]"
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        {naming ? (
          <form
            className="inline-flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = name.trim();
              if (!trimmed) return;
              onSave(trimmed);
              setName("");
              setNaming(false);
            }}
          >
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setNaming(false);
              }}
              maxLength={60}
              placeholder="Name this filter"
              aria-label="Saved filter name"
              className="w-40 rounded-md border border-border bg-surface px-2 py-1 text-foreground outline-none focus:border-primary/40"
            />
            <button type="submit" className="btn-primary px-2.5 py-1 text-xs">
              Save
            </button>
            <button type="button" onClick={() => setNaming(false)} className="text-text-secondary hover:text-foreground">
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setNaming(true)}
            disabled={!active}
            title={active ? "Save the current filters as a chip" : "Set a filter to save it"}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1 font-medium text-text-secondary hover:text-foreground disabled:opacity-50"
          >
            <Bookmark className="h-3 w-3" aria-hidden="true" />
            Save filter
          </button>
        )}
      </div>
    </div>
  );
}
