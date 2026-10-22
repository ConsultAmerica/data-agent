"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, GitBranch } from "lucide-react";

import { RELATED_ROLE_LABEL, loadRelatedDocuments, type RelatedDocument } from "@/lib/related-documents";

/** Quick switcher to the documents linked to this one (base award,
 * modifications, task orders). Renders nothing when there are none. */
export default function RelatedDocumentsSwitcher({
  documentId,
  returnQs,
}: {
  documentId: string;
  returnQs?: string | null;
}) {
  const [related, setRelated] = useState<RelatedDocument[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    loadRelatedDocuments(documentId)
      .then((items) => {
        if (active) setRelated(items);
      })
      .catch(() => {
        if (active) setRelated([]);
      });
    return () => {
      active = false;
    };
  }, [documentId]);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (related.length === 0) return null;

  function href(id: string) {
    return returnQs ? `/documents/${id}?return=${encodeURIComponent(returnQs)}` : `/documents/${id}`;
  }

  return (
    <div className="relative" ref={ref} data-testid="related-documents-switcher">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-xs font-medium text-text-secondary hover:border-primary/40 hover:text-foreground"
      >
        <GitBranch className="h-3 w-3" aria-hidden="true" />
        Related documents ({related.length})
        <ChevronDown className="h-3 w-3" aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Related documents"
          className="absolute left-0 z-40 mt-1 max-h-80 w-80 overflow-y-auto rounded-lg border border-border bg-surface py-1 shadow-md"
        >
          {related.map((item) => (
            <Link
              key={item.documentId}
              href={href(item.documentId)}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="block px-3 py-1.5 text-sm hover:bg-surface-soft"
            >
              <span className="block truncate font-medium text-foreground">{item.title}</span>
              <span className="block truncate text-[11px] text-text-muted">
                {RELATED_ROLE_LABEL[item.role]}
                {item.documentNumber ? ` · ${item.documentNumber}` : ""}
                {/* A parent's own link points further up, so it isn't shown. */}
                {item.role !== "parent" && item.relationshipType ? ` · ${item.relationshipType.replace(/_/g, " ")}` : ""}
                {item.role !== "parent" && item.relationshipStatus && item.relationshipStatus !== "confirmed"
                  ? ` · ${item.relationshipStatus}`
                  : ""}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
