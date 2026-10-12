import {
  EXTRACTION_WORKFLOW_STEPS,
  type ExtractionWorkflowStep,
  workflowStepIndex,
} from "@/lib/extraction-workflow";

interface WorkflowBreadcrumbProps {
  activeStep: ExtractionWorkflowStep;
}

export default function WorkflowBreadcrumb({ activeStep }: WorkflowBreadcrumbProps) {
  const activeIndex = workflowStepIndex(activeStep);

  return (
    <nav aria-label="Extraction workflow" className="workflow-steps">
      <ol className="flex flex-wrap items-center gap-x-1 gap-y-1">
        {EXTRACTION_WORKFLOW_STEPS.map((step, index) => (
          <li key={step.id} className="inline-flex items-center gap-1 sm:gap-2">
            {index > 0 && (
              <span className="workflow-separator text-text-muted" aria-hidden="true">
                /
              </span>
            )}
            <span
              className={
                index < activeIndex
                  ? "step-done"
                  : index === activeIndex
                    ? "step-active"
                    : "text-text-muted"
              }
              aria-current={index === activeIndex ? "step" : undefined}
            >
              {step.label}
            </span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
