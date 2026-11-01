"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Send, ShieldAlert, XCircle } from "lucide-react";

import { buildOracleChecklist, checklistPasses, type OracleChecklistItem } from "@/lib/oracle-checklist";
import { formatKb, oracleEnvironment, payloadBytes } from "@/lib/oracle-payload";
import type { OraclePayloadPreview } from "@/lib/reviewed-export";

/** The last gate before an Oracle send: what will be sent, where, and a
 * checklist that must fully pass plus an explicit acknowledgment. */
export default function OracleSendConfirmModal({
  preview,
  documentFilename,
  onConfirm,
  onCancel,
}: {
  preview: OraclePayloadPreview;
  documentFilename?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const items = buildOracleChecklist(preview);
  const ready = checklistPasses(items);
  const failing = items.filter((item) => !item.passed).length;
  const environment = oracleEnvironment(preview);
  const size = formatKb(payloadBytes(preview));

  useEffect(() => {
    cancelRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="oracle-confirm-title"
        aria-describedby="oracle-confirm-description"
        onClick={(event) => event.stopPropagation()}
        className="editorial-card flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden p-0"
        data-testid="oracle-confirm-modal"
      >
        <header className="border-b border-border px-5 py-4">
          <h2 id="oracle-confirm-title" className="text-base font-semibold text-foreground">
            Confirm Oracle payload transmission
          </h2>
          <p id="oracle-confirm-description" className="mt-1 text-sm text-text-secondary">
            {preview.authoritative_count} field{preview.authoritative_count === 1 ? "" : "s"} from{" "}
            <span className="font-medium text-foreground">{documentFilename || preview.source_document}</span> to{" "}
            <span className="font-medium text-foreground">{preview.erp_target}</span>.
          </p>
          <span
            className={[
              "mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold",
              preview.dry_run ? "bg-surface-soft text-text-secondary" : "bg-danger/10 text-danger",
            ].join(" ")}
          >
            {preview.dry_run ? "Dry-run — simulated, nothing is delivered" : "Live — delivers to Oracle"}
          </span>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-xs" data-testid="oracle-confirm-summary">
            <div>
              <dt className="text-text-muted">Target environment</dt>
              <dd className="font-medium text-foreground">{environment.label}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Payload size</dt>
              <dd className="font-medium tabular-nums text-foreground">{size}</dd>
            </div>
          </dl>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <ChecklistGroup title="Delivery checks" items={items.filter((item) => item.group === "system")} />
          {items.some((item) => item.group === "metadata") && (
            <ChecklistGroup title="Required header metadata" items={items.filter((item) => item.group === "metadata")} />
          )}
          {!ready && (
            <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-foreground" role="status">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden="true" />
              {failing} check{failing === 1 ? "" : "s"} must pass before this payload can be sent.
            </p>
          )}
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="mt-1"
              checked={acknowledged}
              disabled={!ready}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>
              I confirm this payload should be submitted through the authorized Oracle send endpoint
              {preview.dry_run ? " (dry-run / simulated)" : ""}.
            </span>
          </label>
        </div>

        <footer className="flex flex-col-reverse gap-2 border-t border-border px-5 py-3 sm:flex-row sm:justify-end">
          <button ref={cancelRef} type="button" onClick={onCancel} className="btn-secondary w-full sm:w-auto">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!ready || !acknowledged}
            className="btn-primary w-full justify-center disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto"
          >
            <Send className="h-4 w-4" aria-hidden="true" />
            Confirm and send
          </button>
        </footer>
      </div>
    </div>
  );
}

function ChecklistGroup({ title, items }: { title: string; items: OracleChecklistItem[] }) {
  return (
    <section>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{title}</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-start gap-2 px-3 py-2 text-sm"
            data-testid={`oracle-check-${item.id}`}
            data-passed={item.passed ? "true" : "false"}
          >
            {item.passed ? (
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Passed" />
            ) : (
              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-label="Failed" />
            )}
            <span className="min-w-0">
              <span className="block font-medium text-foreground">{item.label}</span>
              <span className={`block break-words text-xs ${item.passed ? "text-text-secondary" : "text-danger"}`}>
                {item.detail}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
