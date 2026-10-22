"use client";

import { useState } from "react";

import ObligationCard from "@/components/obligations/obligation-card";
import {
  obligationKey,
  WORKFLOW_LABELS,
  WORKFLOW_STATUSES,
  workflowOf,
  type Obligation,
  type TrackingPatch,
  type WorkflowStatus,
} from "@/lib/obligations";

/** Columns by workflow status. Cards move with their status select
 * (keyboard) or by dragging between columns. */
export default function ObligationKanban({
  items,
  onUpdate,
  knownAssignees,
  errors,
}: {
  items: Obligation[];
  onUpdate: (item: Obligation, patch: TrackingPatch) => void;
  knownAssignees: string[];
  errors: Record<string, string>;
}) {
  const [over, setOver] = useState<WorkflowStatus | null>(null);

  function drop(status: WorkflowStatus, key: string) {
    setOver(null);
    const item = items.find((candidate) => obligationKey(candidate) === key);
    if (item && workflowOf(item) !== status) onUpdate(item, { workflow_status: status });
  }

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      {WORKFLOW_STATUSES.map((status) => {
        const column = items.filter((item) => workflowOf(item) === status);
        return (
          <section
            key={status}
            aria-label={WORKFLOW_LABELS[status]}
            data-testid={`kanban-${status}`}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              if (over !== status) setOver(status);
            }}
            onDragLeave={() => setOver((current) => (current === status ? null : current))}
            onDrop={(event) => {
              event.preventDefault();
              drop(status, event.dataTransfer.getData("text/plain"));
            }}
            className={`flex min-h-[12rem] flex-col rounded-xl border bg-surface-soft p-2 transition-colors ${
              over === status ? "border-primary" : "border-border"
            }`}
          >
            <h3 className="flex items-center justify-between px-1 pb-2 pt-1 text-xs font-semibold text-foreground">
              {WORKFLOW_LABELS[status]}
              <span className="tabular-nums text-text-muted">{column.length}</span>
            </h3>
            <div className="space-y-2">
              {column.map((item) => (
                <ObligationCard
                  key={obligationKey(item)}
                  item={item}
                  onUpdate={onUpdate}
                  knownAssignees={knownAssignees}
                  error={errors[obligationKey(item)]}
                  draggable
                />
              ))}
              {column.length === 0 && (
                <p className="px-1 py-4 text-center text-[11px] text-text-muted">Nothing here.</p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
