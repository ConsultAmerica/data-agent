import { apiFetch } from "@/lib/api";
import type { SourceLocator } from "@/lib/staging-workbook";

/** Mirrors backend app/api/source_view.py and app/source_view/service.py. */

export type ViewerKind = "pdf" | "image" | "spreadsheet" | "delimited" | "json" | "xml" | "word" | "text" | "unsupported";

export interface SheetSummary {
  index: number;
  name: string;
  max_row: number;
  max_column: number;
  /** Top-left unfrozen cell ("B2"), when the sheet freezes panes. */
  frozen: string | null;
}

export interface SheetCell {
  ref: string;
  row: number;
  column: number;
  /** As written in the file; never evaluated. */
  formula: string | null;
  /** The cell's value — for a formula, the result the file cached (null
   * when the file never stored one). */
  value: string | null;
  type: string;
}

export interface SheetContent extends SheetSummary {
  merged: string[];
  cells: SheetCell[];
  truncated: boolean;
}

export interface XmlNode {
  name: string;
  prefix: string | null;
  namespace: string | null;
  path: string;
  attributes: { name: string; namespace: string | null; value: string; path: string }[];
  text: string | null;
  children: XmlNode[];
}

export interface WordPart {
  text: string;
  href?: string | null;
  anchor?: string | null;
}

export type WordBlock =
  | { type: "heading"; level: number; text: string; section: string[]; index: number }
  | { type: "paragraph"; text: string; parts: WordPart[]; section: string[]; style: string | null; index: number }
  | { type: "list_item"; level: number; text: string; parts: WordPart[]; section: string[]; index: number }
  | { type: "table"; rows: string[][]; section: string[]; index: number };

export interface SourceView {
  viewer: ViewerKind;
  format: string;
  /** The file's own bytes matched its type. */
  verified: boolean;
  /** Why the view is limited (legacy Office, size, mismatch…). */
  note: string | null;
  page_count?: number;
  // spreadsheet
  sheets?: SheetSummary[];
  formulas_available?: boolean;
  macros_note?: string | null;
  // delimited
  encoding?: string;
  encoding_guessed?: boolean;
  delimiter?: string;
  has_header?: boolean;
  header_detected?: boolean;
  rows?: string[][];
  truncated?: boolean;
  warnings?: string[];
  // json
  data?: unknown;
  // xml
  root?: XmlNode;
  namespaces?: { prefix: string | null; uri: string }[];
  node_count?: number;
  // word
  blocks?: WordBlock[];
  metadata?: { title: string | null; author: string | null; created: string | null; modified: string | null };
}

// One request per document per visit (memory only — source content is
// never written to browser storage).
const views = new Map<string, Promise<SourceView>>();

export function getSourceView(documentId: string): Promise<SourceView> {
  let pending = views.get(documentId);
  if (!pending) {
    pending = apiFetch<SourceView>(`/api/documents/${documentId}/source-view`);
    pending.catch(() => views.delete(documentId));
    views.set(documentId, pending);
  }
  return pending;
}

const sheets = new Map<string, Promise<SheetContent>>();

export function getSourceSheet(documentId: string, index: number): Promise<SheetContent> {
  const key = `${documentId}:${index}`;
  let pending = sheets.get(key);
  if (!pending) {
    pending = apiFetch<SheetContent>(`/api/documents/${documentId}/source-view/sheets/${index}`);
    pending.catch(() => sheets.delete(key));
    sheets.set(key, pending);
  }
  return pending;
}

/** Test hook. */
export function clearSourceViewCache() {
  views.clear();
  sheets.clear();
}

/** 1 → A, 27 → AA (as the backend writes cell refs). */
export function columnLetter(index: number): string {
  let letters = "";
  let n = index;
  while (n > 0) {
    const remainder = (n - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** "B12" → { column: 2, row: 12 }. */
export function parseCellRef(ref: string): { column: number; row: number } | null {
  const match = ref.trim().toUpperCase().match(/^\$?([A-Z]{1,3})\$?(\d+)$/);
  if (!match) return null;
  const column = [...match[1]].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
  return { column, row: Number(match[2]) };
}

// ---------------------------------------------------------------- evidence locations

/** Where a value is in its source, as precisely as the evidence says. */
export type SourceLocation =
  | { kind: "page_region"; page: number; bbox: [number, number, number, number] }
  | { kind: "page"; page: number; text: string | null }
  | { kind: "sheet_cell"; sheetName: string | null; sheetIndex: number | null; cell: string }
  | { kind: "sheet"; sheetIndex: number; text: string | null }
  | { kind: "row"; row: number; column: number | null; text: string | null }
  | { kind: "json_value"; text: string }
  | { kind: "xml_path"; path: string }
  | { kind: "word_text"; section: string[]; text: string }
  | { kind: "none" };

export interface ResolvedLocation {
  location: SourceLocation;
  /** exact: recorded coordinates / cell / path. approximate: a recorded
   * page or section, with the value found by matching its text.
   * unavailable: nothing was recorded. */
  precision: "exact" | "approximate" | "unavailable";
  /** For screen readers and the evidence banner. */
  description: string;
}

export interface EvidenceInput {
  pageNumber?: number | null;
  region?: [number, number, number, number] | null;
  highlightText?: string | null;
  value?: string | null;
  locator?: SourceLocator | null;
}

/** Resolve recorded evidence for the viewer in use. Never invents a
 * location: what wasn't recorded is reported as such. */
export function resolveLocation(evidence: EvidenceInput | null, viewer: ViewerKind, sheetNames: string[] = []): ResolvedLocation {
  const text = evidence?.highlightText?.trim() || evidence?.value?.trim() || null;
  const page = evidence?.pageNumber && evidence.pageNumber > 0 ? evidence.pageNumber : null;
  const locator = evidence?.locator ?? null;
  const none: ResolvedLocation = { location: { kind: "none" }, precision: "unavailable", description: "No source location was recorded for this value." };
  if (!evidence) return none;

  if (viewer === "pdf" || viewer === "image" || viewer === "text") {
    if (page && evidence.region) {
      return { location: { kind: "page_region", page, bbox: evidence.region }, precision: "exact", description: `Page ${page}, recorded region.` };
    }
    if (page) {
      return {
        location: { kind: "page", page, text },
        precision: "approximate",
        description: text ? `Page ${page}; no region was recorded, so the value is found by its text.` : `Page ${page}; no region was recorded.`,
      };
    }
    return none;
  }
  if (viewer === "spreadsheet") {
    if (locator?.cell_ref) {
      const sheetIndex = locator.sheet_name ? sheetNames.indexOf(locator.sheet_name) : page ? page - 1 : null;
      return {
        location: { kind: "sheet_cell", sheetName: locator.sheet_name, sheetIndex: sheetIndex != null && sheetIndex >= 0 ? sheetIndex : null, cell: locator.cell_ref },
        precision: "exact",
        description: `${locator.sheet_name ? `Sheet “${locator.sheet_name}”, ` : ""}cell ${locator.cell_ref}.`,
      };
    }
    if (page) {
      const name = sheetNames[page - 1];
      return {
        location: { kind: "sheet", sheetIndex: page - 1, text },
        precision: "approximate",
        description: `${name ? `Sheet “${name}”` : `Sheet ${page}`}; no cell was recorded${text ? ", so the cell is found by matching the value" : ""}.`,
      };
    }
    return none;
  }
  if (viewer === "delimited") {
    if (locator?.row_index != null) {
      return {
        location: { kind: "row", row: locator.row_index, column: locator.column_index ?? null, text },
        precision: "exact",
        description: `Row ${locator.row_index + 1}${locator.column_index != null ? `, column ${locator.column_index + 1}` : ""}.`,
      };
    }
    if (text) return { location: { kind: "row", row: -1, column: null, text }, precision: "approximate", description: "No row was recorded; the row is found by matching the value." };
    return none;
  }
  if (viewer === "xml") {
    if (locator?.dom_path) return { location: { kind: "xml_path", path: locator.dom_path }, precision: "exact", description: `XML path ${locator.dom_path}.` };
    return none;
  }
  if (viewer === "json") {
    if (text) return { location: { kind: "json_value", text }, precision: "approximate", description: "No JSON path was recorded; the value is found by matching it." };
    return none;
  }
  if (viewer === "word") {
    const section = locator?.section_path ?? [];
    if (text) {
      return {
        location: { kind: "word_text", section, text },
        precision: "approximate",
        description: `${section.length ? `Section “${section.join(" › ")}”; ` : ""}the paragraph is found by matching the value.`,
      };
    }
    return none;
  }
  return none;
}
