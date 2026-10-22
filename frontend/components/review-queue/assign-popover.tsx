"use client";

import { useEffect, useId, useRef, useState } from "react";
import { UserPlus } from "lucide-react";

/** "Assign to reviewer": a name (suggested from names already in use) and an
 * optional due date. Escape or a click outside closes it. */
export default function AssignPopover({
  count,
  knownAssignees,
  defaultAssignee = "",
  onAssign,
  onUnassign,
}: {
  count: number;
  knownAssignees: string[];
  defaultAssignee?: string;
  onAssign: (assignee: string, dueDate: string | null) => Promise<void>;
  onUnassign?: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(defaultAssignee);
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const listId = useId();
  const panelId = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    function onPointer(event: MouseEvent) {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
      setDue("");
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the assignment.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={wrapper} className="relative">
      <button
        ref={trigger}
        type="button"
        onClick={() => {
          setError("");
          if (!open && !name) setName(defaultAssignee);
          setOpen((value) => !value);
        }}
        aria-expanded={open}
        aria-controls={panelId}
        className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2.5 py-1 font-semibold text-foreground hover:border-primary/40"
      >
        <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
        Assign to reviewer
      </button>
      {open && (
        <form
          id={panelId}
          role="dialog"
          aria-label="Assign to reviewer"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            const assignee = name.trim();
            if (!assignee) {
              setError("Enter a reviewer name.");
              return;
            }
            void run(() => onAssign(assignee, due || null));
          }}
          className="absolute left-0 top-full z-30 mt-1 w-72 space-y-2 rounded-xl border border-border bg-surface p-3 text-xs shadow-lg"
        >
          <p className="font-semibold text-foreground">
            Assign {count} {count === 1 ? "value" : "values"}
          </p>
          <label className="block space-y-1">
            <span className="text-text-secondary">Reviewer</span>
            <input
              ref={input}
              value={name}
              onChange={(event) => setName(event.target.value)}
              list={listId}
              maxLength={200}
              placeholder="Reviewer name"
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-foreground outline-none focus:border-primary/40"
            />
            <datalist id={listId}>
              {knownAssignees.map((assignee) => (
                <option key={assignee} value={assignee} />
              ))}
            </datalist>
          </label>
          <label className="block space-y-1">
            <span className="text-text-secondary">Due date (optional)</span>
            <input
              type="date"
              value={due}
              onChange={(event) => setDue(event.target.value)}
              className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-foreground outline-none focus:border-primary/40"
            />
          </label>
          {error && (
            <p className="text-[var(--danger)]" role="alert">
              {error}
            </p>
          )}
          <div className="flex items-center justify-between gap-2 pt-1">
            {onUnassign ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(onUnassign)}
                className="text-text-secondary hover:text-foreground disabled:opacity-50"
              >
                Clear assignment
              </button>
            ) : (
              <span />
            )}
            <span className="flex items-center gap-2">
              <button type="button" onClick={close} className="text-text-secondary hover:text-foreground">
                Cancel
              </button>
              <button type="submit" disabled={busy} className="btn-primary px-3 py-1 text-xs disabled:opacity-50">
                {busy ? "Saving…" : "Assign"}
              </button>
            </span>
          </div>
        </form>
      )}
    </div>
  );
}
