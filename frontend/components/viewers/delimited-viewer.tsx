"use client";

import { AlertTriangle } from "lucide-react";
import { useMemo, useState } from "react";

import SmartDataGrid, { type GridColumn, type GridRow } from "@/components/smart-view/smart-data-grid";
import { encodingLabel } from "@/components/smart-view/source-file-card";
import EvidenceBanner from "@/components/viewers/evidence-banner";
import type { ResolvedLocation, SourceView } from "@/lib/source-view";

const DELIMITER_LABEL: Record<string, string> = { comma: "Comma", semicolon: "Semicolon", tab: "Tab", pipe: "Pipe" };

/**
 * A CSV / TSV file's rows exactly as text — identifiers like 0001 stay
 * text, quoted delimiters stay inside their field — with how the file was
 * read (encoding, delimiter, header) and any doubt about it said plainly.
 */
export default function DelimitedViewer({ view, resolved, label }: { view: SourceView; resolved: ResolvedLocation | null; label: string | null }) {
  const rows = useMemo(() => view.rows ?? [], [view.rows]);
  const [header, setHeader] = useState(view.has_header ?? true);
  const [detail, setDetail] = useState<GridRow | null>(null);
  const width = rows.reduce((n, row) => Math.max(n, row.length), 0);

  const columns: GridColumn[] = useMemo(() => {
    const names = header && rows[0] ? rows[0] : [];
    return [
      { key: "__row", label: "#", width: 64, pinned: true },
      ...Array.from({ length: width }, (_, i) => ({ key: `c${i}`, label: names[i]?.trim() || `Column ${i + 1}`, width: 160 })),
    ];
  }, [rows, header, width]);

  const gridRows: GridRow[] = useMemo(
    () =>
      rows.slice(header ? 1 : 0).map((row, i) => {
        const number = i + (header ? 2 : 1);
        return { id: `r${number}`, values: { __row: String(number), ...Object.fromEntries(row.map((v, c) => [`c${c}`, v])) } };
      }),
    [rows, header],
  );

  // Evidence: the recorded row, else the first row holding the value.
  const target = resolved?.location.kind === "row" ? resolved.location : null;
  const focus = useMemo(() => {
    if (!target) return null;
    if (target.row >= 0) return `r${target.row + 1}`;
    const needle = target.text?.trim().toLowerCase();
    if (!needle) return null;
    return gridRows.find((r) => Object.entries(r.values).some(([k, v]) => k !== "__row" && v.trim().toLowerCase() === needle))?.id ?? null;
  }, [target, gridRows]);

  const guessed = view.encoding_guessed;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="delimited-viewer">
      <EvidenceBanner resolved={resolved} found={!target || focus != null} label={label} />
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11px]" data-testid="delimited-provenance">
        {view.encoding && (
          <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 ${guessed ? "bg-warning/10 text-warning" : "bg-surface-soft text-text-secondary"}`}>
            {guessed && <AlertTriangle className="h-3 w-3" aria-hidden="true" />}
            Encoding: {encodingLabel(view.encoding)}{guessed ? " (guessed)" : ""}
          </span>
        )}
        {view.delimiter && <span className="rounded-full bg-surface-soft px-2 py-0.5 text-text-secondary">Delimiter: {DELIMITER_LABEL[view.delimiter] ?? view.delimiter}</span>}
        <label className="inline-flex items-center gap-1 text-text-secondary">
          <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
          First row is the header{view.header_detected === false ? " (not detected)" : view.has_header ? " (detected)" : ""}
        </label>
        <span className="ml-auto text-text-muted">Values are shown exactly as text; nothing is converted.</span>
      </div>
      {(view.warnings ?? []).length > 0 && (
        <ul className="border-b border-warning/30 bg-warning/10 px-3 py-1 text-[11px] text-text-secondary" data-testid="delimited-warnings">
          {view.warnings!.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <SmartDataGrid tableKey="source:delimited" columns={columns} rows={gridRows} exportName="source-rows" emptyMessage="The file has no rows."
          onOpen={setDetail} selectedId={detail?.id ?? focus} focusId={focus} />
      </div>
      {detail && (
        <dl className="max-h-48 overflow-y-auto border-t border-border bg-surface-soft px-3 py-2 text-xs" data-testid="row-details" aria-live="polite">
          <p className="mb-1 font-medium">Row {detail.values.__row}</p>
          {columns.slice(1).map((c) => (
            <div key={c.key} className="grid grid-cols-[10rem_1fr] gap-2">
              <dt className="truncate text-text-secondary">{c.label}</dt>
              <dd className="whitespace-pre-wrap break-words font-mono">{detail.values[c.key] ?? ""}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
