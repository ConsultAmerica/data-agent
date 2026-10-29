"use client";

export const EXTRACTION_TABS = [
  "Overview",
  "Extracted Data",
  "Clauses",
  "Tables",
  "Pages",
  "Relationships",
  "Universal",
  "Structured Output",
  "Activity",
] as const;

export type ExtractionTab = (typeof EXTRACTION_TABS)[number];

interface ExtractionTabBarProps {
  active: ExtractionTab;
  onChange: (tab: ExtractionTab) => void;
  showUniversal?: boolean;
  /** Tabs that don't apply to this document (e.g. Clauses for an invoice). */
  hidden?: readonly ExtractionTab[];
}

export default function ExtractionTabBar({
  active,
  onChange,
  showUniversal = false,
  hidden = [],
}: ExtractionTabBarProps) {
  const tabs = EXTRACTION_TABS.filter(
    (tab) => (tab !== "Universal" || showUniversal) && !hidden.includes(tab),
  );

  return (
    <div className="extraction-tab-bar">
      <div className="extraction-bar-inner flex gap-1 overflow-x-auto" role="tablist">
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={active === tab}
            onClick={() => onChange(tab)}
            className={[
              "shrink-0 rounded-lg px-4 py-2.5 text-sm font-medium transition duration-200",
              active === tab
                ? "bg-surface text-text-dark shadow-sm"
                : "text-text-secondary hover:bg-surface/60 hover:text-text-dark",
            ].join(" ")}
          >
            {tab}
          </button>
        ))}
      </div>
    </div>
  );
}
