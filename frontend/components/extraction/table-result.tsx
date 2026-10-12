"use client";

import { useMemo, useState } from "react";
import { Check, Copy, Download, FileText } from "lucide-react";

import ResizeHandle, { useGridSizes } from "@/components/staging/resize-handle";
import SortableHeader from "@/components/staging/sortable-header";
import { downloadBlob, toCsv, toTsv } from "@/lib/export";
import { cycleSort, sortByText, type SortState } from "@/lib/table-sort";
import type { UniversalTable } from "@/types/document";

interface TableResultProps {
  table: UniversalTable;
  onViewSource?: (request: {
    pageNumber: number;
    highlightText?: string | null;
    label?: string;
  }) => void;
}

const MIN_AUTO_WIDTH = 96;
const MAX_AUTO_WIDTH = 320;
const CHAR_PX = 8;
const CELL_PAD = 32;

function autoWidth(header: string, rows: UniversalTable["rows"]): number {
  let longest = header.length;
  for (const row of rows.slice(0, 40)) {
    longest = Math.max(longest, String(row[header] ?? "").length);
  }
  return Math.min(MAX_AUTO_WIDTH, Math.max(MIN_AUTO_WIDTH, longest * CHAR_PX + CELL_PAD));
}

export default function TableResult({ table, onViewSource }: TableResultProps) {
  const [copied, setCopied] = useState(false);
  const [sort, setSort] = useState<SortState>(null);
  const sizes = useGridSizes();

  const widths = useMemo(
    () =>
      table.headers.map((header) => sizes.columns[header] ?? autoWidth(header, table.rows)),
    [sizes.columns, table.headers, table.rows],
  );
  const tableWidth = widths.reduce((sum, width) => sum + width, 0);

  const sortedRows = useMemo(() => {
    const indexed = table.rows.map((row, index) => ({ row, index }));
    return sortByText(indexed, sort, (entry, field) => String(entry.row[field] ?? ""));
  }, [sort, table.rows]);

  async function copyTable() {
    try {
      await navigator.clipboard.writeText(toTsv(table.headers, table.rows));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied by the browser — the export
      // buttons remain a reliable fallback.
    }
  }

  function exportCsv() {
    downloadBlob(
      toCsv(table.headers, table.rows),
      `table-page-${table.page_number}.csv`,
      "text/csv;charset=utf-8;",
    );
  }

  function exportJson() {
    downloadBlob(
      JSON.stringify(table.rows, null, 2),
      `table-page-${table.page_number}.json`,
      "application/json;charset=utf-8;",
    );
  }

  return (
    <div className="editorial-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            {table.title || "Extracted table"}
          </p>
          <p className="mt-1 font-semibold text-foreground">
            Page {table.page_number}
            <span className="ml-2 text-xs font-medium text-text-teal">
              · Source evidence
            </span>
            <span className="ml-2 text-xs font-medium text-text-muted">
              · {table.rows.length} row{table.rows.length === 1 ? "" : "s"} ×{" "}
              {table.headers.length} column{table.headers.length === 1 ? "" : "s"}
            </span>
          </p>
          <p className="mt-1 text-xs text-text-secondary">
            {table.source_reference || `Verified against page ${table.page_number}`}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {onViewSource ? (
            <button
              type="button"
              onClick={() =>
                onViewSource({
                  pageNumber: table.page_number,
                  highlightText: table.source_reference || null,
                  label: table.title || "Extracted table",
                })
              }
              className="btn-secondary py-1.5 text-xs"
            >
              <FileText className="h-3.5 w-3.5" />
              View Source
            </button>
          ) : (
            <a
              href={`#page-${table.page_number}`}
              className="btn-secondary py-1.5 text-xs"
            >
              <FileText className="h-3.5 w-3.5" />
              View Source
            </a>
          )}

          <button
            type="button"
            onClick={copyTable}
            className="btn-secondary py-1.5 text-xs"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copied ? "Copied" : "Copy"}
          </button>

          <button
            type="button"
            onClick={exportCsv}
            className="btn-secondary py-1.5 text-xs"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>

          <button
            type="button"
            onClick={exportJson}
            className="btn-secondary py-1.5 text-xs"
          >
            <Download className="h-3.5 w-3.5" />
            Export JSON
          </button>
        </div>
      </div>

      <div className="max-h-[32rem] overflow-auto">
        <table
          className="table-fixed border-separate border-spacing-0 text-sm"
          style={{ width: tableWidth, minWidth: "100%" }}
        >
          <colgroup>
            {widths.map((width, index) => (
              <col key={table.headers[index]} style={{ width }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-surface-soft">
            <tr>
              {table.headers.map((header) => {
                const active = sort?.field === header;
                return (
                  <th
                    key={header}
                    scope="col"
                    aria-sort={
                      active && sort
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                    className="relative border-b border-border bg-surface-soft px-4 py-3 text-left align-middle text-[11px] font-semibold uppercase tracking-wide text-text-secondary"
                  >
                    <ResizeHandle
                      axis="column"
                      label={`Resize column ${header}`}
                      onResize={(size) => sizes.setColumn(header, size)}
                      onReset={() => sizes.setColumn(header, null)}
                    />
                    <SortableHeader
                      label={header}
                      active={Boolean(active)}
                      direction={sort?.direction}
                      onSort={() => setSort((current) => cycleSort(current, header))}
                    />
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {sortedRows.map(({ row, index }) => {
              const rowId = `r${index}`;
              const height = sizes.rows[rowId];
              return (
                <tr
                  key={rowId}
                  style={height ? { height } : undefined}
                  className={[
                    "group border-b border-border last:border-0 hover:bg-surface-soft",
                    height ? "grid-row-wrap" : "",
                  ].join(" ")}
                >
                  {table.headers.map((header, columnIndex) => (
                    <td
                      key={header}
                      className={[
                        "relative px-4 py-3 align-top text-text-secondary",
                        height ? "" : "whitespace-nowrap",
                      ].join(" ")}
                      title={String(row[header] ?? "")}
                    >
                      <span className={height ? "block break-words" : "block truncate"}>
                        {String(row[header] ?? "")}
                      </span>
                      {columnIndex === 0 && (
                        <ResizeHandle
                          axis="row"
                          label={`Resize row ${index + 1}`}
                          onResize={(size) => sizes.setRow(rowId, size)}
                          onReset={() => sizes.setRow(rowId, null)}
                        />
                      )}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
