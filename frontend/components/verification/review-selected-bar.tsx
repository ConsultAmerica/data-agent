"use client";

import { useEffect, useState } from "react";

import { reviewStructureRecords, type LayoutField, type LayoutTable, type LayoutTableRow, type StructureAction } from "@/lib/original-structure";

type RecordEntry = { field?: LayoutField; row?: LayoutTableRow; table?: LayoutTable; section: string | null };

/** Steps through the selected records one at a time: each opens its
 * source, and nothing is decided until Approve, Reject or Save is clicked.
 * "Approve & Next" saves the decision and moves to the next record. */
export default function ReviewSelectedBar({ documentId, keys, records, onView, onChanged, onClose }: {
  documentId: string;
  keys: string[];
  records: Map<string, RecordEntry>;
  onView: (key: string) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const key = keys[Math.min(index, keys.length - 1)];
  const record = records.get(key);
  if (!record) return null;
  // One step per record: its state starts fresh when the record changes.
  return (
    <Step key={key} documentId={documentId} recordKey={key} record={record} index={index} total={keys.length}
      setIndex={setIndex} onView={onView} onChanged={onChanged} onClose={onClose} />
  );
}

function Step({ documentId, recordKey: key, record, index, total, setIndex, onView, onChanged, onClose }: {
  documentId: string;
  recordKey: string;
  record: RecordEntry;
  index: number;
  total: number;
  setIndex: (index: number) => void;
  onView: (key: string) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [correcting, setCorrecting] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    onView(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open the source once per record
  }, [key]);

  const title = record.field
    ? record.field.label
    : `${record.table?.title ?? "Table"} · row ${(record.table?.rows.indexOf(record.row!) ?? 0) + 1}`;
  const shown = record.field
    ? record.field.effective_value || record.field.extracted_value || record.field.document_value || "(blank)"
    : (record.row!.reviewed_cells ?? record.row!.cells).filter(Boolean).join(" · ");
  const status = record.field ? record.field.review_status : record.row?.review_status ?? "Not reviewed";

  async function decide(action: StructureAction, next: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const result = await reviewStructureRecords(documentId, [key], action, action === "correct" ? { value } : {});
      const failed = result.results.find((r) => !r.ok);
      if (failed) {
        setMessage(failed.error ?? "The decision wasn't saved.");
        return;
      }
      onChanged();
      setCorrecting(false);
      if (next && index < total - 1) setIndex(index + 1);
      else setMessage("Saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "The decision wasn't saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-primary/30 bg-primary-soft/40 px-3 py-2 text-xs" data-testid="review-selected-bar">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-foreground">Reviewing {index + 1} of {total}</span>
        <span className="min-w-0 truncate text-foreground">{title}: <span className="font-medium">{shown}</span></span>
        <span className="text-text-muted">({status}{record.section ? ` · ${record.section}` : ""})</span>
      </div>
      {correcting && record.field && (
        <input autoFocus value={value} onChange={(event) => setValue(event.target.value)} aria-label="Corrected value"
          className="mt-2 w-full max-w-md rounded-md border border-border bg-surface px-2 py-1" />
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || index === 0} onClick={() => setIndex(index - 1)} className="btn-secondary px-2 py-0.5 text-xs">Previous</button>
        <button type="button" disabled={busy || index >= total - 1} onClick={() => setIndex(index + 1)} className="btn-secondary px-2 py-0.5 text-xs">Next</button>
        {correcting ? (
          <>
            <button type="button" disabled={busy || !value.trim()} onClick={() => void decide("correct", false)} className="btn-primary px-2 py-0.5 text-xs">Save correction</button>
            <button type="button" onClick={() => setCorrecting(false)} className="btn-secondary px-2 py-0.5 text-xs">Cancel</button>
          </>
        ) : (
          <>
            <button type="button" disabled={busy} onClick={() => void decide("accept", true)} className="btn-primary px-2 py-0.5 text-xs">Approve &amp; Next</button>
            <button type="button" disabled={busy} onClick={() => void decide("reject", true)} className="btn-secondary px-2 py-0.5 text-xs text-danger">Reject &amp; Next</button>
            {record.field && (
              <button type="button" disabled={busy} onClick={() => { setValue(shown === "(blank)" ? "" : shown); setCorrecting(true); }} className="btn-secondary px-2 py-0.5 text-xs">Correct</button>
            )}
          </>
        )}
        <button type="button" onClick={onClose} className="ml-auto text-text-secondary hover:text-foreground">Close</button>
      </div>
      <p className="mt-1 text-[11px] text-text-muted">Nothing is approved by selecting; each decision is saved only when you click it.</p>
      {message && <p className={message === "Saved." ? "text-success" : "text-danger"} role="status">{message}</p>}
    </div>
  );
}
