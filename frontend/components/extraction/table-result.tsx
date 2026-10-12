"use client";

import { useMemo, useState } from "react";
import { Check, Copy, Download, FileText } from "lucide-react";

import ResizeHandle, { useGridSizes } from "@/components/staging/resize-handle";
import { downloadBlob, toCsv, toTsv } from "@/lib/export";
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
  const sizes = useGridSizes();

  const widths = useMemo(
    () =>
      table.headers.map((header) => sizes.columns[header] ?? autoWidth(header, table.rows)),
    [sizes.columns, table.headers, table.rows],
  );
  const tableWidth = widths.reduce((sum, width) => sum + width, 0);

  async function copyTsv() {
    await navigator.clipboard.writeText(toTsv(table.headers, table.rows));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function exportCsv() {
    downloadBlob(
      `${table.name || "table"}.csv`,
      toCsv(table.headers, table.rows),
      "text/csv;charset=utf-8",
    );
  }

  function exportJson() {
    downloadBlob(
      `${table.name || "table"}.json`,
      JSON.stringify({ name: table.name, headers: table.headers, rows: table.rows }, null, 2),
      "application/json",
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm text-text-secondary">
          <FileText className="h-4 w-4" />
          <span className="font-medium text-foreground">{table.name || "Extracted table"}</span>
          <span>
            {table.rows.length} row{table.rows.length === 1 ? "" : "s"} · {table.headers.length}{" "}
            column{table.headers.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {onViewSource && table.page_number != null && (
            <button
              type="button"
              onClick={() =>
                onViewSource({
                  pageNumber: table.page_number as number,
                  label: table.name || "Table",
                })
              }
              className="btn-secondary py-1.5 text-xs"
            >
              View source
            </button>
          )}
          <button type="button" onClick={copyTsv} className="btn-secondary py-1.5 text-xs">
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" onClick={exportCsv} className="btn-secondary py-1.5 text-xs">
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
          <button type="button" onClick={exportJson} className="btn-secondary py-1.5 text-xs">
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
              {table.headers.map((header) => (
                <th
                  key={header}
                  scope="col"
                  className="relative border-b border-border bg-surface-soft px-4 py-3 text-left align-middle text-[11px] font-semibold uppercase tracking-wide text-text-secondary"
                >
                  <span className="line-clamp-2 min-w-0 break-normal">{header}</span>
                  <ResizeHandle
                    axis="column"
                    label={`Resize column ${header}`}
                    onResize={(size) => sizes.setColumn(header, size)}
                    onReset={() => sizes.setColumn(header, null)}
                  />
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {table.rows.map((row, index) => {
              const rowId = `r${index}`;
              const height = sizes.rows[rowId];
              const resizeRow = (key: string) => (
                <ResizeHandle
                  key={key}
                  axis="row"
                  label={`Resize row ${index + 1}`}
                  onResize={(size) => sizes.setRow(rowId, size)}
                  onReset={() => sizes.setRow(rowId, null)}
                />
              );
              return (
                <tr
                  key={rowId}
                  style={height ? { height } : undefined}
                  className={[
                    "group border-b border-border last:border-0 hover:bg-surface-soft",
                    height ? "grid-row-wrap" : "",
                  ].join(" ")}
                >
                  {table.headers.map((header) => (
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
                      {resizeRow(`row-${header}`)}
                      <ResizeHandle
                        axis="column"
                        label={`Resize column ${header}`}
                        onResize={(size) => sizes.setColumn(header, size)}
                        onReset={() => sizes.setColumn(header, null)}
                      />
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
