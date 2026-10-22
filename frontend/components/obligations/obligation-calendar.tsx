"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import ObligationCard from "@/components/obligations/obligation-card";
import {
  daysUntil,
  localToday,
  obligationKey,
  workflowOf,
  type Obligation,
  type TrackingPatch,
} from "@/lib/obligations";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MAX_PER_DAY = 3;

function monthStart(iso: string): { year: number; month: number } {
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) - 1 };
}

function isoDay(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** A month grid by due date; undated obligations are listed below it.
 * Choosing an item shows its card (status, owner, sub-tasks) under the grid. */
export default function ObligationCalendar({
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
  const today = localToday();
  const [cursor, setCursor] = useState(() => monthStart(today));
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const byDay = useMemo(() => {
    const map = new Map<string, Obligation[]>();
    for (const item of items) {
      if (!item.due_date) continue;
      map.set(item.due_date, [...(map.get(item.due_date) ?? []), item]);
    }
    return map;
  }, [items]);
  const undated = items.filter((item) => !item.due_date);
  const selected = selectedKey ? items.find((item) => obligationKey(item) === selectedKey) ?? null : null;

  const firstWeekday = new Date(Date.UTC(cursor.year, cursor.month, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(cursor.year, cursor.month + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const monthLabel = new Date(Date.UTC(cursor.year, cursor.month, 1)).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const inMonth = items.filter((item) => item.due_date?.startsWith(isoDay(cursor.year, cursor.month, 1).slice(0, 7))).length;

  function shift(delta: number) {
    setCursor(({ year, month }) => {
      const next = month + delta;
      return { year: year + Math.floor(next / 12), month: ((next % 12) + 12) % 12 };
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => shift(-1)}
            aria-label="Previous month"
            className="rounded-md border border-border p-1 text-text-secondary hover:text-foreground"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <h3 className="min-w-[10rem] text-center text-sm font-semibold text-foreground" aria-live="polite">
            {monthLabel}
          </h3>
          <button
            type="button"
            onClick={() => shift(1)}
            aria-label="Next month"
            className="rounded-md border border-border p-1 text-text-secondary hover:text-foreground"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setCursor(monthStart(today))}
            className="ml-2 rounded-md border border-border px-2 py-1 text-xs text-text-secondary hover:text-foreground"
          >
            Today
          </button>
        </div>
        <p className="text-xs text-text-secondary">
          {inMonth} due this month · {undated.length} without a date
        </p>
      </div>

      <div className="overflow-x-auto">
        <div className="grid min-w-[42rem] grid-cols-7 overflow-hidden rounded-xl border border-border" role="grid" aria-label={monthLabel}>
          {WEEKDAYS.map((day) => (
            <div key={day} role="columnheader" className="border-b border-border bg-surface-soft px-2 py-1 text-[11px] font-semibold text-text-secondary">
              {day}
            </div>
          ))}
          {cells.map((day, index) => {
            const iso = day ? isoDay(cursor.year, cursor.month, day) : "";
            const dayItems = day ? byDay.get(iso) ?? [] : [];
            return (
              <div
                key={index}
                role="gridcell"
                aria-label={day ? iso : undefined}
                className={`min-h-[5.5rem] border-b border-r border-border p-1 ${day ? "bg-surface" : "bg-surface-soft"} ${iso === today ? "ring-1 ring-inset ring-primary" : ""}`}
              >
                {day && <p className={`text-[11px] tabular-nums ${iso === today ? "font-semibold text-primary" : "text-text-muted"}`}>{day}</p>}
                <ul className="mt-0.5 space-y-0.5">
                  {dayItems.slice(0, MAX_PER_DAY).map((item) => {
                    const urgent = daysUntil(iso, today) < 7 && workflowOf(item) !== "completed";
                    return (
                      <li key={obligationKey(item)}>
                        <button
                          type="button"
                          onClick={() => setSelectedKey(obligationKey(item))}
                          title={`${item.title} — ${item.document_name}`}
                          className={`block w-full truncate rounded px-1 py-0.5 text-left text-[11px] ${
                            workflowOf(item) === "completed"
                              ? "bg-surface-soft text-text-muted line-through"
                              : urgent
                                ? "bg-danger/10 text-danger"
                                : "bg-primary/10 text-foreground"
                          } ${selectedKey === obligationKey(item) ? "ring-1 ring-primary" : ""}`}
                        >
                          {item.title}
                        </button>
                      </li>
                    );
                  })}
                  {dayItems.length > MAX_PER_DAY && (
                    <li className="px-1 text-[11px] text-text-muted">+{dayItems.length - MAX_PER_DAY} more</li>
                  )}
                </ul>
              </div>
            );
          })}
        </div>
      </div>

      {selected && (
        <div className="max-w-md">
          <ObligationCard
            key={obligationKey(selected)}
            item={selected}
            onUpdate={onUpdate}
            knownAssignees={knownAssignees}
            error={errors[obligationKey(selected)]}
          />
        </div>
      )}

      <section aria-label="Undated obligations">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
          No due date ({undated.length})
        </h3>
        {undated.length === 0 ? (
          <p className="text-xs text-text-muted">Every obligation shown has a due date.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {undated.map((item) => (
              <ObligationCard
                key={obligationKey(item)}
                item={item}
                onUpdate={onUpdate}
                knownAssignees={knownAssignees}
                error={errors[obligationKey(item)]}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
