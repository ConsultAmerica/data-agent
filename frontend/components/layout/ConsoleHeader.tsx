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
      <div className="px-4 pt-5 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface text-primary shadow-sm ring-1 ring-primary/15">
              <Icon className="h-5 w-5" strokeWidth={1.8} aria-hidden />
            </span>
            <div className="min-w-0">
              <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-foreground">{title}</h1>
              {description && <p className="mt-1 max-w-3xl text-sm leading-6 text-text-secondary">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {children && <div className="mt-4">{children}</div>}
        {tabs && tabs.length > 0 ? (
          <div
            className="-mb-px mt-4 flex gap-1 overflow-x-auto"
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
                  "inline-flex shrink-0 items-center gap-2 border-b-[3px] px-3 pb-2.5 pt-1.5 text-sm transition-colors",
                  tab.active
                    ? "border-primary font-semibold text-primary"
                    : "border-transparent text-text-secondary hover:border-border hover:text-foreground",
                ].join(" ")}
              >
                {tab.label}
                {tab.count !== undefined && (
                  <span
                    className={[
                      "rounded-full px-1.5 py-px text-[11px] font-medium tabular-nums",
                      tab.active ? "bg-primary text-white" : "bg-surface text-text-muted ring-1 ring-border",
                    ].join(" ")}
                  >
                    {tab.count.toLocaleString()}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="h-5" />
        )}
      </div>
    </section>
  );
}
