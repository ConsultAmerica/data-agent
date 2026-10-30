"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import SourceVerificationPanel, { type SourceViewRequest } from "@/components/source-verification-panel";
import SelectCheckbox from "@/components/staging/select-checkbox";
import ConfidenceMeter from "@/components/ui/confidence-meter";
import FieldToneLegend from "@/components/ui/field-tone-legend";
import { fieldToneClass, toneFromConfidence } from "@/lib/field-tone";
import { groupFieldsByUcfPart, type UcfPart } from "@/lib/intake";
import { checkState, fieldId, rowId, useRecordSelection } from "@/lib/record-selection";
import type { ExtractTargetsResult, ScalarTargetResult, TableTargetResult } from "@/types/document";

interface UcfFieldReviewProps {
  documentId: string;
  documentName: string;
  pageCount: number;
  result: ExtractTargetsResult;
  /** The field the viewer currently shows (shared with the page). */
  sourceRequest: SourceViewRequest | null;
  onViewSource: (request: SourceViewRequest) => void;
  /** Ids being stepped through by Review Selected (in order), if any. */
  reviewIds?: string[] | null;
  onReviewDone?: () => void;
}

/** Table rows shown at first; "Show all" renders the rest. */
const ROWS_SHOWN = 50;

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

/** A table row has no coordinates of its own: its table's first page,
 * without a highlight (nothing is invented). */
function sourceRequestForRow(table: TableTargetResult, index: number): SourceViewRequest {
  return {
    id: rowId(table.target, index),
    pageNumber: table.pages[0] ?? 1,
    label: `${table.target} · row ${index + 1}`,
  };
}

/**
 * 50/50 review workspace: the document page on the left (zoom, search,
 * page jump; the selected field's evidence highlighted), extracted fields
 * on the right in tabs by Uniform Contract Format part, from the section
 * the backend resolved for each value. Fields with no resolved UCF
 * section are listed under "Other", never guessed into a part.
 *
 * Inside a RecordSelectionProvider, fields and table rows get checkboxes
 * (all / part / field / table / row), shared with the Staging Workbook.
 */
export default function UcfFieldReview({
  documentId,
  documentName,
  pageCount,
  result,
  sourceRequest,
  onViewSource,
  reviewIds = null,
  onReviewDone,
}: UcfFieldReviewProps) {
  const selection = useRecordSelection();
  const groups = useMemo(() => groupFieldsByUcfPart(result.scalars ?? []), [result.scalars]);
  const firstWithFields = groups.find((group) => group.fields.length > 0)?.part ?? "part1";
  const [tab, setTab] = useState<UcfPart | null>(null);
  const activeTab = tab ?? firstWithFields;
  const active = groups.find((group) => group.part === activeTab) ?? groups[0];
  const tables = useMemo(() => result.tables ?? [], [result.tables]);
  const byKey = useMemo(() => new Map((result.scalars ?? []).map((field) => [field.normalized_key, field])), [result.scalars]);

  const allIds = useMemo(
    () => [
      ...(result.scalars ?? []).map((field) => fieldId(field.normalized_key)),
      ...tables.flatMap((table) => table.rows.map((_, index) => rowId(table.target, index))),
    ],
    [result.scalars, tables],
  );
  const selected = selection?.selected ?? new Set<string>();

  const shownField = sourceRequest?.id ? byKey.get(sourceRequest.id) ?? null : null;

  // Review Selected: step through the selection, one record at a time.
  const [reviewIndex, setReviewIndex] = useState(0);
  const reviewing = reviewIds && reviewIds.length > 0 ? reviewIds : null;
  function openRecord(id: string) {
    if (id.startsWith("field:")) {
      const field = byKey.get(id.slice("field:".length));
      if (field) onViewSource(sourceRequestForField(field));
    } else if (id.startsWith("row:")) {
      const [table, index] = id.slice("row:".length).split("#");
      const found = tables.find((item) => item.target === table);
      if (found) onViewSource(sourceRequestForRow(found, Number(index)));
    }
  }
  function step(next: number) {
    if (!reviewing) return;
    const bounded = Math.max(0, Math.min(reviewing.length - 1, next));
    setReviewIndex(bounded);
    openRecord(reviewing[bounded]);
  }

  return (
    <section
      className="grid h-full gap-4 lg:grid-cols-2"
      aria-label="Field review by contract part"
      data-testid="ucf-field-review"
    >
      <div className="min-h-[420px] lg:sticky lg:top-4 lg:h-full lg:self-start">
        <SourceVerificationPanel
          documentId={documentId}
          documentName={documentName}
          pageCount={pageCount}
          request={sourceRequest}
        />
      </div>

      <div className="editorial-card flex min-h-0 min-w-0 flex-col overflow-auto p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base font-medium text-foreground">
            {selection && (
              <SelectCheckbox
                label="Select all fields and table rows"
                checked={checkState(allIds, selected) === "checked"}
                indeterminate={checkState(allIds, selected) === "indeterminate"}
                onChange={() => selection.toggle(allIds, checkState(allIds, selected) !== "checked")}
              />
            )}
            Extracted fields
          </h2>
          <FieldToneLegend />
        </div>

        {reviewing && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary-soft/40 px-3 py-2 text-xs" data-testid="review-selected-bar">
            <span className="font-medium text-foreground">
              Reviewing {reviewIndex + 1} of {reviewing.length}
            </span>
            <span className="text-text-secondary">Nothing is approved here — check each value against its source.</span>
            <span className="ml-auto flex gap-1.5">
              <button type="button" className="btn-secondary px-2 py-0.5 text-xs" disabled={reviewIndex === 0} onClick={() => step(reviewIndex - 1)}>
                Previous
              </button>
              <button type="button" className="btn-secondary px-2 py-0.5 text-xs" disabled={reviewIndex >= reviewing.length - 1} onClick={() => step(reviewIndex + 1)}>
                Next
              </button>
              <button type="button" className="px-2 py-0.5 text-xs text-text-secondary hover:text-foreground" onClick={() => onReviewDone?.()}>
                Done
              </button>
            </span>
          </div>
        )}

        <div role="tablist" aria-label="Uniform Contract Format parts" className="mt-3 flex flex-wrap gap-1.5">
          {groups.map((group) => {
            const selectedTab = group.part === active.part;
            const short = group.part === "other" ? "Other" : group.label.split(" — ")[0];
            return (
              <button
                key={group.part}
                type="button"
                role="tab"
                id={`ucf-tab-${group.part}`}
                aria-selected={selectedTab}
                aria-controls={`ucf-panel-${group.part}`}
                onClick={() => setTab(group.part)}
                aria-label={`${short}: ${group.fields.length} ${group.fields.length === 1 ? "field" : "fields"}`}
                title={`${group.label} (${group.sections})`}
                className={[
                  "rounded-full border px-3 py-1 text-xs transition",
                  selectedTab
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
          className="mt-4"
        >
          {(() => {
            const partIds = active.fields.map((field) => fieldId(field.normalized_key));
            const state = checkState(partIds, selected);
            return (
              <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                {selection && partIds.length > 0 && (
                  <SelectCheckbox
                    label={`Select all fields in ${active.label}`}
                    checked={state === "checked"}
                    indeterminate={state === "indeterminate"}
                    onChange={() => selection.toggle(partIds, state !== "checked")}
                  />
                )}
                {active.label}
              </p>
            );
          })()}
          <p className="text-xs text-text-muted">{active.sections}</p>

          {active.fields.length === 0 ? (
            <p className="mt-4 rounded-xl border border-dashed border-border p-4 text-sm text-text-secondary">
              No extracted fields were located in {active.part === "other" ? "an unidentified section" : "this part"}.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {active.fields.map((field) => {
                const isShown = sourceRequest?.id === field.normalized_key;
                const id = fieldId(field.normalized_key);
                const tone = toneFromConfidence(
                  field.confidence,
                  field.confidence_band,
                  field.validation_status === "failed",
                );
                return (
                  <li key={field.normalized_key} className="flex items-start gap-2">
                    {selection && (
                      <SelectCheckbox
                        className="mt-3"
                        label={`Select ${field.target}`}
                        checked={selected.has(id)}
                        onChange={() => selection.toggle([id], !selected.has(id))}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => onViewSource(sourceRequestForField(field))}
                      aria-pressed={isShown}
                      className={[
                        "min-w-0 flex-1 rounded-lg px-2 py-2.5 text-left transition",
                        isShown ? "bg-primary-soft/50" : "hover:bg-surface-soft",
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
        </div>

        {shownField && (
          <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 rounded-lg border border-border bg-surface-soft/60 p-3 text-xs" data-testid="selected-field-details">
            <dt className="text-text-secondary">Original label</dt>
            <dd className="text-foreground">{shownField.target}</dd>
            <dt className="text-text-secondary">Extracted value</dt>
            <dd className="break-words text-foreground">{displayValue(shownField.value)}</dd>
            <dt className="text-text-secondary">Validation</dt>
            <dd className={shownField.validation_status === "failed" ? "text-danger" : "text-foreground"}>{shownField.validation_status ?? "Not checked"}</dd>
            <dt className="text-text-secondary">Review status</dt>
            <dd className="text-foreground">{shownField.review_status ?? "Not reviewed"}</dd>
            <dt className="text-text-secondary">Source</dt>
            <dd className="text-foreground">
              Page {shownField.evidence?.page_number || shownField.page}
              {!bboxOf(shownField) && (
                <span className="text-text-muted"> · no coordinates recorded; the page is searched for the value&apos;s text instead</span>
              )}
            </dd>
          </dl>
        )}

        {tables.length > 0 && (
          <div className="mt-5 space-y-3" data-testid="ucf-tables">
            <p className="text-sm font-medium text-foreground">Extracted tables</p>
            {tables.map((table) => (
              <TableRows key={table.target} table={table} onOpen={(index) => onViewSource(sourceRequestForRow(table, index))} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function TableRows({ table, onOpen }: { table: TableTargetResult; onOpen: (index: number) => void }) {
  const selection = useRecordSelection();
  const [all, setAll] = useState(false);
  const selected = selection?.selected ?? new Set<string>();
  const ids = useMemo(() => table.rows.map((_, index) => rowId(table.target, index)), [table]);
  const state = checkState(ids, selected);
  const shown = all ? table.rows : table.rows.slice(0, ROWS_SHOWN);
  const toggleSelection = selection?.toggle;
  const toggleRow = useCallback((id: string, on: boolean) => toggleSelection?.([id], on), [toggleSelection]);
  // A stable handler for the memoised rows; it calls the latest onOpen.
  const openRef = useRef(onOpen);
  useEffect(() => {
    openRef.current = onOpen;
  }, [onOpen]);
  const openRow = useCallback((index: number) => openRef.current(index), []);
  return (
    <div className="rounded-lg border border-border" data-testid="ucf-table">
      <p className="flex items-center gap-2 border-b border-border bg-surface-soft px-3 py-1.5 text-xs">
        {selection && (
          <SelectCheckbox
            label={`Select all rows of ${table.target}`}
            checked={state === "checked"}
            indeterminate={state === "indeterminate"}
            onChange={() => selection.toggle(ids, state !== "checked")}
          />
        )}
        <span className="font-medium text-foreground">{table.target}</span>
        <span className="text-text-muted">
          {table.rows.length} rows · {table.pages.length > 1 ? `pages ${table.pages[0]}–${table.pages[table.pages.length - 1]}` : `page ${table.pages[0] ?? "—"}`}
        </span>
      </p>
      <div className="max-h-[360px] overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-surface">
            <tr className="text-left text-text-secondary">
              {selection && <th className="w-6 px-2 py-1" aria-label="Select" />}
              {table.columns.map((column) => <th key={column} scope="col" className="whitespace-nowrap px-2 py-1 font-medium">{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, index) => (
              <TableRow
                key={ids[index]}
                id={ids[index]}
                index={index}
                table={table.target}
                columns={table.columns}
                row={row}
                selectable={Boolean(selection)}
                checked={selected.has(ids[index])}
                onToggle={toggleRow}
                onOpen={openRow}
              />
            ))}
          </tbody>
        </table>
      </div>
      {table.rows.length > ROWS_SHOWN && (
        <button type="button" className="w-full border-t border-border px-3 py-1 text-xs text-primary hover:bg-surface-soft" onClick={() => setAll((value) => !value)}>
          {all ? `Show the first ${ROWS_SHOWN} rows` : `Show all ${table.rows.length} rows`}
        </button>
      )}
    </div>
  );
}

/** One table row; memoised so a selection change re-renders only the rows
 * whose checkbox changed (large tables stay responsive). */
const TableRow = memo(function TableRow({
  id, index, table, columns, row, selectable, checked, onToggle, onOpen,
}: {
  id: string;
  index: number;
  table: string;
  columns: string[];
  row: Record<string, unknown>;
  selectable: boolean;
  checked: boolean;
  onToggle: (id: string, on: boolean) => void;
  onOpen: (index: number) => void;
}) {
  return (
    <tr className="cursor-pointer border-t border-border/60 hover:bg-surface-soft" onClick={() => onOpen(index)} data-testid="ucf-table-row">
      {selectable && (
        <td className="px-2 py-1">
          <SelectCheckbox label={`Select row ${index + 1} of ${table}`} checked={checked} onChange={() => onToggle(id, !checked)} />
        </td>
      )}
      {columns.map((column) => <td key={column} className="px-2 py-1 text-foreground">{displayValue(row[column])}</td>)}
    </tr>
  );
});
