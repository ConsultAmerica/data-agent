"use client";

import type { FieldRow } from "@/components/extraction/field-row";
import {
  fieldTypeLabel,
  reviewStatusLabel,
} from "@/components/extraction/workbook-classify";
import type { SourceViewRequest } from "@/components/source-verification-panel";
import { fieldToneClass, toneFromConfidence } from "@/lib/field-tone";

interface FieldsWorkbookGridProps {
  rows: FieldRow[];
  typeByLabel: Map<string, string>;
  selectedId?: string | null;
  onViewSource?: (request: SourceViewRequest) => void;
  onSelectRow?: (row: FieldRow) => void;
}

/**
 * Excel-style vertical audit grid for the Results workbook.
 * Label and value always occupy separate columns.
 */
export default function FieldsWorkbookGrid({
  rows,
  typeByLabel,
  selectedId = null,
  onViewSource,
  onSelectRow,
}: FieldsWorkbookGridProps) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-border bg-surface px-4 py-8 text-center text-sm text-text-secondary">
        No rows in this sheet.
      </p>
    );
  }

  return (
    <div className="overflow-auto rounded-xl border border-border bg-surface shadow-sm">
      <table className="min-w-full border-collapse text-left text-sm">
        <thead>
          <tr className="bg-[#1e3a5f] text-white">
            {[
              "PDF Page",
              "Field / Label",
              "Extracted Value",
              "Field Type",
              "Confidence",
              "Status",
              // Section is intentionally omitted here — assignment isn't
              // reliable enough yet and a mostly-blank column just adds
              // clutter. The data isn't gone: it's still recorded per
              // field (see evidence.section / row.evidence?.section) and
              // can come back as an optional column/filter once section
              // detection is reliable across document types.
            ].map((heading) => (
              <th
                key={heading}
                className="whitespace-nowrap border-r border-white/10 px-3 py-2.5 text-xs font-semibold uppercase tracking-wide last:border-r-0"
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const page = row.evidence?.page_number ?? row.scalar?.page ?? null;
            const empty =
              row.value == null ||
              String(row.value).trim() === "" ||
              row.status === "empty" ||
              row.status === "not_found";
            const selected = selectedId === row.id;
            const status = reviewStatusLabel(row);
            const openSource = () => {
              onSelectRow?.(row);
              if (onViewSource && page) {
                onViewSource({
                  id: row.id,
                  pageNumber: page,
                  highlightText:
                    row.evidence?.source_text || String(row.value ?? ""),
                  label: row.label,
                  value: String(row.value ?? ""),
                  confidence: row.confidence ?? undefined,
                  verified: row.verified,
                });
              }
            };

            return (
              <tr
                key={row.id}
                id={`field-row-${row.id}`}
                className={[
                  "border-t border-border",
                  selected
                    ? "bg-primary/10"
                    : index % 2 === 0
                      ? "bg-white"
                      : "bg-sky-50/60",
                  "cursor-pointer hover:bg-primary/5",
                ].join(" ")}
                onClick={openSource}
              >
                <td className="whitespace-nowrap border-r border-border/60 px-3 py-2 tabular-nums text-text-secondary">
                  {page ?? "—"}
                </td>
                <td className="max-w-[16rem] border-r border-border/60 px-3 py-2 font-medium text-foreground">
                  <span className="line-clamp-2">{row.label}</span>
                </td>
                <td className="max-w-[22rem] border-r border-border/60 px-3 py-2">
                  {empty ? (
                    <span className="text-xs font-medium text-warning">
                      Needs Review
                    </span>
                  ) : (
                    <span
                      className={`line-clamp-3 font-medium text-foreground ${fieldToneClass(
                        toneFromConfidence(row.confidence, null, status === "Rejected"),
                      )}`}
                    >
                      {String(row.value)}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap border-r border-border/60 px-3 py-2 text-text-secondary">
                  {fieldTypeLabel(row, typeByLabel)}
                </td>
                <td className="whitespace-nowrap border-r border-border/60 px-3 py-2 text-text-secondary">
                  {row.confidence != null
                    ? `${Math.round(row.confidence * 100)}%`
                    : "—"}
                </td>
                <td
                  className={[
                    "whitespace-nowrap px-3 py-2 text-xs font-semibold",
                    status === "Passed"
                      ? "text-success"
                      : status === "Rejected"
                        ? "text-danger"
                        : status === "Needs Review"
                          ? "text-warning"
                          : "text-primary",
                  ].join(" ")}
                >
                  {status}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
