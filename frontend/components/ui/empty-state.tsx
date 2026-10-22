import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

type Tone = "neutral" | "success";

const TONE: Record<Tone, string> = {
  neutral: "bg-surface-soft text-text-muted ring-border",
  success: "bg-success/10 text-success ring-success/25",
};

/** A clear, honest empty state: what is empty, and why that's fine (or what
 * to do next). `tone="success"` is for "checked and nothing failed"; use
 * "neutral" when there is simply no data yet. */
export default function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = "neutral",
  className = "",
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center px-6 py-12 text-center ${className}`}
      role="status"
      data-testid="empty-state"
    >
      <span className={`flex h-14 w-14 items-center justify-center rounded-full ring-1 ring-inset ${TONE[tone]}`}>
        <Icon className="h-6 w-6" strokeWidth={1.75} aria-hidden="true" />
      </span>
      <p className="mt-4 text-sm font-semibold text-foreground">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm leading-relaxed text-text-secondary">{description}</p>}
      {action && <div className="mt-5 flex flex-wrap items-center justify-center gap-3">{action}</div>}
    </div>
  );
}
