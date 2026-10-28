"use client";

import { CheckCircle2, ChevronDown, ChevronRight, Eye } from "lucide-react";
import { useMemo, useState } from "react";

import type { SourceViewRequest } from "@/components/source-verification-panel";
import type { UniversalValue } from "@/types/document";
import { hasSourcePage, sourcePageLabel } from "@/lib/source-page";

export type { SourceViewRequest };

interface FieldResultProps {
  values: UniversalValue[];
  /** Prefer dense rows for extraction results (default). */
  density?: "compact" | "cards";
  onViewSource?: (request: SourceViewRequest) => void;
}

function methodLabel(method: string): string {
  switch (method) {
    case "form_field":
      return "PDF Form Field";
    case "label_value":
      return "Label / Value";
    case "regex":
      return "Pattern Match";
    case "table":
      return "Table";
    case "ai":
      return "AI Fallback";
    default:
      return method;
  }
}

interface ValueGroup {
  label: string;
  value: unknown;
  items: UniversalValue[];
}

interface SourceEntry {
  page_number: number;
  source_reference: string;
  source_text: string;
  count: number;
}

function groupValues(values: UniversalValue[]): ValueGroup[] {
  const groups = new Map<string, ValueGroup>();

  for (const item of values) {
    const key = `${item.label}::${String(item.value ?? "")}`;
    const existing = groups.get(key);

    if (existing) {
      existing.items.push(item);
    } else {
      groups.set(key, { label: item.label, value: item.value, items: [item] });
    }
  }

  return Array.from(groups.values());
}

function consolidateSources(items: UniversalValue[]): SourceEntry[] {
  const sources = new Map<string, SourceEntry>();

  for (const item of items) {
    const ref = item.evidence.source_reference?.trim() || "";
    const text = item.evidence.source_text?.trim() || "";
    const page = item.evidence.page_number;
    const key = `${page}::${ref}::${text}`;
    const existing = sources.get(key);

    if (existing) {
      existing.count += 1;
    } else {
      sources.set(key, {
        page_number: page,
        source_reference: ref || sourcePageLabel(page),
        source_text: text,
        count: 1,
      });
    }
  }

  return Array.from(sources.values()).sort(
    (a, b) => a.page_number - b.page_number,
  );
}

function ValidationBadge({ verified }: { verified: boolean }) {
  return verified ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-[11px] font-semibold text-success">
      <CheckCircle2 className="h-3 w-3" />
      Valid
    </span>
  ) : (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-semibold text-warning">
      Unverified
    </span>
  );
}

const CONFIDENCE_BAND_STYLES: Record<string, string> = {
  high: "bg-success/10 text-success",
  medium: "bg-warning/10 text-warning",
  low: "bg-danger/10 text-danger",
};

function ConfidenceBadge({
  confidence,
  band,
}: {
  confidence: number;
  band?: string;
}) {
  const resolvedBand =
    band ?? (confidence >= 0.85 ? "high" : confidence >= 0.6 ? "medium" : "low");
  const style = CONFIDENCE_BAND_STYLES[resolvedBand] ?? CONFIDENCE_BAND_STYLES.medium;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ${style}`}
    >
      {resolvedBand} · {Math.round(confidence * 100)}%
    </span>
  );
}

function SourceList({ items }: { items: UniversalValue[] }) {
  const sources = useMemo(() => consolidateSources(items), [items]);

  return (
    <div className="space-y-2">
      {sources.map((source, index) => (
        <div
          key={index}
          className="rounded-lg border border-border bg-surface p-3 text-xs leading-5 text-text-secondary"
        >
          <p className="font-medium text-foreground">
            {source.source_reference}
            {source.count > 1 && (
              <span className="ml-1.5 font-normal text-text-muted">
                · seen {source.count}×
              </span>
            )}
          </p>
          {source.source_text && (
            <p className="mt-2 whitespace-pre-wrap">{source.source_text}</p>
          )}
        </div>
      ))}
    </div>
  );
}

function ValueRow({
  group,
  onViewSource,
}: {
  group: ValueGroup;
  onViewSource?: (request: SourceViewRequest) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const first = group.items[0];
  const anyVerified = group.items.some((item) => item.verified);
  const pages = Array.from(
    new Set(group.items.map((item) => item.evidence.page_number).filter(hasSourcePage)),
  ).sort((a, b) => a - b);
  const uniqueSources = consolidateSources(group.items).length;

  return (
    <>
      <tr className="border-b border-border last:border-0 hover:bg-surface-soft">
        <td className="px-3 py-2.5 align-top sm:px-4">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="flex items-start gap-1.5 text-left"
          >
            {expanded ? (
              <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />
            ) : (
              <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />
            )}
            <span className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              {group.label}
            </span>
          </button>
        </td>
        <td className="px-3 py-2.5 align-top text-sm font-medium text-foreground sm:px-4">
          {String(group.value ?? "")}
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 align-top sm:px-4">
          <ConfidenceBadge confidence={first.confidence} band={first.confidence_band} />
        </td>
        <td className="min-w-[7rem] px-3 py-2.5 align-top text-xs text-text-secondary sm:px-4">
          <span className="font-medium text-foreground">
            {pages.length > 1 ? `pp. ${pages.join(", ")}` : `p. ${pages[0]}`}
          </span>
          {anyVerified && (
            <span className="ml-1 inline-flex align-middle text-success">
              <CheckCircle2 className="h-3 w-3" />
            </span>
          )}
          <p className="mt-0.5 line-clamp-1 text-[11px] text-text-muted">
            {first.evidence.source_reference || "Source evidence"}
          </p>
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 align-top sm:px-4">
          <span className="text-xs font-medium text-foreground">
            {first.display_method || methodLabel(first.extraction_method)}
          </span>
        </td>
        <td className="whitespace-nowrap px-3 py-2.5 align-top sm:px-4">
          <ValidationBadge verified={anyVerified} />
        </td>
        <td className="hidden whitespace-nowrap px-3 py-2.5 align-top sm:table-cell sm:px-4">
          {onViewSource ? (
            <button
              type="button"
              onClick={() =>
                onViewSource({
                  pageNumber: first.evidence.page_number,
                  highlightText:
                    first.evidence.source_text ||
                    String(group.value ?? ""),
                  label: group.label,
                  value: String(group.value ?? ""),
                  confidence: first.confidence,
                  verified: anyVerified,
                })
              }
              className="inline-flex items-center gap-1 text-xs font-semibold text-text-teal hover:text-primary"
            >
              <Eye className="h-3 w-3" />
              View Source
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setExpanded((value) => !value)}
              className="inline-flex items-center gap-1 text-xs font-semibold text-text-teal hover:text-primary"
            >
              <Eye className="h-3 w-3" />
              {uniqueSources > 1 ? `${uniqueSources}` : "Source"}
            </button>
          )}
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-border bg-surface-soft/60 last:border-0">
          <td colSpan={5} className="px-3 py-3 sm:px-4">
            <p className="mb-2 text-[11px] text-text-muted">
              {methodLabel(first.extraction_method)}
              {pages.length > 1 ? ` · Pages ${pages.join(", ")}` : ""}
            </p>
            <SourceList items={group.items} />
          </td>
        </tr>
      )}
    </>
  );
}

export default function FieldResult({
  values,
  density = "compact",
  onViewSource,
}: FieldResultProps) {
  const groups = groupValues(values);

  if (groups.length === 0) {
    return null;
  }

  if (density === "cards" && groups.length < 4) {
    return (
      <div className="space-y-2">
        {groups.map((group, index) => {
          const first = group.items[0];
          const pages = Array.from(
            new Set(group.items.map((item) => item.evidence.page_number)),
          ).sort((a, b) => a - b);
          return (
            <div
              key={`${group.label}-${index}`}
              className="rounded-xl border border-border bg-surface-soft px-4 py-3"
            >
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">
                {group.label}
              </p>
              <p className="mt-1 text-base font-semibold text-foreground">
                {String(group.value ?? "")}
              </p>
              <p className="mt-1 text-xs text-text-secondary">
                {pages.length > 1
                  ? `Pages ${pages.join(", ")}`
                  : `Page ${pages[0]}`}{" "}
                · {methodLabel(first.extraction_method)}
              </p>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="min-w-full text-sm">
        <thead className="bg-surface-soft">
          <tr>
            <th className="whitespace-nowrap border-b border-border px-3 py-2.5 text-left text-xs font-semibold text-foreground sm:px-4">
              Field
            </th>
            <th className="whitespace-nowrap border-b border-border px-3 py-2.5 text-left text-xs font-semibold text-foreground sm:px-4">
              Value
            </th>
            <th className="whitespace-nowrap border-b border-border px-3 py-2.5 text-left text-xs font-semibold text-foreground sm:px-4">
              Confidence
            </th>
            <th className="whitespace-nowrap border-b border-border px-3 py-2.5 text-left text-xs font-semibold text-foreground sm:px-4">
              Source
            </th>
            <th className="whitespace-nowrap border-b border-border px-3 py-2.5 text-left text-xs font-semibold text-foreground sm:px-4">
              Method
            </th>
            <th className="whitespace-nowrap border-b border-border px-3 py-2.5 text-left text-xs font-semibold text-foreground sm:px-4">
              Validation
            </th>
            <th className="hidden whitespace-nowrap border-b border-border px-3 py-2.5 text-left text-xs font-semibold text-foreground sm:table-cell sm:px-4">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group, index) => (
            <ValueRow
              key={`${group.label}-${index}`}
              group={group}
              onViewSource={onViewSource}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
