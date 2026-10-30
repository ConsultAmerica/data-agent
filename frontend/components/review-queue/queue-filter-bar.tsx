"use client";

import { useState } from "react";
import { Bookmark, FilterX, Search, X } from "lucide-react";

import {
  DEFAULT_FILTERS,
  filtersActive,
  UNASSIGNED,
  type ConfidenceFilter,
  type QueueFilters,
  type SavedFilter,
  type UrgencyFilter,
} from "./queue-filters";

const SELECT = "control min-w-0 basis-[calc(50%-0.25rem)] sm:basis-auto";

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
    <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-2.5">
      <div className="flex min-w-0 flex-[1_1_40rem] flex-wrap items-center gap-2" role="group" aria-label="Review filters">
        <label className="relative min-w-0 basis-full sm:min-w-[15rem] sm:flex-1 sm:basis-auto">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <input
            type="search"
            value={filters.query}
            onChange={(event) => set("query", event.target.value)}
            placeholder="Search filename, field or value…"
            aria-label="Search the review queue"
            className="control w-full pl-9"
          />
        </label>
        <select
          aria-label="Confidence level"
          value={filters.confidence}
          onChange={(event) => set("confidence", event.target.value as ConfidenceFilter)}
          data-active={filters.confidence !== DEFAULT_FILTERS.confidence}
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
          data-active={filters.assignee !== DEFAULT_FILTERS.assignee}
          className={`${SELECT} sm:max-w-[12rem]`}
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
          data-active={filters.contractType !== DEFAULT_FILTERS.contractType}
          className={`${SELECT} sm:max-w-[12rem]`}
        >
          <option value="all">Any document type</option>
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
          data-active={filters.urgency !== DEFAULT_FILTERS.urgency}
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
            className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-text-secondary hover:bg-surface-soft hover:text-foreground"
          >
            <FilterX className="h-3.5 w-3.5" aria-hidden="true" />
            Clear filters
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Saved filters" role="group">
        {(saved.length > 0 || naming) && (
          <span className="mr-0.5 font-medium text-text-muted">Saved views</span>
        )}
        {saved.map((entry) => (
          <span
            key={entry.id}
            className="inline-flex h-7 items-center overflow-hidden rounded-md border border-border bg-surface shadow-sm"
          >
            <button
              type="button"
              onClick={() => onChange({ ...entry.filters })}
              className="h-full pl-2.5 pr-1.5 font-medium text-foreground hover:text-primary"
              title="Apply this saved filter"
            >
              {entry.name}
            </button>
            <button
              type="button"
              onClick={() => onRemoveSaved(entry.id)}
              aria-label={`Remove saved filter ${entry.name}`}
              className="h-full border-l border-border px-1.5 text-text-muted hover:bg-danger/5 hover:text-[var(--danger)]"
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
              className="control h-7 w-44 px-2 text-xs"
            />
            <button type="submit" className="btn-primary h-7 px-2.5 text-xs">
              Save
            </button>
            <button type="button" onClick={() => setNaming(false)} className="px-1 font-medium text-text-secondary hover:text-foreground">
              Cancel
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setNaming(true)}
            disabled={!active}
            title={active ? "Save the current filters as a chip" : "Set a filter to save it"}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-dashed border-border px-3 text-[13px] font-medium text-text-secondary hover:border-primary/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border"
          >
            <Bookmark className="h-3.5 w-3.5" aria-hidden="true" />
            Save filter
          </button>
        )}
      </div>
    </div>
  );
}
