"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronRight, Loader2, Search } from "lucide-react";

import ContentSection from "@/components/layout/ContentSection";
import PageHero from "@/components/layout/PageHero";
import { ErrorState, LoadingState } from "@/components/layout/StatusState";
import ConfidenceIndicator from "@/components/confidence-indicator";
import EmptyState from "@/components/illustrations/empty-state";
import {
  aggregateFieldAcrossRepository,
  filterMatchesByValue,
} from "@/lib/field-explorer";
import {
  EXPLORER_FIELDS,
  type ExplorerFieldKey,
  type FieldAggregation,
} from "@/lib/field-schema";

function ExplorerContent() {
  const searchParams = useSearchParams();
  const initialField =
    (searchParams.get("field") as ExplorerFieldKey | null) ?? "payment_terms";
  const initialValue = searchParams.get("value");

  const [selectedField, setSelectedField] = useState<ExplorerFieldKey>(
    EXPLORER_FIELDS.some((f) => f.key === initialField)
      ? initialField
      : "payment_terms",
  );
  const [fieldQuery, setFieldQuery] = useState("");
  const [aggregation, setAggregation] = useState<FieldAggregation | null>(null);
  const [selectedValue, setSelectedValue] = useState<string | null>(
    initialValue,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const filteredFields = useMemo(() => {
    const q = fieldQuery.trim().toLowerCase();
    if (!q) return EXPLORER_FIELDS;
    return EXPLORER_FIELDS.filter(
      (field) =>
        field.label.toLowerCase().includes(q) ||
        field.key.toLowerCase().includes(q) ||
        field.group.toLowerCase().includes(q),
    );
  }, [fieldQuery]);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setError("");

      try {
        const result = await aggregateFieldAcrossRepository(selectedField);
        if (!active) return;
        setAggregation(result);
        if (initialValue && selectedField === initialField) {
          setSelectedValue(initialValue);
        } else {
          setSelectedValue(null);
        }
      } catch (err) {
        if (active) {
          setError(
            err instanceof Error
              ? err.message
              : "Unable to analyze field data.",
          );
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    return () => {
      active = false;
    };
  }, [selectedField, initialField, initialValue, reloadKey]);

  const matches =
    aggregation && selectedValue
      ? filterMatchesByValue(aggregation, selectedValue)
      : [];

  const maxCount = aggregation?.buckets[0]?.count ?? 1;

  return (
    <>
      <PageHero
        compact
        eyebrow="Intelligence & AI"
        title="Field Explorer"
        description="Compare any extracted field across contracts, financial reports and other documents, with confidence and source links."
      />

      <ContentSection>
        <div className="sticky top-0 z-10 -mx-4 bg-background px-4 pb-2 pt-2 sm:-mx-6 sm:px-6">
        <div className="editorial-card p-5 sm:p-6">
          <div className="flex flex-wrap items-end gap-4">
            <div className="min-w-[240px] flex-1">
              <label className="mb-2 block text-xs font-medium text-text-muted">
                Search fields
              </label>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted" />
                <input
                  type="text"
                  value={fieldQuery}
                  onChange={(event) => setFieldQuery(event.target.value)}
                  placeholder="Payment terms, invoice number, sample ID..."
                  className="w-full rounded-xl border border-border bg-surface py-2.5 pl-10 pr-3 text-sm outline-none focus:border-primary/30 focus:ring-2 focus:ring-primary/10"
                />
              </div>
            </div>
            <div className="min-w-[220px] flex-1">
              <label className="mb-2 block text-xs font-medium text-text-muted">
                Target field
              </label>
              <select
                value={selectedField}
                onChange={(event) =>
                  setSelectedField(event.target.value as ExplorerFieldKey)
                }
                className="w-full rounded-xl border border-border bg-surface px-3 py-2.5 text-sm outline-none focus:border-primary/30 focus:ring-2 focus:ring-primary/10"
              >
                {filteredFields.map((field) => (
                  <option key={field.key} value={field.key}>
                    {field.group} · {field.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {filteredFields.length === 0 && (
            <p className="mt-3 text-sm text-text-secondary">
              No fields match &ldquo;{fieldQuery}&rdquo;.
            </p>
          )}
        </div>
        </div>

      {error && (
        <ErrorState
          error={error}
          onRetry={() => setReloadKey((key) => key + 1)}
        />
      )}

      {loading ? (
        <div className="mt-10 flex items-center gap-2 text-sm text-text-secondary">
          <Loader2 className="h-4 w-4 animate-spin" />
          Extracting fields across the document repository...
        </div>
      ) : aggregation ? (
        <div className="mt-8 grid min-w-0 gap-6 lg:grid-cols-[minmax(260px,0.38fr)_minmax(0,0.62fr)]">
          <div className="editorial-card min-w-0 p-6">
            <h2 className="text-lg font-medium text-foreground">
              {aggregation.field_label}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {aggregation.total_analyzed} documents analyzed
            </p>
            <div className="mt-5 max-h-[28rem] space-y-2 overflow-y-auto">
              {aggregation.buckets.length === 0 ? (
                <p className="text-sm text-text-secondary">
                  No values found for this field yet.
                </p>
              ) : (
                aggregation.buckets.map((bucket) => {
                  const width = Math.max(
                    8,
                    Math.round((bucket.count / maxCount) * 100),
                  );
                  return (
                    <button
                      key={bucket.value}
                      type="button"
                      onClick={() => setSelectedValue(bucket.value)}
                      className={[
                        "w-full rounded-xl p-3 text-left transition duration-200",
                        selectedValue === bucket.value
                          ? "bg-primary-soft ring-1 ring-primary/20"
                          : "hover:bg-surface-soft",
                      ].join(" ")}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate text-sm font-medium text-foreground">
                          {bucket.value}
                        </span>
                        <span className="shrink-0 text-xs text-text-secondary">
                          {bucket.count}
                        </span>
                      </div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-soft">
                        <div
                          className="h-full rounded-full bg-primary/70"
                          style={{ width: `${width}%` }}
                        />
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="editorial-card min-w-0 overflow-hidden">
            {selectedValue ? (
              <>
                <div className="border-b border-border px-6 py-5">
                  <p className="text-lg font-medium text-foreground">
                    {matches.length} matching contracts
                  </p>
                  <p className="mt-1 text-sm text-text-secondary">
                    {aggregation.field_label}: {selectedValue}
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-surface-soft">
                        <th className="px-6 py-3 text-left text-xs font-semibold text-foreground">
                          Document
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-foreground">
                          Party
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-foreground">
                          Effective
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-foreground">
                          Expires
                        </th>
                        <th className="px-4 py-3 text-left text-xs font-semibold text-foreground">
                          Confidence
                        </th>
                        <th className="px-4 py-3" />
                      </tr>
                    </thead>
                    <tbody>
                      {matches.map((row) => (
                        <tr
                          key={row.document_id}
                          className="border-b border-border/70 hover:bg-surface-soft/60"
                        >
                          <td className="px-6 py-3.5 font-medium text-foreground">
                            {row.contract_title}
                          </td>
                          <td className="px-4 py-3.5 text-text-secondary">
                            {row.counterparty ?? "—"}
                          </td>
                          <td className="px-4 py-3.5 text-text-secondary">
                            {row.effective_date ?? "—"}
                          </td>
                          <td className="px-4 py-3.5 text-text-secondary">
                            {row.expiration_date ?? "—"}
                          </td>
                          <td className="px-4 py-3.5">
                            {row.confidence !== null ? (
                              <ConfidenceIndicator confidence={row.confidence} />
                            ) : (
                              "—"
                            )}
                          </td>
                          <td className="px-4 py-3.5">
                            <Link
                              href={`/extraction/new?documentId=${row.document_id}`}
                              className="inline-flex items-center gap-1 text-sm text-text-teal hover:text-primary"
                            >
                              Open
                              <ChevronRight className="h-3.5 w-3.5" />
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : (
              <EmptyState
                variant="fields"
                title="Select a value to explore matching documents"
                description="Click any distribution row to open the cross-document results table."
              />
            )}
          </div>
        </div>
      ) : null}
      </ContentSection>
    </>
  );
}

export default function FieldExplorerPage() {
  return (
    <Suspense
      fallback={
        <LoadingState
          title="Loading Field Explorer..."
          description="Aggregating extracted scalar fields across all repository contracts."
        />
      }
    >
      <ExplorerContent />
    </Suspense>
  );
}
