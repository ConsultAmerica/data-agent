import type { ComponentType, ReactNode } from "react";

export interface ConsoleTab {
  id: string;
  label: string;
  /** Shown as a small count after the label; omitted while unknown. */
  count?: number;
  active: boolean;
  onSelect: () => void;
}

interface ConsoleHeaderProps {
  icon: ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean }>;
  title: string;
  description?: string;
  /** Right-aligned buttons; the first is usually the primary action. */
  actions?: ReactNode;
  /** Underline tabs along the band's bottom edge (filters or sections). */
  tabs?: ConsoleTab[];
  /** Accessible name for the tab group. */
  tabsLabel?: string;
  /** Extra content under the title row, above the tabs (e.g. a progress tracker). */
  children?: ReactNode;
}

/**
 * Cloud-console style product band: a tinted strip with the page's icon,
 * title and primary actions, and its view tabs underlined along the
 * bottom edge — the header pattern of Google Cloud, Azure and OCI consoles.
 * Tabs are toggle buttons (aria-pressed) because they filter the page
 * rather than switch between panels.
 */
export default function ConsoleHeader({
  icon: Icon,
  title,
  description,
  actions,
  tabs,
  tabsLabel,
  children,
}: ConsoleHeaderProps) {
  return (
    <section className="console-header border-b border-border" data-testid="console-header">
      <div className="px-4 pt-4 sm:px-6 sm:pt-5">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-px flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary ring-1 ring-inset ring-primary/10">
              <Icon className="h-[18px] w-[18px]" strokeWidth={1.9} aria-hidden />
            </span>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold leading-7 tracking-[-0.01em] text-foreground">{title}</h1>
              {description && <p className="mt-0.5 max-w-3xl text-[13px] leading-5 text-text-secondary">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {children && <div className="mt-4">{children}</div>}
        {tabs && tabs.length > 0 ? (
          <div
            className="-mb-px mt-3 flex gap-0.5 overflow-x-auto [scrollbar-width:none]"
            role="group"
            aria-label={tabsLabel ?? `${title} views`}
          >
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                aria-pressed={tab.active}
                onClick={tab.onSelect}
                className={[
                  "inline-flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 pb-2.5 pt-1.5 text-[13px] font-medium transition-colors",
                  tab.active
                    ? "border-primary text-foreground"
                    : "border-transparent text-text-secondary hover:border-border hover:text-foreground",
                ].join(" ")}
              >
                {tab.label}
                {tab.count !== undefined && (
                  <span
                    className={[
                      "min-w-5 rounded-full px-1.5 py-px text-center text-[11px] font-medium tabular-nums",
                      tab.active ? "bg-primary-soft text-primary" : "bg-surface-soft text-text-muted",
                    ].join(" ")}
                  >
                    {tab.count.toLocaleString()}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="h-4 sm:h-5" />
        )}
      </div>
    </section>
  );
}
