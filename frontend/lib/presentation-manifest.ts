import type {
  SourceColumnValue,
  StagingCell,
  StagingColumn,
  StagingDataset,
  StagingRecord,
  StagingWorkbook,
} from "@/lib/staging-workbook";

/** Presentation only. The business workspace answers "what information is
 * in this document?". Canonical datasets, provenance, review status and
 * exports stay exactly as extracted; this decides what is shown where, and
 * leaves every technical detail to the evidence / technical views. */

/** "card": a compact document-summary card (label over value, in a grid). */
/** text: a heading over the document's own paragraphs (one item). */
export type SectionPattern = "detail" | "grid" | "summary" | "card" | "text";

/** One displayed value: a business label and the cell behind it. */
export interface FieldItem {
  id: string;
  label: string;
  cell: StagingCell;
  /** Where the value sits, for the evidence view ("Supplier"). */
  context: string;
  sourceLabel: string | null;
  fieldId: string | null;
  category: string | null;
  fragments?: SourceColumnValue[];
  emphasis?: "total";
  /** Where the value is stored (dataset, record, field), for Export
   * Selected. Absent for a value that has no single stored cell. */
  source?: FieldSource;
}

export interface FieldSource {
  datasetId: string;
  recordId: string;
  field: string;
}

export interface PresentationSection {
  id: string;
  /** Sub-heading inside the tab; null when the tab needs none. */
  title: string | null;
  pattern: SectionPattern;
  items: FieldItem[];
  /** Record grid only. */
  dataset?: StagingDataset;
  columns?: StagingColumn[];
  /** Populated but too sparse for the grid; shown in row details. */
  detailColumns?: StagingColumn[];
  noun?: [string, string];
  /** Alternative views of one tab ("Contract View" / "Transformation View"). */
  view?: string;
  /** Review state as a subtle row mark; the identity value opens the record. */
  inlineReview?: boolean;
  /** Short note under the section heading. */
  note?: string;
  /** Enclosing source heading shown above this section when it changes
   * ("Section G - Contract Administration Data"). */
  supertitle?: string;
  /** A grid composed here (not a staged dataset): where each of its cells
   * is stored, by record id then field, for Export Selected. */
  cellSources?: Record<string, Record<string, FieldSource>>;
}

export interface PresentationGroup {
  id: string;
  label: string;
  sections: PresentationSection[];
}

export interface PresentationManifest {
  heading: string;
  subtitle: string | null;
  family: string | null;
  groups: PresentationGroup[];
  /** Every dataset, unchanged, for the collapsed technical view. */
  technical: StagingDataset[];
  reasons: string[];
}

// --- value and column hygiene ---------------------------------------------

const PLACEHOLDER = /^[\s\-–—_.]*$/;

export function isBlank(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "boolean" || typeof value === "number") return false;
  return PLACEHOLDER.test(String(value));
}

const TECHNICAL_KEY =
  /(^|\.)(found_by|extraction_method|value_type|source_page|bbox|dom_path|qa_status|confidence|category|source_label|field_id|source_table|detection|source_filename|source_type|processing_status|structure_summary|page_count)$/i;
const TECHNICAL_LABEL =
  /^(type|found by|method|extraction method|location|evidence|confidence|status|category|source label|field id|table|source table|detected by|bbox|dom path)$/i;
const TABLE_ORIGIN = /^table\s+\d+\s*\(page\s*\d+\)$/i;

function isTechnicalColumn(column: StagingColumn): boolean {
  return (
    TECHNICAL_KEY.test(column.canonical_field) ||
    TECHNICAL_KEY.test(column.key) ||
    TECHNICAL_LABEL.test(column.display_label.trim())
  );
}

/** "transcript.student.name" / "student_name" → "Student Name". */
export function businessLabel(label: string): string {
  // "Management (SAM); CAGE" — a run-on source sentence before the label.
  const trimmed = (label.includes(";") ? label.slice(label.lastIndexOf(";") + 1) : label).trim() || label.trim();
  if (!/^[a-z0-9_.]+$/.test(trimmed) || !/[._]/.test(trimmed)) return trimmed;
  const last = trimmed.split(".").filter(Boolean).pop() ?? trimmed;
  return last
    .split("_")
    .filter(Boolean)
    .map((word) => (word.length <= 3 && /^(id|gpa|po|uom|vat)$/.test(word) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim();
}

function valueText(cell: StagingCell | undefined): string {
  if (!cell || isBlank(cell.value)) return "";
  return String(cell.value).trim();
}

// --- field-style datasets (Field / Value / Category … per record) ----------

interface FieldColumns {
  name: StagingColumn;
  value: StagingColumn;
  category?: StagingColumn;
  sourceLabel?: StagingColumn;
  fieldId?: StagingColumn;
  scope?: StagingColumn;
}

function columnBySuffix(dataset: StagingDataset, ...suffixes: string[]): StagingColumn | undefined {
  return dataset.columns.find((column) =>
    suffixes.some((suffix) => column.key === suffix || column.canonical_field.endsWith(`.${suffix}`)),
  );
}

function fieldColumns(dataset: StagingDataset): FieldColumns | null {
  if (dataset.cardinality !== "repeating") return null;
  const value = columnBySuffix(dataset, "value");
  const name = columnBySuffix(dataset, "name", "label");
  if (!value || !name || value === name) return null;
  return {
    name,
    value,
    category: columnBySuffix(dataset, "category"),
    sourceLabel: columnBySuffix(dataset, "source_label"),
    fieldId: columnBySuffix(dataset, "field_id"),
    scope: columnBySuffix(dataset, "scope"),
  };
}

function fieldItems(dataset: StagingDataset, context: string): FieldItem[] {
  const columns = fieldColumns(dataset);
  if (!columns) return [];
  const items: FieldItem[] = [];
  for (const record of dataset.records) {
    const cell = record.cells[columns.value.canonical_field];
    const name = valueText(record.cells[columns.name.canonical_field]);
    if (!cell || isBlank(cell.value) || !name) continue;
    const scope = columns.scope ? valueText(record.cells[columns.scope.canonical_field]) : "";
    items.push({
      id: `${dataset.dataset_id}:${record.record_id}`,
      label: businessLabel(name) + (scope ? ` (${scope})` : ""),
      cell,
      context,
      sourceLabel: columns.sourceLabel ? valueText(record.cells[columns.sourceLabel.canonical_field]) || null : null,
      fieldId: columns.fieldId ? valueText(record.cells[columns.fieldId.canonical_field]) || null : null,
      category: columns.category ? valueText(record.cells[columns.category.canonical_field]) || null : null,
      fragments: record.source_columns,
      source: { datasetId: dataset.dataset_id, recordId: record.record_id, field: columns.value.canonical_field },
    });
  }
  return items;
}

/** A single-record dataset as label/value items, blanks and technical
 * columns omitted. */
function singleItems(dataset: StagingDataset, context: string): FieldItem[] {
  const record = dataset.records[0];
  if (!record) return [];
  return dataset.columns
    .filter((column) => !isTechnicalColumn(column))
    .map((column) => ({ column, cell: record.cells[column.canonical_field] }))
    .filter(({ cell }) => cell && !isBlank(cell.value))
    .map(({ column, cell }) => ({
      id: `${dataset.dataset_id}:${column.canonical_field}`,
      label: businessLabel(column.display_label),
      cell,
      context,
      sourceLabel: cell.source_column?.raw_header ?? null,
      fieldId: column.canonical_field,
      category: null,
      source: { datasetId: dataset.dataset_id, recordId: record.record_id, field: column.canonical_field },
    }));
}

function dedupeItems(items: FieldItem[]): FieldItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${norm(item.label)}|${norm(valueText(item.cell))}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --- document text ------------------------------------------------------------

/** Heading | Content records as text sections: the heading titles the
 * section, its content reads as the document printed it. */
function textSections(dataset: StagingDataset): PresentationSection[] {
  const heading = columnBySuffix(dataset, "heading");
  const content = columnBySuffix(dataset, "content");
  if (!heading || !content) return [];
  return dataset.records.flatMap((record) => {
    const cell = record.cells[content.canonical_field];
    const title = valueText(record.cells[heading.canonical_field]);
    if (!cell || isBlank(cell.value) || !title) return [];
    return [
      {
        id: `${dataset.dataset_id}:${record.record_id}`,
        title,
        pattern: "text" as const,
        items: [
          {
            id: `${dataset.dataset_id}:${record.record_id}`,
            label: title,
            cell,
            context: title,
            sourceLabel: title,
            fieldId: content.canonical_field,
            category: null,
            fragments: record.source_columns,
            source: { datasetId: dataset.dataset_id, recordId: record.record_id, field: content.canonical_field },
          },
        ],
      },
    ];
  });
}

// --- record grids ------------------------------------------------------------

function population(dataset: StagingDataset, column: StagingColumn): number {
  if (dataset.records.length === 0) return 0;
  const filled = dataset.records.filter((record) => !isBlank(record.cells[column.canonical_field]?.value)).length;
  return filled / dataset.records.length;
}

function isTableOrigin(dataset: StagingDataset, column: StagingColumn): boolean {
  const values = dataset.records.map((record) => valueText(record.cells[column.canonical_field])).filter(Boolean);
  return values.length > 0 && values.every((value) => TABLE_ORIGIN.test(value));
}

const SHORT_LABELS: Record<string, string> = {
  quantity: "Qty",
  "line amount": "Amount",
  "label as stated": "Charge",
};

/** Meaningful business columns of a repeating dataset: declared grid
 * columns first, never technical or table-origin columns, never empty
 * columns. Sparse optional columns move to row details. */
export function gridColumns(dataset: StagingDataset): { columns: StagingColumn[]; detailColumns: StagingColumn[] } {
  const declared = dataset.grid_fields?.length
    ? dataset.grid_fields
        .map((field) => dataset.columns.find((column) => column.canonical_field === field))
        .filter((column): column is StagingColumn => Boolean(column))
    : dataset.columns;
  const candidates = declared.filter(
    (column) => !isTechnicalColumn(column) && !isTableOrigin(dataset, column) && population(dataset, column) > 0,
  );
  const dense = candidates.filter((column) => population(dataset, column) >= 0.15 || column.expected);
  const sparse = dataset.records.length >= 8 && dense.length >= 3
    ? candidates.filter((column) => !dense.includes(column))
    : [];
  const columns = candidates
    .filter((column) => !sparse.includes(column))
    .map((column) => {
      const short = SHORT_LABELS[column.display_label.trim().toLowerCase()];
      const label = short ?? businessLabel(column.display_label);
      return label === column.display_label ? column : { ...column, display_label: label };
    });
  return { columns, detailColumns: sparse };
}

function gridSection(dataset: StagingDataset, title: string | null, noun?: [string, string]): PresentationSection | null {
  if (dataset.records.length === 0) return null;
  const { columns, detailColumns } = gridColumns(dataset);
  if (columns.length === 0) return null;
  return {
    id: dataset.dataset_id,
    title,
    pattern: "grid",
    items: [],
    dataset,
    columns,
    detailColumns,
    noun,
  };
}

// --- invoice financial summary ------------------------------------------------

const CHARGE_WORD = /^(sub\s*-?\s*total|total|tax|vat|gst|hst|pst|sales tax|discount|freight|shipping|handling|insurance|surcharge|fee|deposit|amount due|balance due)\b/i;
const MONEYISH = /^[-(]?\s*[$€£¥₹]?\s*[\d.,]+\s*\)?%?$/;

function cellEnding(record: StagingRecord, suffix: string): StagingCell | undefined {
  for (const [key, cell] of Object.entries(record.cells)) {
    if (key.endsWith(`.${suffix}`)) return cell;
  }
  return undefined;
}

/** An extracted "line" that is really a charge/total row of the totals
 * block (no description or quantity; its label sits in another column). */
function chargeRow(record: StagingRecord): { label: string; cell: StagingCell } | null {
  const amount = cellEnding(record, "amount");
  if (!amount || isBlank(amount.value)) return null;
  const description = valueText(cellEnding(record, "description"));
  const quantity = valueText(cellEnding(record, "quantity"));
  if (quantity) return null;
  if (description) return CHARGE_WORD.test(description) ? { label: description, cell: amount } : null;
  for (const suffix of ["unit_price", "item_number", "uom", "line_number"]) {
    const text = valueText(cellEnding(record, suffix));
    if (text && !MONEYISH.test(text)) return { label: text, cell: amount };
  }
  return null;
}

function amountKey(cell: StagingCell): string {
  return String(cell.value ?? "").replace(/[^\d.]/g, "").replace(/^0+(?=\d)/, "");
}

function invoiceCharges(
  totals: StagingDataset | undefined,
  charges: StagingDataset | undefined,
  rerouted: FieldItem[],
): FieldItem[] {
  const totalsRecord = totals?.records[0];
  const total = (suffix: string, label: string, emphasis?: "total"): FieldItem | null => {
    if (!totalsRecord) return null;
    const entry = Object.entries(totalsRecord.cells).find(([key]) => key.endsWith(`.${suffix}`));
    if (!entry || isBlank(entry[1].value)) return null;
    return {
      id: `totals:${suffix}`,
      label,
      cell: entry[1],
      context: "Charges & Totals",
      sourceLabel: null,
      fieldId: entry[0],
      category: null,
      emphasis,
      source: { datasetId: totals!.dataset_id, recordId: totalsRecord.record_id, field: entry[0] },
    };
  };

  const middle: FieldItem[] = [];
  for (const record of charges?.records ?? []) {
    const amount = cellEnding(record, "amount");
    if (!amount || isBlank(amount.value)) continue;
    const label = valueText(cellEnding(record, "label")) || valueText(cellEnding(record, "type")) || "Charge";
    const rate = valueText(cellEnding(record, "rate"));
    middle.push({
      id: `charges:${record.record_id}`,
      label: rate && !label.includes("%") ? `${label} (${rate})` : label,
      cell: amount,
      context: "Charges & Totals",
      sourceLabel: valueText(cellEnding(record, "label")) || null,
      fieldId: amount.canonical_field,
      category: null,
      source: { datasetId: charges!.dataset_id, recordId: record.record_id, field: amount.canonical_field },
    });
  }
  for (const item of rerouted) {
    if (/^sub\s*-?\s*total|^total|amount due|balance due/i.test(item.label)) continue;
    middle.push(item);
  }
  // Totals-block tax / discount / freight, unless the same amount is
  // already listed as a charge (the same concept stated once).
  for (const [suffix, label] of [["discount", "Discount"], ["tax", "Tax"], ["freight", "Freight"]] as const) {
    const item = total(suffix, label);
    if (!item) continue;
    const duplicate = middle.some((existing) => amountKey(existing.cell) === amountKey(item.cell));
    if (!duplicate) middle.push(item);
  }
  const dedupedMiddle = dedupeItems(middle);

  return [
    total("subtotal", "Subtotal"),
    ...dedupedMiddle,
    total("invoice_amount", "Total", "total"),
    total("amount_paid", "Amount Paid"),
    total("amount_due", "Amount Due", total("amount_paid", "") ? "total" : undefined),
  ].filter((item): item is FieldItem => item !== null);
}

// --- grouping -----------------------------------------------------------------

const TECHNICAL_DATASETS = new Set([
  "qa_review",
  "far_sections",
  "far_canonical",
  "far_oracle_output_map",
  "other_tables",
  "all_fields",
  "source_documents",
]);

const SUMMARY_LABEL =
  /\b(c?gpa|grade point|total marks|max(imum)? marks|out of|average|mean (grade|score|mark)s?|percentage|overall (grade|result)|mean grade|recommendation|result|division|classification|class of (degree|award)|credits? (earned|attempted|completed|total)|total credits?)\b/i;
const STUDENT_LABEL = /\b(academic year|year of study|semester|term|grade level|stream|intake|mode of study|campus|admission (date|year))\b/i;
const SHIPPING = /incoterm|country of origin|gross weight|net weight|packages|ship via|carrier|tracking|insurance|reason for export|hs code|port of/i;

function subsectionFor(item: FieldItem): string {
  const category = item.category ?? "";
  const hay = `${category} ${item.label}`;
  if (SHIPPING.test(item.label)) return "Shipping & Commercial";
  if (/institution|school|university|college/i.test(category)) return "Institution";
  if (/accredit/i.test(hay)) return "Accreditation";
  if (/certif|signat|registrar|seal|attest|issue date|issued/i.test(hay)) return "Certification";
  if (/note|comment|remark|commentary/i.test(category)) return "Notes";
  if (/test|exam|immuni/i.test(category)) return businessLabel(category);
  if (category && !/^(other|other information|additional|general|misc)/i.test(category) && !/^invoice|^supplier|^customer|^totals?$|^line/i.test(category)) {
    return category;
  }
  return "Additional Details";
}

function subsections(items: FieldItem[], prefix: string, order: string[] = []): PresentationSection[] {
  const buckets = new Map<string, FieldItem[]>();
  for (const item of dedupeItems(items)) {
    const title = subsectionFor(item);
    buckets.set(title, [...(buckets.get(title) ?? []), item]);
  }
  const titles = [...buckets.keys()].sort((a, b) => {
    const rank = (title: string) => {
      const index = order.indexOf(title);
      return index === -1 ? (title === "Additional Details" ? 99 : 50) : index;
    };
    return rank(a) - rank(b);
  });
  const single = titles.length === 1 && titles[0] === "Additional Details";
  return titles.map((title) => ({
    id: `${prefix}:${norm(title)}`,
    title: single ? null : title,
    pattern: "detail" as const,
    items: buckets.get(title) ?? [],
  }));
}

function byCategory(items: FieldItem[], prefix: string, rename: (category: string) => string): PresentationSection[] {
  const buckets = new Map<string, FieldItem[]>();
  for (const item of dedupeItems(items)) {
    const title = rename(item.category ?? "");
    buckets.set(title, [...(buckets.get(title) ?? []), item]);
  }
  const first = ["Student", "Program"];
  const rank = (title: string) => (first.includes(title) ? first.indexOf(title) : first.length);
  const titles = [...buckets.keys()].sort((a, b) => rank(a) - rank(b));
  return titles.map((title) => ({
    id: `${prefix}:${norm(title)}`,
    title: titles.length > 1 ? title : null,
    pattern: "detail" as const,
    items: buckets.get(title) ?? [],
  }));
}

function professionalLabel(label: string): string {
  if (/invoice lines/i.test(label)) return "Line Items";
  if (/business export/i.test(label)) return "Clause Text";
  return businessLabel(label);
}

interface GroupDraft {
  id: string;
  label: string;
  rank: number;
  sections: PresentationSection[];
}

/** Values already on screen, so all-fields inventories only add what no
 * business group shows. */
function shownValues(groups: GroupDraft[]): Set<string> {
  const values = new Set<string>();
  for (const group of groups) {
    for (const section of group.sections) {
      for (const item of section.items) values.add(norm(valueText(item.cell)));
      for (const record of section.dataset?.records ?? []) {
        for (const cell of Object.values(record.cells)) {
          const text = norm(valueText(cell));
          if (text) values.add(text);
        }
      }
    }
  }
  return values;
}

const LEFTOVER_LIMIT = 60;

/** Table cells that exist only in an all-fields inventory ("ROW / Column",
 * category "Table 1 (page 1)") rebuilt as a record grid. Cells are reused
 * as-is, so provenance and review status are unchanged. */
function pivotTables(items: FieldItem[]): { sections: PresentationSection[]; rest: FieldItem[] } {
  const tables = new Map<string, FieldItem[]>();
  const rest: FieldItem[] = [];
  for (const item of items) {
    if (item.category && TABLE_ORIGIN.test(item.category) && item.label.includes(" / ")) {
      tables.set(item.category, [...(tables.get(item.category) ?? []), item]);
    } else {
      rest.push(item);
    }
  }
  const sections: PresentationSection[] = [];
  let index = 0;
  for (const [origin, cells] of tables) {
    index += 1;
    const rowOrder: string[] = [];
    const columnOrder: string[] = [];
    const rows = new Map<string, Record<string, StagingCell>>();
    const sources = new Map<string, Record<string, FieldSource>>();
    for (const item of cells) {
      const [rowLabel, ...columnParts] = item.label.split(" / ");
      const columnLabel = columnParts.join(" / ").trim();
      if (!rows.has(rowLabel)) {
        rows.set(rowLabel, {});
        rowOrder.push(rowLabel);
      }
      if (!columnOrder.includes(columnLabel)) columnOrder.push(columnLabel);
      const columnField = `table.${index}.col.${columnOrder.indexOf(columnLabel)}`;
      rows.get(rowLabel)![columnField] = item.cell;
      if (item.source) sources.set(rowLabel, { ...(sources.get(rowLabel) ?? {}), [columnField]: item.source });
    }
    const rowKey = `table.${index}.row`;
    const columns: StagingColumn[] = [
      { canonical_field: rowKey, key: "row", display_label: "Item", value_type: "text", expected: true },
      ...columnOrder.map((label, column) => ({
        canonical_field: `table.${index}.col.${column}`,
        key: `col_${column}`,
        display_label: label,
        value_type: "text",
        expected: false,
      })),
    ];
    const records: StagingRecord[] = rowOrder.map((rowLabel, row) => {
      const rowCells = rows.get(rowLabel)!;
      const first = Object.values(rowCells)[0];
      const statuses = Object.values(rowCells).map((cell) => cell.review_status);
      return {
        record_id: `${origin}:${row}`,
        cells: {
          [rowKey]: { ...first, canonical_field: rowKey, display_label: "Item", value: /^row \d+$/i.test(rowLabel) ? null : rowLabel, raw_value: rowLabel },
          ...rowCells,
        },
        record_status: statuses.includes("Needs Review") ? "Needs Review" : statuses.every((status) => status === "Verified") ? "Verified" : null,
        links_to_dataset: null,
      };
    });
    const dataset: StagingDataset = {
      dataset_id: `table_${index}`,
      display_name: tables.size > 1 ? `Table ${index}` : "Table",
      cardinality: "repeating",
      role: "business",
      description: null,
      columns,
      records,
      identity_fields: [rowKey],
    };
    const section = gridSection(dataset, tables.size > 1 ? `Table ${index}` : null, ["row", "rows"]);
    if (section) {
      section.cellSources = Object.fromEntries(
        rowOrder.map((rowLabel, row) => [`${origin}:${row}`, sources.get(rowLabel) ?? {}]),
      );
      sections.push(section);
    }
  }
  return { sections, rest };
}

function headingFrom(workbook: StagingWorkbook, groups: GroupDraft[]): string {
  // Values of repeating rows (courses, line items, clauses …) can never be
  // the document's identity.
  const rowValues = new Set<string>();
  for (const dataset of workbook.datasets) {
    if (dataset.cardinality !== "repeating" || fieldColumns(dataset)) continue;
    for (const record of dataset.records) {
      for (const cell of Object.values(record.cells)) {
        const text = norm(valueText(cell));
        if (text) rowValues.add(text);
      }
    }
  }
  const explicit: string[] = [];
  for (const dataset of workbook.datasets) {
    if (dataset.cardinality === "single") {
      for (const [key, cell] of Object.entries(dataset.records[0]?.cells ?? {})) {
        if (/\.(document_title|part_heading)$/.test(key)) explicit.push(valueText(cell));
      }
    }
  }
  for (const group of groups) {
    for (const section of group.sections) {
      for (const item of section.items) {
        if (/document_title$/.test(item.fieldId ?? "") || /^document title$/i.test(item.label)) {
          explicit.push(valueText(item.cell));
        }
      }
    }
  }
  const title = explicit.find(
    (value) => value.length > 3 && value.length < 140 && !rowValues.has(norm(value)) && !/table\s+\d|column\s+\d/i.test(value),
  );
  if (title) return title;
  const family = workbook.processing_metadata.document_family_label;
  if (family && !/unknown|general/i.test(family)) return family;
  if (workbook.profile.display_name && !/generic/i.test(workbook.profile.display_name)) {
    return workbook.profile.display_name;
  }
  return "Document";
}

function subtitleFrom(groups: GroupDraft[], heading: string): string | null {
  for (const group of groups) {
    for (const section of group.sections) {
      for (const item of section.items) {
        if (/program\.institution$/.test(item.fieldId ?? "") || (/^supplier name$/i.test(item.label) && group.id === "parties")) {
          const value = valueText(item.cell);
          if (value && norm(value) !== norm(heading)) return value;
        }
      }
    }
  }
  return null;
}

// --- contract staging: three source-adaptive tabs ---------------------------------

const CONTRACT_SECTION_ORDER = [
  "Solicitation & Award",
  "Issuing Office",
  "Contractor / Offeror",
  "Contacts",
  "Performance",
  "Financial / Administrative",
];

/** A grid that keeps the source's own column headings ("MAX QUANTITY",
 * "Unit Price") — never shortened or renamed for display. */
function sourceGrid(
  dataset: StagingDataset | undefined,
  title: string,
  noun: [string, string],
  options: {
    allColumns?: boolean;
    inlineReview?: boolean;
    view?: string;
    note?: string;
    id?: string;
    supertitle?: string;
    hide?: string[];
    /** Explicit columns (relabelled per table), in order. */
    columns?: StagingColumn[];
  } = {},
): PresentationSection | null {
  if (!dataset || dataset.records.length === 0) return null;
  const { columns, detailColumns } = gridColumns(dataset);
  const byField = new Map(dataset.columns.map((column) => [column.canonical_field, column]));
  // A target template (Transformation View) shows every target column,
  // filled or not; business grids only populated source columns.
  // Columns the source prints stay even when empty ("QUANTITY", "UNIT").
  const printed = new Set(dataset.source_columns ?? []);
  const populated = new Set(columns.map((column) => column.canonical_field));
  const base = options.columns
    ? options.columns
    : options.allColumns
      ? dataset.columns
      : dataset.columns.filter((column) => populated.has(column.canonical_field) || printed.has(column.canonical_field));
  const shown = base
    .map((column) => (options.columns || options.allColumns ? column : (byField.get(column.canonical_field) ?? column)))
    .filter((column) => !options.hide?.includes(column.canonical_field));
  if (shown.length === 0) return null;
  return {
    id: options.id ?? (options.view ? `${dataset.dataset_id}:${options.view}` : dataset.dataset_id),
    supertitle: options.supertitle,
    title,
    pattern: "grid",
    items: [],
    dataset,
    columns: shown,
    detailColumns: options.allColumns ? [] : detailColumns,
    noun,
    view: options.view,
    inlineReview: options.inlineReview,
    note: options.note,
  };
}

function contractDetailSections(dataset: StagingDataset): PresentationSection[] {
  const buckets = new Map<string, FieldItem[]>();
  for (const record of dataset.records) {
    const cells = record.cells;
    const cell = cells["contract.detail.value"];
    const label = valueText(cells["contract.detail.label"]);
    if (!cell || isBlank(cell.value) || !label) continue;
    const section = valueText(cells["contract.detail.section"]) || "Solicitation & Award";
    buckets.set(section, [
      ...(buckets.get(section) ?? []),
      {
        id: `${dataset.dataset_id}:${record.record_id}`,
        label,
        cell,
        context: section,
        sourceLabel: valueText(cells["contract.detail.source_label"]) || null,
        fieldId: valueText(cells["contract.detail.field_id"]) || null,
        category: null,
        source: { datasetId: dataset.dataset_id, recordId: record.record_id, field: "contract.detail.value" },
      },
    ]);
  }
  const rank = (title: string) => {
    const index = CONTRACT_SECTION_ORDER.indexOf(title);
    return index === -1 ? CONTRACT_SECTION_ORDER.length : index;
  };
  return [...buckets.entries()]
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([title, items]) => ({ id: `contract_details:${title}`, title, pattern: "detail" as const, items }));
}

function groupRecords(dataset: StagingDataset, field: string): Map<string, StagingRecord[]> {
  const groups = new Map<string, StagingRecord[]>();
  for (const record of dataset.records) {
    const key = valueText(record.cells[field]);
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return groups;
}

/** Section J's list (grouped "J.1 MASTER CONTRACT ATTACHMENTS" / "J.2 …"),
 * else the V3 attachment references. */
function attachmentSections(list: StagingDataset | undefined, fallback: StagingDataset | undefined): (PresentationSection | null)[] {
  if (!list || list.records.length === 0) {
    return [sourceGrid(fallback, "Attachments / References", ["attachment", "attachments"], { inlineReview: true })];
  }
  const groups = [...groupRecords(list, "contract.attachment_item.group")];
  return groups.map(([group, records], index) =>
    sourceGrid({ ...list, records }, group || "Attachments / References", ["attachment", "attachments"], {
      inlineReview: true,
      id: `contract_attachments:${index}`,
      supertitle: index === 0 ? "Attachments / References" : undefined,
      hide: ["contract.attachment_item.group", "contract.attachment_item.section"],
    }),
  );
}

/** The contract body: each UCF section with its numbered subsections
 * (text in the record details) and the tables printed inside it, under
 * their own column headings. */
function contractBodySections(outline: StagingDataset | undefined, tables: StagingDataset | undefined): (PresentationSection | null)[] {
  const bySection = new Map<string, { subsections: StagingRecord[]; tables: Map<string, StagingRecord[]> }>();
  const entry = (section: string) => {
    const found = bySection.get(section) ?? { subsections: [], tables: new Map<string, StagingRecord[]>() };
    bySection.set(section, found);
    return found;
  };
  for (const record of outline?.records ?? []) entry(valueText(record.cells["contract.body.section"])).subsections.push(record);
  for (const record of tables?.records ?? []) {
    const group = entry(valueText(record.cells["contract.body_table.section"]));
    const id = valueText(record.cells["contract.body_table.table_id"]);
    group.tables.set(id, [...(group.tables.get(id) ?? []), record]);
  }
  const sections: (PresentationSection | null)[] = [];
  let first = true;
  for (const [heading, content] of bySection) {
    let supertitle: string | undefined = heading || "Contract Sections";
    if (outline && content.subsections.length > 0) {
      sections.push(
        sourceGrid({ ...outline, records: content.subsections }, "Subsections", ["subsection", "subsections"], {
          inlineReview: true,
          id: `contract_sections:${heading}`,
          supertitle,
          hide: ["contract.body.section"],
          note: first ? "Open a subsection for its full text." : undefined,
        }),
      );
      supertitle = undefined;
      first = false;
    }
    for (const [id, records] of content.tables) {
      if (!tables) continue;
      const headings = valueText(records[0].cells["contract.body_table.headers"]).split(" | ");
      const columns = headings.map((label, index) => {
        const column = tables.columns.find((c) => c.canonical_field === `contract.body_table.c${index + 1}`)!;
        return { ...column, display_label: label };
      });
      const subsection = valueText(records[0].cells["contract.body_table.subsection"]);
      sections.push(
        sourceGrid({ ...tables, records }, subsection ? `Table — ${subsection}` : "Table", ["row", "rows"], {
          inlineReview: true,
          id: `section_tables:${id}`,
          supertitle,
          columns,
        }),
      );
      supertitle = undefined;
    }
  }
  return sections;
}

const CLAUSE_SECTION = "contract.contract_clause.contract_section";
const CLAUSE_HEADING = "contract.contract_clause.source_heading";

/** Clauses as the contract lays them out: each contract section (Section
 * G …), and inside it each incorporation heading ("DFARS Clauses
 * Incorporated by Reference") as its own list, in document order. */
function clauseGroups(dataset: StagingDataset | undefined): PresentationSection[] {
  if (!dataset || dataset.records.length === 0) return [];
  const groups = new Map<string, { section: string; heading: string; records: StagingRecord[] }>();
  for (const record of dataset.records) {
    const section = valueText(record.cells[CLAUSE_SECTION]);
    const heading = valueText(record.cells[CLAUSE_HEADING]) || "Clauses";
    const key = `${section}\u0000${heading}`;
    const group = groups.get(key) ?? { section, heading, records: [] };
    group.records.push(record);
    groups.set(key, group);
  }
  const sections: PresentationSection[] = [];
  let previous: string | null = null;
  [...groups.values()].forEach((group, index) => {
    const grid = sourceGrid({ ...dataset, records: group.records }, group.heading, ["clause", "clauses"], {
      inlineReview: true,
      view: "Contract View",
      id: `contract_clauses:${index}`,
      supertitle: group.section && group.section !== previous ? group.section : undefined,
      hide: [CLAUSE_SECTION, CLAUSE_HEADING],
    });
    previous = group.section || previous;
    if (grid) sections.push(grid);
  });
  return sections;
}

/** Contracts: Contract Details, Contract Data and Clauses — what is inside
 * each comes from the document's own form, tables and clause sections. */
function composeContract(workbook: StagingWorkbook): PresentationManifest {
  const find = (id: string) => workbook.datasets.find((dataset) => dataset.dataset_id === id);
  const reasons: string[] = [];
  const groups: PresentationGroup[] = [];

  const details = find("contract_details");
  let detailSections = details && details.records.length > 0 ? contractDetailSections(details) : [];
  const summary = find("contract_summary");
  if (detailSections.length === 0 && summary && summary.records.length > 0) {
    const items = singleItems(summary, "Contract Details");
    if (items.length > 0) detailSections = [{ id: "contract_summary", title: null, pattern: "detail", items }];
  }
  if (detailSections.length > 0) groups.push({ id: "contract_details", label: "Contract Details", sections: detailSections });

  const lineItems = find("line_items");
  const lineSections = [
    sourceGrid(
      lineItems && lineItems.records.length > 0 ? lineItems : find("clins"),
      "Line Items",
      ["line item", "line items"],
      { inlineReview: true },
    ),
    sourceGrid(find("delivery_information"), "Delivery Information", ["delivery", "deliveries"], { inlineReview: true }),
  ].filter((section): section is PresentationSection => section !== null);
  const dataSections = [
    sourceGrid(find("funding"), "Funding", ["funding line", "funding lines"], { inlineReview: true }),
    ...attachmentSections(find("contract_attachments"), find("attachments")),
    ...contractBodySections(find("contract_sections"), find("section_tables")),
  ].filter((section): section is PresentationSection => section !== null);
  if (dataSections.length > 0) groups.push({ id: "contract_data", label: "Contract Data", sections: dataSections });
  if (lineSections.length > 0) groups.push({ id: "line_items", label: "Line Items", sections: lineSections });

  const clauses = find("contract_clauses");
  const clauseSections = [
    ...clauseGroups(clauses),
    sourceGrid(find("clause_transformation"), "Clause Transformation", ["clause", "clauses"], {
      allColumns: true,
      inlineReview: true,
      view: "Transformation View",
      note: "Only source-supported values are filled; empty columns have no approved source or rule yet.",
    }),
  ].filter((section): section is PresentationSection => section !== null);
  if (clauseSections.length > 0) groups.push({ id: "clauses", label: "Clauses", sections: clauseSections });

  for (const dataset of workbook.datasets) reasons.push(`contract:${dataset.dataset_id}:${dataset.records.length}`);
  const drafts = groups.map((group, rank) => ({ ...group, rank }));
  const heading = headingFrom(workbook, drafts);
  const refined = refineGroups(groups, heading);
  return {
    heading,
    subtitle: subtitleFrom(drafts, heading),
    family: workbook.processing_metadata.document_family,
    groups: refined,
    technical: workbook.datasets,
    reasons,
  };
}

export function composePresentation(workbook: StagingWorkbook): PresentationManifest {
  // A PDF Portfolio (special source) still explains itself through its
  // source documents, whatever the profile.
  if (workbook.profile.profile_id === "contract_v3" && workbook.outcome.status !== "special_source") {
    return composeContract(workbook);
  }
  const reasons: string[] = [];
  const drafts = new Map<string, GroupDraft>();
  const add = (id: string, label: string, rank: number, ...sections: (PresentationSection | null)[]) => {
    const kept = sections.filter((section): section is PresentationSection =>
      Boolean(section && (section.pattern === "grid" || section.items.length > 0)),
    );
    if (kept.length === 0) return;
    const draft = drafts.get(id) ?? { id, label, rank, sections: [] };
    draft.sections.push(...kept);
    drafts.set(id, draft);
  };

  const find = (id: string) => workbook.datasets.find((dataset) => dataset.dataset_id === id);
  const specialSource = workbook.outcome.status === "special_source";
  // FAR regulation sources lead with their clauses; the overview goes last.
  const hasClauses = workbook.datasets.some((dataset) => dataset.dataset_id === "far_clauses" && dataset.records.length > 0);
  const isTranscript = Boolean(find("student_program") || find("academic_record"));
  const other: FieldItem[] = [];
  const summaryExtras: FieldItem[] = [];
  const studentExtras: FieldItem[] = [];
  const rerouted: FieldItem[] = [];
  let chargesPlaced = false;

  for (const dataset of workbook.datasets) {
    const id = dataset.dataset_id;
    if (dataset.role === "qa" || (dataset.role === "source" && !specialSource) || (TECHNICAL_DATASETS.has(id) && !(specialSource && id === "source_documents"))) {
      reasons.push(`technical:${id}`);
      continue;
    }
    if (dataset.records.length === 0) {
      reasons.push(`empty:${id}`);
      continue;
    }
    const name = professionalLabel(dataset.display_name);

    if (dataset.role === "source") {
      add("source_documents", "Source Documents", 0, gridSection(dataset, null));
    } else if (id === "invoice_summary" || id === "contract_summary" || id === "document_summary" || /overview|award/.test(id)) {
      add("summary", id === "document_summary" ? "Document Details" : name, hasClauses ? 8 : 0, {
        id,
        title: null,
        pattern: "detail",
        items: singleItems(dataset, name),
      });
    } else if (id === "reference") {
      add("summary", "Invoice Summary", 0, { id, title: "References", pattern: "detail", items: singleItems(dataset, "References") });
    } else if (/supplier|customer|ship_to|remit|offeror|party|parties/.test(id) && dataset.cardinality === "single") {
      add("parties", "Parties", 1, { id, title: name, pattern: "detail", items: singleItems(dataset, name) });
    } else if (id === "student_program") {
      const items = fieldItems(dataset, "Student & Program");
      add(
        "student_program",
        "Student & Program",
        1,
        ...byCategory(items, id, (category) =>
          /student/i.test(category) ? "Student" : /program|course|degree/i.test(category) ? "Program" : businessLabel(category) || "Student",
        ),
      );
    } else if (id === "academic_summary") {
      summaryExtras.push(...fieldItems(dataset, "Academic Summary"));
    } else if (id === "other_information" || id === "other_fields" || id === "key_fields") {
      const items = fieldItems(dataset, "Other Information");
      if (id === "key_fields" && !isTranscript) {
        add("summary", "Document Details", 0, { id, title: null, pattern: "detail", items });
        continue;
      }
      for (const item of items) {
        if (isTranscript && SUMMARY_LABEL.test(item.label)) summaryExtras.push({ ...item, context: "Academic Summary" });
        else if (isTranscript && STUDENT_LABEL.test(item.label)) studentExtras.push({ ...item, context: "Student & Program" });
        else other.push(item);
      }
    } else if (id === "contacts") {
      add("contacts", "Contacts", 1, { id, title: null, pattern: "detail", items: fieldItems(dataset, "Contacts") });
    } else if (id === "document_sections") {
      // The document's own text reads right after its summary.
      add("content", "Content", 0.5, ...textSections(dataset));
    } else if (id === "taxes_charges" || id === "totals") {
      chargesPlaced = true;
    } else if (id === "invoice_lines" || id === "line_items") {
      const lines = dataset.records.filter((record) => {
        const charge = id === "invoice_lines" ? chargeRow(record) : null;
        if (charge) {
          rerouted.push({
            id: `${id}:${record.record_id}`,
            label: charge.label,
            cell: charge.cell,
            context: "Charges & Totals",
            sourceLabel: charge.label,
            fieldId: charge.cell.canonical_field,
            category: null,
            source: { datasetId: id, recordId: record.record_id, field: charge.cell.canonical_field },
          });
        }
        return !charge;
      });
      add("lines", "Line Items", 2, gridSection({ ...dataset, records: lines }, null, ["item", "items"]));
    } else if (id === "distributions") {
      add("lines", "Line Items", 2, gridSection(dataset, "Distributions", ["distribution", "distributions"]));
    } else if (id === "academic_record") {
      add("academic_record", "Academic Record", 2, gridSection(dataset, null, ["course", "courses"]));
    } else if (dataset.cardinality === "single") {
      add(id, name, 2, { id, title: null, pattern: "detail", items: singleItems(dataset, name) });
    } else if (fieldColumns(dataset)) {
      other.push(...fieldItems(dataset, "Other Information"));
    } else {
      add(id, name, /clause|clin/.test(id) ? 2 : 3, gridSection(dataset, null, ["record", "records"]));
    }
    reasons.push(`group:${id}`);
  }

  if (chargesPlaced || rerouted.length > 0) {
    add("charges", "Charges & Totals", 3, {
      id: "charges",
      title: null,
      pattern: "summary",
      items: invoiceCharges(find("totals"), find("taxes_charges"), rerouted),
    });
  }
  if (studentExtras.length > 0) {
    add("student_program", "Student & Program", 1, { id: "student_extras", title: "Program", pattern: "detail", items: studentExtras });
  }
  if (summaryExtras.length > 0) {
    add("academic_summary", "Academic Summary", 3, {
      id: "academic_summary",
      title: null,
      pattern: "summary",
      items: dedupeItems(summaryExtras),
    });
  }

  // All-fields inventories only contribute values no business group shows.
  const inventory = find("all_fields");
  if (inventory) {
    const shown = shownValues([...drafts.values()]);
    for (const item of other) shown.add(norm(valueText(item.cell)));
    // With the document's sections shown, its headings are not values.
    const hasSections = Boolean(find("document_sections")?.records.length);
    const leftovers = fieldItems(inventory, "Other Information").filter(
      (item) =>
        !shown.has(norm(valueText(item.cell))) &&
        !/^(line|course|clin|clause)\s*\d+\s*\//i.test(item.label) &&
        !(hasSections && item.category === "Heading"),
    );
    const { sections: tables, rest } = pivotTables(leftovers);
    add("tables", "Table Data", 4, ...tables);
    if (rest.length <= LEFTOVER_LIMIT) other.push(...rest);
    else reasons.push(`leftovers-in-technical:${rest.length}`);
  }
  if (other.length > 0) {
    add("other", "Other Information", 9, ...subsections(other, "other", ["Institution", "Certification", "Accreditation", "Shipping & Commercial", "Notes"]));
  }

  // Unique tab rule: groups resolving to the same label are one group.
  const byLabel = new Map<string, GroupDraft>();
  for (const draft of [...drafts.values()].sort((a, b) => a.rank - b.rank)) {
    const key = norm(draft.label);
    const existing = byLabel.get(key);
    if (existing) existing.sections.push(...draft.sections);
    else byLabel.set(key, { ...draft, sections: [...draft.sections] });
  }
  const groups = [...byLabel.values()].map((draft) => ({
    id: draft.id,
    label: draft.label,
    sections: mergeSections(draft.sections),
  }));

  const heading = headingFrom(workbook, [...drafts.values()]);
  return {
    heading,
    subtitle: subtitleFrom([...drafts.values()], heading),
    family: workbook.processing_metadata.document_family,
    groups: refineGroups(groups, heading),
    technical: workbook.datasets,
    reasons,
  };
}

// --- one adaptive presentation rule for every profile ---------------------------

const SUMMARY_IDS = new Set(["summary", "contract_details"]);
const DOCUMENT_LEVEL_TITLES = /^(institution|certification|accreditation|issuer|document)/i;
const OTHER_INLINE_LIMIT = 3;
const REFERENCE_INLINE_LIMIT = 2;

function itemCount(sections: PresentationSection[]): number {
  return sections.reduce((total, section) => total + (section.pattern === "grid" ? section.dataset?.records.length ?? 0 : section.items.length), 0);
}

/** "Invoice Details"; a long document title reads "Document Details". */
function detailsTitle(heading: string): string {
  const base = heading.replace(/\s+details$/i, "");
  return base.length <= 32 ? `${base} Details` : "Document Details";
}

/** Tabs come from meaningful content, not datasets:
 * - the summary tab is always "Summary" and comes first; a document with
 *   no summary dataset gets one from its document-level details
 *   (institution, certification);
 * - Summary reads as cards: the first, untitled one is "<Document> Details";
 *   one or two references join it, a References block only when there
 *   are more;
 * - Other Information is a tab only when it holds more than a handful of
 *   values — otherwise those values close the Summary;
 * - graduation requirements read with the Academic Summary. */
export function refineGroups(input: PresentationGroup[], heading: string): PresentationGroup[] {
  let groups = input.map((group) => ({ ...group, sections: [...group.sections] }));
  const other = groups.find((group) => group.id === "other");
  let summary = groups.find((group) => SUMMARY_IDS.has(group.id));

  if (other) {
    const academic = groups.find((group) => group.id === "academic_summary");
    if (academic) {
      const requirements = other.sections.filter((section) => /graduation|requirement/i.test(section.title ?? ""));
      academic.sections.push(...requirements);
      other.sections = other.sections.filter((section) => !requirements.includes(section));
    }
    if (!summary) {
      const documentLevel = other.sections.filter((section) => DOCUMENT_LEVEL_TITLES.test(section.title ?? ""));
      if (documentLevel.length > 0) {
        summary = { id: "summary", label: "Summary", sections: documentLevel };
        other.sections = other.sections.filter((section) => !documentLevel.includes(section));
        groups.unshift(summary);
      }
    }
  }

  if (summary) {
    summary.label = "Summary";
    const references = summary.sections.find((section) => /^references$/i.test(section.title ?? ""));
    const first = summary.sections.find((section) => section.pattern === "detail" && section !== references);
    if (references && first && references.items.length <= REFERENCE_INLINE_LIMIT) {
      first.items = [...first.items, ...references.items];
      summary.sections = summary.sections.filter((section) => section !== references);
    }
    summary.sections = summary.sections.map((section, index) =>
      section.pattern === "detail"
        ? {
            ...section,
            pattern: "card" as const,
            title: section.title ?? (index === 0 ? detailsTitle(heading) : null),
          }
        : section,
    );
  }

  if (other) {
    const count = itemCount(other.sections);
    if (count === 0) {
      groups = groups.filter((group) => group !== other);
    } else if (count <= OTHER_INLINE_LIMIT) {
      const items = other.sections.flatMap((section) => section.items);
      const target = summary ?? { id: "summary", label: "Summary", sections: [] };
      target.sections.push({ id: "additional_information", title: "Additional Information", pattern: "card", items });
      groups = groups.filter((group) => group !== other);
      if (!summary) groups.push(target);
    } else if (other.sections.length === 1 && other.sections[0].title) {
      // One coherent subject (e.g. Shipping & Commercial) names its own tab.
      other.label = other.sections[0].title;
      other.sections = [{ ...other.sections[0], title: null }];
    }
  }
  return orderGroups(groups.filter((group) => group.sections.length > 0));
}

/** The extraction workspace's tab order (Original Structure, the document's
 * own layout, is added before these by the workspace). Groups a profile adds
 * (Parties, Charges & Totals, Academic Record…) keep their relative order
 * between Contacts and Table Data. Summary is always last. */
const TAB_RANK: Record<string, number> = {
  content: 1,
  contacts: 2,
  parties: 2.5,
  student_program: 2.5,
  lines: 3,
  tables: 5,
  other: 6,
};

export function orderGroups(groups: PresentationGroup[]): PresentationGroup[] {
  const rank = (group: PresentationGroup) => (SUMMARY_IDS.has(group.id) ? 99 : TAB_RANK[group.id] ?? 4);
  return groups
    .map((group, index) => ({ group, index }))
    .sort((a, b) => rank(a.group) - rank(b.group) || a.index - b.index)
    .map(({ group }) => group);
}

/** Detail sections with the same heading become one. */
function mergeSections(sections: PresentationSection[]): PresentationSection[] {
  const merged: PresentationSection[] = [];
  for (const section of sections) {
    const twin = section.pattern !== "grid"
      ? merged.find((existing) => existing.pattern === section.pattern && norm(existing.title ?? "") === norm(section.title ?? ""))
      : undefined;
    if (twin) twin.items = dedupeItems([...twin.items, ...section.items]);
    else merged.push({ ...section, items: dedupeItems(section.items) });
  }
  return merged;
}
