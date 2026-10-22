import type { ReactNode } from "react";
import { Check } from "lucide-react";

import { INTAKE_STEPS, intakeStepIndex, type IntakeStep } from "@/lib/intake";

interface IntakeProgressTrackerProps {
  activeStep: IntakeStep;
  /** The active step itself is finished too (e.g. batch approved). */
  complete?: boolean;
  /** Right-side actions (Run full extraction, API status). */
  actions?: ReactNode;
}

/** Upload → Auto-classification → Entity extraction → Human-in-the-loop
 * review, for the batch (or the open document) on /extraction/new. */
export default function IntakeProgressTracker({
  activeStep,
  complete = false,
  actions,
}: IntakeProgressTrackerProps) {
  const activeIndex = intakeStepIndex(activeStep);

  return (
    <div
      className="flex flex-col gap-4 border-b border-border bg-surface px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between"
      data-testid="intake-progress-tracker"
    >
      <nav aria-label="Batch progress" className="min-w-0">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-2">
          {INTAKE_STEPS.map((step, index) => {
            const done = index < activeIndex || (index === activeIndex && complete);
            const active = index === activeIndex && !complete;
            return (
              <li key={step.id} className="flex items-center gap-2" title={step.detail}>
                {index > 0 && (
                  <span
                    aria-hidden="true"
                    className={`hidden h-px w-6 sm:block ${index <= activeIndex ? "bg-primary/50" : "bg-border"}`}
                  />
                )}
                <span
                  aria-hidden="true"
                  className={[
                    "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums",
                    done
                      ? "bg-primary text-white"
                      : active
                        ? "border-2 border-primary bg-primary-soft text-primary"
                        : "border border-border bg-surface-soft text-text-muted",
                  ].join(" ")}
                >
                  {done ? <Check className="h-3.5 w-3.5" strokeWidth={2.5} /> : index + 1}
                </span>
                <span
                  aria-current={active ? "step" : undefined}
                  className={`text-xs font-medium sm:text-sm ${
                    active ? "text-foreground" : done ? "text-text-secondary" : "text-text-muted"
                  }`}
                >
                  {step.label}
                  <span className="sr-only">{done ? " (done)" : active ? " (current)" : ""}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </nav>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-3">{actions}</div>}
    </div>
  );
}
