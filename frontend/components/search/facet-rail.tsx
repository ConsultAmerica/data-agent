"use client";

import { useState } from "react";
import { Bookmark, X } from "lucide-react";

import {
  activeFilterCount,
  FACET_GROUPS,
  STATUS_LABELS,
  type FacetKey,
  type FacetValue,
  type InsightsFilters,
  type SavedView,
} from "@/lib/insights-search";

interface FacetRailProps {
  facets: Record<FacetKey, FacetValue[]> | null;
  filters: InsightsFilters;
  onChange: (filters: InsightsFilters) => void;
  views: SavedView[];
  onSaveView: (name: string) => void;
  onApplyView: (view: SavedView) => void;
  onDeleteView: (id: string) => void;
}

function facetLabel(key: FacetKey, value: string) {
  return key === "statuses" ? (STATUS_LABELS[value] ?? value) : value;
}

export default function FacetRail({ facets, filters, onChange, views, onSaveView, onApplyView, onDeleteView }: FacetRailProps) {
  const [viewName, setViewName] = useState("");
  const active = activeFilterCount(filters);

  function toggle(key: FacetKey, value: string) {
    const current = filters[key];
    const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value];
    onChange({ ...filters, [key]: next });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Filters</p>
        {active > 0 && (
          <button
            type="button"
            onClick={() => onChange({ ...filters, document_types: [], families: [], statuses: [], clause_families: [], years: [], has_clauses: [], uploaded_from: null, uploaded_to: null })}
            className="text-xs font-medium text-primary hover:underline"
          >
            Clear filters ({active})
          </button>
        )}
      </div>

      {FACET_GROUPS.map((group) => {
        const values = facets?.[group.key] ?? [];
        // Keep selected values visible even when the current query has none.
        const selected = filters[group.key].filter((value) => !values.some((item) => item.value === value));
        const rows = [...values, ...selected.map((value) => ({ value, count: 0 }))];
        if (rows.length === 0) return null;
        return (
          <fieldset key={group.key}>
            <legend className="mb-1.5 text-xs font-medium text-foreground">{group.label}</legend>
            <ul className="space-y-0.5">
              {rows.map((item) => {
                const checked = filters[group.key].includes(item.value);
                return (
                  <li key={item.value}>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-sm hover:bg-surface-soft">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(group.key, item.value)}
                        className="h-3.5 w-3.5 accent-[var(--primary)]"
                      />
                      <span className="min-w-0 flex-1 truncate text-text-secondary">{facetLabel(group.key, item.value)}</span>
                      <span className="text-xs tabular-nums text-text-muted">{item.count}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}

      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-foreground">Uploaded</legend>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[11px] text-text-muted">
            From
            <input
              type="date"
              value={filters.uploaded_from ?? ""}
              onChange={(event) => onChange({ ...filters, uploaded_from: event.target.value || null })}
              className="mt-0.5 w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground"
            />
          </label>
          <label className="text-[11px] text-text-muted">
            To
            <input
              type="date"
              value={filters.uploaded_to ?? ""}
              onChange={(event) => onChange({ ...filters, uploaded_to: event.target.value || null })}
              className="mt-0.5 w-full rounded-md border border-border bg-surface px-2 py-1 text-xs text-foreground"
            />
          </label>
        </div>
      </fieldset>

      <div className="border-t border-border pt-4">
        <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-foreground">
          <Bookmark className="h-3.5 w-3.5 text-primary" />
          Saved views
        </p>
        {views.length === 0 ? (
          <p className="text-xs text-text-muted">Save a search and its filters to come back to it.</p>
        ) : (
          <ul className="flex flex-wrap gap-1.5">
            {views.map((view) => (
              <li key={view.id} className="inline-flex items-center rounded-full border border-border bg-surface text-xs">
                <button type="button" onClick={() => onApplyView(view)} className="py-1 pl-2.5 pr-1 text-text-secondary hover:text-foreground">
                  {view.name}
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteView(view.id)}
                  aria-label={`Delete saved view ${view.name}`}
                  className="py-1 pl-0.5 pr-2 text-text-muted hover:text-danger"
                >
                  <X className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (!viewName.trim()) return;
            onSaveView(viewName.trim());
            setViewName("");
          }}
        >
          <input
            value={viewName}
            onChange={(event) => setViewName(event.target.value)}
            placeholder="Name this view"
            aria-label="Saved view name"
            className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-xs"
          />
          <button type="submit" disabled={!viewName.trim()} className="btn-secondary px-2.5 py-1 text-xs disabled:opacity-50">
            Save
          </button>
        </form>
      </div>
    </div>
  );
}
