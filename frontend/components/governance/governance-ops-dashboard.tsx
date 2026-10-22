"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import ContentSection from "@/components/layout/ContentSection";
import PageHero from "@/components/layout/PageHero";
import { getCurrentActor } from "@/lib/auth";
import {
  getDashboardStats,
  getDocumentStatusCounts,
  getGlobalAuditLog,
  searchDocuments,
  startProcessingJob,
} from "@/lib/documents";
import { probeOpsHealth, type OpsHealthSnapshot } from "@/lib/ops-health";
import { getPortfolio, type Portfolio } from "@/lib/portfolio";
import type {
  ActorInfo,
  DashboardStats,
  DocumentSummary,
  GlobalAuditEntry,
} from "@/types/document";

/** Map backend document/job statuses to operator-facing labels. */
export function mapProcessingLabel(status: string | null | undefined): string {
  switch ((status ?? "").toLowerCase()) {
    case "queued":
    case "pending":
      return "Queued";
    case "processing":
    case "extracting":
      return "Processing";
    case "completed":
    case "processed":
      return "Completed";
    case "failed":
    case "error":
      return "Failed";
    case "retryable":
      return "Retryable";
    case "review_required":
      return "Review required";
    case "":
      return "Unknown / unavailable";
    default:
      return status ?? "Unknown / unavailable";
  }
}

type MetricCard = {
  label: string;
  value: string;
  /** What the number counts, in plain words. */
  hint: string;
  href?: string;
  tone?: "default" | "warning" | "danger" | "success";
};

function fmt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString();
}

function can(actor: ActorInfo | null, permission: string): boolean {
  return Boolean(actor?.permissions?.includes(permission));
}

export default function GovernanceOpsDashboard() {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [statusCounts, setStatusCounts] = useState<Partial<
    Record<string, number>
  > | null>(null);
  const [failedDocs, setFailedDocs] = useState<DocumentSummary[]>([]);
  const [recentReview, setRecentReview] = useState<GlobalAuditEntry[]>([]);
  const [health, setHealth] = useState<OpsHealthSnapshot | null>(null);
  const [actor, setActor] = useState<ActorInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reprocessBusy, setReprocessBusy] = useState<string | null>(null);
  const [reprocessNotice, setReprocessNotice] = useState("");
  const [reprocessError, setReprocessError] = useState("");
  const inFlightReprocess = useRef<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [port, dash, counts, failed, audit, healthSnap, me] =
        await Promise.all([
          getPortfolio(),
          getDashboardStats().catch(() => null),
          getDocumentStatusCounts().catch(() => null),
          searchDocuments({ status: "failed", limit: 10, offset: 0 }).catch(
            () => ({ documents: [], total: 0 }),
          ),
          getGlobalAuditLog(8, 0).catch(() => ({ entries: [], total: 0 })),
          probeOpsHealth(),
          getCurrentActor().catch(() => null),
        ]);
      setPortfolio(port);
      setStats(dash);
      setStatusCounts(counts?.by_status ?? null);
      setFailedDocs(failed.documents);
      setRecentReview(audit.entries);
      setHealth(healthSnap);
      setActor(me);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to load governance operations data.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function reprocess(documentId: string) {
    if (inFlightReprocess.current.has(documentId)) return;
    if (actor && !can(actor, "extraction.run")) {
      setReprocessError("Your role cannot start reprocessing.");
      return;
    }
    inFlightReprocess.current.add(documentId);
    setReprocessBusy(documentId);
    setReprocessError("");
    setReprocessNotice("");
    try {
      const job = await startProcessingJob(documentId);
      setReprocessNotice(
        `Reprocess queued for ${documentId.slice(0, 8)}… (job ${job.id}, ${job.status}).`,
      );
      await load();
    } catch (err) {
      setReprocessError(
        err instanceof Error ? err.message : "Reprocess request failed.",
      );
    } finally {
      inFlightReprocess.current.delete(documentId);
      setReprocessBusy(null);
    }
  }

  const reviewDecisions = portfolio
    ? portfolio.review.accepted +
      portfolio.review.edited +
      portfolio.review.rejected
    : null;

  const cards: MetricCard[] = portfolio
    ? [
        {
          label: "Total documents",
          value: fmt(portfolio.totals.documents),
          hint: "Every document in this workspace",
          href: "/documents",
        },
        {
          label: "Values awaiting review",
          value: fmt(portfolio.review.pending),
          hint: "Extracted values with no reviewer decision yet",
          href: "/review-queue",
          tone: portfolio.review.pending > 0 ? "warning" : "default",
        },
        {
          label: "Processing failures",
          value: fmt(portfolio.totals.failed),
          hint: "Documents whose processing failed",
          href: "/documents?filter=failed",
          tone: portfolio.totals.failed > 0 ? "danger" : "default",
        },
        {
          label: "Active processing",
          value: fmt(portfolio.totals.processing),
          hint: "Documents being processed right now",
          tone: portfolio.totals.processing > 0 ? "warning" : "default",
        },
        {
          label: "Review decisions",
          value: fmt(reviewDecisions),
          hint: "Values accepted, corrected or rejected by a reviewer",
          href: "/audit-log",
        },
        {
          label: "Low-confidence documents",
          value: fmt(portfolio.review.low_confidence_documents),
          hint: "Documents with at least one low-confidence value",
          href: "/documents?filter=review",
          tone:
            portfolio.review.low_confidence_documents > 0
              ? "warning"
              : "default",
        },
      ]
    : [];

  if (stats) {
    cards.push({
      label: "Documents with flagged values",
      value: fmt(stats.documents_requiring_manual_review),
      hint: "Documents with at least one value flagged for a reviewer",
      href: "/review-queue",
    });
  }

  const toneClass = {
    default: "text-foreground",
    warning: "text-warning",
    danger: "text-danger",
    success: "text-success",
  } as const;

  return (
    <>
      <PageHero
        compact
        eyebrow="Administration"
        title="Operations"
        description="Service health, review workload and recent reviewer activity across the workspace."
      />
      <ContentSection className="space-y-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-text-secondary" aria-live="polite">
            {loading
              ? "Loading operations data…"
              : health
                ? health.label
                : "Health not checked yet"}
          </p>
          <button
            type="button"
            className="btn-secondary px-3 py-1.5 text-xs"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Refresh
          </button>
        </div>

        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger" role="alert">
            {error}
          </div>
        )}

        {health && (
          <section
            className="rounded-xl border border-border bg-surface px-4 py-3"
            data-testid="ops-health"
          >
            <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Service health
            </h2>
            <p className="mt-1 text-sm font-medium text-foreground">{health.label}</p>
            <p className="mt-0.5 text-xs text-text-secondary">{health.detail}</p>
            <dl className="mt-2 flex flex-wrap gap-4 text-xs text-text-muted">
              {health.readyStatus && (
                <div>
                  Readiness check:{" "}
                  <span className="text-foreground">{health.readyStatus === "ready" ? "passed" : health.readyStatus}</span>
                </div>
              )}
              {health.oracleDryRun != null && (
                <div>
                  Oracle sends:{" "}
                  <span className="text-foreground">
                    {health.oracleDryRun ? "dry run only" : "live"}
                  </span>
                </div>
              )}
              {health.rbacEnforced != null && (
                <div>
                  Access control:{" "}
                  <span className="text-foreground">
                    {health.rbacEnforced ? "role-based" : "open workspace (demo)"}
                  </span>
                </div>
              )}
              {health.metadataReviewMutationsEnabled != null && (
                <div>
                  Review edits:{" "}
                  <span className="text-foreground">
                    {health.metadataReviewMutationsEnabled
                      ? "allowed"
                      : "locked"}
                  </span>
                </div>
              )}
            </dl>
          </section>
        )}

        <section data-testid="ops-metrics">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Portfolio metrics
          </h2>
          {loading && !portfolio ? (
            <p className="mt-3 text-sm text-text-secondary">Loading metrics…</p>
          ) : (
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {cards.map((card) => {
                const body = (
                  <>
                    <p className="text-xs text-text-secondary">{card.label}</p>
                    <p
                      className={`mt-1 text-2xl font-semibold tabular-nums ${toneClass[card.tone ?? "default"]}`}
                    >
                      {card.value}
                    </p>
                    <p className="mt-2 text-[10px] leading-4 text-text-muted">
                      {card.hint}
                    </p>
                  </>
                );
                return card.href ? (
                  <Link
                    key={card.label}
                    href={card.href}
                    className="rounded-xl border border-border bg-surface px-4 py-3 transition hover:border-primary/40"
                  >
                    {body}
                  </Link>
                ) : (
                  <div
                    key={card.label}
                    className="rounded-xl border border-border bg-surface px-4 py-3"
                  >
                    {body}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-border bg-surface px-4 py-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Role-aware actions
          </h2>
          <p className="mt-1 text-xs text-text-muted">
            Actions shown for your role. Permissions are also checked on the server.
            {actor
              ? ` Signed in as ${actor.display_name} (${actor.role}).`
              : " Your identity couldn't be loaded."}
          </p>
          <ul className="mt-3 flex flex-wrap gap-2 text-xs" data-testid="role-actions">
            <ActionChip href="/documents" label="View documents" allowed />
            <ActionChip
              href="/review-queue"
              label="Review metadata"
              allowed={can(actor, "review.accept") || can(actor, "review.edit")}
            />
            <ActionChip
              href="/documents"
              label="Export data"
              allowed={can(actor, "export.read")}
            />
            <ActionChip
              href="/documents?filter=failed"
              label="Reprocess documents"
              allowed={can(actor, "extraction.run")}
            />
            <ActionChip
              href="/integrations"
              label="Oracle preview"
              allowed={can(actor, "oracle.preview")}
            />
            <ActionChip
              href="/integrations"
              label="Oracle send"
              allowed={can(actor, "oracle.send")}
            />
            <ActionChip href="/audit-log" label="View audit history" allowed />
            <ActionChip
              href="/settings/extraction-models"
              label="Manage settings"
              allowed={can(actor, "admin.providers") || actor?.role === "admin"}
            />
          </ul>
        </section>

        <section className="rounded-xl border border-border bg-surface px-4 py-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Processing operations
              </h2>
              <p className="mt-1 text-xs text-text-muted">
                States from portfolio / status-counts. Retry creates a new
                process job — no automatic retries.
              </p>
            </div>
            <Link href="/documents?filter=failed" className="text-xs text-primary hover:underline">
              Open failed documents
            </Link>
          </div>
          <dl
            className="mt-3 flex flex-wrap gap-4 text-xs"
            data-testid="processing-status-counts"
          >
            <div>
              <dt className="text-text-muted">Queued / not processed</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {fmt(portfolio?.totals.not_processed)}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Processing</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {fmt(
                  statusCounts?.processing ?? portfolio?.totals.processing,
                )}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Completed</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {fmt(statusCounts?.completed ?? portfolio?.totals.processed)}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Failed (retryable via job)</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {fmt(statusCounts?.failed ?? portfolio?.totals.failed)}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Review required</dt>
              <dd className="font-medium tabular-nums text-foreground">
                {fmt(statusCounts?.review_required)}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Unknown / unavailable</dt>
              <dd className="font-medium text-text-muted">
                Shown only when a job/document status is missing
              </dd>
            </div>
          </dl>
          <div className="mt-3" aria-live="polite">
            {reprocessNotice && (
              <p className="text-xs text-success" role="status">
                {reprocessNotice}
              </p>
            )}
            {reprocessError && (
              <p className="text-xs text-danger" role="alert">
                {reprocessError}
              </p>
            )}
          </div>
          {failedDocs.length === 0 ? (
            <p className="mt-3 text-sm text-text-muted">
              No failed documents in the current workspace scope.
            </p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-sm" data-testid="failed-docs-table">
                <thead className="text-xs uppercase text-text-secondary">
                  <tr className="border-b border-border">
                    <th className="px-2 py-2 font-semibold">Document</th>
                    <th className="px-2 py-2 font-semibold">Status</th>
                    <th className="px-2 py-2 font-semibold">Updated</th>
                    <th className="px-2 py-2 font-semibold">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {failedDocs.map((doc) => {
                    const allowRetry = !actor || can(actor, "extraction.run");
                    return (
                      <tr
                        key={doc.document_id}
                        className="border-b border-border/70"
                      >
                        <td className="px-2 py-2">
                          <Link
                            href={`/documents/${doc.document_id}`}
                            className="font-medium text-primary hover:underline"
                          >
                            {doc.original_filename}
                          </Link>
                        </td>
                        <td className="px-2 py-2 text-danger">
                          {mapProcessingLabel(doc.status)}
                          <span className="ml-1 text-[10px] text-text-muted">
                            ({doc.status})
                          </span>
                        </td>
                        <td className="px-2 py-2 text-text-secondary">
                          {doc.last_updated
                            ? new Date(doc.last_updated).toLocaleString()
                            : doc.uploaded_at
                              ? new Date(doc.uploaded_at).toLocaleString()
                              : "—"}
                        </td>
                        <td className="px-2 py-2">
                          {allowRetry ? (
                            <button
                              type="button"
                              className="btn-secondary px-2 py-1 text-xs disabled:opacity-50"
                              disabled={reprocessBusy === doc.document_id}
                              onClick={() => void reprocess(doc.document_id)}
                            >
                              {reprocessBusy === doc.document_id
                                ? "Queuing…"
                                : "Retry reprocess"}
                            </button>
                          ) : (
                            <span className="text-xs text-text-muted">
                              Retry hidden for role
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section
          className="rounded-xl border border-border bg-surface px-4 py-4"
          data-testid="recent-review-activity"
        >
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
                Recent review activity
              </h2>
              <p className="mt-1 text-xs text-text-muted">
                The last 8 reviewer decisions. Export and Oracle events are
                recorded in the integration log.
              </p>
            </div>
            <Link href="/audit-log" className="text-xs text-primary hover:underline">
              Open audit explorer
            </Link>
          </div>
          {recentReview.length === 0 ? (
            <p className="mt-3 text-sm text-text-muted">
              No recent metadata review audit rows in scope.
            </p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {recentReview.map((entry, index) => (
                <li
                  key={`${entry.document_id}-${entry.changed_at}-${index}`}
                  className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border/50 pb-2"
                >
                  <span>
                    <Link
                      href={`/documents/${entry.document_id}/review`}
                      className="font-medium text-primary hover:underline"
                    >
                      {entry.document_filename}
                    </Link>
                    <span className="text-text-secondary">
                      {" "}
                      · {entry.field_key} · {entry.action}
                    </span>
                  </span>
                  <span className="text-xs text-text-muted">
                    {new Date(entry.changed_at).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-border bg-surface px-4 py-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Exports &amp; Oracle
          </h2>
          <ul className="mt-2 space-y-1 text-xs text-text-secondary">
            <li>
              Recent exports:{" "}
              <span className="text-text-muted">
                Tracked per document. Open a document&apos;s Export menu to see its history.
              </span>
            </li>
            <li>
              Oracle outcomes:{" "}
              <span className="text-text-muted">
                Tracked per document. Open{" "}
                <Link href="/integrations" className="text-primary hover:underline">
                  Exports &amp; Oracle
                </Link>{" "}
                and choose a document.
              </span>
            </li>
          </ul>
        </section>

        <section className="rounded-xl border border-border bg-surface px-4 py-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Oracle operational safety
          </h2>
          <ul className="mt-2 space-y-1 text-xs text-text-secondary">
            <li>Generating a preview doesn&apos;t send anything to Oracle.</li>
            <li>
              Dry-run sends are logged as simulations, not deliveries to Fusion.
            </li>
            <li>
              Live sends stay off until an administrator connects an approved
              Fusion account.
            </li>
            <li>
              If a send times out or its result is unknown, check its history
              before trying again. Nothing retries automatically.
            </li>
            <li>
              Duplicate sends aren&apos;t detected yet, so don&apos;t resend a
              document that may already have arrived.
            </li>
          </ul>
          <Link
            href="/integrations"
            className="btn-secondary mt-3 inline-flex px-3 py-1.5 text-xs"
          >
            Open Exports & Oracle
          </Link>
        </section>

        <section className="flex flex-wrap gap-3 text-sm">
          <Link href="/audit-log" className="btn-primary px-3 py-2 text-sm">
            Audit explorer
          </Link>
          <Link href="/activity" className="btn-secondary px-3 py-2 text-sm">
            Activity feed
          </Link>
          <Link href="/analytics" className="btn-secondary px-3 py-2 text-sm">
            Analytics
          </Link>
          <Link href="/risk" className="btn-secondary px-3 py-2 text-sm">
            Risk register
          </Link>
        </section>
      </ContentSection>
    </>
  );
}

function ActionChip({
  href,
  label,
  allowed,
}: {
  href: string;
  label: string;
  allowed: boolean;
}) {
  if (!allowed) {
    return (
      <li>
        <span
          className="inline-flex rounded-full border border-border px-2.5 py-1 text-text-muted"
          title="Not permitted for this role"
        >
          {label} · hidden
        </span>
      </li>
    );
  }
  return (
    <li>
      <Link
        href={href}
        className="inline-flex rounded-full border border-primary/30 bg-primary-soft/40 px-2.5 py-1 font-medium text-primary hover:border-primary/60"
      >
        {label}
      </Link>
    </li>
  );
}
