import type { StagingColumn, StagingRecord } from "@/lib/staging-workbook";

/** Sizing and freezing for the shared staging data grid. Labels and column
 * order always come from the dataset (the source / profile); this only
 * decides how wide each column is and which leading columns stay frozen. */

export const MIN_COLUMN_WIDTH = 80;
export const MAX_COLUMN_WIDTH = 280;
/** Trailing (blank / repeated) columns stay narrow: their values ellipsize. */
export const TRAILING_MAX_WIDTH = 130;
const SAMPLE = 200;
const DATE = /^(\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{1,2}[- ][A-Za-z]{3,9}[- ]\d{2,4}|[A-Za-z]{3,9}\.? \d{1,2},? \d{4}|[A-Za-z]{3,9} \d{4})$/;

function text(value: unknown): string {
  return value == null ? "" : String(value).replace(/\s+/g, " ").trim();
}

/** A width that shows a typical value on one line: Y/N flags and codes
 * stay narrow, dates fit, prose gets a wide column (ellipsized). */
export function columnWidth(column: StagingColumn, records: StagingRecord[]): number {
  return Math.max(valueWidth(column, records), headerWordWidth(column.display_label));
}

/** Headers wrap only between words: a column is never narrower than its
 * longest header word (11px uppercase ≈ 7.5px per letter, plus padding). */
function headerWordWidth(label: string): number {
  const longest = Math.max(0, ...label.split(/[\s/]+/).map((word) => word.length));
  return Math.min(MAX_COLUMN_WIDTH, Math.round(longest * 7.5 + 26));
}

function valueWidth(column: StagingColumn, records: StagingRecord[]): number {
  const values: string[] = [];
  for (const record of records) {
    const value = text(record.cells[column.canonical_field]?.value);
    if (value) values.push(value);
    if (values.length >= SAMPLE) break;
  }
  const labelWidth = Math.min(column.display_label.length * 7 + 28, 170);
  if (values.length === 0) return clamp(Math.max(labelWidth, 100));
  if (values.every((value) => DATE.test(value))) return clamp(Math.max(115, Math.min(labelWidth, 140)));
  const average = values.reduce((sum, value) => sum + value.length, 0) / values.length;
  let width: number;
  if (average <= 4) width = 80;
  else if (average <= 10) width = 105;
  else if (average <= 18) width = 140;
  else if (average <= 30) width = 180;
  else if (average <= 60) width = 220;
  else if (average <= 120) width = 250;
  else width = MAX_COLUMN_WIDTH;
  // Short values keep their header readable; prose doesn't need to.
  return clamp(average <= 30 ? Math.max(width, Math.min(labelWidth, 140)) : width);
}

function clamp(width: number): number {
  return Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(width)));
}

const IDENTIFIER = /(^|\b)(number|no\.?|id|item no\.?|clin|code|clause number|reference|far number|record id|key)$/i;
const TITLE = /^(title|field \/ title|name|display name|field|description|supplies\/services)$/i;
/** Frozen columns never take more than this much of the grid's width. */
export const MAX_FROZEN_WIDTH = 640;

/** How many leading columns stay frozen on horizontal scroll: through the
 * record's identifier and, when it follows closely, its title — found by
 * the dataset's own column names, not by profile. Falls back to the first
 * column. */
export function frozenColumnCount(columns: StagingColumn[], widths: number[]): number {
  const labels = columns.map((column) => column.display_label.trim());
  const identifier = labels.findIndex((label, index) => index < 6 && IDENTIFIER.test(label));
  const title = labels.findIndex((label, index) => index < 7 && TITLE.test(label));
  const within = (count: number) => widths.slice(0, count).reduce((sum, width) => sum + width, 0) <= MAX_FROZEN_WIDTH;
  const candidates = [
    identifier >= 0 && title > identifier && title - identifier <= 2 ? title + 1 : -1,
    identifier >= 0 ? identifier + 1 : -1,
    title >= 0 ? title + 1 : -1,
  ];
  for (const count of candidates) {
    if (count > 0 && within(count)) return count;
  }
  return columns.length > 1 ? 1 : 0;
}

/** A category column before the identifier (Section, Record Type…) has at
 * most this many values, each shared by several records. */
const CATEGORY_MAX_VALUES = 20;

function distinctValues(column: StagingColumn, records: StagingRecord[], limit: number): Set<string> {
  const values = new Set<string>();
  for (const record of records) {
    const value = text(record.cells[column.canonical_field]?.value);
    if (value) values.add(value);
    if (values.size >= limit) break;
  }
  return values;
}

/** On-screen column order: the columns that tell the shown rows apart come
 * first, then those filled on only a few shown rows; columns blank on every
 * shown row, one value repeated on every shown row, or a category ahead of
 * the identifier (Section, Record Type) move to the end. Only the grid's
 * display order changes — exports and the record drawer keep the dataset's
 * own order. */
export function arrangeColumns(
  columns: StagingColumn[],
  shown: StagingRecord[],
  records: StagingRecord[],
): { columns: StagingColumn[]; trailing: Set<string> } {
  const identifier = columns.findIndex((column, index) => index < 6 && IDENTIFIER.test(column.display_label.trim()));
  const trailing = new Set<string>();
  columns.forEach((column, index) => {
    if (index === identifier) return;
    const onScreen = distinctValues(column, shown, 2).size;
    const repeated = onScreen === 0 || (onScreen === 1 && shown.length > 1);
    const category =
      index < identifier &&
      (() => {
        const count = distinctValues(column, records, CATEGORY_MAX_VALUES + 1).size;
        return count <= CATEGORY_MAX_VALUES && count * 5 <= records.length;
      })();
    if (repeated || category) trailing.add(column.canonical_field);
  });
  if (trailing.size >= columns.length) return { columns, trailing: new Set() };
  // Of the rest, columns filled on only a few shown rows follow the well-filled ones.
  const sparse = new Set(
    columns
      .filter((column, index) => index !== identifier && !trailing.has(column.canonical_field))
      .filter((column) => filledShare(column, shown) < SPARSE_SHARE)
      .map((column) => column.canonical_field),
  );
  const tier = (column: StagingColumn) =>
    trailing.has(column.canonical_field) ? 2 : sparse.has(column.canonical_field) ? 1 : 0;
  return {
    columns: [0, 1, 2].flatMap((rank) => columns.filter((column) => tier(column) === rank)),
    trailing,
  };
}

/** Below this share of shown rows with a value, a column is sparse. */
const SPARSE_SHARE = 0.25;

function filledShare(column: StagingColumn, records: StagingRecord[]): number {
  if (records.length === 0) return 0;
  const filled = records.filter((record) => text(record.cells[column.canonical_field]?.value)).length;
  return filled / records.length;
}

/** Left offsets (px) of the frozen columns. */
export function frozenOffsets(widths: number[], count: number): number[] {
  const offsets: number[] = [];
  let left = 0;
  for (let index = 0; index < count; index += 1) {
    offsets.push(left);
    left += widths[index];
  }
  return offsets;
}
