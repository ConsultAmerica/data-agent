"use client";

import type { SourceViewRequest } from "@/components/source-verification-panel";
import type { ReviewStatus, StagingCell } from "@/lib/staging-workbook";

const TONE: Record<ReviewStatus, string> = {
  Verified: "text-success",
  "Needs Review": "text-warning",
  Missing: "text-text-muted",
};

const MARK: Record<ReviewStatus, string> = {
  Verified: "✓",
  "Needs Review": "!",
  Missing: "—",
};

export function ReviewStatusBadge({ status }: { status: ReviewStatus | null }) {
  if (!status) return null;
  const label =
    status === "Verified"
      ? "Staging Verified"
      : status === "Needs Review"
        ? "Staging Needs Review"
        : status;
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium ${TONE[status]}`}
      title="Staging QA status — not metadata Accept/Edit/Reject"
    >
      <span aria-hidden="true">{MARK[status]}</span>
      {label}
    </span>
  );
}

export function formatCellValue(cell: StagingCell): string {
  const { value } = cell;
  if (value == null) return "";
  if (typeof value === "number" && cell.value_type === "money") {
    return value.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }
  return String(value);
}

/** A cell can open source verification when its provenance points at a
 * page of the document, or at a structural HTML region. System facts
 * can't. */
export function canOpenSource(cell: StagingCell): boolean {
  const provenance = cell.provenance;
  if (cell.value == null || !provenance) return false;
  if (provenance.source_type === "html") {
    return Boolean(provenance.source_region_id || provenance.source_locator);
  }
  return typeof provenance.source_page === "number" && provenance.source_page > 0;
}

/** Where a value sits: its page, or for HTML a short structural address
 * (no page numbers are invented for HTML). */
export function locationLabel(cell: StagingCell): string {
  const provenance = cell.provenance;
  if (!provenance) return "—";
  if (provenance.source_page) return String(provenance.source_page);
  const locator = provenance.source_locator;
  // XML: the element path inside the root ("Clause[3]/Title").
  if (provenance.source_type === "xml" && locator?.dom_path) {
    return locator.dom_path.split("/").slice(2).join("/") || locator.dom_path;
  }
  if (provenance.source_type === "html" && locator) {
    if (locator.table_index != null) {
      const row =
        locator.row_index != null && locator.row_index >= 0 ? ` · row ${locator.row_index + 1}` : "";
      return `Table ${locator.table_index + 1}${row}`;
    }
    return locator.section_path[locator.section_path.length - 1] ?? "HTML";
  }
  return "—";
}

/** Builds the source-verification request from ONE cell's provenance, so
 * the viewer highlights that cell rather than its whole record. */
export function cellSourceRequest(
  cell: StagingCell,
  requestId: string,
): SourceViewRequest | null {
  const provenance = cell.provenance;
  if (!provenance || !canOpenSource(cell)) return null;
  return {
    id: requestId,
    pageNumber: provenance.source_page ?? 1,
    sourceType: provenance.source_type,
    regionId: provenance.source_region_id,
    locator: provenance.source_locator,
    highlightText: provenance.highlight_text,
    anchorText: provenance.anchor_text,
    region: provenance.source_bbox,
    label: cell.display_label,
    value: formatCellValue(cell),
    evidenceText: provenance.evidence_text,
    extractionMethod: provenance.extraction_method,
    reviewStatus: cell.review_status,
    reviewReasons: cell.review_reasons,
    verified: cell.review_status === "Verified",
  };
}
