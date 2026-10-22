"use client";

import { AlignJustify, Rows3 } from "lucide-react";

import type { TableDensity } from "@/lib/table-density";

const OPTIONS: { value: TableDensity; label: string; icon: typeof Rows3 }[] = [
  { value: "comfortable", label: "Comfortable", icon: Rows3 },
  { value: "compact", label: "Compact", icon: AlignJustify },
];

/** Segmented Comfortable / Compact switch for a table toolbar. */
export default function DensityToggle({
  value,
  onChange,
}: {
  value: TableDensity;
  onChange: (next: TableDensity) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Row density"
      className="inline-flex h-8 shrink-0 items-center rounded-lg border border-border bg-surface p-0.5"
    >
      {OPTIONS.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={`${option.label} rows`}
            onClick={() => onChange(option.value)}
            className={[
              "inline-flex h-full items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors",
              active ? "bg-primary/10 text-foreground" : "text-text-secondary hover:text-foreground",
            ].join(" ")}
          >
            <option.icon className="h-3.5 w-3.5" aria-hidden="true" />
            <span className="hidden sm:inline">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
