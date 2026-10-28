"use client";

import { ChevronDown, Download } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildFieldRows,
  classifyRowKind,
  type FieldRow,
  type FieldRowStatus,
} from "@/components/extraction/field-row";
import ExtractionSummaryBar from "@/components/extraction/extraction-summary-bar";
import FieldsWorkbookGrid from "@/components/extraction/fields-workbook-grid";
import ResultSummaryBar from "@/components/extraction/result-summary-bar";
import SourceVerificationDrawer from "@/components/extraction/source-verification-drawer";
import TableResult from "@/components/extraction/table-result";
import ValidationIssuesPanel from "@/components/extraction/validation-issues-panel";
import type { SourceViewRequest } from "@/components/source-verification-panel";
import StagingWorkbook from "@/components/staging/staging-workbook";
import {
  isBusinessFieldRow,
  isKeyContractRow,
  isLineItemTable,
  isNarrativeOrSectionRow,
  needsReviewRow,
  type WorkbookTab,
} from "@/components/extraction/workbook-classify";
import {
  downloadReviewedJson,
  scalarToExportField,
} from "@/lib/reviewed-export";
import { downloadBlob } from "@/lib/export";
import {
  listTargetCorrections,
  markTargetVerified,
  rejectTargetValue,
  saveTargetCorrection,
} from "@/lib/target-corrections";
import type {
  DocumentTarget,
  AIEnrichmentSummary,
  ExtractTargetsResult,
  TableTargetResult,
  TargetCorrection,
  TargetType,
  UniversalTable,
} from "@/types/document";
import { useReviewMutationsEnabled } from "@/lib/review-gate";

/** Shown only when optional AI enrichment was unavailable: the document
 * still processed deterministically, so this is a quiet note, not an error. */
export function AIEnrichmentNotice({ summary }: { summary: AIEnrichmentSummary | null }) {
  if (!summary?.notice) return null;
  return (
    <div role="status" className="rounded-xl border border-border bg-surface-soft px-4 py-3 text-sm">
      <p className="font-medium text-foreground">{summary.notice.title}</p>
      {summary.notice.detail && (
        <p className="mt-0.5 text-xs text-text-secondary">{summary.notice.detail}</p>
      )}
    </div>
  );
}

/** Processing Details: the technical record behind the results — AI
 * provider/model/error detail and the legacy extraction warnings. */
function ProcessingDiagnostics({
  summary,
  warnings,
}: {
  summary: AIEnrichmentSummary | null;
  warnings: string[];
}) {
  if (!summary && warnings.length === 0) return null;
  return (
    <div className="space-y-2 rounded-xl border border-border bg-surface-soft p-4 text-xs text-text-secondary">
      {summary && (
        <div>
          <p className="font-semibold text-foreground">AI enrichment</p>
          <p>
            Deterministic extraction: {summary.deterministic_status} · AI enrichment:{" "}
            {summary.ai_enrichment_status.replace("_", " ")}
            {summary.provider ? ` · provider ${summary.provider}` : ""}
            {summary.model ? ` (${summary.model})` : ""}
            {` · ${summary.calls_attempted} call(s)`}
          </p>
          {summary.reason && <p>{summary.reason}</p>}
          {summary.error_kind && <p>Error kind: {summary.error_kind}</p>}
          {summary.error_detail && (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px]">
              {summary.error_detail}
            </pre>
          )}
        </div>
      )}
      {warnings.length > 0 && (
        <div>
          <p className="font-semibold text-foreground">Extraction warnings</p>
          {warnings.map((warning, index) => (
            <p key={index}>{warning}</p>
          ))}
        </div>
      )}
    </div>
  );
}

interface TargetResultsProps {
  result: ExtractTargetsResult;
  /** Schema targets used to classify scalar results (contacts vs fields). */
  targets?: DocumentTarget[];
  documentId?: string;
  documentName?: string;
  pageCount?: number;
  status?: "complete" | "processing" | "failed" | "partial";
  processingDurationMs?: number | null;
  selectedResultId?: string | null;
  onViewSource?: (request: SourceViewRequest) => void;
}

function tableToUniversalTable(
  table: TableTargetResult,
  index: number,
): UniversalTable {
  return {
    table_id: `${table.target}-${index}`,
    title: table.target,
    headers: table.columns,
    rows: table.rows,
    page_number: table.pages[0] ?? 0,
    confidence: 1,
    source_reference: table.pages.length
      ? `pages ${table.pages.join(", ")}`
      : "",
  };
}

function isClauseLike(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.includes("clause") ||
    lower.includes("far") ||
    lower.includes("dfars") ||
    lower.includes("section") ||
    lower.includes("article")
  );
}

function dedupeClauseTables(tables: TableTargetResult[]): TableTargetResult[] {
  const seen = new Map<string, TableTargetResult>();

  for (const table of tables) {
    const fingerprint = [
      table.target.toLowerCase(),
      table.columns.join("|"),
      JSON.stringify(table.rows.slice(0, 3)),
    ].join("::");

    const existing = seen.get(fingerprint);
    if (!existing) {
      seen.set(fingerprint, table);
      continue;
    }

    const pages = Array.from(
      new Set([...existing.pages, ...table.pages]),
    ).sort((a, b) => a - b);
    seen.set(fingerprint, { ...existing, pages });
  }

  return Array.from(seen.values());
}

const STATUS_LABEL: Record<NonNullable<TargetResultsProps["status"]>, string> = {
  complete: "Extraction complete",
  processing: "Extraction in progress",
  failed: "Extraction failed",
  partial: "Partial results",
};

const STATUS_TONE: Record<NonNullable<TargetResultsProps["status"]>, string> = {
  complete: "bg-success/10 text-success",
  processing: "bg-primary/10 text-primary",
  failed: "bg-danger/10 text-danger",
  partial: "bg-warning/10 text-warning",
};

function formatDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

const METHOD_FILTER_OPTIONS = [
  { value: "all", label: "All methods" },
  { value: "native", label: "Native" },
  { value: "ai", label: "AI Fallback" },
];

const VALIDATION_FILTER_OPTIONS: { value: "all" | FieldRowStatus; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "extracted", label: "Extracted" },
  { value: "not_found", label: "Not found" },
  { value: "empty", label: "Empty" },
  { value: "low_confidence", label: "Needs review" },
  { value: "validation_failed", label: "Unverified" },
];

function matchesMethodFilter(row: FieldRow, filter: string): boolean {
  if (filter === "all") return true;
  if (filter === "ai") return row.extraction_method === "ai";
  return row.extraction_method !== "ai";
}

function isInternalFormName(name: string): boolean {
  if (!name.trim()) return true;
  const stripped = name.trim();
  if (stripped.startsWith("#")) return true;
  if (
    /^(TextField|CheckBox|RadioButton|SignatureField|NumericField|DateTimeField|DropDownList)\d*$/i.test(
      stripped,
    ) ||
    /^(Page\d+|PG\d+[A-Z]*)$/i.test(stripped)
  ) {
    return true;
  }

  let signals = 0;
  if (/topmostSubform|\bsubform\b|\bxfa\b|\bform\d+\b/i.test(stripped)) {
    signals += 2;
  }
  if (/\bPage\d+\b|\bPG\d+[A-Z]*\b/i.test(stripped)) {
    signals += 1;
  }
  if (/\[\d+\]/.test(stripped)) {
    signals += 1;
  }
  if (
    /TextField\d*|CheckBox\d*|RadioButton\d*|SignatureField\d*|NumericField\d*|DateTimeField\d*|DropDownList\d*/i.test(
      stripped,
    )
  ) {
    signals += 1;
  }
  return signals >= 2;
}

function isInternalKey(key: string, label: string): boolean {
  return isInternalFormName(key) || isInternalFormName(label);
}

export default function TargetResults({
  result,
  targets = [],
  documentId,
  documentName,
  pageCount = 1,
  status = "complete",
  processingDurationMs,
  selectedResultId = null,
  onViewSource,
}: TargetResultsProps) {
  const reviewEnabled = useReviewMutationsEnabled();
  const [searchQuery, setSearchQuery] = useState("");
  const [confidenceFilter, setConfidenceFilter] = useState<
    "all" | "high" | "medium" | "low"
  >("all");
  const [methodFilter, setMethodFilter] = useState("all");
  const [validationFilter, setValidationFilter] = useState<"all" | FieldRowStatus>(
    "all",
  );
  const [onlyWithValues, setOnlyWithValues] = useState(false);
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [workbookTab, setWorkbookTab] = useState<WorkbookTab>("all");
  const [showLegacyAudit, setShowLegacyAudit] = useState(false);
  // Diagnostics are reviewer/developer views, opened from the workbook's
  // "More" menu rather than shown in the document navigation.
  const diagnosticsRef = useRef<HTMLDivElement>(null);
  const extractionDetailsRef = useRef<HTMLDivElement>(null);
  function openDiagnostics(target: React.RefObject<HTMLDivElement | null>) {
    setShowLegacyAudit(true);
    requestAnimationFrame(() => target.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);
  const [corrections, setCorrections] = useState<Map<string, TargetCorrection>>(
    new Map(),
  );
  const [sourceOpen, setSourceOpen] = useState(false);
  const [sourceRequest, setSourceRequest] = useState<SourceViewRequest | null>(
    null,
  );
  const [activeRow, setActiveRow] = useState<FieldRow | null>(null);

  useEffect(() => {
    if (!exportMenuOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (!exportMenuRef.current?.contains(event.target as Node)) {
        setExportMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [exportMenuOpen]);

  useEffect(() => {
    if (!documentId) return;
    let cancelled = false;
    listTargetCorrections(documentId)
      .then((list) => {
        if (cancelled) return;
        setCorrections(new Map(list.map((c) => [c.normalized_key, c])));
      })
      .catch(() => {
        // Corrections are a review-quality-of-life feature — if they
        // fail to load, the raw extracted values still render fine.
      });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  const typeByLabel = new Map<string, TargetType>();
  const labelByKey = new Map<string, string>();
  for (const target of targets) {
    typeByLabel.set(target.label.toLowerCase(), target.target_type);
    typeByLabel.set(target.key.toLowerCase(), target.target_type);
    labelByKey.set(target.key, target.label);
  }

  const { meaningfulMissing, internalMissingCount } = useMemo(() => {
    const meaningful: { key: string; label: string }[] = [];
    let internalCount = 0;
    for (const key of result.unresolved_targets) {
      const label = labelByKey.get(key) ?? key;
      if (isInternalKey(key, label)) {
        internalCount += 1;
      } else {
        meaningful.push({ key, label });
      }
    }
    return { meaningfulMissing: meaningful, internalMissingCount: internalCount };
    // labelByKey is rebuilt from `targets` every render but is
    // value-equivalent when `targets` hasn't changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result.unresolved_targets, targets]);

  const allRows = useMemo(
    () => buildFieldRows(result.scalars, meaningfulMissing, corrections, labelByKey),
    // labelByKey is rebuilt from `targets` every render but is
    // value-equivalent when `targets` hasn't changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result.scalars, meaningfulMissing, corrections, targets],
  );

  const confidenceCounts = useMemo(() => {
    const counts = { high: 0, medium: 0, low: 0 };
    for (const scalar of result.scalars) {
      counts[scalar.confidence_band] += 1;
    }
    return counts;
  }, [result.scalars]);

  const issueCount = useMemo(
    () => allRows.filter((row) => row.status !== "extracted").length,
    [allRows],
  );
  void issueCount;

  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return allRows.filter((row) => {
      if (
        confidenceFilter !== "all" &&
        row.confidence_band !== confidenceFilter
      ) {
        return false;
      }
      if (!matchesMethodFilter(row, methodFilter)) return false;
      if (validationFilter !== "all" && row.status !== validationFilter) {
        return false;
      }
      if (onlyWithValues && (row.status === "empty" || row.status === "not_found")) {
        return false;
      }
      if (onlyMissing && row.status !== "not_found") return false;
      if (!query) return true;
      const value = String(row.value ?? "").toLowerCase();
      return row.label.toLowerCase().includes(query) || value.includes(query);
    });
  }, [
    allRows,
    searchQuery,
    confidenceFilter,
    methodFilter,
    validationFilter,
    onlyWithValues,
    onlyMissing,
  ]);

  const contactRows: FieldRow[] = [];
  const identifierRows: FieldRow[] = [];
  const fieldRows: FieldRow[] = [];

  for (const row of filteredRows) {
    const kind = classifyRowKind(row, typeByLabel);
    if (kind === "contact") contactRows.push(row);
    else if (kind === "identifier") identifierRows.push(row);
    else fieldRows.push(row);
  }
  void contactRows;
  void identifierRows;
  void fieldRows;

  const dataTables = result.tables.filter(
    (table) => !isClauseLike(table.target),
  );
  const clauseTables = dedupeClauseTables(
    result.tables.filter((table) => isClauseLike(table.target)),
  );
  const lineItemTables = dataTables.filter(isLineItemTable);
  const genuineTables = dataTables.filter((table) => !isLineItemTable(table));

  const businessRows = filteredRows.filter(isBusinessFieldRow);
  const workbookRows: Record<WorkbookTab, FieldRow[]> = {
    all: businessRows,
    key: businessRows.filter(isKeyContractRow),
    sections: filteredRows.filter(isNarrativeOrSectionRow),
    line_items: [],
    tables: [],
    needs_review: businessRows.filter(needsReviewRow),
  };

  const typeLabelMap = new Map<string, string>();
  for (const [key, value] of typeByLabel) {
    typeLabelMap.set(key, value);
  }

  function handleOpenSource(request: SourceViewRequest, row?: FieldRow) {
    setSourceRequest(request);
    setActiveRow(row ?? allRows.find((item) => item.id === request.id) ?? null);
    setSourceOpen(true);
    onViewSource?.(request);
  }

  async function handleSaveCorrection(row: FieldRow, correctedValue: string) {
    if (!documentId) return;
    const originalValue = row.correction
      ? row.correction.original_value
      : row.value;
    const saved = await saveTargetCorrection(documentId, row.id, {
      originalValue,
      correctedValue,
      evidence: row.evidence
        ? {
            page_number: row.evidence.page_number,
            source_text: row.evidence.source_text,
            source_reference: row.evidence.source_reference,
          }
        : null,
    });
    setCorrections((prev) => {
      const next = new Map(prev);
      next.set(row.id, saved);
      return next;
    });
  }

  async function handleMarkVerified(row: FieldRow) {
    if (!documentId) return;
    const originalValue = row.correction ? row.correction.original_value : row.value;
    const saved = await markTargetVerified(
      documentId,
      row.id,
      originalValue,
      row.evidence
        ? {
            page_number: row.evidence.page_number,
            source_text: row.evidence.source_text,
            source_reference: row.evidence.source_reference,
          }
        : null,
    );
    setCorrections((prev) => {
      const next = new Map(prev);
      next.set(row.id, saved);
      return next;
    });
  }

  async function handleReject(row: FieldRow) {
    if (!documentId) return;
    const originalValue = row.correction ? row.correction.original_value : row.value;
    const saved = await rejectTargetValue(
      documentId,
      row.id,
      originalValue,
      row.evidence
        ? {
            page_number: row.evidence.page_number,
            source_text: row.evidence.source_text,
            source_reference: row.evidence.source_reference,
          }
        : null,
    );
    setCorrections((prev) => {
      const next = new Map(prev);
      next.set(row.id, saved);
      return next;
    });
  }

  function handleIssueClick(rowId: string) {
    setSearchQuery("");
    setConfidenceFilter("all");
    setMethodFilter("all");
    setValidationFilter("all");
    setOnlyWithValues(false);
    setOnlyMissing(false);

    requestAnimationFrame(() => {
      const element = document.getElementById(`field-row-${rowId}`);
      if (!element) return;
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      element.classList.add("bg-primary/10");
      setTimeout(() => element.classList.remove("bg-primary/10"), 2000);
    });
  }

  function exportFieldsJson() {
    const fields = workbookRows.all
      .filter((row) => row.scalar)
      .map((row) => scalarToExportField(row.scalar!, row.correction, row.label));
    downloadReviewedJson(`${result.document_id}-fields.json`, fields);
  }

  function exportFieldsCsv() {
    const fields = workbookRows.all
      .filter((row) => row.scalar)
      .map((row) => scalarToExportField(row.scalar!, row.correction, row.label));
    // Wide business CSV: human field names as headers, one data row —
    // never the raw internal field_key (e.g. "kv_pricing_arrangement").
    const headers = fields.map((field) => field.field || field.field_key || "");
    const values = fields.map((field) => field.value ?? "");
    const escape = (cell: string) => {
      if (/[",\n]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
      return cell;
    };
    const csv = `${headers.map(escape).join(",")}\n${values.map((v) => escape(String(v))).join(",")}\n`;
    downloadBlob(
      csv,
      `${result.document_id}-fields.csv`,
      "text/csv;charset=utf-8;",
    );
  }

  function exportAuditCsv() {
    const rows = workbookRows.all;
    const headers = [
      "PDF Page",
      "Section",
      "Field / Label",
      "Extracted Value",
      "Field Type",
      "Confidence",
      "Status",
    ];
    const escape = (cell: string) => {
      if (/[",\n]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
      return cell;
    };
    const lines = [headers.map(escape).join(",")];
    for (const row of rows) {
      const page = row.evidence?.page_number ?? row.scalar?.page ?? "";
      lines.push(
        [
          String(page),
          row.evidence?.section || "",
          row.label,
          String(row.value ?? ""),
          row.scalar?.display_method || "field",
          row.confidence != null ? `${Math.round(row.confidence * 100)}%` : "",
          row.status,
        ]
          .map((cell) => escape(String(cell)))
          .join(","),
      );
    }
    downloadBlob(
      `${lines.join("\n")}\n`,
      `${result.document_id}-audit.csv`,
      "text/csv;charset=utf-8;",
    );
  }

  const WORKBOOK_TABS: { id: WorkbookTab; label: string; count?: number }[] = [
    { id: "all", label: "All Fields", count: workbookRows.all.length },
    { id: "key", label: "Key Contract Fields", count: workbookRows.key.length },
    { id: "sections", label: "Sections", count: workbookRows.sections.length },
    {
      id: "line_items",
      label: "Line Items",
      count: lineItemTables.length,
    },
    { id: "tables", label: "Tables", count: genuineTables.length },
    {
      id: "needs_review",
      label: "Needs Review",
      count: workbookRows.needs_review.length,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold text-foreground">
            {documentName ?? "Document"}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${STATUS_TONE[status]}`}
          >
            {STATUS_LABEL[status]}
          </span>
          {processingDurationMs != null && (
            <span className="text-xs text-text-secondary">
              in {formatDuration(processingDurationMs)}
            </span>
          )}
        </div>
      </div>

      <AIEnrichmentNotice summary={result.ai_enrichment ?? null} />

      {documentId && (
        <StagingWorkbook
          documentId={documentId}
          documentName={documentName}
          onOpenSource={(request) => handleOpenSource(request)}
          selectedSourceId={sourceRequest?.id ?? null}
          refreshKey={`${result.scalars.length}-${result.tables.length}-${result.warnings.length}`}
          moreActions={[
            { label: "Extraction details", onSelect: () => openDiagnostics(extractionDetailsRef) },
            { label: "Processing diagnostics", onSelect: () => openDiagnostics(diagnosticsRef) },
          ]}
        />
      )}

      {showLegacyAudit && (
      <div ref={diagnosticsRef} className="space-y-4 rounded-xl border border-dashed border-border bg-surface-soft/60 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] uppercase tracking-[0.12em] text-text-muted">Opened from More</p>
        <button
          type="button"
          onClick={() => setShowLegacyAudit(false)}
          className="text-[11px] text-text-muted underline decoration-dotted underline-offset-4 hover:text-text-secondary"
        >
          Hide
        </button>
      </div>
      <p className="text-[11px] uppercase tracking-[0.12em] text-text-muted">
        Development &amp; admin diagnostics — not part of the document results
      </p>
      <ProcessingDiagnostics summary={result.ai_enrichment ?? null} warnings={result.warnings} />
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-teal">
          Extraction Results (legacy)
        </p>
        <p className="mt-1 text-lg font-medium text-foreground">
          Structured data workbook
        </p>
        <p className="mt-1 max-w-2xl text-sm text-text-secondary">
          Full-width spreadsheet of accepted fields, superseded by the
          Professional Staging Workbook above. Kept for debugging/compatibility.
          Click any row to open source verification on demand.
        </p>
      </div>

      <div ref={extractionDetailsRef} className="mt-4">
        <ExtractionSummaryBar result={result} />
      </div>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <ResultSummaryBar
          documentName={documentName ?? "Document"}
          status={status}
          fieldsExtracted={workbookRows.all.length}
          tablesExtracted={genuineTables.length + lineItemTables.length}
          highConfidence={confidenceCounts.high}
          mediumConfidence={confidenceCounts.medium}
          lowConfidence={confidenceCounts.low}
          validationWarnings={workbookRows.needs_review.length}
          processingDurationMs={processingDurationMs}
        />
        <div className="relative" ref={exportMenuRef}>
          <button
            type="button"
            onClick={() => setExportMenuOpen((open) => !open)}
            className="btn-secondary text-sm"
          >
            <Download className="h-4 w-4" />
            Legacy Export
            <ChevronDown className="h-4 w-4" />
          </button>
          {exportMenuOpen && (
            <div className="absolute right-0 top-full z-10 mt-1 w-56 rounded-lg border border-border bg-surface p-1 shadow-lg">
              {/* Excel/Document Fields CSV/Line Items CSV route through
                  authenticated backend endpoints (export.read) and 401 in
                  any browser session without a valid credential. Audit CSV
                  and JSON are built entirely from data already loaded in
                  this page, so they always work. Re-add the backend-backed
                  options once export auth is actually provisioned. */}
              <button
                type="button"
                onClick={() => {
                  exportAuditCsv();
                  setExportMenuOpen(false);
                }}
                className="block w-full rounded-md px-3 py-2 text-left text-xs text-foreground hover:bg-surface-soft"
              >
                Download Legacy Extraction Audit (CSV)
              </button>
              <button
                type="button"
                onClick={() => {
                  exportFieldsJson();
                  setExportMenuOpen(false);
                }}
                className="block w-full rounded-md px-3 py-2 text-left text-xs text-foreground hover:bg-surface-soft"
              >
                Download JSON
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-border pb-px">
        {WORKBOOK_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => setWorkbookTab(tab.id)}
            className={[
              "whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition",
              workbookTab === tab.id
                ? "border-success text-foreground"
                : "border-transparent text-text-secondary hover:text-foreground",
            ].join(" ")}
          >
            {tab.label}
            {typeof tab.count === "number" && (
              <span className="ml-1.5 text-xs text-text-muted">({tab.count})</span>
            )}
          </button>
        ))}
      </div>

      {(workbookTab === "all" ||
        workbookTab === "key" ||
        workbookTab === "sections" ||
        workbookTab === "needs_review") && (
        <div className="space-y-2.5 rounded-xl border border-border bg-surface-soft p-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search fields or values..."
              className="w-full min-w-0 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-foreground outline-none placeholder:text-text-muted sm:w-auto sm:flex-1"
            />
            <select
              value={confidenceFilter}
              onChange={(event) =>
                setConfidenceFilter(
                  event.target.value as "all" | "high" | "medium" | "low",
                )
              }
              className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground outline-none"
            >
              <option value="all">All confidence</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            <select
              value={methodFilter}
              onChange={(event) => setMethodFilter(event.target.value)}
              className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground outline-none"
            >
              {METHOD_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <select
              value={validationFilter}
              onChange={(event) =>
                setValidationFilter(event.target.value as "all" | FieldRowStatus)
              }
              className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-foreground outline-none"
            >
              {VALIDATION_FILTER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-4 px-1">
            <label className="flex items-center gap-1.5 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={onlyWithValues}
                onChange={(event) => {
                  setOnlyWithValues(event.target.checked);
                  if (event.target.checked) setOnlyMissing(false);
                }}
              />
              Only fields with values
            </label>
            <label className="flex items-center gap-1.5 text-xs text-text-secondary">
              <input
                type="checkbox"
                checked={onlyMissing}
                onChange={(event) => {
                  setOnlyMissing(event.target.checked);
                  if (event.target.checked) setOnlyWithValues(false);
                }}
              />
              Only missing fields
            </label>
          </div>
        </div>
      )}

      {internalMissingCount > 0 && workbookTab === "all" && (
        <p className="text-xs text-text-muted">
          {internalMissingCount} internal form field
          {internalMissingCount === 1 ? " was" : "s were"} skipped.
        </p>
      )}

      {(workbookTab === "all" ||
        workbookTab === "key" ||
        workbookTab === "sections" ||
        workbookTab === "needs_review") && (
        <FieldsWorkbookGrid
          rows={workbookRows[workbookTab]}
          typeByLabel={typeLabelMap}
          selectedId={selectedResultId ?? sourceRequest?.id ?? null}
          onViewSource={(request) => {
            const row = allRows.find((item) => item.id === request.id) ?? null;
            handleOpenSource(request, row ?? undefined);
          }}
          onSelectRow={(row) => setActiveRow(row)}
        />
      )}

      {workbookTab === "line_items" && (
        <div className="space-y-4">
          {lineItemTables.length === 0 ? (
            <p className="rounded-xl border border-border bg-surface px-4 py-8 text-center text-sm text-text-secondary">
              No CLIN / line-item tables detected.
            </p>
          ) : (
            lineItemTables.map((table, index) => (
              <TableResult
                key={tableToUniversalTable(table, index).table_id}
                table={tableToUniversalTable(table, index)}
                onViewSource={
                  onViewSource
                    ? (req) =>
                        handleOpenSource({
                          ...req,
                          id: tableToUniversalTable(table, index).table_id,
                          value: table.target,
                          verified: true,
                        })
                    : undefined
                }
              />
            ))
          )}
        </div>
      )}

      {workbookTab === "tables" && (
        <div className="space-y-4">
          {genuineTables.length === 0 ? (
            <p className="rounded-xl border border-border bg-surface px-4 py-8 text-center text-sm text-text-secondary">
              No accepted structured tables.
            </p>
          ) : (
            genuineTables.map((table, index) => (
              <TableResult
                key={tableToUniversalTable(table, index).table_id}
                table={tableToUniversalTable(table, index)}
                onViewSource={
                  onViewSource
                    ? (req) =>
                        handleOpenSource({
                          ...req,
                          id: tableToUniversalTable(table, index).table_id,
                          value: table.target,
                          verified: true,
                        })
                    : undefined
                }
              />
            ))
          )}
          {clauseTables.length > 0 && (
            <p className="text-xs text-text-muted">
              Narrative clauses are listed under Sections, not Tables.
            </p>
          )}
        </div>
      )}

      {workbookTab === "needs_review" && (
        <div id="validation-section">
          <ValidationIssuesPanel
            rows={workbookRows.needs_review}
            onIssueClick={handleIssueClick}
          />
        </div>
      )}
      </div>
      )}


      {documentId && (
        <SourceVerificationDrawer
          open={sourceOpen}
          onClose={() => setSourceOpen(false)}
          documentId={documentId}
          documentName={documentName ?? "Document"}
          pageCount={pageCount}
          request={sourceRequest}
          activeRow={activeRow}
          onSaveCorrection={reviewEnabled ? handleSaveCorrection : undefined}
          onMarkVerified={reviewEnabled ? handleMarkVerified : undefined}
          onReject={reviewEnabled ? handleReject : undefined}
        />
      )}
    </div>
  );
}
