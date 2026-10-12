"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";

import { ReviewStatusBadge, canOpenSource, formatCellValue } from "@/components/staging/review-status";
import type { SourceColumnValue, StagingCell } from "@/lib/staging-workbook";
import { humanizeExtractionMethod, sourceLocation } from "@/lib/transcript-workbook";

export interface EvidenceTarget {
  /** Where the value sits in the workbook ("Student Information"). */
  context: string;
  /** Display label of the field. */
  field: string;
  cell: StagingCell;
  /** The label exactly as printed, when the value had one. */
  sourceLabel?: string | null;
  /** Canonical field id (integration key). */
  fieldId?: string | null;
  /** Physical pieces the logical value was built from. */
  fragments?: SourceColumnValue[];
}

interface EvidenceDrawerProps {
  target: EvidenceTarget;
  onClose: () => void;
  onViewInDocument?: (target: EvidenceTarget) => void;
  /**
   * Entry point to metadata Accept/Edit/Reject. Do not invent field-level
   * linkage — use the review page, optionally with a confirmed field_key.
   */
  metadataReviewHref?: string | null;
}

function Highlighted({ evidence, value }: { evidence: string; value: string }) {
  const needle = value.trim();
  const index = needle ? evidence.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (index < 0) return <>{evidence}</>;
  return (
    <>
      {evidence.slice(0, index)}
      <mark className="rounded bg-warning/20 px-0.5 text-foreground">{evidence.slice(index, index + needle.length)}</mark>
      {evidence.slice(index + needle.length)}
    </>
  );
}

/** One value's evidence: the source text it was read from, where it sits,
 * and a way to see it on the original. Extraction internals are kept in a
 * collapsed Technical Details section. */
export default function EvidenceDrawer({
  target,
  onClose,
  onViewInDocument,
  metadataReviewHref = null,
}: EvidenceDrawerProps) {
  const { cell } = target;
  const provenance = cell.provenance;
  const value = formatCellValue(cell);
  const location = sourceLocation(provenance);
  const method = humanizeExtractionMethod(provenance?.extraction_method);
  const bbox = provenance?.source_bbox;
  const locator = provenance?.source_locator;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  const technical: [string, string][] = [
    ["Extraction method", method ?? ""],
    [
      "OCR confidence",
      provenance?.ocr_confidence != null
        ? `${Math.round(provenance.ocr_confidence * 100)}%`
        : provenance?.source_type === "image"
          ? "Unavailable for this value"
          : "",
    ],
    ["OCR passes", provenance?.ocr_contested ? "Disagreed — confirm against the image" : ""],
    ["Location", location ?? ""],
    ["Source label", target.sourceLabel ?? ""],
    ["Canonical ID", target.fieldId ?? cell.canonical_field],
    ["Bounding box", bbox ? bbox.map((v) => v.toFixed(1)).join(", ") : ""],
    ["Source locator", locator?.dom_path ?? locator?.cell_ref ?? ""],
  ].filter(([, v]) => v) as [string, string][];

  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Evidence">
      <button type="button" aria-label="Close evidence" className="flex-1 bg-black/20" onClick={onClose} />
      <aside className="flex h-full w-full max-w-xl flex-col border-l border-border bg-surface shadow-xl">
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-text-teal">{target.context}</p>
            <h4 className="mt-1 break-words text-sm font-semibold text-foreground">{target.field}</h4>
            <p className="mt-1 whitespace-pre-wrap break-words text-base text-foreground">{value || "—"}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-right">
              <ReviewStatusBadge status={cell.review_status} />
              <p className="mt-0.5 text-[10px] text-text-muted">Staging QA</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-md p-1 text-text-secondary hover:bg-surface-soft"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 text-sm">
          {cell.review_reasons.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-warning">
              {cell.review_reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}

          <section aria-label="Source evidence" className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h5 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">Source Evidence</h5>
              {location && <span className="text-xs text-text-secondary">{location}</span>}
            </div>
            {provenance?.evidence_text ? (
              <blockquote className="whitespace-pre-wrap break-words rounded-lg border border-border bg-surface-soft px-3 py-2 text-sm leading-relaxed text-foreground">
                <Highlighted evidence={provenance.evidence_text} value={provenance.highlight_text ?? value} />
              </blockquote>
            ) : (
              <p className="text-text-muted">No source evidence was recorded for this value.</p>
            )}
            <div className="flex flex-wrap gap-2">
              {onViewInDocument && canOpenSource(cell) && (
                <button
                  type="button"
                  onClick={() => onViewInDocument(target)}
                  className="btn-secondary text-xs"
                >
                  View in Document
                </button>
              )}
              {metadataReviewHref && (
                <Link href={metadataReviewHref} className="btn-secondary text-xs" data-testid="open-metadata-review">
                  Open metadata review
                </Link>
              )}
            </div>
            {metadataReviewHref && (
              <p className="text-[11px] text-text-muted">
                Staging Verified is not Metadata Accepted. Accept / Edit / Reject live in metadata review.
              </p>
            )}
          </section>

          {technical.length > 0 && (
            <details className="rounded-lg border border-border px-3 py-2">
              <summary className="cursor-pointer select-none text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Technical Details
              </summary>
              <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-xs">
                {technical.map(([label, detail]) => (
                  <div key={label} className="contents">
                    <dt className="text-text-secondary">{label}</dt>
                    <dd className="break-all font-mono text-foreground">{detail}</dd>
                  </div>
                ))}
              </dl>
              {target.fragments && target.fragments.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs text-text-secondary">Source fragments</p>
                  <ul className="mt-1 space-y-0.5 text-xs">
                    {target.fragments.map((fragment, index) => (
                      <li key={index} className="font-mono text-foreground">
                        {fragment.raw_header ? <span className="text-text-muted">{fragment.raw_header}: </span> : null}
                        {fragment.raw_value}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </details>
          )}
        </div>
      </aside>
    </div>
  );
}
