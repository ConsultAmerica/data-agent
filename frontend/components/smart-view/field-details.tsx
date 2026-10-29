"use client";

import { Crosshair, X } from "lucide-react";
import Link from "next/link";

import type { SourceViewRequest } from "@/components/source-verification-panel";
import { EvidenceBadge } from "@/components/smart-view/review-indicators";
import type { FormField } from "@/lib/doc-schemas";

const STATUS: Record<string, string> = {
  found: "Found in the document",
  matched_by_label: "Found next to its label",
  calculated: "Calculated from other values",
  default: "Default value (not printed in the document)",
  not_found: "Not found in the document",
};

/** One schema field's details: value, how it was found, where, and how
 * to correct it. Nothing is shown that wasn't recorded. */
export default function FieldDetails({
  field,
  documentId,
  onViewSource,
  onClose,
}: {
  field: FormField;
  documentId: string;
  onViewSource: (request: SourceViewRequest) => void;
  onClose: () => void;
}) {
  const value = field.value;
  return (
    <section className="space-y-2 text-xs" data-testid="field-details" aria-label={`Field details: ${field.label}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-primary">Field</p>
          <h3 className="break-words text-[15px] font-semibold text-foreground">{field.label}</h3>
        </div>
        <button type="button" onClick={onClose} aria-label="Close field details" className="rounded-lg p-1 text-text-muted hover:bg-surface-soft hover:text-foreground">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      <dl className="space-y-1">
        <div className="grid grid-cols-[6.5rem_1fr] gap-2"><dt className="text-text-secondary">Value</dt>
          <dd className="whitespace-pre-wrap break-words font-medium text-foreground">{value.value || <span className="font-normal text-text-muted">Not found</span>}</dd></div>
        <div className="grid grid-cols-[6.5rem_1fr] gap-2"><dt className="text-text-secondary">How</dt>
          <dd>{STATUS[value.status] ?? value.status}{value.method ? ` · ${value.method}` : ""}</dd></div>
        {value.document_label && (
          <div className="grid grid-cols-[6.5rem_1fr] gap-2"><dt className="text-text-secondary">Printed label</dt><dd>{value.document_label}</dd></div>
        )}
        <div className="grid grid-cols-[6.5rem_1fr] gap-2"><dt className="text-text-secondary">Evidence check</dt>
          <dd><EvidenceBadge status={value.review_status} /></dd></div>
        <div className="grid grid-cols-[6.5rem_1fr] gap-2"><dt className="text-text-secondary">Page</dt>
          <dd>{value.page ?? <span className="text-text-muted">No page recorded</span>}</dd></div>
        {field.description && <div className="grid grid-cols-[6.5rem_1fr] gap-2"><dt className="text-text-secondary">Meaning</dt><dd className="text-text-secondary">{field.description}</dd></div>}
      </dl>
      {value.page ? (
        <button type="button" className="btn-secondary inline-flex items-center gap-1.5 px-2.5 py-1 text-xs"
          onClick={() => onViewSource({ pageNumber: value.page!, highlightText: value.highlight, label: field.label, value: value.value, anchorText: value.document_label })}>
          <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />View in source
        </button>
      ) : (
        <p className="text-[11px] text-text-muted">No source page was recorded for this value, so it can&apos;t be shown in the document.</p>
      )}
      <p className="text-[11px] text-text-muted">
        Values are corrected and approved in <Link href={`/documents/${documentId}/review`} className="text-primary hover:underline">Metadata review</Link>.
      </p>
    </section>
  );
}
