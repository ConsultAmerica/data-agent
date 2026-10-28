"use client";

import { useEffect, useState } from "react";

import {
  formatKeyDate,
  getDocumentKeyDates,
  KIND_LABELS,
  relativeLabel,
  SOURCE_LABELS,
  type KeyDate,
} from "@/lib/key-dates";

const TONE: Record<string, string> = {
  expired: "text-danger",
  expiring: "text-warning",
  upcoming: "text-success",
  past: "text-text-secondary",
};

/** Header tag with the document's own expiry, when it states one. */
export default function ExpiryTag({ documentId, className }: { documentId: string; className: string }) {
  const [expiry, setExpiry] = useState<KeyDate | null>(null);

  useEffect(() => {
    let live = true;
    getDocumentKeyDates(documentId)
      .then((result) => {
        if (live) setExpiry(result.expiry);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [documentId]);

  if (!expiry) return null;
  return (
    <div
      className={className}
      data-testid="workspace-expiry"
      title={`${KIND_LABELS[expiry.kind] ?? expiry.kind}: ${expiry.label} · from ${SOURCE_LABELS[expiry.source] ?? expiry.source}${expiry.page ? `, page ${expiry.page}` : ""}`}
    >
      <dt className="text-text-muted">{KIND_LABELS[expiry.kind] ?? "Expiry"}</dt>
      <dd className={`font-medium ${TONE[expiry.status] ?? "text-foreground"}`}>
        {formatKeyDate(expiry.date)}
        <span className="ml-1 font-normal text-text-secondary">· {relativeLabel(expiry)}</span>
      </dd>
    </div>
  );
}
