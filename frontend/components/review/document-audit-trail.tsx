"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { History } from "lucide-react";

import EmptyState from "@/components/ui/empty-state";
import { SkeletonText } from "@/components/ui/skeleton";
import { getGlobalAuditLog } from "@/lib/documents";
import type { GlobalAuditEntry } from "@/types/document";
import { auditFieldLabel } from "@/lib/audit-label";

const ACTION_LABEL: Record<string, string> = {
  accept: "accepted",
  accepted: "accepted",
  edit: "corrected",
  edited: "corrected",
  reject: "rejected",
  rejected: "rejected",
  revert: "reverted",
  approve: "approved",
  promote: "promoted",
  delete: "deleted",
};

function when(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString([], { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** This document's append-only review log: who changed which value, from
 * what, to what, and why. */
export default function DocumentAuditTrail({ documentId, refreshKey = 0 }: { documentId: string; refreshKey?: number }) {
  const [state, setState] = useState<{ key: string; entries: GlobalAuditEntry[] | null; error: string }>({
    key: "",
    entries: null,
    error: "",
  });
  const requestKey = `${documentId}:${refreshKey}`;

  useEffect(() => {
    let active = true;
    getGlobalAuditLog(50, 0, { documentId })
      .then((result) => {
        if (active) setState({ key: requestKey, entries: result.entries, error: "" });
      })
      .catch((err) => {
        if (active) setState({ key: requestKey, entries: null, error: err instanceof Error ? err.message : "Unable to load the audit trail." });
      });
    return () => {
      active = false;
    };
  }, [documentId, requestKey]);

  const current = state.key === requestKey ? state : null;

  return (
    <section className="flex h-full flex-col" aria-label="Audit trail" data-testid="document-audit-trail">
      <div className="shrink-0 border-b border-border px-6 py-4">
        <p className="text-sm font-medium text-foreground">Audit trail</p>
        <p className="mt-0.5 text-xs text-text-secondary">
          Every review decision on this document, append-only.{" "}
          <Link href={`/audit-log?document_id=${encodeURIComponent(documentId)}`} className="text-primary hover:underline">
            Open in audit log
          </Link>
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!current ? (
          <div className="px-6 py-5">
            <SkeletonText lines={6} />
          </div>
        ) : current.error ? (
          <p className="px-6 py-5 text-sm text-danger" role="alert">
            {current.error}
          </p>
        ) : current.entries && current.entries.length === 0 ? (
          <EmptyState
            icon={History}
            title="No review decisions yet"
            description="When a reviewer accepts, corrects or rejects a value on this document, it is recorded here with who, when and the value before and after."
          />
        ) : (
          <ol className="divide-y divide-border">
            {(current.entries ?? []).map((entry, index) => (
              <li key={`${entry.changed_at}-${entry.field_key}-${index}`} className="px-6 py-3 text-sm">
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-xs tabular-nums text-text-muted">{when(entry.changed_at)}</span>
                  <span className="font-medium text-foreground">{entry.changed_by}</span>
                  <span className="text-text-secondary">{ACTION_LABEL[entry.action] ?? entry.action}</span>
                  <span className="font-medium text-foreground">{auditFieldLabel(entry.field_key)}</span>
                </p>
                {(entry.previous_value || entry.new_value) && (
                  <p className="mt-1 break-words text-xs text-text-secondary">
                    <span className="text-text-muted line-through">{entry.previous_value || "∅"}</span> →{" "}
                    <span className="text-foreground">{entry.new_value || "∅"}</span>
                  </p>
                )}
                {entry.reason && <p className="mt-0.5 text-xs italic text-text-muted">{entry.reason}</p>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
