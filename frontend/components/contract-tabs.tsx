"use client";

const TABS = [
  "Overview",
  "Data",
  "Clauses",
  "Relationships",
  "Documents",
  "Activity",
] as const;

export type ContractTab = (typeof TABS)[number];

interface ContractTabsProps {
  active: ContractTab;
  onChange: (tab: ContractTab) => void;
  /** The tabs that apply to this document (default: all). */
  tabs?: readonly ContractTab[];
}

export default function ContractTabs({ active, onChange, tabs = TABS }: ContractTabsProps) {
  return (
    <div className="flex shrink-0 gap-6 overflow-x-auto border-b border-border/80 bg-surface px-6 sm:px-8" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={active === tab}
          onClick={() => onChange(tab)}
          className={[
            "shrink-0 border-b-2 py-4 text-sm font-medium transition duration-200",
            active === tab
              ? "border-navy text-foreground"
              : "border-transparent text-text-secondary hover:text-foreground",
          ].join(" ")}
        >
          {tab}
        </button>
      ))}
    </div>
  );
}

export { TABS };
