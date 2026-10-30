import { apiFetch } from "@/lib/api";

/** Mirrors backend app/source_structure/original_layout.py. */

export interface LayoutFlag {
  code: string;
  message: string;
  /** Table cells: the column the flag is about. */
  column?: number;
}

export interface LayoutMetadata {
  id: number;
  field_key: string;
  label: string;
  /** The value in effect (after review). */
  value: string;
  original_value: string;
  review_status: string;
  confidence: number;
  extraction_method: string;
  source_text: string | null;
  page: number | null;
  validation_status: string | null;
}

/** A reviewer's decision on a record with no extraction row. */
export interface StructureReview {
  status: "accepted" | "rejected" | "edited";
  original_value: string | string[] | null;
  reviewed_value: string | string[] | null;
  reason: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

/** The numbered item a field belongs to ("1." "Contractor Information"),
 * decided once by the backend layout; views never re-derive it. */
export interface LayoutItem {
  /** Stable: the field's parent_id. */
  id: string;
  number: string;
  name: string;
  /** True: the item has sub-fields printed under its caption. */
  has_subfields: boolean;
}

/** One state per value: confirmed, unreadable, missing_extraction, blank,
 * conflicting, unverified_ocr or extracted (labels in `quality_labels`). */
export type QualityCode = string;

/** How far the source can be shown, kept apart from the value's quality:
 * an exact region, its page only, or nothing recorded. */
export type SourceLocation = "exact" | "page" | "none";

export interface LayoutField {
  kind: "field";
  id: string;
  /** Stable across views and reloads: selection and review use it. */
  record_key: string;
  /** The caption the row sits under ("2. Contract Information"). */
  group: string | null;
  /** The label as printed. */
  label: string;
  /** The value as printed on the page (null: not placed in the layout). */
  document_value: string | null;
  blank: boolean;
  extracted_value: string;
  effective_value: string;
  evidence: string | null;
  review_status: string;
  value_type: string;
  found_by: string;
  page: number | null;
  bbox: number[] | null;
  value_bbox: number[] | null;
  flags: LayoutFlag[];
  metadata: LayoutMetadata | null;
  other_metadata: LayoutMetadata[];
  structure_review?: StructureReview;
  /** Extracted value shown in the section of its page; exact spot unknown. */
  placed_by_page?: boolean;
  /** Its numbered item, or null for an unnumbered, uncaptioned label. */
  item?: LayoutItem | null;
  /** The field's own wording ("Cage"; "Briefed Through" for item 3). */
  field_name?: string;
  /** The first field of its item: the only row showing the item's number and name. */
  item_start?: boolean;
  /** Its item's id, else its section's id. */
  parent_id?: string;
  quality?: QualityCode;
  quality_label?: string;
  ocr_confidence?: number | null;
  ocr_contested?: boolean;
  /** A printed date range's Start Date and End Date (the value itself is kept). */
  parts?: CompositePart[];
  /** Printed again at the top of a later page (a running header). */
  repeated_header?: boolean;
  source_location?: SourceLocation;
}

export interface CompositePart {
  label: string;
  value: string;
}

/** A column holding one contract or item for every row: shown once above the table. */
export interface SharedColumn {
  column: number;
  label: string;
  value: string;
}

export interface CellIssue {
  column: number;
  quality: QualityCode;
  message: string;
}

/** Contract metadata a table belongs to, shown once above it. */
export interface TableContext {
  /** The concept ("Contractor Name"). */
  label: string;
  /** The label as the document printed it ("Legal Entity"). */
  printed_label?: string;
  value: string;
  record_key: string;
  page: number | null;
}

export interface LayoutTableRow {
  id: string;
  record_key: string;
  page: number | null;
  cells: string[];
  flags?: LayoutFlag[];
  review_status?: string;
  /** A reviewer's corrected cells; `cells` stays as printed. */
  reviewed_cells?: string[];
  /** A row a reviewer added (missing from the printed table). */
  added?: boolean;
  structure_review?: StructureReview;
  /** The table's record key. */
  parent_id?: string;
  /** The row's printed region on its page, for source navigation. */
  bbox?: number[] | null;
  /** Cells worth a second look (unreadable, unverified OCR); an empty cell is printed blank. */
  cell_issues?: CellIssue[];
  source_location?: SourceLocation;
}

export interface LayoutTable {
  kind: "table";
  id: string;
  record_key: string;
  title: string | null;
  headers: string[];
  /** False: the table printed no header row (columns are numbered). */
  headers_printed: boolean;
  pages: number[];
  continued: boolean;
  detection_method: string;
  rows: LayoutTableRow[];
  row_count: number;
  /** Its section's id. */
  parent_id?: string;
  context?: TableContext[];
  /** "printed": the document shows the block right above the table;
   * "inherited": taken from the nearest block before it. */
  context_source?: "printed" | "inherited" | null;
  shared_columns?: SharedColumn[];
}

export interface LayoutSection {
  id: string;
  title: string | null;
  page: number;
  /** 1: a part ("Section C - …"); 2: a subsection printed inside it. */
  level?: number;
  parent?: string | null;
  items: (LayoutField | LayoutTable)[];
}

export interface OriginalStructure {
  document_id: string;
  source_type: string;
  pages: number;
  sections: LayoutSection[];
  document_title?: string | null;
  /** The document's first contract metadata block. */
  document_context?: TableContext[];
  quality_labels?: Record<QualityCode, string>;
  unplaced: LayoutField[];
  stats: {
    sections: number;
    fields: number;
    blank_fields: number;
    tables: number;
    table_rows: number;
    needs_review: number;
    unplaced: number;
    /** Empty "fields" with no printed label, left out of the view. */
    artifacts_hidden?: number;
    quality?: Record<QualityCode, number>;
    cell_issues?: Record<QualityCode, number>;
  };
}

export function getOriginalStructure(documentId: string): Promise<OriginalStructure> {
  return apiFetch(`/api/documents/${documentId}/original-structure`);
}

export type StructureAction = "accept" | "reject" | "correct" | "reset" | "add_row";

export interface StructureReviewResult {
  record_key: string;
  ok: boolean;
  error?: string;
  review_status?: string | null;
  stored_on?: "metadata" | "structure";
}

/** Approve, reject or correct records by key. Fields with an extraction
 * row are reviewed there (Metadata review); the others keep the printed
 * value and store the decision beside it. Never called by selecting. */
export function reviewStructureRecords(
  documentId: string,
  records: string[],
  action: StructureAction,
  options: { value?: string; cells?: string[]; reason?: string } = {},
): Promise<{ results: StructureReviewResult[]; reviewed: number }> {
  return apiFetch(`/api/documents/${documentId}/original-structure/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ records, action, ...options }),
  });
}

export interface RecordHistoryEntry {
  action: string;
  previous_value: unknown;
  new_value: unknown;
  previous_status: string | null;
  new_status: string | null;
  reason: string | null;
  by: string | null;
  at: string | null;
  /** extraction: the extraction row's audit log; structure: a layout review. */
  source: "extraction" | "structure";
}

/** Every decision and correction on one record, oldest first. */
export function getRecordHistory(documentId: string, recordKey: string): Promise<{ record_key: string; entries: RecordHistoryEntry[] }> {
  return apiFetch(`/api/documents/${documentId}/original-structure/history?record_key=${encodeURIComponent(recordKey)}`);
}

/** Every reviewable record in a layout, by key. */
export function layoutRecords(structure: OriginalStructure): Map<string, { field?: LayoutField; row?: LayoutTableRow; table?: LayoutTable; section: string | null }> {
  const records = new Map<string, { field?: LayoutField; row?: LayoutTableRow; table?: LayoutTable; section: string | null }>();
  for (const section of [...structure.sections, { title: null, items: structure.unplaced } as Pick<LayoutSection, "title" | "items">]) {
    for (const item of section.items) {
      if (item.kind === "field") records.set(item.record_key, { field: item, section: section.title });
      else for (const row of item.rows) records.set(row.record_key, { row, table: item, section: section.title });
    }
  }
  return records;
}
