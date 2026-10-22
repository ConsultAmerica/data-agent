"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { X } from "lucide-react";

import { getDocumentTypeAppearance } from "@/lib/document-type-icon";
import { presentDocument, statusMark } from "@/lib/document-presentation";
import {
  EXTRACTED_STATUS_TONE,
  extractedStatusLabel,
  formatContractValue,
  formatDocumentDate,
} from "@/lib/document-repository";
import type { DocumentSummary } from "@/types/document";

/** Right-side quick look at one repository row: what it is, who it's with
 * and how far extraction got, without leaving the list. */
export default function DocumentPreviewDrawer({
  document,
  workspaceHref,
  reviewHref,
  onClose,
}: {
  document: DocumentSummary;
  workspaceHref: string;
  reviewHref: string;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const row = presentDocument(document);
  const { Icon, bgClass, iconClass } = getDocumentTypeAppearance(document.original_filename, document.document_type);

  // Focus the drawer on open and hand focus back to the row on close.
  useEffect(() => {
    const previous = globalThis.document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    globalThis.document.addEventListener("keydown", onKey);
    return () => {
      globalThis.document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  const facts: { label: string; value: string }[] = [
    { label: "Type", value: row.typeLabel },
    { label: "Profile", value: row.profileLabel },
    { label: "Agency / contracting activity", value: document.agency || "—" },
    { label: "Contracting officer", value: document.contracting_officer || "—" },
    { label: "Counterparty", value: document.counterparty || "—" },
    { label: "Total contract value", value: formatContractValue(document.contract_value) },
    { label: "Effective date", value: formatDocumentDate(document.effective_date) },
    { label: "Expiration date", value: formatDocumentDate(document.expiration_date) },
    { label: "Uploaded", value: formatDocumentDate(document.uploaded_at) },
    { label: "Last updated", value: formatDocumentDate(document.last_updated) },
    { label: "Fields extracted", value: document.fields_extracted.toLocaleString() },
    { label: "Pages", value: document.page_count ? document.page_count.toLocaleString() : "—" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="absolute inset-0 bg-slate-950/30"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="document-preview-title"
        className="relative flex h-full w-full max-w-md flex-col border-l border-border bg-surface shadow-2xl"
        data-testid="document-preview-drawer"
      >
        <header className="flex items-start gap-3 border-b border-border px-5 py-4">
          <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${bgClass}`}>
            <Icon className={`h-4.5 w-4.5 ${iconClass}`} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-muted">Quick preview</p>
            <h2 id="document-preview-title" className="mt-0.5 break-words text-sm font-semibold text-foreground">
              {document.original_filename}
            </h2>
            <p className={`mt-1 text-xs font-medium ${EXTRACTED_STATUS_TONE[row.status]}`}>
              {statusMark(row.status)} {extractedStatusLabel(row.status)}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="rounded-lg p-1.5 text-text-muted hover:bg-surface-soft hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <dl className="min-h-0 flex-1 divide-y divide-border/70 overflow-y-auto px-5 py-2 text-sm">
          {facts.map((fact) => (
            <div key={fact.label} className="grid grid-cols-[minmax(8rem,45%)_1fr] gap-3 py-2">
              <dt className="text-text-muted">{fact.label}</dt>
              <dd className={`break-words ${fact.value === "—" ? "text-text-muted" : "text-foreground"}`}>{fact.value}</dd>
            </div>
          ))}
        </dl>

        <footer className="flex gap-2 border-t border-border px-5 py-3">
          <Link href={workspaceHref} className="btn-hero-primary !w-auto flex-1 justify-center px-4 py-2 text-sm">
            Open workspace
          </Link>
          <Link href={reviewHref} className="btn-secondary flex-1 justify-center px-4 py-2 text-sm">
            Review
          </Link>
        </footer>
      </aside>
    </div>
  );
}
