"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Eye } from "lucide-react";

import ClickableFieldValue from "@/components/clickable-field-value";
import ConfidenceIndicator from "@/components/confidence-indicator";
import type { MetadataField, ReviewStatus } from "@/types/document";
import { sourcePageLabel } from "@/lib/source-page";

const GROUP_ORDER = [
  "Identification",
  "Parties",
  "Dates",
  "Financial",
  "Legal",
  "Commercial",
  "Compliance",
  "Government",
];

type FieldFilter =
  | "all"
  | "high"
  | "needs_review"
  | "accepted"
  | "rejected"
  | "unknown";

interface ExtractedDataPanelProps {
  fields: MetadataField[];
  initialFilter?: FieldFilter;
}

function matchesFilter(field: MetadataField, filter: FieldFilter): boolean {
  switch (filter) {
    case "high":
      return field.confidence >= 0.95;
    case "needs_review":
      return field.review_status === "pending";
    case "accepted":
      return (
        field.review_status === "accepted" || field.review_status === "edited"
      );
    case "rejected":
      return field.review_status === "rejected";
    case "unknown":
      return field.review_status === "unknown";
    default:
      return true;
  }
}

export default function ExtractedDataPanel({
  fields,
  initialFilter = "all",
}: ExtractedDataPanelProps) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FieldFilter>(initialFilter);

  useEffect(() => {
    setFilter(initialFilter);
  }, [initialFilter]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(["Identification", "Parties"]),
  );
  const [expandedField, setExpandedField] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return fields.filter((field) => {
      if (!matchesFilter(field, filter)) return false;
      if (!q) return true;
      const confidenceLabel = `${Math.round(field.confidence * 100)}%`;
      return (
        field.label.toLowerCase().includes(q) ||
        field.field_key.toLowerCase().includes(q) ||
        field.field_group.toLowerCase().includes(q) ||
        field.value.toLowerCase().includes(q) ||
        confidenceLabel.includes(q)
      );
    });
  }, [fields, filter, search]);

  const groups = useMemo(() => {
    const map = new Map<string, MetadataField[]>();
    for (const field of filtered) {
      const list = map.get(field.field_group) ?? [];
      list.push(field);
      map.set(field.field_group, list);
    }
    return [
      ...GROUP_ORDER.filter((g) => map.has(g)),
      ...[...map.keys()].filter((g) => !GROUP_ORDER.includes(g)),
    ].map((name) => ({ name, fields: map.get(name)! }));
  }, [filtered]);

  function toggleGroup(name: string) {
    setExpandedGroups((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  const filters: { id: FieldFilter; label: string }[] = [
    { id: "all", label: "All Fields" },
    { id: "high", label: "High Confidence" },
    { id: "needs_review", label: "Needs Review" },
    { id: "accepted", label: "Accepted" },
    { id: "rejected", label: "Rejected" },
    { id: "unknown", label: "Unknown" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-medium text-foreground">Extracted Data</h3>
          <p className="text-sm text-text-secondary">
            {filtered.length} of {fields.length} fields
          </p>
        </div>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search extracted fields..."
          className="w-full max-w-sm rounded-xl border border-border bg-surface px-4 py-2.5 text-sm outline-none focus:border-primary/30"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        {filters.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setFilter(item.id)}
            className={filter === item.id ? "chip chip-active" : "chip"}
          >
            {item.label}
          </button>
        ))}
      </div>

      {groups.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-secondary">
          No fields match your search or filters.
        </p>
      ) : (
        <div className="space-y-2">
          {groups.map(({ name, fields: groupFields }) => {
            const open = expandedGroups.has(name);
            return (
              <div
                key={name}
                className="rounded-xl border border-border bg-surface"
              >
                <button
                  type="button"
                  onClick={() => toggleGroup(name)}
                  className="sticky-group-header flex w-full items-center gap-3 rounded-t-xl px-4 py-3 text-left"
                >
                  {open ? (
                    <ChevronDown className="h-4 w-4 text-text-secondary" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-text-secondary" />
                  )}
                  <span className="text-xs font-semibold uppercase tracking-wider text-text-teal">
                    {name}
                  </span>
                  <span className="ml-auto text-xs text-text-muted">
                    {groupFields.length}{" "}
                    {groupFields.length === 1 ? "field" : "fields"}
                  </span>
                </button>

                {open && (
                  <div className="divide-y divide-border/60 border-t border-border/60">
                    {groupFields.map((field) => (
                      <FieldRow
                        key={field.field_key}
                        field={field}
                        expanded={expandedField === field.field_key}
                        onToggle={() =>
                          setExpandedField((current) =>
                            current === field.field_key
                              ? null
                              : field.field_key,
                          )
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FieldRow({
  field,
  expanded,
  onToggle,
}: {
  field: MetadataField;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div>
      {/* A button-like row, not a <button>: the value inside it is its own
          button (search popover), and buttons cannot nest. */}
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onToggle();
          }
        }}
        className="flex w-full cursor-pointer items-center gap-4 px-4 py-3 text-left transition hover:bg-surface-soft/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
      >
        <span className="min-w-[140px] shrink-0 text-sm text-text-secondary">
          {field.label}
        </span>
        <div className="min-w-0 flex-1">
          <ClickableFieldValue
            fieldKey={field.field_key}
            fieldLabel={field.label}
            value={field.value}
          />
        </div>
        <ConfidenceIndicator confidence={field.confidence} />
        <span className="hidden shrink-0 text-xs text-primary sm:inline">
          View Source
        </span>
        <StatusPill status={field.review_status} />
      </div>

      {expanded && (
        <div className="border-t border-border/60 bg-surface-soft/50 px-4 py-3 text-sm">
          <dl className="grid gap-2 sm:grid-cols-2">
            <Detail label="Source page" value={sourcePageLabel(field.evidence.page_number)} />
            <Detail
              label="Extraction method"
              value={field.extraction_method}
            />
            <Detail
              label="Verified"
              value={field.verified ? "Verified against source" : "Not verified"}
            />
            <Detail label="Reference" value={field.evidence.source_reference} />
          </dl>
          <button
            type="button"
            className="btn-tertiary mt-3 text-xs"
            onClick={(e) => e.stopPropagation()}
          >
            <Eye className="h-3.5 w-3.5" />
            View full source text
          </button>
          <p className="mt-2 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-surface p-3 text-xs leading-5 text-text-secondary">
            {field.evidence.source_text}
          </p>
        </div>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}

function StatusPill({ status }: { status: ReviewStatus }) {
  const styles: Record<ReviewStatus, string> = {
    pending: "bg-surface-soft text-text-secondary",
    accepted: "bg-success/10 text-success",
    edited: "bg-primary-soft text-primary",
    rejected: "bg-danger/10 text-danger",
    unknown: "bg-warning/10 text-warning",
  };
  return (
    <span
      className={[
        "hidden shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase sm:inline",
        styles[status],
      ].join(" ")}
    >
      {status.replace("_", " ")}
    </span>
  );
}

export type { FieldFilter };
