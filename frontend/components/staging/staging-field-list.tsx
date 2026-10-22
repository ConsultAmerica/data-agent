"use client";

import type { SourceViewRequest } from "@/components/source-verification-panel";
import {
  ReviewStatusBadge,
  cellSourceRequest,
  formatCellValue,
  locationLabel,
} from "@/components/staging/review-status";
import SelectCheckbox from "@/components/staging/select-checkbox";
import SelectionToolbar from "@/components/staging/selection-toolbar";
import FieldToneLegend from "@/components/ui/field-tone-legend";
import { fieldToneClass, toneFromStagingCell } from "@/lib/field-tone";
import type { StagingDataset } from "@/lib/staging-workbook";
import { allSelected, isSelected, setCells, someSelected, toggleBlock, toggleCell, useTableSelection } from "@/lib/table-selection";

interface StagingFieldListProps {
  dataset: StagingDataset;
  onOpenSource?: (request: SourceViewRequest) => void;
  selectedId?: string | null;
  /** Field selection with Export Selected (needs the document). */
  documentId?: string;
  filename?: string;
}

/** A single-record dataset (Contract Summary, Document Summary, later
 * Invoice Summary) rendered as Field | Value | Page | Method | Status. */
export default function StagingFieldList({
  dataset,
  onOpenSource,
  selectedId,
  documentId,
  filename,
}: StagingFieldListProps) {
  const [selection, setSelection] = useTableSelection(documentId, dataset.dataset_id, dataset.display_name);
  const record = dataset.records[0];
  if (!record) return null;
  // One record: selecting means choosing which of its fields to export.
  const selecting = Boolean(documentId) && !record.record_id.endsWith(":empty");
  const ids = [record.record_id];
  const fields = dataset.columns.filter((column) => record.cells[column.canonical_field]).map((column) => column.canonical_field);

  return (
    <div className="space-y-2">
    <FieldToneLegend />
    {selecting && (
      <SelectionToolbar
        documentId={documentId}
        datasetId={dataset.dataset_id}
        filename={filename ?? "export"}
        selection={selection}
        onClear={() => setSelection(new Map())}
        onSelectVisible={() => setSelection((current) => setCells(current, ids, fields, true))}
      />
    )}
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full min-w-[640px] divide-y divide-border text-sm">
        <thead className="bg-surface-soft">
          <tr>
            {selecting && (
              <th className="w-9 px-2 py-2 text-center">
                <SelectCheckbox
                  checked={allSelected(selection, ids, fields)}
                  indeterminate={someSelected(selection, ids, fields)}
                  onChange={() => setSelection((current) => toggleBlock(current, ids, fields))}
                  label={`Select all ${fields.length} fields`}
                />
              </th>
            )}
            {["Field", "Value", "Location", "Method", "Status"].map((label) => (
              <th
                key={label}
                className="whitespace-nowrap px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-text-secondary"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {dataset.columns.map((column) => {
            const cell = record.cells[column.canonical_field];
            if (!cell) return null;
            const requestId = `${dataset.dataset_id}:${record.record_id}:${column.canonical_field}`;
            const request = cellSourceRequest(cell, requestId);
            const text = formatCellValue(cell);
            const picked = selecting && isSelected(selection, record.record_id, column.canonical_field);
            const toggle = () => setSelection((current) => toggleCell(current, record.record_id, column.canonical_field));
            return (
              <tr
                key={column.canonical_field}
                aria-selected={selecting ? picked : undefined}
                className={`align-top ${selectedId === requestId ? "bg-primary/[0.06]" : ""}`}
              >
                {selecting && (
                  <td className="px-2 py-2 text-center">
                    <SelectCheckbox checked={picked} onChange={toggle} label={`Select field ${column.display_label}`} />
                  </td>
                )}
                <td
                  className={`whitespace-nowrap px-3 py-2 text-text-secondary ${selecting ? "cursor-cell" : ""}`}
                  onClick={selecting ? toggle : undefined}
                >
                  {column.display_label}
                </td>
                <td
                  className={`relative max-w-md px-3 py-2 ${picked ? "cell-selected" : ""} ${fieldToneClass(toneFromStagingCell(cell), "cell")}`}
                >
                  {cell.value == null ? (
                    <span className="text-text-muted">—</span>
                  ) : request && onOpenSource ? (
                    <button
                      type="button"
                      onClick={() => onOpenSource(request)}
                      className="text-left font-medium text-foreground underline decoration-dotted decoration-text-muted hover:text-primary hover:decoration-primary"
                      title="View source evidence"
                    >
                      {text}
                    </button>
                  ) : (
                    <span className="font-medium text-foreground">{text}</span>
                  )}
                  {cell.review_status === "Needs Review" && cell.review_reasons.length > 0 && (
                    <p className="mt-0.5 text-xs text-warning">{cell.review_reasons[0]}</p>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums text-text-secondary">
                  {locationLabel(cell)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-xs text-text-secondary">
                  {cell.provenance?.extraction_method ?? "—"}
                </td>
                <td className="px-3 py-2">
                  <ReviewStatusBadge status={cell.review_status} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </div>
  );
}
