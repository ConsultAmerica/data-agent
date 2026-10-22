"use client";

import { useEffect, useState } from "react";
import { CalendarClock, Check, Download, FileSpreadsheet, FileText, Loader2, X } from "lucide-react";

import type { ActionResult } from "@/lib/document-actions";

/** What each action actually does, in order (see app/services/document_actions.py). */
export const ACTION_STEPS: Record<string, string[]> = {
  executive_summary: [
    "Load the document's staging workbook",
    "Read identification, parties and award values",
    "Count CLINs, funding lines and FAR / DFARS clauses",
    "Pull the next obligations due",
    "Check the clause playbook",
    "Summarize review status",
  ],
  risk_register: [
    "Load the document's staging workbook",
    "Evaluate the clause playbook",
    "Run enabled validation rules",
    "Find low-confidence and pending fields",
    "Check for missing key fields and funding gaps",
    "Rank risks by severity",
  ],
  clause_gap_report: [
    "Load extracted clause references",
    "Apply your workspace playbook",
    "Group findings by status",
  ],
  obligations_register: [
    "Read schedules, periods and option CLINs",
    "Map clause duties to obligations",
    "Find duty sentences in the contract text",
    "De-duplicate and date each obligation",
  ],
  funding_reconciliation: [
    "Read CLIN prices and not-to-exceed amounts",
    "Read funding lines",
    "Match funding to CLINs",
    "Compare totals with the ceiling and minimum",
    "Flag unfunded and overfunded lines",
  ],
};

const REVIEW_STEP = "Review the agent's output";
const STEP_INTERVAL_MS = 320;

export type RunState = "running" | "completed" | "failed";

function outputCount(result: ActionResult) {
  return result.sections.reduce(
    (total, section) => total + (section.kind === "table" ? section.rows.length : section.kind === "facts" ? section.facts.length : 0),
    0,
  );
}

/** The run as a checklist of the action's stages next to a results card. */
export default function AgentRun({
  actionId,
  title,
  documentName,
  state,
  result,
  error,
  startedAt,
  downloading,
  onDownload,
}: {
  actionId: string;
  title: string;
  documentName: string;
  state: RunState;
  result: ActionResult | null;
  error?: string;
  startedAt: Date;
  downloading: "csv" | "md" | null;
  onDownload: (format: "csv" | "md") => void;
}) {
  const steps = [...(ACTION_STEPS[actionId] ?? ["Run the action"]), REVIEW_STEP];
  const work = steps.length - 1;
  // While the request is open, the stages tick forward but never past the last
  // working stage; the response completes them (or fails the current one).
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    if (state !== "running") return;
    const timer = window.setInterval(() => {
      setProgress((current) => Math.min(current + 1, work - 1));
    }, STEP_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [state, work]);

  const done = state === "completed" ? work : progress;
  const stem = documentName.replace(/\.[^.]+$/, "");

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]" aria-live="polite">
      <ol className="space-y-2" aria-label={`${title} steps`}>
        {steps.map((step, index) => {
          const isReview = index === work;
          const status =
            state === "failed" && index === done
              ? "failed"
              : index < done
                ? "done"
                : isReview
                  ? state === "completed"
                    ? "current"
                    : "pending"
                  : index === done && state === "running"
                    ? "running"
                    : "pending";
          return (
            <li
              key={step}
              className={[
                "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors",
                status === "done" ? "border-success/25 bg-success/5 text-foreground" : "",
                status === "running" ? "border-primary/40 bg-primary/5 text-foreground" : "",
                status === "current" ? "border-primary bg-primary text-white" : "",
                status === "failed" ? "border-danger/40 bg-danger/5 text-danger" : "",
                status === "pending" ? "border-border bg-surface text-text-muted" : "",
              ].join(" ")}
            >
              <span
                className={[
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                  status === "done" ? "bg-success text-white" : "",
                  status === "current" ? "bg-white/20 text-white" : "",
                  status === "failed" ? "bg-danger text-white" : "",
                  status === "running" || status === "pending" ? "border border-current" : "",
                ].join(" ")}
                aria-hidden="true"
              >
                {status === "done" ? (
                  <Check className="h-3 w-3" />
                ) : status === "running" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : status === "failed" ? (
                  <X className="h-3 w-3" />
                ) : (
                  index + 1
                )}
              </span>
              <span className="min-w-0 flex-1">
                {index + 1}. {step}
              </span>
              <span className="sr-only">{status}</span>
            </li>
          );
        })}
      </ol>

      <div className="h-fit rounded-xl border border-border bg-surface p-4 shadow-sm">
        <p className="text-sm font-semibold text-foreground">Results</p>
        <p className="mt-0.5 truncate text-xs text-text-secondary">{documentName}</p>
        {state === "completed" && result ? (
          <>
            <ul className="mt-3 space-y-2">
              {(
                [
                  ["csv", FileSpreadsheet, `${stem}-${actionId}.csv`],
                  ["md", FileText, `${stem}-${actionId}.md`],
                ] as const
              ).map(([format, Icon, name]) => (
                <li key={format}>
                  <button
                    type="button"
                    onClick={() => onDownload(format)}
                    disabled={downloading !== null}
                    aria-label={`Download ${format === "csv" ? "CSV" : "Markdown"}: ${name}`}
                    className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-xs text-foreground hover:bg-surface-soft disabled:opacity-60"
                  >
                    <Icon className="h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">{format === "csv" ? "CSV spreadsheet" : "Markdown report"}</span>
                      <span className="block truncate text-[11px] text-text-muted">{name}</span>
                    </span>
                    {downloading === format ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin text-text-muted" />
                    ) : (
                      <Download className="h-3.5 w-3.5 text-text-muted" />
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-text-secondary">
              {result.sections.length} section{result.sections.length === 1 ? "" : "s"} · {outputCount(result)} item
              {outputCount(result) === 1 ? "" : "s"}
              {result.warnings.length > 0 ? ` · ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}` : ""}
            </p>
          </>
        ) : state === "failed" ? (
          <p className="mt-3 text-xs text-danger">{error || "The action failed."}</p>
        ) : (
          <p className="mt-3 text-xs text-text-muted">Working…</p>
        )}
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3 text-xs">
          <span className="text-text-secondary">
            Run by <span className="font-medium text-foreground">you</span>
          </span>
          <span
            className={[
              "rounded-md px-2 py-0.5 font-semibold",
              state === "completed" ? "bg-success/10 text-success" : state === "failed" ? "bg-danger/10 text-danger" : "bg-primary/10 text-primary",
            ].join(" ")}
          >
            {state === "completed" ? "Completed" : state === "failed" ? "Failed" : "Running"}
          </span>
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-text-muted">
          <CalendarClock className="h-3.5 w-3.5" />
          {startedAt.toLocaleDateString()} · {startedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </p>
      </div>
    </div>
  );
}
