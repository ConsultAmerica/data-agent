"use client";

import { CheckCircle2, CircleAlert, GraduationCap } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  correctInvoiceSupplier,
  invoiceRecognition,
  listSuppliers,
  type ReferenceSupplier,
} from "@/lib/invoice-recognition";
import { useReviewMutationsEnabled } from "@/lib/review-gate";
import type { StagingWorkbook } from "@/lib/staging-workbook";

const RESULT_TONE: Record<string, string> = {
  PASS: "text-success",
  REVIEW: "text-warning",
  INFO: "text-text-secondary",
};

/** IDR-style recognition status for an invoice, its supplier/PO checks,
 * and the reviewer's supplier match — which Dataomatix learns from. */
export default function InvoiceRecognitionPanel({
  documentId,
  workbook,
  onChanged,
}: {
  documentId: string;
  workbook: StagingWorkbook;
  /** Called after a supplier match with a message to show; the workbook
   * reloads (and this panel remounts) after it. */
  onChanged: (message: string) => void;
}) {
  const recognition = useMemo(() => invoiceRecognition(workbook), [workbook]);
  const reviewEnabled = useReviewMutationsEnabled();
  const [suppliers, setSuppliers] = useState<ReferenceSupplier[]>([]);
  const [choice, setChoice] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const needsSupplier = recognition !== null && !recognition.supplierMatched;
  useEffect(() => {
    if (!needsSupplier) return;
    let live = true;
    listSuppliers()
      .then((rows) => {
        if (live) setSuppliers(rows.filter((s) => !s.excluded_from_recognition));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [needsSupplier]);

  if (!recognition) return null;
  const complete = recognition.status === "Not Validated";

  async function matchSupplier() {
    if (!choice) return;
    setSaving(true);
    setMessage(null);
    try {
      const result = await correctInvoiceSupplier(documentId, Number(choice));
      onChanged(
        result.alias_learned
          ? `Matched to ${result.supplier_name}. Dataomatix learned "${result.printed_name}" — future invoices with this name match automatically.`
          : `Matched to ${result.supplier_name}.`,
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The supplier could not be matched.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className={`rounded-xl border px-4 py-3 ${complete ? "border-success/30 bg-success/5" : "border-warning/30 bg-warning/5"}`}
      aria-label="Invoice recognition"
      data-testid="invoice-recognition"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          {complete ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 text-success" aria-hidden="true" />
          ) : (
            <CircleAlert className="mt-0.5 h-4 w-4 text-warning" aria-hidden="true" />
          )}
          <div>
            <p className="text-sm font-semibold text-foreground" data-testid="invoice-recognition-status">
              {recognition.status}
            </p>
            <p className="text-xs text-text-secondary">
              {complete ? "Every expected field recognized and matched — ready for ERP validation." : recognition.reasons}
            </p>
          </div>
        </div>
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {recognition.erp
            .filter((row) => ["Supplier Number", "Supplier Site", "Business Unit", "PO Number"].includes(row.field))
            .map((row) => (
              <div key={row.field} className="flex gap-1">
                <dt className="text-text-muted">{row.field}</dt>
                <dd className="font-medium text-foreground">{row.value || "—"}</dd>
              </div>
            ))}
        </dl>
      </div>

      {recognition.checks.length > 0 && (
        <ul className="mt-2 grid gap-1 text-xs sm:grid-cols-2" data-testid="invoice-recognition-checks">
          {recognition.checks
            .filter((check) => check.check !== "Recognition status")
            .map((check, index) => (
              <li key={`${check.check}-${index}`} className="flex gap-1.5">
                <span className={`font-semibold ${RESULT_TONE[check.result] ?? "text-text-secondary"}`}>{check.result}</span>
                <span className="text-foreground">{check.check}:</span>
                <span className="text-text-secondary">{check.details}</span>
              </li>
            ))}
        </ul>
      )}

      {needsSupplier && suppliers.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3 text-xs">
          <GraduationCap className="h-4 w-4 text-primary" aria-hidden="true" />
          <label htmlFor="invoice-supplier-match" className="text-text-secondary">
            Which supplier issued this invoice?
          </label>
          <select
            id="invoice-supplier-match"
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
            disabled={!reviewEnabled || saving}
            className="rounded-lg border border-border bg-surface px-2 py-1 text-xs text-foreground"
          >
            <option value="">Choose from the supplier master…</option>
            {suppliers.map((supplier) => (
              <option key={supplier.id} value={supplier.id}>
                {supplier.name} ({supplier.supplier_number})
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void matchSupplier()}
            disabled={!reviewEnabled || saving || !choice}
            className="btn-primary px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Matching…" : "Match and learn"}
          </button>
        </div>
      )}
      {message && (
        <p className="mt-2 text-xs text-text-secondary" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
