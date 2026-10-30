"use client";

import { Crosshair, X } from "lucide-react";

import { QualityChip, RecordReview, SOURCE_LOCATION_LABEL, StatusBadge, type Selection } from "@/components/original-structure/original-structure-view";
import { MAPPING_LABEL, MAPPING_TONE, type CategoryMapping } from "@/components/smart-view/oracle-status";
import { ConfidenceChip, RecordHistory } from "@/components/verification/field-card";
import type { LayoutField, LayoutTable, LayoutTableRow } from "@/lib/original-structure";
import type { BusinessData } from "@/lib/verification";

type RecordEntry = { field?: LayoutField; row?: LayoutTableRow; table?: LayoutTable; section: string | null };

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-2 py-0.5">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="min-w-0 whitespace-pre-wrap break-words text-foreground">{children}</dd>
    </div>
  );
}

/** The business field that claims a layout record (its display label). */
function businessFieldOf(business: BusinessData | null, recordKey: string) {
  for (const section of business?.sections ?? []) {
    for (const field of section.fields) {
      if (field.candidates.some((c) => c.record_key === recordKey)) return { field, section: section.label };
    }
  }
  return null;
}

/**
 * Everything known about one record: its original and display labels, the
 * printed, extracted and reviewed values, evidence and page, how it was
 * found, extraction confidence and validation (kept apart), its correction
 * history and Oracle mapping — and the review actions.
 */
export default function RecordDetails({ documentId, recordKey, record, business, mappings, onClose, onViewSource, onChanged }: {
  documentId: string;
  recordKey: string;
  record: RecordEntry | undefined;
  business: BusinessData | null;
  mappings: CategoryMapping[] | null;
  onClose: () => void;
  onViewSource: (recordKey: string) => void;
  onChanged: () => void;
}) {
  const none = <span className="text-text-muted">Not recorded</span>;
  if (!record) {
    return (
      <section className="rounded-xl border border-border bg-surface p-4 text-xs" aria-label="Record details" data-testid="record-details">
        <p className="text-text-muted">This record is no longer in the document layout.</p>
        <button type="button" onClick={onClose} className="btn-secondary mt-2 px-2 py-1 text-xs">Close</button>
      </section>
    );
  }
  const selection: Selection = record.field
    ? { kind: "field", field: record.field, section: record.section }
    : { kind: "row", table: record.table!, row: record.row!, section: record.section };
  const claimed = businessFieldOf(business, recordKey);
  const category = record.field ? "header" : "lines";
  const relevant = (mappings ?? []).filter((m) => m.category === category);
  const page = record.field ? record.field.page : record.row?.page;
  const field = record.field;
  const meta = field?.metadata ?? null;

  return (
    <section className="space-y-3 rounded-xl border border-border bg-surface p-4 text-xs" aria-label="Record details" data-testid="record-details">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-primary">{field ? "Field" : record.row?.added ? "Added row" : "Table row"}</p>
          <h3 className="break-words text-sm font-semibold text-foreground">
            {claimed?.field.label ?? field?.label ?? `${record.table?.title ?? "Table"} · row ${(record.table?.rows.indexOf(record.row!) ?? 0) + 1}`}
          </h3>
          {record.section && <p className="text-text-muted">{record.section}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label="Close details" className="rounded-md p-1 text-text-muted hover:bg-surface-soft">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {field ? (
        <dl>
          <Detail label="Original label">{field.label}{field.item ? <span className="text-text-muted"> · under {[field.item.number, field.item.name].filter(Boolean).join(" ")}</span> : field.group ? <span className="text-text-muted"> · under {field.group}</span> : null}</Detail>
          <Detail label="Data quality"><QualityChip quality={field.quality} label={field.quality_label} confidence={field.ocr_confidence} /></Detail>
          <Detail label="Display label">{claimed ? `${claimed.field.label} (${claimed.section})` : <span className="text-text-muted">No business category</span>}</Detail>
          <Detail label="Printed value">{field.document_value === null ? none : field.document_value || <span className="text-text-muted">Blank in source</span>}</Detail>
          <Detail label="Original extracted value">{meta ? field.extracted_value || <span className="text-text-muted">Nothing extracted</span> : <span className="text-text-muted">Read from the layout; no extraction record</span>}</Detail>
          <Detail label="Effective value">{field.effective_value || <span className="text-text-muted">(blank)</span>}</Detail>
          <Detail label="Source evidence">{field.evidence || <span className="text-text-muted">Original source text unavailable.</span>}</Detail>
          <Detail label="Source page">{page ?? none}{page && !(field.value_bbox ?? field.bbox) ? <span className="text-text-muted"> · no coordinates (the page is searched for the text)</span> : null}</Detail>
          {field.source_location && <Detail label="Source location">{SOURCE_LOCATION_LABEL[field.source_location]}</Detail>}
          <Detail label="Extraction method">{field.found_by || none}{meta && ` · ${meta.extraction_method}`}</Detail>
          <Detail label="Confidence"><ConfidenceChip value={meta ? meta.confidence : null} /></Detail>
          <Detail label="Validation">
            {meta?.validation_status ?? (claimed ? claimed.field.validation_status.replace("_", " ") : none)}
            {[...field.flags.map((f) => f.message), ...(claimed?.field.issues ?? []).filter((i) => i.source !== "layout").map((i) => i.message)]
              .map((message, index) => <span key={index} className="block text-danger">{message}</span>)}
          </Detail>
          <Detail label="Review status"><StatusBadge status={field.review_status} /></Detail>
          {(field.other_metadata.length > 0 || meta) && (
            <Detail label="Candidates">
              {[meta, ...field.other_metadata].filter(Boolean).map((m) => (
                <span key={m!.id} className="block">
                  {m!.label}: {m!.original_value || m!.value || "(empty)"} · {Math.round(m!.confidence * 100)}% · {m!.validation_status ?? "not checked"} · {m!.review_status}
                </span>
              ))}
            </Detail>
          )}
        </dl>
      ) : (
        <dl>
          {record.table!.headers.map((header, index) => {
            const printed = record.row!.cells[index] ?? "";
            const reviewed = record.row!.reviewed_cells?.[index];
            return (
              <Detail key={index} label={header}>
                <span className={record.row!.flags?.some((f) => f.column === index) ? "text-danger" : ""}>{reviewed ?? printed}</span>
                {reviewed !== undefined && reviewed !== printed && !record.row!.added && <span className="text-text-muted"> (printed: {printed || "blank"})</span>}
              </Detail>
            );
          })}
          <Detail label="Review status"><StatusBadge status={record.row!.review_status ?? "Not reviewed"} /></Detail>
          <Detail label="Source page">{page ?? none}</Detail>
          <Detail label="Extraction method">{record.table!.detection_method.replace(/_/g, " ") || "table"}{record.table!.continued && " · merged across pages"}</Detail>
        </dl>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
        {page ? (
          <button type="button" onClick={() => onViewSource(recordKey)} className="btn-secondary inline-flex items-center gap-1.5 px-2.5 py-1 text-xs">
            <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />View in source
          </button>
        ) : (
          <span className="text-text-muted">No source page was recorded.</span>
        )}
      </div>

      <RecordReview key={recordKey} documentId={documentId} selection={selection} onDone={onChanged} />

      <div className="border-t border-border pt-2">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Correction history</p>
        <RecordHistory documentId={documentId} recordKey={recordKey} />
      </div>

      <div className="border-t border-border pt-2" data-testid="record-oracle">
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-text-secondary">Oracle mapping</p>
        {mappings === null ? (
          <p className="text-text-muted">Checking saved mappings…</p>
        ) : relevant.length === 0 ? (
          <p className="text-text-muted">No Oracle mapping configured.</p>
        ) : (
          <ul className="space-y-1">
            {relevant.map((m) => (
              <li key={m.profile.id} className="flex flex-wrap items-center gap-2">
                <span className="text-foreground">{m.template.object_name} v{m.template.version}</span>
                <span className={`rounded-full px-2 py-0.5 text-[11px] ${MAPPING_TONE[m.state]}`}>{MAPPING_LABEL[m.state]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
