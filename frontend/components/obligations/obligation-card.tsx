"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";

import { initials } from "@/lib/assignments";
import {
  daysUntil,
  dueLabel,
  obligationKey,
  WORKFLOW_LABELS,
  WORKFLOW_STATUSES,
  workflowOf,
  type Obligation,
  type TrackingPatch,
  type WorkflowStatus,
} from "@/lib/obligations";

/** Red when fewer than 7 days remain (or it's past due). */
export function DueBadge({ item, today }: { item: Obligation; today?: string }) {
  if (!item.due_date) {
    return <span className="text-[11px] text-text-muted">{dueLabel(item)}</span>;
  }
  const days = daysUntil(item.due_date, today);
  const urgent = days < 7 && workflowOf(item) !== "completed";
  return (
    <span
      data-urgent={urgent ? "true" : "false"}
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${
        urgent ? "bg-danger/10 text-danger" : "bg-surface-soft text-text-secondary"
      }`}
    >
      {days < 0 ? "Overdue · " : "Due "}
      {dueLabel({ ...item, recurrence: null })}
    </span>
  );
}

export function AssigneeAvatar({ name }: { name?: string | null }) {
  if (!name) {
    return (
      <span
        className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-dashed border-border text-[10px] text-text-muted"
        title="Unassigned"
        aria-label="Unassigned"
      >
        ?
      </span>
    );
  }
  return (
    <span
      className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
      title={name}
      aria-label={`Owner ${name}`}
    >
      {initials(name)}
    </span>
  );
}

export function SubtaskProgress({ item }: { item: Obligation }) {
  const tasks = item.subtasks ?? [];
  if (tasks.length === 0) return null;
  const done = tasks.filter((task) => task.done).length;
  const percent = Math.round((done / tasks.length) * 100);
  return (
    <div className="flex items-center gap-2" aria-label={`${done} of ${tasks.length} sub-tasks done`} role="img">
      <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--border)]" aria-hidden="true">
        <span className="absolute inset-y-0 left-0 rounded-full bg-[var(--success)]" style={{ width: `${percent}%` }} />
      </span>
      <span className="text-[11px] tabular-nums text-text-secondary">
        {done}/{tasks.length}
      </span>
    </div>
  );
}

export function WorkflowSelect({
  item,
  onUpdate,
  className = "",
}: {
  item: Obligation;
  onUpdate: (item: Obligation, patch: TrackingPatch) => void;
  className?: string;
}) {
  return (
    <select
      value={workflowOf(item)}
      onChange={(event) => onUpdate(item, { workflow_status: event.target.value as WorkflowStatus })}
      aria-label={`Status for ${item.title}`}
      className={`rounded-md border border-border bg-surface px-1.5 py-1 text-[11px] text-foreground ${className}`}
    >
      {WORKFLOW_STATUSES.map((value) => (
        <option key={value} value={value}>
          {WORKFLOW_LABELS[value]}
        </option>
      ))}
    </select>
  );
}

/** One obligation as a card: title, contract link, due badge, owner and
 * sub-task progress, with status, owner and sub-task editing. */
export default function ObligationCard({
  item,
  onUpdate,
  knownAssignees,
  error,
  draggable = false,
}: {
  item: Obligation;
  onUpdate: (item: Obligation, patch: TrackingPatch) => void;
  knownAssignees: string[];
  error?: string;
  draggable?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [owner, setOwner] = useState(item.assignee ?? "");
  const [newTask, setNewTask] = useState("");
  const listId = useId();
  const tasks = item.subtasks ?? [];

  function saveOwner() {
    const next = owner.trim();
    if (next !== (item.assignee ?? "")) onUpdate(item, { assignee: next || null });
  }

  return (
    <article
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", obligationKey(item));
        event.dataTransfer.effectAllowed = "move";
      }}
      aria-label={item.title}
      className={`space-y-2 rounded-lg border border-border bg-surface p-3 text-sm ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 font-medium leading-snug text-foreground">{item.title}</p>
        <AssigneeAvatar name={item.assignee} />
      </div>
      <Link
        href={`/documents/${item.document_id}`}
        className="block truncate text-xs text-text-secondary hover:text-primary"
        title={item.document_name}
      >
        {item.document_name}
      </Link>
      <div className="flex flex-wrap items-center gap-2">
        <DueBadge item={item} />
        <span className="font-id text-[11px] text-text-muted">{item.source_reference}</span>
      </div>
      <SubtaskProgress item={item} />
      <div className="flex items-center justify-between gap-2">
        <WorkflowSelect item={item} onUpdate={onUpdate} className="min-w-0 flex-1" />
        <button
          type="button"
          onClick={() => {
            setOwner(item.assignee ?? "");
            setEditing((value) => !value);
          }}
          aria-expanded={editing}
          aria-label={`${editing ? "Hide" : "Edit"} owner and sub-tasks for ${item.title}`}
          className="inline-flex items-center gap-0.5 text-[11px] font-medium text-text-secondary hover:text-foreground"
        >
          {editing ? <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" /> : <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
          Details
        </button>
      </div>
      {error && (
        <p className="text-[11px] text-[var(--danger)]" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <div className="space-y-2 border-t border-border pt-2 text-xs">
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              saveOwner();
            }}
          >
            <input
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
              list={listId}
              maxLength={200}
              placeholder="Owner name"
              aria-label={`Owner for ${item.title}`}
              className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-foreground"
            />
            <datalist id={listId}>
              {knownAssignees.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <button type="submit" className="rounded-md border border-border px-2 py-1 font-medium text-foreground hover:border-primary/40">
              Save
            </button>
          </form>
          <ul className="space-y-1" aria-label="Sub-tasks">
            {tasks.map((task, index) => (
              <li key={`${index}-${task.title}`} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={task.done}
                  onChange={() =>
                    onUpdate(item, {
                      subtasks: tasks.map((candidate, position) =>
                        position === index ? { ...candidate, done: !candidate.done } : candidate,
                      ),
                    })
                  }
                  aria-label={task.title}
                  className="h-3.5 w-3.5 accent-[var(--primary)]"
                />
                <span className={`min-w-0 flex-1 truncate ${task.done ? "text-text-muted line-through" : "text-foreground"}`}>
                  {task.title}
                </span>
                <button
                  type="button"
                  onClick={() => onUpdate(item, { subtasks: tasks.filter((_, position) => position !== index) })}
                  aria-label={`Remove sub-task ${task.title}`}
                  className="text-text-muted hover:text-[var(--danger)]"
                >
                  <Trash2 className="h-3 w-3" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              const title = newTask.trim();
              if (!title) return;
              onUpdate(item, { subtasks: [...tasks, { title, done: false }] });
              setNewTask("");
            }}
          >
            <input
              value={newTask}
              onChange={(event) => setNewTask(event.target.value)}
              maxLength={200}
              placeholder="Add a sub-task"
              aria-label={`New sub-task for ${item.title}`}
              className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2 py-1 text-foreground"
            />
            <button
              type="submit"
              aria-label="Add sub-task"
              className="inline-flex items-center rounded-md border border-border px-1.5 py-1 text-foreground hover:border-primary/40"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </form>
        </div>
      )}
    </article>
  );
}
