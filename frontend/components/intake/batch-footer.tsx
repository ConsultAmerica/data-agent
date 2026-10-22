"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, CheckCircle2, Loader2, Save, XCircle } from "lucide-react";

import DeleteConfirmModal from "@/components/delete-confirm-modal";
import { setIntakeBatchStatus, type IntakeStatus } from "@/lib/intake";

interface BatchFooterProps {
  batchId: string;
  /** Uploaded documents in the batch (only these carry its tags). */
  documentCount: number;
  /** Files still uploading / processing / extracting. */
  busyCount: number;
  status: IntakeStatus | "mixed" | null;
  onStatusChange: (status: IntakeStatus) => void;
}

const STATUS_COPY: Record<IntakeStatus, string> = {
  draft: "Saved as draft — not in the review queue yet.",
  submitted: "Approved — the batch is in the review queue.",
  rejected: "Rejected — the batch is kept out of the review queue.",
};

/** Batch decision bar: keep as draft, reject, or approve into the review
 * queue (POST /api/intake/batches/{id}/status). */
export default function BatchFooter({
  batchId,
  documentCount,
  busyCount,
  status,
  onStatusChange,
}: BatchFooterProps) {
  const [pending, setPending] = useState<IntakeStatus | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const [error, setError] = useState("");

  async function apply(next: IntakeStatus) {
    setPending(next);
    setError("");
    try {
      await setIntakeBatchStatus(batchId, next);
      onStatusChange(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The batch status could not be saved.");
    } finally {
      setPending(null);
      setConfirmReject(false);
    }
  }

  const disabled = documentCount === 0 || pending != null;
  const plural = documentCount === 1 ? "document" : "documents";

  return (
    <div
      className="sticky bottom-0 z-20 mt-6 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:px-6"
      data-testid="batch-footer"
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 text-xs text-text-secondary" aria-live="polite">
          <p>
            <span className="font-medium text-foreground">
              {documentCount} {plural}
            </span>{" "}
            in this batch
            {busyCount > 0 ? ` · ${busyCount} still processing` : ""}
          </p>
          {status && status !== "mixed" && <p className="mt-0.5">{STATUS_COPY[status]}</p>}
          {status === "mixed" && <p className="mt-0.5">Documents in this batch have different statuses.</p>}
          {error && (
            <p className="mt-0.5 text-danger" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-60"
            disabled={disabled}
            onClick={() => void apply("draft")}
          >
            {pending === "draft" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save as draft
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-xl border border-danger/30 px-4 py-2 text-sm font-medium text-danger transition hover:bg-danger/5 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={disabled}
            onClick={() => setConfirmReject(true)}
          >
            <XCircle className="h-4 w-4" />
            Reject batch
          </button>
          {status === "submitted" ? (
            <Link href="/review-queue" className="btn-primary text-sm">
              <CheckCircle2 className="h-4 w-4" />
              Open review queue
              <ArrowRight className="h-4 w-4" />
            </Link>
          ) : (
            <button
              type="button"
              className="btn-primary text-sm disabled:cursor-not-allowed disabled:opacity-60"
              disabled={disabled}
              onClick={() => void apply("submitted")}
              title={busyCount > 0 ? "Files still processing will join the review queue when they finish." : undefined}
            >
              {pending === "submitted" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Approve &amp; push to review queue
            </button>
          )}
        </div>
      </div>

      {confirmReject && (
        <DeleteConfirmModal
          title="Reject this batch?"
          description={`The ${documentCount} ${plural} in this batch stay stored but are kept out of the review queue. You can approve the batch later.`}
          confirmLabel="Reject batch"
          busy={pending === "rejected"}
          onConfirm={() => void apply("rejected")}
          onCancel={() => setConfirmReject(false)}
        />
      )}
    </div>
  );
}
