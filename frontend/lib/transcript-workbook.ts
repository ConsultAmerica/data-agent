import type {
  CellProvenance,
  StagingCell,
  StagingDataset,
  StagingRecord,
  StagingWorkbook,
} from "@/lib/staging-workbook";

/** Presentation of the academic_transcript profile's workbook. The
 * profile's datasets and canonical fields are unchanged; this only decides
 * how they are grouped and labelled on screen. */

export const TRANSCRIPT_PROFILE_ID = "academic_transcript";

export function isTranscriptProfile(workbook: StagingWorkbook): boolean {
  return workbook.profile.profile_id === TRANSCRIPT_PROFILE_ID;
}

export type TranscriptTabId =
  | "overview"
  | "student_program"
  | "academic_record"
  | "academic_summary"
  | "other_information"
  | "all_fields";

export const TRANSCRIPT_TABS: { id: TranscriptTabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "student_program", label: "Student & Program" },
  { id: "academic_record", label: "Academic Record" },
  { id: "academic_summary", label: "Academic Summary" },
  { id: "other_information", label: "Other Information" },
  { id: "all_fields", label: "All Fields" },
];

/** Columns of the field-style datasets (Student & Program, Academic
 * Summary, Other Information, All Fields). Each dataset has its own
 * canonical ids ("transcript.student_program.value"), so cells are found
 * by their last part. */
export type FieldPart = "name" | "value" | "scope" | "category" | "source_label" | "field_id";

export function fieldCell(record: StagingRecord, part: FieldPart): StagingCell | undefined {
  const suffix = `.${part}`;
  for (const [key, cell] of Object.entries(record.cells)) {
    if (key.endsWith(suffix)) return cell;
  }
  return undefined;
}

export function findDataset(workbook: StagingWorkbook, id: string): StagingDataset | undefined {
  return workbook.datasets.find((dataset) => dataset.dataset_id === id);
}

export function text(cell: StagingCell | undefined): string {
  if (!cell || cell.value == null) return "";
  return String(cell.value);
}

/** The first field record whose Field ID is `fieldId`. */
export function fieldRecord(
  dataset: StagingDataset | undefined,
  fieldId: string,
): StagingRecord | undefined {
  return dataset?.records.find((record) => text(fieldCell(record, "field_id")) === fieldId);
}

/** Records grouped by their Category, in first-seen order. */
export function byCategory(records: StagingRecord[]): [string, StagingRecord[]][] {
  const groups = new Map<string, StagingRecord[]>();
  for (const record of records) {
    const category = text(fieldCell(record, "category")) || "Other Information";
    groups.set(category, [...(groups.get(category) ?? []), record]);
  }
  return [...groups.entries()];
}

/** Columns of a table dataset that hold at least one value. */
export function populatedColumns(dataset: StagingDataset) {
  return dataset.columns.filter((column) =>
    dataset.records.some((record) => record.cells[column.canonical_field]?.value != null),
  );
}

/** Where a value sits, as a reader would say it: "Page 2", "HTML",
 * "Sheet Summary". No location is invented when the source gave none. */
export function sourceLocation(provenance: CellProvenance | null | undefined): string | null {
  if (!provenance) return null;
  if (provenance.source_page) return `Page ${provenance.source_page}`;
  const locator = provenance.source_locator;
  if (locator?.sheet_name) return `Sheet ${locator.sheet_name}`;
  if (provenance.source_type === "html") return "HTML";
  return null;
}

const METHOD_WORDS: Record<string, string> = {
  native: "Document text",
  ocr: "OCR",
  dom: "HTML structure",
  html: "HTML structure",
  system: "File details",
  form_widget: "Form field",
  label_value: "Label / value pair",
  course_table: "Table row",
  course_group: "Table group heading",
  summary: "Summary line",
  section: "Section",
  fragment: "Source fragment",
  same_line_separator: "Label / value pair",
  left_right_separator: "Label / value pair",
  left_right_typography: "Label / value pair",
  left_right_whitespace: "Label / value pair",
  same_line_filler: "Same-line field",
  form_fill_in: "Form field",
  table_key_value_grid: "Form grid",
  ruled_form_box: "Form box",
  label_above_value: "Label above value",
  html_label_for: "HTML form label",
  html_definition_list: "HTML definition list",
  html_table_header_cell: "HTML table",
  html_adjacent_elements: "HTML structure",
  html_inline_separator: "HTML structure",
  html_dom: "HTML table",
  raster_ruling_lines: "Detected table",
  pdf_ruling_lines: "Detected table",
  pdf_column_alignment: "Detected table",
  heading: "Heading",
  typed_value: "Value in text",
  contact_block: "Contact block",
  form_field: "Form field",
};

/** An extraction method as a reader-facing phrase — never an internal
 * strategy name ("ocr:label_value" → "OCR · Label / value pair"). */
export function humanizeExtractionMethod(method: string | null | undefined): string | null {
  if (!method) return null;
  const words: string[] = [];
  for (const raw of method.split(/[:\s]+/)) {
    const token = raw.trim().toLowerCase();
    if (!token || token === "v3") continue;
    const phrase =
      METHOD_WORDS[token] ??
      (token.includes("ocr") ? "OCR" : token.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()));
    if (!words.includes(phrase)) words.push(phrase);
  }
  return words.join(" · ") || null;
}
