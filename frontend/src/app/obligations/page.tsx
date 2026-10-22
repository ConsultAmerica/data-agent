"use client";

import { CalendarCheck, CalendarDays, Columns3, Download, Search, Table2 } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";

import ContentSection from "@/components/layout/ContentSection";
import PageHero from "@/components/layout/PageHero";
import EmptyState from "@/components/ui/empty-state";
import { ErrorState, LoadingState } from "@/components/layout/StatusState";
import ObligationCalendar from "@/components/obligations/obligation-calendar";
import { AssigneeAvatar, WorkflowSelect } from "@/components/obligations/obligation-card";
import ObligationKanban from "@/components/obligations/obligation-kanban";
import ObligationStatusChip from "@/components/obligations/obligation-status-chip";
import { EmptyNote, Panel } from "@/components/portfolio/portfolio-parts";
import { getAssignees } from "@/lib/assignments";
import {
  dueLabel,
  getPortfolioObligations,
  OBLIGATION_STATUSES,
  obligationKey,
  obligationsCsv,
  RISK_LABELS,
  riskOf,
  STATUS_LABELS,
  updateObligationTracking,
  WORKFLOW_LABELS,
  WORKFLOW_STATUSES,
  workflowOf,
  type Obligation,
  type ObligationsResult,
  type ObligationStatus,
  type RiskLevel,
  type TrackingPatch,
  type WorkflowStatus,
} from "@/lib/obligations";

const PAGE_SIZE = 25;
const SOURCE_LABELS = { clause: "Clause", schedule: "Schedule", text: "Document text" } as const;

type View = "table" | "kanban" | "calendar";
const VIEWS: { id: View; label: string; icon: typeof Table2 }[] = [
  { id: "table", label: "Table", icon: Table2 },
  { id: "kanban", label: "Kanban", icon: Columns3 },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
];
const UNASSIGNED = "__unassigned__";
const NO_RISK = "none";
const SELECT = "rounded-lg border border-border bg-surface px-2 py-1 text-xs text-foreground";

export default function ObligationsPage() {
  return (
    <>
      <PageHero
        compact
        eyebrow="Compliance & Controls"
        title="Obligations tracker"
        description="Deliverables, reports, notices, options and compliance duties found in your contracts' schedules, clauses and text — each with the page it came from."
      />
      <ContentSection>
        <Suspense>
          <ObligationsBody />
        </Suspense>
      </ContentSection>
    </>
  );
}

function ObligationsBody() {
  const initialDocument = useSearchParams().get("document_id") ?? "all";
  const [data, setData] = useState<ObligationsResult | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    getPortfolioObligations()
      .then((result) => active && setData(result))
      .catch((err: unknown) => active && setError(err instanceof Error ? err.message : "Unable to load obligations."));
    return () => {
      active = false;
    };
  }, [tick]);

  if (error) {
    return (
      <ErrorState
        error={error}
        onRetry={() => {
          setError("");
          setTick((value) => value + 1);
        }}
      />
    );
  }
  if (!data) return <LoadingState title="Loading obligations..." description="Reading schedules, clauses and contract text…" />;
  return <ObligationsTracker key={tick} data={data} initialDocument={initialDocument} />;
}

function ObligationsTracker({ data, initialDocument }: { data: ObligationsResult; initialDocument: string }) {
  const [items, setItems] = useState<Obligation[]>(data.obligations);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [view, setView] = useState<View>("table");
  const [status, setStatus] = useState<"all" | ObligationStatus>("all");
  const [category, setCategory] = useState("all");
  const [documentId, setDocumentId] = useState(initialDocument);
  const [owner, setOwner] = useState("all");
  const [workflow, setWorkflow] = useState<"all" | WorkflowStatus>("all");
  const [risk, setRisk] = useState<"all" | RiskLevel | typeof NO_RISK>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [suggested, setSuggested] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    // Owner suggestions only; the tracker works without them.
    getAssignees()
      .then((result) => active && setSuggested(result.assignees))
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const documents = useMemo(() => {
    const names = new Map<string, string>();
    for (const item of items) names.set(item.document_id, item.document_name);
    return [...names.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items]);
  const owners = useMemo(
    () => [...new Set(items.map((item) => item.assignee ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [items],
  );
  const knownAssignees = useMemo(
    () => [...new Set([...suggested, ...owners])].sort((a, b) => a.localeCompare(b)),
    [suggested, owners],
  );

  const scoped = useMemo(
    () => items.filter((item) => documentId === "all" || item.document_id === documentId),
    [items, documentId],
  );
  const counts = useMemo(() => {
    const result: Record<ObligationStatus, number> = { overdue: 0, due_soon: 0, upcoming: 0, ongoing: 0, undated: 0 };
    for (const item of scoped) result[item.status] += 1;
    return result;
  }, [scoped]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return scoped.filter(
      (item) =>
        (status === "all" || item.status === status) &&
        (category === "all" || item.category === category) &&
        (workflow === "all" || workflowOf(item) === workflow) &&
        (owner === "all" || (owner === UNASSIGNED ? !item.assignee : item.assignee === owner)) &&
        (risk === "all" || (riskOf(item) ?? NO_RISK) === risk) &&
        (!needle ||
          [item.title, item.description, item.source_reference, item.evidence, item.trigger ?? "", item.assignee ?? ""]
            .join(" ")
            .toLowerCase()
            .includes(needle)),
    );
  }, [scoped, status, category, workflow, owner, risk, query]);

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clamped = Math.min(page, pages - 1);
  const shown = filtered.slice(clamped * PAGE_SIZE, clamped * PAGE_SIZE + PAGE_SIZE);

  /** Optimistic: the change shows at once and only its own fields roll back
   * if the save fails. */
  const update = useCallback((item: Obligation, patch: TrackingPatch) => {
    const key = obligationKey(item);
    const applied: Partial<Obligation> = { ...patch };
    if ("assignee" in patch) applied.assignee = patch.assignee?.trim() || null;
    const previous: Partial<Obligation> = {};
    for (const field of Object.keys(applied) as (keyof TrackingPatch)[]) {
      (previous as Record<string, unknown>)[field] = item[field];
    }
    const patchItem = (changes: Partial<Obligation>) =>
      setItems((current) =>
        current.map((candidate) => (obligationKey(candidate) === key ? { ...candidate, ...changes } : candidate)),
      );
    patchItem(applied);
    setErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
    updateObligationTracking(item.document_id, key, patch)
      .then((saved) =>
        patchItem({
          workflow_status: saved.workflow_status,
          assignee: saved.assignee,
          subtasks: saved.subtasks,
          tracking_updated_at: saved.tracking_updated_at,
          tracking_updated_by: saved.tracking_updated_by,
        }),
      )
      .catch((err: unknown) => {
        patchItem(previous);
        setErrors((current) => ({
          ...current,
          [key]: `Not saved: ${err instanceof Error ? err.message : "the change could not be saved."}`,
        }));
      });
  }, []);

  function download() {
    const blob = new Blob([obligationsCsv(filtered)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "obligations.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  const reset = (apply: () => void) => {
    apply();
    setPage(0);
  };

  if (data.obligations.length === 0) {
    return (
      <EmptyState
        icon={CalendarCheck}
        title="No obligations yet"
        description="Deliverables, reports, option windows and deadlines appear once a contract with schedules, clauses or contractor duties has been processed."
        action={
          <Link href="/extraction/new" className="btn-primary px-4 py-2 text-sm">
            Start an extraction
          </Link>
        }
      />
    );
  }

  const errorList = Object.entries(errors);

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5" role="group" aria-label="Obligations by status">
        {OBLIGATION_STATUSES.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={status === value}
            onClick={() => reset(() => setStatus(status === value ? "all" : value))}
            className={`rounded-xl border bg-surface px-5 py-4 text-left transition-colors ${status === value ? "border-primary" : "border-border hover:border-primary/40"}`}
          >
            <p className="text-2xl font-semibold tabular-nums tracking-tight text-foreground">{counts[value].toLocaleString()}</p>
            <p className="mt-1 text-sm text-text-secondary">{STATUS_LABELS[value]}</p>
          </button>
        ))}
      </div>

      <Panel
        title="Obligations"
        description={`${filtered.length.toLocaleString()} of ${scoped.length.toLocaleString()} shown. Dates come from the document; clause duties state the clause's own timing. Workflow status, owner and sub-tasks are set by your team.`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex overflow-hidden rounded-lg border border-border" role="group" aria-label="View">
              {VIEWS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={view === id}
                  onClick={() => setView(id)}
                  className={`inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium ${
                    view === id ? "bg-primary text-white" : "bg-surface text-text-secondary hover:text-foreground"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={download}
              disabled={filtered.length === 0}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:border-primary/40 disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              CSV
            </button>
          </div>
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="Obligation filters">
          <label className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => reset(() => setQuery(event.target.value))}
              placeholder="Search obligations…"
              aria-label="Search obligations"
              className="w-48 rounded-lg border border-border bg-surface py-1 pl-7 pr-2 text-xs text-foreground"
            />
          </label>
          <select
            value={documentId}
            onChange={(event) => reset(() => setDocumentId(event.target.value))}
            aria-label="Document"
            className={`${SELECT} max-w-[14rem]`}
          >
            <option value="all">All contracts</option>
            {documents.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select
            value={owner}
            onChange={(event) => reset(() => setOwner(event.target.value))}
            aria-label="Owner"
            className={`${SELECT} max-w-[12rem]`}
          >
            <option value="all">Any owner</option>
            <option value={UNASSIGNED}>Unassigned</option>
            {owners.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            value={workflow}
            onChange={(event) => reset(() => setWorkflow(event.target.value as "all" | WorkflowStatus))}
            aria-label="Workflow status"
            className={SELECT}
          >
            <option value="all">Any workflow status</option>
            {WORKFLOW_STATUSES.map((value) => (
              <option key={value} value={value}>
                {WORKFLOW_LABELS[value]}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(event) => reset(() => setStatus(event.target.value as "all" | ObligationStatus))}
            aria-label="Status"
            className={SELECT}
          >
            <option value="all">Any due status</option>
            {OBLIGATION_STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </select>
          <select
            value={risk}
            onChange={(event) => reset(() => setRisk(event.target.value as "all" | RiskLevel | typeof NO_RISK))}
            aria-label="Risk (by due date)"
            title="High: overdue or due within 7 days · Medium: within 30 days · Low: later"
            className={SELECT}
          >
            <option value="all">Risk (by due date): any</option>
            {(["high", "medium", "low"] as RiskLevel[]).map((value) => (
              <option key={value} value={value}>
                Risk (by due date): {RISK_LABELS[value]}
              </option>
            ))}
            <option value={NO_RISK}>No due date</option>
          </select>
          <select
            value={category}
            onChange={(event) => reset(() => setCategory(event.target.value))}
            aria-label="Category"
            className={`${SELECT} capitalize`}
          >
            <option value="all">All categories</option>
            {data.by_category.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name} ({entry.count})
              </option>
            ))}
          </select>
        </div>

        {view === "table" && errorList.length > 0 && (
          <ul className="mb-3 space-y-1 text-xs text-[var(--danger)]" role="alert">
            {errorList.map(([key, message]) => (
              <li key={key}>
                {items.find((item) => obligationKey(item) === key)?.title ?? "Obligation"}: {message}
              </li>
            ))}
          </ul>
        )}

        {filtered.length === 0 ? (
          <EmptyNote>No obligations match these filters.</EmptyNote>
        ) : view === "kanban" ? (
          <ObligationKanban items={filtered} onUpdate={update} knownAssignees={knownAssignees} errors={errors} />
        ) : view === "calendar" ? (
          <ObligationCalendar items={filtered} onUpdate={update} knownAssignees={knownAssignees} errors={errors} />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
                    <th className="py-2 pr-4">Obligation</th>
                    <th className="py-2 pr-4">Document</th>
                    <th className="py-2 pr-4">Category</th>
                    <th className="py-2 pr-4">Party</th>
                    <th className="py-2 pr-4">Due</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4">Workflow</th>
                    <th className="py-2">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {shown.map((item) => (
                    <ObligationRow key={item.obligation_id} item={item} onUpdate={update} />
                  ))}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div className="mt-3 flex items-center justify-between text-xs text-text-secondary">
                <button type="button" disabled={clamped === 0} onClick={() => setPage(clamped - 1)} className="rounded-md border border-border px-2.5 py-1 disabled:opacity-40">
                  Previous
                </button>
                <span>
                  Page {clamped + 1} of {pages}
                </span>
                <button type="button" disabled={clamped >= pages - 1} onClick={() => setPage(clamped + 1)} className="rounded-md border border-border px-2.5 py-1 disabled:opacity-40">
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

function ObligationRow({
  item,
  onUpdate,
}: {
  item: Obligation;
  onUpdate: (item: Obligation, patch: TrackingPatch) => void;
}) {
  return (
    <tr className="align-top">
      <td className="max-w-[26rem] py-2.5 pr-4">
        <p className="font-medium text-foreground">{item.title}</p>
        <p className="mt-0.5 line-clamp-2 text-xs text-text-secondary" title={item.evidence}>
          {item.trigger ? `${item.trigger[0].toUpperCase()}${item.trigger.slice(1)}. ` : ""}
          {item.description}
        </p>
      </td>
      <td className="max-w-[14rem] py-2.5 pr-4">
        <Link
          href={`/documents/${item.document_id}?view=source`}
          className="block truncate text-foreground hover:text-primary"
          title={item.document_name}
        >
          {item.document_name}
        </Link>
      </td>
      <td className="whitespace-nowrap py-2.5 pr-4 capitalize text-text-secondary">{item.category}</td>
      <td className="whitespace-nowrap py-2.5 pr-4 capitalize text-text-secondary">{item.responsible_party}</td>
      <td className="whitespace-nowrap py-2.5 pr-4 tabular-nums text-foreground">{dueLabel(item)}</td>
      <td className="py-2.5 pr-4">
        <ObligationStatusChip status={item.status} />
      </td>
      <td className="py-2.5 pr-4">
        <div className="flex items-center gap-1.5">
          <AssigneeAvatar name={item.assignee} />
          <WorkflowSelect item={item} onUpdate={onUpdate} />
        </div>
      </td>
      <td className="whitespace-nowrap py-2.5 text-xs text-text-secondary">
        <span className="font-id text-foreground">{item.source_reference}</span>
        <br />
        {SOURCE_LABELS[item.source_type]}
        {item.page ? ` · p. ${item.page}` : ""}
      </td>
    </tr>
  );
}
