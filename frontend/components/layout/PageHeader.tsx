import type { ReactNode } from "react";

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** Compact workspace page title + actions (not the marketing PageHero). */
export default function PageHeader({ title, description, actions, className = "" }: PageHeaderProps) {
  return (
    <header
      className={["workspace-page-header flex flex-wrap items-end justify-between gap-3", className].join(" ")}
      data-testid="page-header"
    >
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">{title}</h1>
        {description && <div className="mt-1 text-sm text-text-secondary">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
