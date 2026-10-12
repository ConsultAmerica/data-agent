"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CheckCheck,
  Inbox,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";

import ContentSection from "@/components/layout/ContentSection";
import PageHero from "@/components/layout/PageHero";
import {
  acceptAllMetadataFields,
  getReviewQueue,
  getReviewQueueFields,
} from "@/lib/documents";
import {
  DOCUMENT_TYPE_OPTIONS,
  type ReviewQueueEntry,
  type ReviewQueueFieldItem,
} from "@/types/document";

const DEFAULT_REVIEWER = "Data Agent";

function issueKind(
  item: ReviewQueueFieldItem,
): "extraction" | "validation" | "missing" | "conflicts" {
  const text = [
    ...(item.reason_labels ?? []),
    ...(item.reasons ?? []),
    item.review_status,
  ]
    .join(" ")
    .toLowerCase();
  if (/missing|unknown|empty|blank|not found/.test(text)) return "missing";
  if (/conflict|disagree|reject/.test(text)) return "conflicts";
  if (/validat|type|format|failed|mismatch/.test(text)) return "validation";
  return "extraction";
}

function issueLabel(item: ReviewQueueFieldItem): string {
  return item.reason_labels?.[0] || issueKind(item);
}

export default function ReviewQueuePage() {
  const [entries, setEntries] = useState<ReviewQueueEntry[]>([]);
  const [fieldItems, setFieldItems] = useState<ReviewQueueFieldItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [query, setQuery] = useState("");
  const [documentType, setDocumentType] = useState("");
  const [issueFilter, setIssueFilter] = useState<
    "all" | "extraction" | "validation" | "missing" | "conflicts"
  >("all");

  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  async function load(active: () => boolean = () => true) {
    setLoading(true);
    setError("");

    try {
      const [result, fields] = await Promise.all([
        getReviewQueue(),
        getReviewQueueFields(),
      ]);
      if (active()) {
        setEntries(result);
        setFieldItems(fields);
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
    const normalizedQuery = query.trim().toLowerCase();

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
  }, [entries, query, documentType]);

  async function handleAcceptAll(entry: ReviewQueueEntry) {
    setAcceptingId(entry.document_id);
    setRowErrors((current) => {
      const next = { ...current };
      delete next[entry.document_id];
      return next;
    });

    try {
      await acceptAllMetadataFields(entry.document_id, DEFAULT_REVIEWER);
      setEntries((current) =>
        current.filter((item) => item.document_id !== entry.document_id),
      );
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

  const attentionItems = useMemo(() => {
    return fieldItems.filter((item) => {
      const needs =
        item.decision_status === "needs_review" || item.reasons.length > 0;
      if (!needs) return false;
      if (issueFilter === "all") return true;
      return issueKind(item) === issueFilter;
    });
  }, [fieldItems, issueFilter]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      if (event.key === "n" || event.key === "N") {
        const next = attentionItems[0];
        if (next) {
          window.location.assign(`/documents/${next.document_id}?view=qa`);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [attentionItems]);

  return (
    <>
      <PageHero
        compact
        eyebrow="Review"
        title="Review"
        description="Route machine extraction into human governance — accept, correct, or reject with a durable audit trail."
        actions={
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="btn-hero-secondary disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
        }
      />

      <ContentSection>
        <p className="mb-3 text-sm text-text-secondary">
          {attentionItems.length} items need attention
        </p>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {(
            [
              ["all", "All"],
              ["extraction", "Extraction"],
              ["validation", "Validation"],
              ["missing", "Missing"],
              ["conflicts", "Conflicts"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setIssueFilter(id)}
              className={[
                "rounded-full px-3 py-1.5 text-xs font-semibold",
                issueFilter === id
                  ? "bg-primary text-white"
                  : "border border-border bg-surface text-text-secondary",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by filename..."
            className="w-full rounded-xl border border-border bg-surface py-2 pl-9 pr-3 text-sm text-foreground outline-none focus:border-primary/30"
          />
        </div>

        <select
          value={documentType}
          onChange={(event) => setDocumentType(event.target.value)}
          className="rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none focus:border-primary/30"
        >
          <option value="">All types</option>
          {documentTypesInQueue.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="mb-6 rounded-xl border border-danger/20 bg-danger/5 p-3 text-sm text-danger">
          {error}
        </div>
      )}

      {!loading && fieldItems.length > 0 && (
        <div className="editorial-card mb-6 overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border px-6 py-4">
            <ShieldAlert className="h-4 w-4 text-amber-600" />
            <div>
              <p className="text-sm font-semibold text-foreground">Review</p>
              <p className="text-xs text-text-secondary">
                Why a person needs to look — extraction, validation, a missing value, or a conflict.
              </p>
            </div>
          </div>
          <div className="divide-y divide-border">
            {attentionItems.slice(0, 40).map((item) => (
                <div
                  key={`${item.document_id}:${item.field_key}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-6 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {item.label}
                      <span className="ml-2 text-xs font-normal text-text-muted">
                        {item.original_filename}
                      </span>
                    </p>
                    <p className="truncate text-xs text-text-secondary">
                      {issueLabel(item)}
                      {item.value ? ` · ${item.value}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <Link
                      href={`/documents/${item.document_id}?view=qa`}
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
        {filteredEntries.length > 0 && (
            <div className="editorial-card overflow-hidden">
              <div className="border-b border-border px-6 py-4">
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
                        disabled={acceptingId === entry.document_id}
                        className="btn-secondary py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <CheckCheck className="h-3.5 w-3.5" />
                        {acceptingId === entry.document_id
                          ? "Accepting..."
                          : "Accept All"}
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
