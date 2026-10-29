"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCheck, FileStack, Flag, Inbox, ListChecks, RefreshCw, ShieldAlert } from "lucide-react";

import ContentSection from "@/components/layout/ContentSection";
import ConsoleHeader from "@/components/layout/ConsoleHeader";
import FieldReviewList from "@/components/review-queue/field-review-list";
import QueueFilterBar from "@/components/review-queue/queue-filter-bar";
import {
  DEFAULT_FILTERS,
  ISSUE_TABS,
  issueKind,
  issueLabel,
  matchesFilters,
  useSavedFilters,
  type QueueFilters,
} from "@/components/review-queue/queue-filters";
import {
  getAssignees,
  normalizeContractType,
  type AssigneesResult,
  type Assignment,
  type ReviewQueueFieldDetail,
} from "@/lib/assignments";
import { HIGH_BAND_MIN } from "@/lib/confidence-policy";
import {
  acceptAllMetadataFields,
  acceptReviewQueueFields,
  getReviewQueue,
  getReviewQueueFields,
  isLowRiskQueueField,
} from "@/lib/documents";
import {
  DOCUMENT_TYPE_OPTIONS,
  type ReviewQueueEntry,
  type ReviewQueueFieldItem,
} from "@/types/document";
import ReviewReadOnlyNotice from "@/components/review/review-read-only-notice";
import { REVIEW_READ_ONLY_MESSAGE, useReviewMutationsEnabled } from "@/lib/review-gate";

const DEFAULT_REVIEWER = "Dataomatix";

function needsReview(item: ReviewQueueFieldItem): boolean {
  return item.decision_status === "needs_review" || item.reasons.length > 0;
}

function sameField(a: ReviewQueueFieldItem, b: { document_id: string; metadata_field_id?: number | null; field_key: string }) {
  if (a.document_id !== b.document_id) return false;
  return a.metadata_field_id != null && b.metadata_field_id != null
    ? a.metadata_field_id === b.metadata_field_id
    : a.field_key === b.field_key;
}

export default function ReviewQueuePage() {
  const reviewEnabled = useReviewMutationsEnabled();
  const [entries, setEntries] = useState<ReviewQueueEntry[]>([]);
  const [fieldItems, setFieldItems] = useState<ReviewQueueFieldDetail[]>([]);
  const [assigneeInfo, setAssigneeInfo] = useState<AssigneesResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [filters, setFilters] = useState<QueueFilters>(DEFAULT_FILTERS);
  const [savedFilters, setSavedFilters] = useSavedFilters();
  const [documentType, setDocumentType] = useState("");

  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  async function load(active: () => boolean = () => true) {
    setLoading(true);
    setError("");

    try {
      const [result, fields, assignees] = await Promise.all([
        getReviewQueue(),
        getReviewQueueFields(),
        // Suggestions only: the queue still works without them.
        getAssignees().catch(() => null),
      ]);
      if (active()) {
        setEntries(result);
        setFieldItems(fields as ReviewQueueFieldDetail[]);
        setAssigneeInfo(assignees);
      }
    } catch (err) {
      if (active()) {
        setError(
          err instanceof Error
            ? err.message
            : "Unable to load the review queue.",
        );
      }
    } finally {
      if (active()) setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    load(() => active);

    return () => {
      active = false;
    };
  }, []);

  const documentTypesInQueue = useMemo(
    () =>
      DOCUMENT_TYPE_OPTIONS.filter((option) =>
        entries.some((entry) => entry.document_type === option),
      ),
    [entries],
  );

  const filteredEntries = useMemo(() => {
    const normalizedQuery = filters.query.trim().toLowerCase();

    return entries.filter((entry) => {
      if (
        normalizedQuery &&
        !entry.original_filename.toLowerCase().includes(normalizedQuery)
      ) {
        return false;
      }

      if (documentType && entry.document_type !== documentType) {
        return false;
      }

      return true;
    });
  }, [entries, filters.query, documentType]);

  async function handleAcceptAll(entry: ReviewQueueEntry) {
    setAcceptingId(entry.document_id);
    setRowErrors((current) => {
      const next = { ...current };
      delete next[entry.document_id];
      return next;
    });

    try {
      // Only low-risk values are accepted in bulk; flagged ones stay
      // pending, so the document stays in the queue until they're decided.
      const updated = await acceptAllMetadataFields(entry.document_id, DEFAULT_REVIEWER);
      const stillPending = updated.filter((field) => field.review_status === "pending").length;
      if (stillPending === 0) {
        setEntries((current) =>
          current.filter((item) => item.document_id !== entry.document_id),
        );
      } else {
        setRowErrors((current) => ({
          ...current,
          [entry.document_id]: `${stillPending} flagged value${stillPending === 1 ? "" : "s"} still need an individual decision.`,
        }));
      }
    } catch (err) {
      setRowErrors((current) => ({
        ...current,
        [entry.document_id]:
          err instanceof Error
            ? err.message
            : "Unable to accept all fields.",
      }));
    } finally {
      setAcceptingId(null);
    }
  }

  const flaggedItems = useMemo(() => fieldItems.filter(needsReview), [fieldItems]);
  // The banner counts by issue tab, as before; the table applies every filter.
  const attentionItems = useMemo(
    () => flaggedItems.filter((item) => filters.issue === "all" || issueKind(item) === filters.issue),
    [flaggedItems, filters.issue],
  );
  const tableItems = useMemo(
    () => flaggedItems.filter((item) => matchesFilters(item, filters)),
    [flaggedItems, filters],
  );
  const issueCounts = useMemo(() => {
    const counts: Record<string, number> = { all: flaggedItems.length };
    for (const item of flaggedItems) counts[issueKind(item)] = (counts[issueKind(item)] ?? 0) + 1;
    return counts;
  }, [flaggedItems]);
  const assigneeOptions = useMemo(
    () =>
      [...new Set([...(assigneeInfo?.assignees ?? []), ...fieldItems.map((item) => item.assignee ?? "")])]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    [assigneeInfo, fieldItems],
  );
  const contractTypes = useMemo(
    () =>
      [...new Set(flaggedItems.map((item) => normalizeContractType(item.contract_type)))]
        .filter((value): value is string => Boolean(value))
        .sort((a, b) => a.localeCompare(b)),
    [flaggedItems],
  );

  // Values waiting with nothing flagged: a reviewer can accept them in bulk.
  const readyCount = fieldItems.length - flaggedItems.length;
  // The subset safe for one-click batch approval: unflagged and high confidence.
  const lowRiskItems = useMemo(() => fieldItems.filter(isLowRiskQueueField), [fieldItems]);
  const attentionDocuments = new Set(attentionItems.map((item) => item.document_id)).size;
  const [confirmLowRisk, setConfirmLowRisk] = useState(false);
  const [acceptingLowRisk, setAcceptingLowRisk] = useState(false);
  const [batchNotice, setBatchNotice] = useState("");

  async function acceptLowRisk() {
    setAcceptingLowRisk(true);
    setBatchNotice("");
    const { accepted, failed } = await acceptReviewQueueFields(lowRiskItems, DEFAULT_REVIEWER);
    const done = new Set(accepted);
    setFieldItems((current) => current.filter((item) => !done.has(item)));
    setBatchNotice(
      `Accepted ${accepted.length} low-risk ${accepted.length === 1 ? "value" : "values"}` +
        (failed.length ? ` · ${failed.length} could not be saved` : "") +
        ".",
    );
    setAcceptingLowRisk(false);
    setConfirmLowRisk(false);
  }

  // A saved Approve / Reject / correction leaves the queue (and its counts) for good.
  const handleDecided = useCallback((decided: ReviewQueueFieldItem) => {
    setFieldItems((current) => current.filter((item) => !sameField(item, decided)));
  }, []);

  const handleAssigned = useCallback((changed: ReviewQueueFieldDetail[], saved: Assignment[]) => {
    setFieldItems((current) =>
      current.map((item) => {
        if (!changed.some((candidate) => sameField(item, candidate))) return item;
        const assignment = saved.find((candidate) => sameField(item, candidate));
        return {
          ...item,
          assignee: assignment?.assignee ?? null,
          due_date: assignment?.due_date ?? null,
          assigned_at: assignment?.assigned_at ?? null,
        };
      }),
    );
    const names = saved.map((assignment) => assignment.assignee);
    if (names.length) {
      setAssigneeInfo((current) => ({
        current_actor: current?.current_actor ?? "",
        assignees: [...new Set([...(current?.assignees ?? []), ...names])],
      }));
    }
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.closest('[role="dialog"]'))
      ) {
        return;
      }
      if (event.key === "n" || event.key === "N") {
        const next = tableItems[0];
        if (next) {
          window.location.assign(`/documents/${next.document_id}?view=qa`);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tableItems]);

  return (
    <>
      <ConsoleHeader
        icon={ListChecks}
        title="Review queue"
        description="Accept, correct or reject extracted values. Every decision is recorded in the audit trail."
        actions={
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="btn-secondary h-9 px-3 text-sm disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
        }
        tabsLabel="Issue type"
        tabs={ISSUE_TABS.map(([id, label]) => ({
          id,
          label,
          count: loading ? undefined : (issueCounts[id] ?? 0),
          active: filters.issue === id,
          onSelect: () => setFilters((current) => ({ ...current, issue: id })),
        }))}
      />

      <ContentSection>
        <ReviewReadOnlyNotice className="mb-3" />
        <dl className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="review-summary">
          {(
            [
              ["Flagged values", attentionItems.length, Flag, "bg-warning/10 text-warning"],
              ["Documents", attentionDocuments, FileStack, "bg-primary-soft text-primary"],
              ["Critical", (issueCounts.validation ?? 0) + (issueCounts.conflicts ?? 0), ShieldAlert, "bg-danger/10 text-danger"],
              ["Ready to accept", readyCount, CheckCheck, "bg-success/10 text-success"],
            ] as const
          ).map(([label, value, Icon, tone]) => (
            <div key={label} className="flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface px-4 py-3.5 shadow-sm">
              <div>
                <dt className="text-xs text-text-muted">{label}</dt>
                <dd className="mt-0.5 text-2xl font-semibold tabular-nums tracking-tight text-foreground">
                  {loading && entries.length === 0 ? <span className="text-text-muted">—</span> : value.toLocaleString()}
                </dd>
              </div>
              <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${tone}`}>
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
            </div>
          ))}
        </dl>
        <p className="sr-only">
          <span className="font-medium text-foreground">{attentionItems.length}</span>{" "}
          {attentionItems.length === 1 ? "value" : "values"} flagged for review
          {attentionDocuments > 0 && ` in ${attentionDocuments} ${attentionDocuments === 1 ? "document" : "documents"}`}
          {readyCount > 0 && ` · ${readyCount} more ready to accept`}
        </p>
        {lowRiskItems.length > 0 && (
          <div
            className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--success)]/30 bg-[var(--success)]/[0.06] px-4 py-3 text-sm"
            data-testid="low-risk-batch"
          >
            <CheckCheck className="h-4 w-4 shrink-0 text-[var(--success)]" aria-hidden="true" />
            <p className="min-w-0 flex-1 text-text-secondary">
              <span className="font-medium text-foreground">{lowRiskItems.length}</span> unflagged{" "}
              {lowRiskItems.length === 1 ? "value scores" : "values score"} {Math.round(HIGH_BAND_MIN * 100)}% or
              higher{" "}
              {(() => {
                const count = new Set(lowRiskItems.map((item) => item.document_id)).size;
                return `across ${count} ${count === 1 ? "document" : "documents"}`;
              })()}
              . Each acceptance is audited.
            </p>
            {confirmLowRisk ? (
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void acceptLowRisk()}
                  disabled={!reviewEnabled || acceptingLowRisk}
                  className="btn-primary px-3 py-1.5 text-xs disabled:opacity-50"
                >
                  {acceptingLowRisk ? "Accepting…" : `Confirm: accept ${lowRiskItems.length}`}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmLowRisk(false)}
                  disabled={acceptingLowRisk}
                  className="text-xs text-text-secondary hover:text-foreground"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmLowRisk(true)}
                disabled={!reviewEnabled}
                title={reviewEnabled ? undefined : REVIEW_READ_ONLY_MESSAGE}
                className="btn-secondary px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
              >
                Accept low-risk values
              </button>
            )}
          </div>
        )}
        {batchNotice && (
          <p className="mb-4 text-sm text-text-secondary" role="status">
            {batchNotice}
          </p>
        )}
        <QueueFilterBar
          filters={filters}
          onChange={setFilters}
          assignees={assigneeOptions}
          contractTypes={contractTypes}
          saved={savedFilters}
          onSave={(name) =>
            setSavedFilters([
              ...savedFilters.filter((entry) => entry.name !== name),
              { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, name, filters },
            ])
          }
          onRemoveSaved={(id) => setSavedFilters(savedFilters.filter((entry) => entry.id !== id))}
        />

      {error && (
        <div className="mb-6 rounded-xl border border-danger/20 bg-danger/5 p-3 text-sm text-danger">
          {error}
        </div>
      )}

      {!loading && flaggedItems.length > 0 && (
        <>
          {tableItems.length !== flaggedItems.length && (
            <p className="mb-2 text-xs text-text-secondary">
              {tableItems.length} of {flaggedItems.length} flagged values match these filters.
            </p>
          )}
          <FieldReviewList
            items={tableItems}
            reviewer={DEFAULT_REVIEWER}
            issueLabel={issueLabel}
            onDecided={handleDecided}
            knownAssignees={assigneeOptions}
            currentActor={assigneeInfo?.current_actor ?? ""}
            onAssigned={handleAssigned}
          />
        </>
      )}

      {loading && entries.length === 0 && (
        <div className="space-y-3">
          {[0, 1, 2].map((index) => (
            <div
              key={index}
              className="h-16 animate-pulse rounded-2xl border border-border bg-surface-soft"
            />
          ))}
        </div>
      )}

      {!loading && entries.length === 0 && !error && (
        <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-border py-16 text-center">
          <Inbox className="h-8 w-8 text-text-muted" />
          <p className="text-sm font-medium text-foreground">
            The review queue is empty.
          </p>
          <p className="text-xs text-text-secondary">
            Every uploaded document has been fully reviewed.
          </p>
        </div>
      )}

      {!loading &&
        entries.length > 0 &&
        filteredEntries.length === 0 &&
        !error && (
          <p className="rounded-2xl border border-dashed border-border py-10 text-center text-sm text-text-secondary">
            No documents match your filters.
          </p>
        )}

      <div className="space-y-6">
        {entries.length > 0 && filteredEntries.length > 0 && (
            <div className="editorial-card overflow-hidden">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-6 py-4">
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    Documents
                    <span className="ml-2 text-xs font-normal text-text-muted">
                      {filteredEntries.length}
                    </span>
                  </p>
                  <p className="text-xs text-text-secondary">
                    Open a document to verify the field in source.
                  </p>
                </div>
                {documentTypesInQueue.length > 1 && (
                  <select
                    value={documentType}
                    onChange={(event) => setDocumentType(event.target.value)}
                    aria-label="Document type"
                    className="rounded-lg border border-border bg-surface px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary/30"
                  >
                    <option value="">All types</option>
                    {documentTypesInQueue.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="divide-y divide-border">
                {filteredEntries.map((entry) => (
                  <div
                    key={entry.document_id}
                    className="flex flex-wrap items-center justify-between gap-3 px-6 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-foreground">
                        {entry.original_filename}
                      </p>
                      <p className="text-xs text-text-secondary">
                        {entry.document_type ?? "Unclassified"} ·{" "}
                        {new Date(entry.uploaded_at).toLocaleDateString()}
                        {typeof entry.pending_field_count === "number" && (
                          <> · {entry.pending_field_count} pending</>
                        )}
                        {entry.top_reasons && entry.top_reasons.length > 0 && (
                          <> · {entry.top_reasons.join(", ")}</>
                        )}
                      </p>
                      {rowErrors[entry.document_id] && (
                        <p className="mt-1 text-xs text-danger">
                          {rowErrors[entry.document_id]}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => handleAcceptAll(entry)}
                        disabled={!reviewEnabled || acceptingId === entry.document_id}
                        className="btn-secondary py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <CheckCheck className="h-3.5 w-3.5" />
                        {acceptingId === entry.document_id
                          ? "Accepting..."
                          : "Accept low-risk"}
                      </button>

                      <Link
                        href={`/documents/${entry.document_id}?view=qa`}
                        className="text-xs font-semibold text-text-teal hover:text-primary"
                      >
                        Review
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            </div>
        )}
      </div>
      </ContentSection>
    </>
  );
}
