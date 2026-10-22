import { Check, Loader2, Sparkles } from "lucide-react";

/** Sample-contract agent run shown in the hero. Fictional data from
 * lib/sample/sample-extraction.json; the stage follows the hero tabs
 * (0 extract, 1 review, 2 govern). Decorative: hidden from screen readers. */

const STEPS = [
  "Read SF 1449 form blocks",
  "Map the CLIN schedule",
  "Detect FAR / DFARS clauses",
  "Score confidence per value",
  "Route 3 values to a reviewer",
  "Log reviewer decisions",
  "Stage reviewed values for export",
] as const;

/** How many steps are complete at each hero stage; the next one is running. */
const DONE_AT_STAGE = [4, 5, 7] as const;

type RowState = "ready" | "review" | "corrected" | "staged";

const ROWS: { field: string; value: string; confidence: number; page: number; states: [RowState, RowState, RowState] }[] = [
  { field: "Contract number", value: "W91ZZZ26C0042", confidence: 85, page: 1, states: ["ready", "ready", "staged"] },
  { field: "Award date", value: "08/19/2026", confidence: 85, page: 1, states: ["ready", "ready", "staged"] },
  { field: "Contractor", value: "Northwind Analytics LLC", confidence: 70, page: 1, states: ["ready", "ready", "staged"] },
  { field: "UEI", value: "QX7LMN4TZ8K1", confidence: 85, page: 1, states: ["ready", "ready", "staged"] },
  { field: "Total award", value: "$1,250,000.00", confidence: 85, page: 1, states: ["ready", "ready", "staged"] },
  { field: "Issued by", value: "2 candidates", confidence: 50, page: 1, states: ["review", "corrected", "staged"] },
  { field: "DFARS 252.204-7012", value: "Safeguarding CDI", confidence: 80, page: 2, states: ["ready", "ready", "staged"] },
];

const ROW_LABEL: Record<RowState, string> = {
  ready: "Ready",
  review: "Review",
  corrected: "Edited",
  staged: "Staged",
};

const ROW_TONE: Record<RowState, string> = {
  ready: "bg-[#e6f4ee] text-[#1f7a55]",
  review: "bg-[#fbf1df] text-[#9a6a17]",
  corrected: "bg-[#e3f2f9] text-[#0a6eb4]",
  staged: "bg-[#e6eff0] text-[#0d5b61]",
};

export default function AgentRunMockup({ stage }: { stage: 0 | 1 | 2 }) {
  const done = DONE_AT_STAGE[stage];
  const finished = done === STEPS.length;
  const issuedBy = stage === 0 ? "2 candidates" : "Sample Contracting Activity";

  return (
    <div className="agent-window" aria-hidden="true">
      <div className="agent-window-bar">
        <span className="agent-window-brand">
          <span className="agent-window-logo" />
          Dataomatix
        </span>
        <nav className="agent-window-nav">
          <span>Documents</span>
          <span className="is-active">Agents</span>
          <span>Staging</span>
          <span className="hidden sm:inline">Exports</span>
        </nav>
      </div>

      <div className="agent-window-head">
        <div className="min-w-0">
          <p className="agent-window-title">Contract intake</p>
          <p className="agent-window-sub">sample-contract.pdf · fictional specimen</p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <span className="agent-window-btn">Activity log</span>
          <span className="agent-window-btn is-primary">{finished ? "Run complete" : "Running…"}</span>
        </div>
      </div>

      <div className="agent-window-body">
        <ol className="agent-steps">
          {STEPS.map((step, index) => {
            const state = index < done ? "done" : index === done ? "running" : "todo";
            return (
              <li key={step} className={`agent-step is-${state}`}>
                <span className="agent-step-icon">
                  {state === "done" ? (
                    <Check className="h-3 w-3" strokeWidth={3} />
                  ) : state === "running" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="truncate">{step}</span>
                {state !== "todo" && <Sparkles className="ml-auto h-3 w-3 shrink-0 opacity-60" />}
              </li>
            );
          })}
          <li className={`agent-step-final ${finished ? "is-ready" : ""}`}>
            <span className="truncate">Review the agent&apos;s output</span>
            <span className="ml-auto flex shrink-0 gap-1">
              <span className="agent-step-final-btn">Reject</span>
              <span className="agent-step-final-btn is-approve">Approve</span>
            </span>
          </li>
        </ol>

        <div className="agent-output">
          <div className="agent-output-head">
            <span className="font-semibold text-[var(--text-dark)]">Agent output</span>
            <span className="agent-output-tabs">
              <span className="is-active">Fields</span>
              <span>CLINs</span>
              <span>Clauses</span>
            </span>
          </div>
          <table className="agent-output-table">
            <thead>
              <tr>
                <th>Field</th>
                <th>Value</th>
                <th className="text-right">Conf.</th>
                <th className="hidden xl:table-cell">Page</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => {
                const state = row.states[stage];
                return (
                  <tr key={row.field} className={state === "review" ? "is-flagged" : ""}>
                    <td className="text-[var(--text-muted)]">{row.field}</td>
                    <td className="max-w-[8rem] truncate font-medium text-[var(--text-dark)]">
                      {row.field === "Issued by" ? issuedBy : row.value}
                    </td>
                    <td className="text-right tabular-nums">{row.confidence}%</td>
                    <td className="hidden tabular-nums xl:table-cell">p.{row.page}</td>
                    <td>
                      <span className={`agent-pill ${ROW_TONE[state]}`}>{ROW_LABEL[state]}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
