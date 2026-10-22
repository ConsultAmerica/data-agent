"use client";

import { useMemo, useState } from "react";

import SourceVerificationPanel, { type SourceViewRequest } from "@/components/source-verification-panel";
import ConfidenceMeter from "@/components/ui/confidence-meter";
import FieldToneLegend from "@/components/ui/field-tone-legend";
import { fieldToneClass, toneFromConfidence } from "@/lib/field-tone";
import { groupFieldsByUcfPart, type UcfPart } from "@/lib/intake";
import type { ExtractTargetsResult, ScalarTargetResult } from "@/types/document";

interface UcfFieldReviewProps {
  documentId: string;
  documentName: string;
  pageCount: number;
  result: ExtractTargetsResult;
  /** The field the viewer currently shows (shared with the page). */
  sourceRequest: SourceViewRequest | null;
  onViewSource: (request: SourceViewRequest) => void;
}

function displayValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function bboxOf(field: ScalarTargetResult): [number, number, number, number] | null {
  const { x0, y0, x1, y1 } = field.evidence ?? {};
  return x0 != null && y0 != null && x1 != null && y1 != null ? [x0, y0, x1, y1] : null;
}

export function sourceRequestForField(field: ScalarTargetResult): SourceViewRequest {
  return {
    id: field.normalized_key,
    pageNumber: field.evidence?.page_number || field.page,
    highlightText: field.evidence?.source_text || displayValue(field.value),
    region: bboxOf(field),
    label: field.target,
    value: displayValue(field.value),
    confidence: field.confidence,
    verified: field.verified,
  };
}

/**
 * 50/50 review workspace: the document page on the left (zoom, search,
 * page jump; the selected field's evidence highlighted), extracted fields
 * on the right in tabs by Uniform Contract Format part, from the section
 * the backend resolved for each value. Fields with no resolved UCF
 * section are listed under "Other", never guessed into a part.
 */
export default function UcfFieldReview({
  documentId,
  documentName,
  pageCount,
  result,
  sourceRequest,
  onViewSource,
}: UcfFieldReviewProps) {
  const groups = useMemo(() => groupFieldsByUcfPart(result.scalars ?? []), [result.scalars]);
  const firstWithFields = groups.find((group) => group.fields.length > 0)?.part ?? "part1";
  const [tab, setTab] = useState<UcfPart | null>(null);
  const activeTab = tab ?? firstWithFields;
  const active = groups.find((group) => group.part === activeTab) ?? groups[0];

  return (
    <section
      className="grid gap-4 lg:grid-cols-2"
      aria-label="Field review by contract part"
      data-testid="ucf-field-review"
    >
      <div className="min-h-[560px] lg:sticky lg:top-4 lg:h-[calc(100vh-8rem)] lg:self-start">
        <SourceVerificationPanel
          documentId={documentId}
          documentName={documentName}
          pageCount={pageCount}
          request={sourceRequest}
        />
      </div>

      <div className="editorial-card flex min-w-0 flex-col p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-medium text-foreground">Extracted fields</h2>
          <FieldToneLegend />
        </div>

        <div role="tablist" aria-label="Uniform Contract Format parts" className="mt-3 flex flex-wrap gap-1.5">
          {groups.map((group) => {
            const selected = group.part === active.part;
            const short = group.part === "other" ? "Other" : group.label.split(" — ")[0];
            return (
              <button
                key={group.part}
                type="button"
                role="tab"
                id={`ucf-tab-${group.part}`}
                aria-selected={selected}
                aria-controls={`ucf-panel-${group.part}`}
                onClick={() => setTab(group.part)}
                aria-label={`${short}: ${group.fields.length} ${group.fields.length === 1 ? "field" : "fields"}`}
                title={`${group.label} (${group.sections})`}
                className={[
                  "rounded-full border px-3 py-1 text-xs transition",
                  selected
                    ? "border-primary/40 bg-primary-soft font-medium text-primary"
                    : "border-border text-text-secondary hover:bg-surface-soft hover:text-foreground",
                ].join(" ")}
              >
                {short}
                <span className="ml-1 tabular-nums text-text-muted">{group.fields.length}</span>
              </button>
            );
          })}
        </div>

        <div
          role="tabpanel"
          id={`ucf-panel-${active.part}`}
          aria-labelledby={`ucf-tab-${active.part}`}
          className="mt-4 min-h-0 flex-1"
        >
          <p className="text-sm font-medium text-foreground">{active.label}</p>
          <p className="text-xs text-text-muted">{active.sections}</p>

          {active.fields.length === 0 ? (
            <p className="mt-4 rounded-xl border border-dashed border-border p-4 text-sm text-text-secondary">
              No extracted fields were located in {active.part === "other" ? "an unidentified section" : "this part"}.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {active.fields.map((field) => {
                const selected = sourceRequest?.id === field.normalized_key;
                const tone = toneFromConfidence(
                  field.confidence,
                  field.confidence_band,
                  field.validation_status === "failed",
                );
                return (
                  <li key={field.normalized_key}>
                    <button
                      type="button"
                      onClick={() => onViewSource(sourceRequestForField(field))}
                      aria-pressed={selected}
                      className={[
                        "w-full rounded-lg px-2 py-2.5 text-left transition",
                        selected ? "bg-primary-soft/50" : "hover:bg-surface-soft",
                      ].join(" ")}
                    >
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-medium text-text-secondary">{field.target}</span>
                        <ConfidenceMeter value={field.confidence} />
                        <span className="ml-auto text-[11px] tabular-nums text-text-muted">
                          p. {field.evidence?.page_number || field.page}
                        </span>
                      </span>
                      <span className={`mt-1 block break-words text-sm text-foreground ${fieldToneClass(tone)}`}>
                        {displayValue(field.value)}
                      </span>
                      {field.evidence?.section && (
                        <span className="mt-0.5 block truncate text-[11px] text-text-muted">
                          {field.evidence.section}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {(result.tables?.length ?? 0) > 0 && (
            <p className="mt-4 text-xs text-text-muted">
              {result.tables.length} extracted {result.tables.length === 1 ? "table is" : "tables are"} listed in the
              detailed results below.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
