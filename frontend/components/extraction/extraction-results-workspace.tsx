"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";

import ExtractedDataPanel, {
  type FieldFilter,
} from "@/components/extraction/extracted-data-panel";
import ExtractionDocumentHeader from "@/components/extraction/extraction-document-header";
import ExtractionTabBar, {
  type ExtractionTab,
} from "@/components/extraction/extraction-tab-bar";
import PaginatedPages from "@/components/extraction/paginated-pages";
import IngestionChecklist from "@/components/ingestion-checklist";
import RelationshipCard from "@/components/relationship-card";
import StructuredOutputPanel from "@/components/structured-output-panel";
import UniversalResults from "@/components/universal-results";
import ConfidenceIndicator from "@/components/confidence-indicator";
import {
  extractClauses,
  extractTables,
  getClauses,
} from "@/lib/documents";
import type {
  ClauseResult,
  ContractAnalysisResult,
  DetectedRelationship,
  DocumentPage,
  MetadataField,
  NormalizedTable,
  RelationshipAction,
  StructuredContractOutput,
  UniversalExtractionResult,
  UploadedDocument,
} from "@/types/document";

const KEY_FIELD_KEYS = [
  "contract_number",
  "contract_title",
  "supplier",
  "customer",
  "counterparty",
  "effective_date",
  "expiration_date",
  "contract_value",
  "payment_terms",
  "governing_law",
];

const CONTRACT_SIDE_LABELS: Record<string, string> = {
  buy_side: "Buy-Side",
  sell_side: "Sell-Side",
  unknown: "Unknown",
};

interface ExtractionResultsWorkspaceProps {
  document: UploadedDocument;
  analysis: ContractAnalysisResult;
  pages: DocumentPage[];
  structuredOutput: StructuredContractOutput | null;
  universalResult: UniversalExtractionResult | null;
  extractingPages: boolean;
  pagesError: string;
  onRetryPages: () => void;
  relationshipBusy: boolean;
  onRelationshipAction: (action: RelationshipAction) => void;
  onRelationshipChange: (relationship: DetectedRelationship | null) => void;
}

export default function ExtractionResultsWorkspace({
  document,
  analysis,
  pages,
  structuredOutput,
  universalResult,
  extractingPages,
  pagesError,
  onRetryPages,
  relationshipBusy,
  onRelationshipAction,
  onRelationshipChange,
}: ExtractionResultsWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<ExtractionTab>("Overview");
  const [dataFilter, setDataFilter] = useState<FieldFilter>("all");
  const [showAllKeyFields, setShowAllKeyFields] = useState(false);
  const [clauses, setClauses] = useState<ClauseResult[]>([]);
  const [clausesLoading, setClausesLoading] = useState(false);
  const [clausesLoaded, setClausesLoaded] = useState(false);
  const [clauseFilter, setClauseFilter] = useState("All");
  const [expandedClause, setExpandedClause] = useState<number | null>(null);
  const [tables, setTables] = useState<NormalizedTable[]>([]);
  const [tablesLoading, setTablesLoading] = useState(false);
  const [tablesLoaded, setTablesLoaded] = useState(false);
  const [expandedTable, setExpandedTable] = useState<number | null>(null);

  const loadClauses = useCallback(async () => {
    if (clausesLoaded || clausesLoading) return;
    setClausesLoading(true);
    try {
      const existing = await getClauses(document.document_id).catch(() => null);
      if (existing?.clauses?.length) {
        setClauses(existing.clauses);
      } else {
        const extracted = await extractClauses(document.document_id);
        setClauses(extracted.clauses);
      }
    } catch {
      setClauses([]);
    } finally {
      setClausesLoading(false);
      setClausesLoaded(true);
    }
  }, [clausesLoaded, clausesLoading, document.document_id]);

  const loadTables = useCallback(async () => {
    if (tablesLoaded || tablesLoading) return;
    setTablesLoading(true);
    try {
      const extracted = await extractTables(document.document_id);
      setTables(extracted.tables ?? []);
    } catch {
      setTables([]);
    } finally {
      setTablesLoading(false);
      setTablesLoaded(true);
    }
  }, [document.document_id, tablesLoaded, tablesLoading]);

  useEffect(() => {
    void loadClauses();
    void loadTables();
  }, [loadClauses, loadTables]);

  // Also ensure load when opening those tabs if prefetch hasn't finished
  useEffect(() => {
    if (activeTab === "Clauses") void loadClauses();
    if (activeTab === "Tables") void loadTables();
  }, [activeTab, loadClauses, loadTables]);

  const reviewCounts = useMemo(() => {
    const counts = { accepted: 0, pending: 0, unknown: 0, rejected: 0 };
    for (const field of analysis.metadata_fields) {
      if (field.review_status === "accepted" || field.review_status === "edited")
        counts.accepted++;
      else if (field.review_status === "pending") counts.pending++;
      else if (field.review_status === "unknown") counts.unknown++;
      else if (field.review_status === "rejected") counts.rejected++;
    }
    return counts;
  }, [analysis.metadata_fields]);

  const confidenceCounts = useMemo(() => {
    let high = 0;
    let medium = 0;
    let low = 0;
    for (const field of analysis.metadata_fields) {
      if (field.confidence >= 0.95) high++;
      else if (field.confidence >= 0.8) medium++;
      else low++;
    }
    return { high, medium, low };
  }, [analysis.metadata_fields]);

  const avgConfidence = useMemo(() => {
    if (analysis.metadata_fields.length === 0) return null;
    const sum = analysis.metadata_fields.reduce((a, f) => a + f.confidence, 0);
    return Math.round((sum / analysis.metadata_fields.length) * 100);
  }, [analysis.metadata_fields]);

  const keyFields = useMemo(() => {
    const byKey = new Map(analysis.metadata_fields.map((f) => [f.field_key, f]));
    const ordered: MetadataField[] = [];
    for (const key of KEY_FIELD_KEYS) {
      const field = byKey.get(key);
      if (field) ordered.push(field);
    }
    if (showAllKeyFields) {
      for (const field of analysis.metadata_fields) {
        if (!ordered.some((f) => f.field_key === field.field_key)) {
          ordered.push(field);
        }
      }
    }
    return ordered;
  }, [analysis.metadata_fields, showAllKeyFields]);

  const filteredClauses = useMemo(() => {
    if (clauseFilter === "All") return clauses;
    return clauses.filter((c) =>
      c.clause_type.toUpperCase().includes(clauseFilter.toUpperCase()),
    );
  }, [clauses, clauseFilter]);

  function goToDataFilter(filter: FieldFilter) {
    setDataFilter(filter);
    setActiveTab("Extracted Data");
  }

  return (
    <div className="extraction-workspace -mx-[max(1.5rem,3vw)] mt-10 border-t border-border">
      <ExtractionDocumentHeader document={document} analysis={analysis} />
      <ExtractionTabBar
        active={activeTab}
        onChange={setActiveTab}
        showUniversal={Boolean(universalResult)}
      />

      <div className="extraction-workspace-inner py-8">
        {activeTab === "Overview" && (
          <OverviewTab
            analysis={analysis}
            reviewCounts={reviewCounts}
            confidenceCounts={confidenceCounts}
            avgConfidence={avgConfidence}
            keyFields={keyFields}
            showAllKeyFields={showAllKeyFields}
            onShowAllKeyFields={() => setShowAllKeyFields(true)}
            onGoToData={() => setActiveTab("Extracted Data")}
            onGoToRelationships={() => setActiveTab("Relationships")}
            onFilterData={goToDataFilter}
            metadataCount={analysis.metadata_fields.length}
            clauseCount={clausesLoaded ? clauses.length : undefined}
            tableCount={tablesLoaded ? tables.length : undefined}
            pageCount={pages.length}
          />
        )}

        {activeTab === "Extracted Data" && (
          <ExtractedDataPanel
            key={dataFilter}
            fields={analysis.metadata_fields}
            initialFilter={dataFilter}
          />
        )}

        {activeTab === "Clauses" && (
          <ClausesTab
            clauses={filteredClauses}
            loading={clausesLoading}
            filter={clauseFilter}
            onFilter={setClauseFilter}
            expanded={expandedClause}
            onExpand={setExpandedClause}
            onExtract={loadClauses}
            loaded={clausesLoaded}
          />
        )}

        {activeTab === "Tables" && (
          <TablesTab
            tables={tables}
            loading={tablesLoading}
            expanded={expandedTable}
            onExpand={setExpandedTable}
            onExtract={loadTables}
            loaded={tablesLoaded}
          />
        )}

        {activeTab === "Pages" && (
          <PaginatedPages
            pages={pages}
            extracting={extractingPages}
            error={pagesError}
            onRetry={onRetryPages}
            tablePageNumbers={
              tablesLoaded
                ? tables.map((table) => table.page_number)
                : undefined
            }
            clausePageNumbers={
              clausesLoaded
                ? clauses.map((clause) => clause.evidence.page_number)
                : undefined
            }
          />
        )}

        {activeTab === "Relationships" && (
          <RelationshipCard
            documentId={document.document_id}
            relationship={analysis.relationship}
            reviewerName="Data Agent"
            busy={relationshipBusy}
            onConfirm={() => onRelationshipAction("confirm")}
            onReject={() => onRelationshipAction("reject")}
            onRelationshipChange={onRelationshipChange}
          />
        )}

        {activeTab === "Universal" && universalResult && (
          <div className="space-y-6">
            <div className="editorial-card p-6">
              <h3 className="text-lg font-medium text-foreground">
                Universal Extraction
              </h3>
              <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <SummaryItem
                  label="Query"
                  value={universalResult.instruction || "—"}
                />
                <SummaryItem
                  label="Intent"
                  value={universalResult.intent || "—"}
                />
                <SummaryItem
                  label="Pages used"
                  value={
                    universalResult.pages_used?.length
                      ? universalResult.pages_used.slice(0, 12).join(", ") +
                        (universalResult.pages_used.length > 12 ? "…" : "")
                      : "—"
                  }
                />
              </dl>
            </div>
            <UniversalResults result={universalResult} />
          </div>
        )}

        {activeTab === "Structured Output" && (
          structuredOutput ? (
            <StructuredOutputPanel data={structuredOutput} />
          ) : (
            <EmptyTab message="Structured JSON output is not available for this document yet." />
          )
        )}

        {activeTab === "Activity" && (
          <div className="space-y-6">
            <IngestionChecklist steps={document.pipeline_log ?? []} />
            {analysis.warnings.length > 0 && (
              <div className="editorial-card p-6">
                <h3 className="text-sm font-medium text-foreground">Warnings</h3>
                <ul className="mt-3 space-y-2 text-sm text-text-secondary">
                  {analysis.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="editorial-card p-6">
              <h3 className="text-sm font-medium text-foreground">Next steps</h3>
              <p className="mt-2 text-sm text-text-secondary">
                Open the review workspace to validate fields, approve the document,
                and export results.
              </p>
              <Link
                href={`/documents/${document.document_id}/review`}
                className="btn-primary mt-4"
              >
                Open Review Workspace
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function OverviewTab({
  analysis,
  reviewCounts,
  confidenceCounts,
  avgConfidence,
  keyFields,
  showAllKeyFields,
  onShowAllKeyFields,
  onGoToData,
  onGoToRelationships,
  onFilterData,
  metadataCount,
  clauseCount,
  tableCount,
  pageCount,
}: {
  analysis: ContractAnalysisResult;
  reviewCounts: Record<string, number>;
  confidenceCounts: { high: number; medium: number; low: number };
  avgConfidence: number | null;
  keyFields: MetadataField[];
  showAllKeyFields: boolean;
  onShowAllKeyFields: () => void;
  onGoToData: () => void;
  onGoToRelationships: () => void;
  onFilterData: (f: FieldFilter) => void;
  metadataCount: number;
  clauseCount?: number;
  tableCount?: number;
  pageCount: number;
}) {
  const { classification, relationship } = analysis;
  const previewLimit = 8;
  const displayedKey = showAllKeyFields
    ? keyFields
    : keyFields.slice(0, previewLimit);
  const hiddenCount = Math.max(0, metadataCount - displayedKey.length);

  return (
    <div className="space-y-8">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="editorial-card p-6">
          <h3 className="text-sm font-medium text-foreground">
            Review Status
          </h3>
          <div className="mt-4 flex flex-wrap gap-4">
            <ReviewStat
              label="Accepted"
              count={reviewCounts.accepted}
              onClick={() => onFilterData("accepted")}
            />
            <ReviewStat
              label="Needs Review"
              count={reviewCounts.pending}
              onClick={() => onFilterData("needs_review")}
            />
            <ReviewStat
              label="Unknown"
              count={reviewCounts.unknown}
              onClick={() => onFilterData("unknown")}
            />
            <ReviewStat
              label="Rejected"
              count={reviewCounts.rejected}
              onClick={() => onFilterData("rejected")}
            />
          </div>
        </div>

        <div className="editorial-card p-6">
          <h3 className="text-sm font-medium text-foreground">Confidence</h3>
          <div className="mt-4 grid grid-cols-3 gap-4 text-center">
            <div>
              <p className="text-2xl font-medium tabular-nums">{confidenceCounts.high}</p>
              <p className="text-xs text-text-secondary">High</p>
            </div>
            <div>
              <p className="text-2xl font-medium tabular-nums">{confidenceCounts.medium}</p>
              <p className="text-xs text-text-secondary">Medium</p>
            </div>
            <div>
              <p className="text-2xl font-medium tabular-nums">{confidenceCounts.low}</p>
              <p className="text-xs text-text-secondary">Low</p>
            </div>
          </div>
        </div>
      </div>

      <div className="editorial-card p-6">
        <h3 className="text-sm font-medium text-foreground">
          Document Classification
        </h3>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <SummaryItem label="Document Type" value={classification.document_type} />
          <SummaryItem
            label="Contract Side"
            value={
              CONTRACT_SIDE_LABELS[classification.contract_side] ??
              classification.contract_side
            }
          />
          <SummaryItem
            label="Language"
            value={classification.language ?? "Unknown"}
          />
          <SummaryItem
            label="Confidence"
            value={`${Math.round(classification.confidence * 100)}%`}
          />
        </dl>
      </div>

      <div>
        <div className="flex flex-wrap items-end justify-between gap-2">
          <h3 className="text-sm font-medium text-foreground">
            Key Contract Details
          </h3>
          <p className="text-xs text-text-muted">
            {displayedKey.length} of {metadataCount} fields shown
          </p>
        </div>
        <div className="mt-3 overflow-hidden rounded-xl border border-border bg-surface">
          <div className="divide-y divide-border/60">
            {displayedKey.map((field) => (
              <div
                key={field.field_key}
                className="flex flex-wrap items-center gap-3 px-4 py-2.5 sm:flex-nowrap"
              >
                <span className="w-40 shrink-0 text-sm text-text-secondary">
                  {field.label}
                </span>
                <span className="min-w-0 flex-1 text-sm font-medium text-foreground">
                  {field.value}
                </span>
                <ConfidenceIndicator confidence={field.confidence} />
              </div>
            ))}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {!showAllKeyFields && hiddenCount > 0 && (
            <button
              type="button"
              onClick={onShowAllKeyFields}
              className="btn-tertiary"
            >
              Show all {metadataCount}
            </button>
          )}
          <button type="button" onClick={onGoToData} className="btn-secondary">
            View all extracted fields
          </button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="editorial-card p-6">
          <h3 className="text-sm font-medium text-foreground">
            Relationship Summary
          </h3>
          <p className="mt-2 text-sm text-text-secondary">
            {relationship
              ? `1 Parent · ${relationship.relationship_type.replace(/_/g, " ")}`
              : "No parent relationship detected"}
          </p>
          {relationship && (
            <p className="mt-1 text-sm font-medium text-foreground">
              {relationship.parent_document_title}
            </p>
          )}
          <button
            type="button"
            onClick={onGoToRelationships}
            className="btn-tertiary mt-3"
          >
            View relationships
          </button>
        </div>

        <div className="editorial-card p-6">
          <h3 className="text-sm font-medium text-foreground">
            Extraction Summary
          </h3>
          <dl className="mt-3 space-y-2 text-sm">
            <SummaryRow label="Metadata fields" value={String(metadataCount)} />
            <SummaryRow
              label="Clauses"
              value={
                clauseCount !== undefined ? String(clauseCount) : "Loading…"
              }
            />
            <SummaryRow
              label="Tables"
              value={tableCount !== undefined ? String(tableCount) : "Loading…"}
            />
            <SummaryRow label="Pages" value={String(pageCount)} />
            {avgConfidence !== null && (
              <SummaryRow
                label="Avg. confidence"
                value={`${avgConfidence}%`}
              />
            )}
          </dl>
        </div>
      </div>
    </div>
  );
}

function ClausesTab({
  clauses,
  loading,
  filter,
  onFilter,
  expanded,
  onExpand,
  onExtract,
  loaded,
}: {
  clauses: ClauseResult[];
  loading: boolean;
  filter: string;
  onFilter: (f: string) => void;
  expanded: number | null;
  onExpand: (i: number | null) => void;
  onExtract: () => void;
  loaded: boolean;
}) {
  const filters = ["All", "FAR", "DFARS", "Commercial"];

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-text-secondary">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading clauses...
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="editorial-card p-8 text-center">
        <p className="text-sm text-text-secondary">Clause data has not been loaded.</p>
        <button type="button" onClick={onExtract} className="btn-primary mt-4">
          Load Clauses
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-medium text-foreground">Clauses</h3>
          <p className="text-sm text-text-secondary">{clauses.length} detected</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {filters.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => onFilter(f)}
              className={filter === f ? "chip chip-active" : "chip"}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {clauses.length === 0 ? (
        <p className="py-8 text-center text-sm text-text-secondary">
          No clauses extracted yet.
        </p>
      ) : (
        <div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-surface">
          {clauses.map((clause, index) => {
            const open = expanded === index;
            return (
              <div key={`${clause.clause_type}-${index}`}>
                <button
                  type="button"
                  onClick={() => onExpand(open ? null : index)}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-soft/80"
                >
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-foreground">
                      {clause.clause_type}
                    </span>
                    <span className="mt-0.5 block text-sm text-text-secondary line-clamp-1">
                      {clause.value_summary || clause.extracted_text.slice(0, 120)}
                    </span>
                  </span>
                  <ConfidenceIndicator confidence={clause.confidence} />
                  {open ? (
                    <ChevronDown className="h-4 w-4 shrink-0" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0" />
                  )}
                </button>
                {open && (
                  <div className="border-t border-border/60 bg-surface-soft/40 px-4 py-3 text-sm leading-6 text-text-secondary">
                    <p className="whitespace-pre-wrap">{clause.extracted_text}</p>
                    <p className="mt-2 text-xs text-text-muted">
                      Page {clause.evidence.page_number}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TablesTab({
  tables,
  loading,
  expanded,
  onExpand,
  onExtract,
  loaded,
}: {
  tables: NormalizedTable[];
  loading: boolean;
  expanded: number | null;
  onExpand: (i: number | null) => void;
  onExtract: () => void;
  loaded: boolean;
}) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-12 text-sm text-text-secondary">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading tables...
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="editorial-card p-8 text-center">
        <p className="text-sm text-text-secondary">Table data has not been loaded.</p>
        <button type="button" onClick={onExtract} className="btn-primary mt-4">
          Extract Tables
        </button>
      </div>
    );
  }

  if (tables.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-text-secondary">
        No tables extracted for this document.
      </p>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {tables.map((table, index) => {
        const open = expanded === index;
        return (
          <div key={index} className="editorial-card overflow-hidden">
            <button
              type="button"
              onClick={() => onExpand(open ? null : index)}
              className="flex w-full items-center justify-between p-5 text-left"
            >
              <div>
                <p className="font-medium text-foreground">Table {index + 1}</p>
                <p className="text-sm text-text-secondary">
                  Page {table.page_number} · {table.rows.length} rows
                </p>
              </div>
              {open ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </button>
            {open && (
              <div className="max-h-64 overflow-auto border-t border-border px-4 py-3">
                <table className="min-w-full text-xs">
                  <thead>
                    <tr>
                      {table.headers.map((h) => (
                        <th key={h} className="px-2 py-1 text-left font-medium">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.slice(0, 20).map((row, ri) => (
                      <tr key={ri}>
                        {table.headers.map((h) => (
                          <td key={h} className="px-2 py-1 text-text-secondary">
                            {String(row[h] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EmptyTab({ message }: { message: string }) {
  return (
    <p className="py-12 text-center text-sm text-text-secondary">{message}</p>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-text-secondary">{label}</dt>
      <dd className="font-medium text-foreground">{value}</dd>
    </div>
  );
}

function ReviewStat({
  label,
  count,
  onClick,
}: {
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-lg px-3 py-2 text-left transition hover:bg-surface-soft"
    >
      <p className="text-xl font-medium tabular-nums">{count}</p>
      <p className="text-xs text-text-secondary">{label}</p>
    </button>
  );
}
