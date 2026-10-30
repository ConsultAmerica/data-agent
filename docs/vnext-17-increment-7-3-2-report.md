# Increment 7.3.2 — Hierarchical Extraction and Original Structure Export

Branch `feature/di-02-safety-foundation`. Nothing is committed, pushed or deployed.

## Where the hierarchy now lives

`backend/app/source_structure/original_layout.py` decides the hierarchy and data quality
once, for every record:

- section › numbered item › sub-field;
- table › row.

Consumers read it from the layout and none of them re-derives it:

- Original Structure;
- Smart Review cards;
- the record details drawer;
- the Excel, CSV and JSON exports.

The frontend's own item-number regex (`fieldPlacement` in `original-structure-view.tsx`)
was removed. The export's copy (`item_parts` in `original_export.py`) moved into the
layout.

New fields in `GET /api/documents/{id}/original-structure`:

| Record | New fields |
|---|---|
| Field | `item` `{id, number, name, has_subfields}` or null · `field_name` · `item_start` · `parent_id` (item id, else section id) · `quality` · `quality_label` · `ocr_confidence` / `ocr_contested` (unverified OCR only) |
| Table | `parent_id` (section id) · `context` `[{label, value, record_key, page}]` · `context_source` `printed` \| `inherited` \| null |
| Table row | `parent_id` (table key) · `bbox` (union of its cell boxes) · `cell_issues` `[{column, quality, message}]` (only cells worth a second look) |
| Section | `parent_id` (its part's id, for subsections) |
| Layout | `document_context` · `quality_labels` · `stats.quality` · `stats.cell_issues` |

Item ids are built from the section id, the item number and the item name. They are the
same on every rebuild of the same document (tested).

## By requirement

### 1. Numbered fields
- Item # and the item name are written on the item's first row only.
- Each sub-field has its own row, with the parent cells left blank.
- Field order is unchanged.
- An item that is its own field ("3. Briefed Through") has no sub-attribute.

### 2. Native tables
Tables keep, unchanged:
- their printed headers, column order and row order;
- blank cells;
- dates and amounts, as printed text;
- the source page of every row.

Tables are never flattened into key/value records:
- The selected-records CSV used to turn rows into "Header: cell | …" lines. It now writes
  each table under its own headers.
- Smart Review already kept tables as tables.

### 3. Table-specific schemas
No generic column set is imposed. Each table keeps the headers printed in the source, so
the Contract Period and Contract Modifications tables export with their own columns,
including extra ones such as "Fee Ceiling Value" and "Funding".

### 4. Parent metadata
Contractor Name, Contract Number, Oracle Project Number and Contract Type are found by the
printed wording of their fields (`CONTEXT_FIELDS`). Each table gets the block that belongs
to it:

- **printed:** the document prints the block in the table's own section, before the
  table. It is already shown there once, so nothing is added.
- **inherited:** the table has no block of its own, so it takes the nearest block printed
  before it, never the document's first block. A brief can describe several contracts:
  - the fixture's accrual table (page 6) belongs to `C05550001.00.9999`;
  - its contractor is printed blank and stays blank.

The block is shown once above the table, never in its rows. This applies on screen (an
inherited table's context line) and in Excel.

### 5. Excel export
The Export menu entry is now **Excel → Original Document Structure**. It produces one
worksheet, "Original Structure", in reading order:

- a section row for each printed heading;
- the field columns `Item # | Section / Field Name | Extracted Value | Field Details /
  Sub-Attributes` at the start of each run of fields;
- for each table:
  - its title and source pages;
  - the inherited metadata line, when it has one;
  - its printed header row;
  - its rows.

Formatting and data rules:
- Bold headings and header rows, with a light fill.
- No merged cells anywhere, so every value can be edited, sorted and filtered.
- Values are written as text exactly as printed, and formulas are never executed.

### 6. Data quality
Every field has exactly one state:

| Code | Shown as | When |
|---|---|---|
| `confirmed` | Confirmed source value | Read from the source; nothing contradicts it |
| `unreadable` | Unreadable source value | Text contains U+FFFD or is a run of `#` (too wide for its printed cell) |
| `missing_extraction` | Missing extraction | The page shows a value; extraction found none |
| `blank` | Blank in source | Printed blank and nothing extracted |
| `conflicting` | Conflicting candidates | Candidates disagree, extraction read another value, or the value belongs to another label |
| `unverified_ocr` | Unverified OCR result | OCR-read below the staging validator's 0.80 bar (or contested, or no confidence), not yet approved |
| `unlocated` | Source position not found | Extracted, but the printed position wasn't found; never claimed as confirmed |

Table cells:
- An empty cell is printed blank.
- `cell_issues` lists only cells that are unreadable or unverified OCR, so large tables
  stay small.
- Reviewing a row clears its unverified-OCR marks.

In Excel:
- every state other than confirmed or blank adds a cell comment on the value, with OCR
  confidence and the other candidates when known;
- the value itself is never changed or filled in.

Modification ranges are never expanded into rows. Nothing in the code does that (checked).

### 7. Source traceability
- Fields already opened their exact region.
- Table rows now record their printed region (`bbox`). Selecting a row boxes the whole
  row on the page (browser-checked on the fixture's modification rows).
- Without a box, a row falls back to text search, as before.

### 8. UI consistency

| Surface | Uses the layout's hierarchy |
|---|---|
| Original Structure | Item #, name, sub-attribute and Data Quality columns come from `item` / `field_name` / `quality`. Inherited table context line. Cell-issue tints with their message as a tooltip |
| Smart Review | Each card shows its chosen candidate's data quality. Candidates name their original item |
| Record details | "Original label … under 1. Contractor Information" from `item`. A Data quality row |
| Excel, CSV | One row builder (`original_export.original_rows`) |
| JSON | `structured.json` embeds the layout, so it carries the same fields |
| Advanced Grid | **Not changed.** See gap 1 |

## Acceptance criteria

| # | Criterion | Evidence |
|---|---|---|
| 1 | Item numbers once per parent | `test_original_document_structure_export_is_one_editable_sheet_in_document_order`: "10." appears once. UI test: `item-number` cells |
| 2 | Section labels not repeated | Same test: "Acquisition Agency" appears once. `rowspan` UI test |
| 3 | Nested fields keep their parent | `test_numbered_items_are_decided_once_in_the_layout`: `parent_id`, `item_start`, stable ids |
| 4 | Tables keep column names and row order | Export test: summary and both modification tables match their printed headers; mod numbers run 1…82 in order |
| 5 | Contract metadata once above each table | `test_table_metadata_belongs_to_the_contract_printed_above_it`. Export: one context line, none above tables with a printed block |
| 6 | Blank and unreadable handled | `test_quality_states_follow_the_source_and_extraction` (every state). `test_values_that_are_not_confirmed_carry_a_note_and_are_never_changed` |
| 7 | Excel readable and editable | One sheet, no merges, every cell text (export test). Manual check of the generated workbook |
| 8 | Source evidence accessible | Row `bbox`. Browser check of the field and row regions. Evidence and page kept on every field |
| 9 | No records lost | `test_the_export_loses_no_record`: one export row per field and per table row, in order |
| 10 | Oracle mapping and review intact | Full backend suite. Staging and Oracle code untouched. Review endpoints unchanged |

## Tests

| Suite | Result |
|---|---|
| Backend: full suite | 1,326 passed, 14 skipped |
| Backend: `test_original_structure.py` + `test_document_workspace.py` | 43 passed (7 new tests) |
| Frontend: Original Structure, verification, documents | 74 passed |
| Frontend: full suite | 632 passed |

**Browser walkthrough** on the contract brief fixture (6 pages), at 1600×1000, local API
and local frontend, with no console errors. It checked:
- the field grid's Item # / name / sub-attribute layout;
- "Blank in source" chips;
- the inherited context line above Contract Summary, and none above the modification
  tables;
- a field click boxing its exact value, and a row click boxing the whole row.

## Remaining gaps

1. **The Advanced Grid is not on the layout hierarchy.** It shows the staging profile's
   datasets, which feed Oracle mapping and their own exports. Moving it onto the layout
   would change those contracts, so it was left as is.
   - Its row datasets (CLINs, funding, modifications) don't repeat contract metadata;
     that lives once in Contract Summary.
   - Grid ↔ record selection still links the two.
2. **CSV carries no quality notes.** A CSV has no comments. Quality is in the Excel
   comments, the UI and the JSON.
3. **Metadata is matched by a fixed list of printed labels** (`CONTEXT_FIELDS`). A
   contract that names them differently (e.g. "Vendor") gets no context until the list
   grows. Non-contract documents get none.
4. **"Unreadable" is detected from the text only** (U+FFFD, `#####`). An OCR misread
   that produces plausible characters shows as unverified OCR, not unreadable.
5. **The table title is the nearest printed heading.** The structure has no separate
   caption. When it equals the section title, Excel writes "Table" with the source pages,
   rather than repeating the heading.
6. **Reverse selection** (click the page → record) still covers fields only, though rows
   now have boxes.
7. **Deployment:** frontend and backend must ship together. Without the new backend
   fields, the grid shows no item numbers.
