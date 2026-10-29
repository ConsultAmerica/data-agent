"use client";

import { Crosshair, Loader2, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import type { SourceViewRequest } from "@/components/source-verification-panel";
import { CATEGORY_LABEL, NO_DESTINATION, type CategoryId, type SelectedRecord } from "@/components/smart-view/contract-smart-view";
import { MAPPING_LABEL, MAPPING_TONE, type CategoryMapping } from "@/components/smart-view/oracle-status";
import { EvidenceBadge, ReviewSignals, validationOf } from "@/components/smart-view/review-indicators";
import { REVIEW_READ_ONLY_MESSAGE } from "@/lib/review-gate";
import type { StagingCell, StagingRecord } from "@/lib/staging-workbook";

/**
 * Record details: one record's summary, every extracted value in full,
 * its source evidence, validation, human review and saved Oracle mapping.
 *
 * Nothing is inferred: a missing page, coordinate, reviewer or mapping is
 * said to be missing. Values are shown as stored — machine-extracted
 * values only; human decisions live in Metadata review.
 */

const text = (value: StagingCell["value"] | undefined) => (value == null ? "" : String(value));

function cellOf(record: StagingRecord, key: string): StagingCell | undefined {
  return record.cells[key] ?? Object.values(record.cells).find((c) => c.canonical_field.endsWith(`.${key}`));
}

/** The cell whose provenance best locates the record (a page, then a region). */
export function evidenceCell(record: StagingRecord): StagingCell | null {
  const located = Object.values(record.cells).filter((c) => c.value != null && c.provenance?.source_page);
  return located.find((c) => c.provenance?.source_bbox) ?? located.find((c) => c.provenance?.highlight_text) ?? located[0] ?? null;
}

/** The source-viewer request for a record, and whether it can be exact. */
export function sourceRequestFor(selection: SelectedRecord, record: StagingRecord): { request: SourceViewRequest; exact: boolean } | null {
  const cell = evidenceCell(record);
  const provenance = cell?.provenance;
  if (!cell || !provenance?.source_page) return null;
  const highlight = provenance.highlight_text ?? (cell.value != null ? String(cell.value) : null);
  return {
    exact: Boolean(provenance.source_bbox || provenance.highlight_text),
    request: {
      id: `${selection.datasetId}:${record.record_id}`,
      pageNumber: provenance.source_page,
      highlightText: highlight,
      anchorText: provenance.anchor_text ?? null,
      region: provenance.source_bbox ?? null,
      label: selection.title,
      value: cell.value != null ? String(cell.value) : undefined,
      reviewStatus: record.record_status,
      extractionMethod: provenance.extraction_method ?? null,
      evidenceText: provenance.evidence_text ?? null,
      locator: provenance.source_locator ?? null,
      sourceType: provenance.source_type ?? null,
    },
  };
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
  return (
    <section data-testid={testId} aria-label={title}>
      <h4 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{title}</h4>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-2 py-0.5 text-xs">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}

const missing = (label = "Not recorded") => <span className="text-text-muted">{label}</span>;

export default function RecordDetails({
  selection,
  record,
  loading,
  mappings,
  documentId,
  documentName,
  reviewEnabled,
  onViewSource,
  onClose,
}: {
  selection: SelectedRecord;
  /** The full record (long values complete); null while it loads. */
  record: StagingRecord | null;
  loading: boolean;
  mappings: CategoryMapping[] | null;
  documentId: string;
  documentName: string;
  reviewEnabled: boolean;
  onViewSource: (request: SourceViewRequest) => void;
  onClose: () => void;
}) {
  const [showEmpty, setShowEmpty] = useState(false);
  const shown = record ?? selection.record;
  const cells = Object.values(shown.cells);
  const filled = cells.filter((c) => text(c.value).trim());
  const empty = cells.filter((c) => !text(c.value).trim());
  const field = (key: string) => text(cellOf(shown, key)?.value);
  const recordType = field("record_type");
  const identifier = field("record_id") || field("clin") || field("clause_number") || shown.record_id;
  const title = field("title") || (field("value").length <= 160 ? field("value") : "");
  const section = field("source_section") || field("section");
  const source = sourceRequestFor(selection, shown);
  const evidence = evidenceCell(shown);
  const provenance = evidence?.provenance ?? null;
  const locator = provenance?.source_locator;
  const validation = validationOf(cells);
  const failedChecks = cells.flatMap((c) => (c.validation?.checks ?? []).filter((k) => !k.passed).map((k) => ({ cell: c, check: k })));
  const requiredMissing = failedChecks.filter(({ check }) => /required|missing/i.test(check.check));
  const typeIssues = failedChecks.filter(({ check }) => /type|format|date|number|amount|pattern/i.test(check.check));
  const otherIssues = failedChecks.filter((f) => !requiredMissing.includes(f) && !typeIssues.includes(f));
  const relevant = (mappings ?? []).filter((m) => m.category === selection.category);
  const noDestination = NO_DESTINATION.includes(selection.category as CategoryId);

  return (
    <div className="space-y-4 text-sm" data-testid="record-details" role="region" aria-label={`Record details: ${selection.title}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-primary">{CATEGORY_LABEL[selection.category]}</p>
          <h3 className="break-words text-[15px] font-semibold text-foreground">{identifier}</h3>
        </div>
        <button type="button" onClick={onClose} aria-label="Close record details" className="rounded-lg p-1 text-text-muted hover:bg-surface-soft hover:text-foreground">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <Section title="Record summary" testId="details-summary">
        <dl>
          <Row label="Record type">{[CATEGORY_LABEL[selection.category], recordType].filter(Boolean).join(" · ")}</Row>
          <Row label="Identifier">{identifier}</Row>
          <Row label="Title / description">{title || missing()}</Row>
          <Row label="Source section">{section || missing()}</Row>
          <Row label="Evidence check"><EvidenceBadge status={shown.record_status} /></Row>
        </dl>
      </Section>

      <Section title={`Extracted data (${filled.length})`} testId="details-values">
        {loading && (
          <p className="mb-1 flex items-center gap-1.5 text-[11px] text-text-muted">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />Loading complete values…
          </p>
        )}
        <dl className="max-h-80 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border">
          {filled.map((c) => {
            const value = text(c.value);
            const raw = c.raw_value ?? "";
            return (
              <div key={c.canonical_field} className="px-2 py-1.5 text-xs" data-testid="details-value">
                <dt className="flex items-baseline justify-between gap-2">
                  <span className="font-medium text-text-secondary">{c.display_label}</span>
                  <span className="text-[10px] text-text-muted">{c.value_type}</span>
                </dt>
                <dd className="break-all font-mono text-[10px] text-text-muted" data-testid="details-canonical">{c.canonical_field}</dd>
                <dd className="mt-0.5 whitespace-pre-wrap break-words text-foreground">{value}</dd>
                {raw && raw.trim() !== value.trim() && (
                  <dd className="mt-0.5 whitespace-pre-wrap break-words text-[11px] text-text-muted">As printed: {raw}</dd>
                )}
              </div>
            );
          })}
        </dl>
        {empty.length > 0 && (
          <button type="button" onClick={() => setShowEmpty((v) => !v)} className="mt-1 text-[11px] text-primary hover:underline" aria-expanded={showEmpty}>
            {showEmpty ? "Hide" : "Show"} {empty.length} field{empty.length === 1 ? "" : "s"} not found in the document
          </button>
        )}
        {showEmpty && <p className="mt-1 text-[11px] text-text-muted">{empty.map((c) => c.display_label).join(" · ")}</p>}
      </Section>

      <Section title="Source evidence" testId="details-evidence">
        {loading && !provenance ? (
          // The grid row carries no provenance; the full record does.
          <p className="flex items-center gap-1.5 text-xs text-text-muted">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />Loading source evidence…
          </p>
        ) : (
        <>
        <dl>
          <Row label="Document">{provenance?.source_filename || documentName}</Row>
          <Row label="Page">{provenance?.source_page ?? missing("No page recorded")}</Row>
          <Row label="Section">{locator?.section_path?.length ? locator.section_path.join(" › ") : section || missing()}</Row>
          <Row label="Source reference">{field("source_reference") || field("reference") || missing()}</Row>
          {(locator?.sheet_name || locator?.cell_ref) && <Row label="Cell">{[locator.sheet_name, locator.cell_ref].filter(Boolean).join(" ! ")}</Row>}
          <Row label="Location">
            {provenance?.source_bbox ? (
              <span className="tabular-nums">Region recorded ({provenance.source_bbox.map((n) => Math.round(n)).join(", ")} pt)</span>
            ) : (
              missing("No exact coordinates recorded")
            )}
          </Row>
        </dl>
        {provenance?.evidence_text && (
          <blockquote className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border-l-2 border-primary/40 bg-surface-soft px-2 py-1.5 text-xs text-foreground">
            {provenance.evidence_text}
          </blockquote>
        )}
        <button type="button" disabled={!source} onClick={() => source && onViewSource(source.request)}
          className="btn-secondary mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 text-xs disabled:opacity-50">
          <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />View in source
        </button>
        {source && !source.exact && (
          <p className="mt-1 text-[11px] text-text-muted" data-testid="inexact-source">
            Exact highlighting isn&apos;t available for this record: the viewer opens page {source.request.pageNumber} and searches for the value.
          </p>
        )}
        {!source && <p className="mt-1 text-[11px] text-text-muted">No source page was recorded for this record.</p>}
        </>
        )}
      </Section>

      <Section title="Validation" testId="details-validation">
        <ReviewSignals record={shown} />
        {validation === "failed" && (
          <div className="mt-2 space-y-1 text-[11px]">
            {requiredMissing.length > 0 && <p className="text-danger">Missing required: {requiredMissing.map(({ cell }) => cell.display_label).join(", ")}</p>}
            {typeIssues.length > 0 && <p className="text-danger">Data-type issues: {typeIssues.map(({ cell, check }) => `${cell.display_label} (${check.message ?? check.check})`).join("; ")}</p>}
            {otherIssues.length > 0 && <p className="text-danger">Other checks: {otherIssues.map(({ cell, check }) => `${cell.display_label}: ${check.message ?? check.check}`).join("; ")}</p>}
          </div>
        )}
      </Section>

      <Section title="Human review" testId="details-human-review">
        <dl>
          <Row label="Review status">Not reviewed</Row>
          <Row label="Reviewer">{missing()}</Row>
          <Row label="Reviewed at">{missing()}</Row>
          <Row label="Approved value">{missing()}</Row>
        </dl>
        <p className="mt-1 text-[11px] text-text-muted">
          Extracted records carry no human decisions; values are approved and corrected in{" "}
          <Link href={`/documents/${documentId}/review`} className="text-primary hover:underline">Metadata review</Link>, which keeps its own audit history.
        </p>
        {!reviewEnabled && <p className="mt-1 text-[11px] text-warning">{REVIEW_READ_ONLY_MESSAGE}</p>}
      </Section>

      <Section title="Oracle mapping" testId="details-oracle">
        {mappings === null ? (
          <p className="text-xs text-text-muted">Checking saved mappings…</p>
        ) : relevant.length === 0 ? (
          <p className="text-xs text-text-muted">
            No Oracle mapping configured.
            {noDestination && " No verified Oracle import destination exists for this record type."}
          </p>
        ) : (
          <div className="space-y-3">{relevant.map((m) => <MappingFields key={m.profile.id} mapping={m} selection={selection} record={shown} documentId={documentId} />)}</div>
        )}
      </Section>
    </div>
  );
}

function MappingFields({ mapping, selection, record, documentId }: { mapping: CategoryMapping; selection: SelectedRecord; record: StagingRecord; documentId: string }) {
  const byColumn = new Map(mapping.template.columns.map((c) => [c.technical_name, c]));
  const keyOf = (c: StagingCell) => c.canonical_field.split(".").pop() ?? c.canonical_field;
  const rows = mapping.profile.spec.mappings
    .filter((m) => m.source.kind === "field" && m.source.field)
    .map((m) => {
      const cell = Object.values(record.cells).find((c) => c.canonical_field === m.source.field || keyOf(c) === m.source.field);
      return { mapping: m, column: byColumn.get(m.column), cell };
    })
    .filter((r) => r.cell);
  return (
    <div className="rounded-lg border border-border p-2 text-xs" data-testid="details-mapping">
      <p className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium text-foreground">{mapping.template.object_name}</span>
        <span className="text-text-muted">template v{mapping.template.version} · “{mapping.profile.name}” v{mapping.profile.version}</span>
        <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${MAPPING_TONE[mapping.state]}`}>{MAPPING_LABEL[mapping.state]}</span>
      </p>
      {rows.length ? (
        <table className="mt-1.5 w-full table-fixed text-left">
          <thead className="text-[10px] uppercase tracking-wide text-text-muted">
            <tr><th className="py-0.5 pr-2">Oracle label</th><th className="py-0.5 pr-2">Technical attribute</th><th className="py-0.5">Mapped value</th></tr>
          </thead>
          <tbody>
            {rows.map(({ mapping: m, column, cell }) => {
              const sameDataset = !m.source.dataset_id || m.source.dataset_id === selection.datasetId;
              return (
                <tr key={m.column} className="border-t border-border/60 align-top">
                  <td className="break-words py-1 pr-2">{column?.display_label || <span className="text-text-muted">—</span>}</td>
                  <td className="break-words py-1 pr-2 font-mono text-[11px]">{m.column}</td>
                  <td className="break-words py-1">
                    {sameDataset ? text(cell!.value) || <span className="text-text-muted">empty</span> : <span className="text-text-muted">From {m.source.dataset_id}, matched at export</span>}
                    {m.transform && m.transform !== "as_is" && <span className="block text-[10px] text-text-muted">exported with “{m.transform}”</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="mt-1 text-text-muted">
          This mapping exports rows of “{mapping.profile.spec.row_dataset ?? "the document"}”; none of its columns reads this record&apos;s fields directly.
        </p>
      )}
      <Link href={`/mapping/designer?template=${mapping.template.id}&document=${documentId}`} className="mt-1 inline-block text-primary hover:underline">Open in Mapping Studio</Link>
    </div>
  );
}
