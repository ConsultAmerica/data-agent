"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Sparkles } from "lucide-react";

import {
  actionHref,
  listDocumentActions,
  type DocumentAction,
} from "@/lib/document-actions";

/** Header dropdown listing the agent action catalog for one document; each
 * item opens /actions with that action running. */
export default function DocumentActionsMenu({ documentId }: { documentId: string }) {
  const router = useRouter();
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [actions, setActions] = useState<DocumentAction[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || actions) return;
    let active = true;
    listDocumentActions(documentId)
      .then((items) => {
        if (active) setActions(items);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Actions are unavailable.");
      });
    return () => {
      active = false;
    };
  }, [open, actions, documentId]);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
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

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="btn-secondary px-3 py-2 text-sm"
        data-testid="document-actions-trigger"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Actions
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          // Opens rightward: Actions is the header's first button, so a
          // right-anchored menu would slide under the sidebar.
          className="absolute left-0 z-50 mt-1 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-surface py-1 shadow-sm"
          role="menu"
          aria-label="Document actions"
        >
          <p className="border-b border-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted">
            Run an agent action
          </p>
          {error && <p className="px-3 py-2 text-sm text-danger">{error}</p>}
          {!error && !actions && <p className="px-3 py-2 text-sm text-text-secondary">Loading…</p>}
          {actions?.map((action) => (
            <button
              key={action.action_id}
              type="button"
              role="menuitem"
              disabled={!action.available}
              title={action.reason ?? undefined}
              onClick={() => {
                setOpen(false);
                router.push(actionHref(documentId, action.action_id));
              }}
              className="block w-full px-3 py-2 text-left hover:bg-surface-soft disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
            >
              <span className="block text-sm text-foreground">{action.title}</span>
              <span className="block text-xs text-text-secondary">
                {action.available ? action.category : action.reason}
              </span>
            </button>
          ))}
          {actions && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                router.push(actionHref(documentId));
              }}
              className="block w-full border-t border-border px-3 py-2 text-left text-sm text-primary hover:bg-surface-soft"
            >
              Open action catalog
            </button>
          )}
        </div>
      )}
    </div>
  );
}
