"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";

import type { SortDirection } from "@/lib/table-sort";

/** Clickable column label that shows the active sort direction. */
export default function SortableHeader({
  label,
  active,
  direction,
  onSort,
}: {
  label: string;
  active: boolean;
  direction?: SortDirection;
  onSort: () => void;
}) {
  const Icon = !active ? ArrowUpDown : direction === "asc" ? ArrowUp : ArrowDown;
  const sortHint = !active ? "Sort ascending" : direction === "asc" ? "Sort descending" : "Clear sort";

  return (
    <button
      type="button"
      onClick={onSort}
      title={`${label} — ${sortHint}`}
      aria-label={`${label}. ${sortHint}`}
      className={[
        "group/sort inline-flex max-w-full items-center gap-1 text-left uppercase tracking-wide",
        active ? "text-foreground" : "hover:text-foreground",
      ].join(" ")}
    >
      <span className="line-clamp-2 min-w-0 break-normal">{label}</span>
      <Icon
        className={[
          "h-3.5 w-3.5 shrink-0",
          active ? "text-primary" : "text-text-muted group-hover/sort:text-foreground",
        ].join(" ")}
        aria-hidden="true"
      />
    </button>
  );
}
