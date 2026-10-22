import {
  Archive,
  CheckCircle2,
  Search,
  Upload,
  Zap,
} from "lucide-react";

const STEPS = [
  {
    id: "upload",
    label: "Upload",
    description: "PDF, HTML, XML, scan or image",
    Icon: Upload,
  },
  {
    id: "understand",
    label: "Understand",
    description: "Detect structure & schema",
    Icon: Search,
  },
  {
    id: "extract",
    label: "Extract",
    description: "Fields, tables, clauses",
    Icon: Zap,
  },
  {
    id: "verify",
    label: "Verify",
    description: "Source evidence first",
    Icon: CheckCircle2,
  },
  {
    id: "repository",
    label: "Repository",
    description: "Search & analyze",
    Icon: Archive,
  },
] as const;

interface WorkflowDiagramProps {
  /** Highlight a step (optional). */
  activeStep?: (typeof STEPS)[number]["id"];
  compact?: boolean;
  className?: string;
}

export default function WorkflowDiagram({
  activeStep,
  compact = false,
  className = "",
}: WorkflowDiagramProps) {
  return (
    <div
      className={[
        "workflow-diagram",
        compact ? "workflow-diagram-compact" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label="Dataomatix workflow: Upload, Understand, Extract, Verify, Repository"
    >
      <ol className="workflow-diagram-steps">
        {STEPS.map((step, index) => {
          const isActive = activeStep === step.id;
          const Icon = step.Icon;

          return (
            <li key={step.id} className="workflow-diagram-step">
              {index > 0 && (
                <span
                  className={[
                    "workflow-diagram-connector",
                    isActive ? "workflow-diagram-connector-active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-hidden
                />
              )}
              <div
                className={[
                  "workflow-diagram-node",
                  isActive ? "workflow-diagram-node-active" : "",
                ].join(" ")}
              >
                <span className="workflow-diagram-icon-wrap">
                  <Icon className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <div className="workflow-diagram-text">
                  {!compact && (
                    <span className="workflow-diagram-number">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                  )}
                  <p className="workflow-diagram-label">{step.label}</p>
                  {!compact && (
                    <p className="workflow-diagram-desc">{step.description}</p>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
