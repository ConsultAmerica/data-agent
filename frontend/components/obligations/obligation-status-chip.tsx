import { AlarmClock, AlertOctagon, CalendarClock, CircleDashed, Repeat } from "lucide-react";

import { STATUS_LABELS, type ObligationStatus } from "@/lib/obligations";

const STATUS_STYLE: Record<ObligationStatus, { tone: string; icon: typeof AlertOctagon }> = {
  overdue: { tone: "bg-danger/10 text-danger", icon: AlertOctagon },
  due_soon: { tone: "bg-warning/10 text-warning", icon: AlarmClock },
  upcoming: { tone: "bg-primary/10 text-primary", icon: CalendarClock },
  ongoing: { tone: "bg-surface-soft text-text-secondary", icon: Repeat },
  undated: { tone: "bg-surface-soft text-text-muted", icon: CircleDashed },
};

/** Status is never color alone: icon + label. */
export default function ObligationStatusChip({ status }: { status: ObligationStatus }) {
  const { tone, icon: Icon } = STATUS_STYLE[status];
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {STATUS_LABELS[status]}
    </span>
  );
}
