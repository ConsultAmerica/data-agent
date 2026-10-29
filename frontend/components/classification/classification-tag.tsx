"use client";

import { ShieldQuestion, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import ClassificationPanel, { STATUS_TONE } from "@/components/classification/classification-panel";
import { STATUS_LABELS, getClassification, type ClassificationState } from "@/lib/classification";

/** The document's classification status as a header tag; opens the panel
 * (evidence, alternatives, confirm / change) in a side drawer. ``onChanged``
 * runs when the drawer closes after a decision, so the reviewer sees the
 * outcome before the page reloads its re-staged data. */
export default function ClassificationTag({
  documentId,
  className,
  onChanged,
}: {
  documentId: string;
  className: string;
  onChanged?: (state: ClassificationState) => void;
}) {
  const [state, setState] = useState<ClassificationState | null>(null);
  const [open, setOpen] = useState(false);
  const changed = useRef<ClassificationState | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    if (changed.current) {
      const next = changed.current;
      changed.current = null;
      onChanged?.(next);
    }
  }, [onChanged]);

  useEffect(() => {
    let active = true;
    getClassification(documentId)
      .then((loaded) => active && setState(loaded))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [documentId]);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!state) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${className} hover:border-primary/40`}
        data-testid="workspace-classification"
        title="Document classification: evidence, alternatives, confirm or change"
      >
        <span className="text-text-muted">Classification</span>
        <span className={`rounded-full px-1.5 py-px text-[11px] font-medium ${STATUS_TONE[state.status]}`}>
          {STATUS_LABELS[state.status]}
        </span>
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Document classification">
          <button type="button" aria-label="Close" tabIndex={-1} className="flex-1 bg-black/25" onClick={close} />
          <aside className="flex h-full w-full max-w-md flex-col border-l border-border bg-surface shadow-xl">
            <header className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <ShieldQuestion className="h-4 w-4 text-primary" aria-hidden="true" />
                Document classification
              </h2>
              <button type="button" onClick={close} aria-label="Close" className="rounded-md p-1 text-text-secondary hover:bg-surface-soft">
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto px-5 py-4">
              <ClassificationPanel
                documentId={documentId}
                onChanged={(next) => {
                  setState(next);
                  changed.current = next;
                }}
              />
            </div>
          </aside>
        </div>
      )}
    </>
  );
}
