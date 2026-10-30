# Original File tab: final validation report

Branch `feature/di-02-safety-foundation`. **Nothing is committed, pushed or deployed.** This
builds on Increment 7.3.2 (`docs/vnext-17-increment-7-3-2-report.md`), which is also
uncommitted on this branch.

## Result

The backend suite ran first, to completion. The frontend suite ran on its own afterwards.

| Test area | Total | Passed | Failed | Skipped | Result |
|---|---|---|---|---|---|
| Backend | 1,350 | 1,336 | 0 | 14 | Pass |
| Frontend | 638 | 638 | 0 | 0 | Pass |
| Original File tab: grouping, no repeated labels | 19 UI tests + 3 documents in the browser | all | 0 | 0 | Pass |
| Excel export: one worksheet, right sections and tables | 3 workbooks; 23 tab-vs-Excel comparisons | all | 0 | 0 | Pass |
| Multi-contract metadata | 2 tests + the brief's two contracts | all | 0 | 0 | Pass |
| Source verification: field and row highlighting | 7 browser clicks | 7 | 0 | 0 | Pass |
| Oracle mapping regression | 43 | 42 | 0 | 1 | Pass |
| Integration: frontend with backend | Local frontend against the local API, 3 documents | all | 0 | 0 | Pass |

Summary of the checks:

| Suite | Result |
|---|---|
| Backend: full suite | **1,336 passed, 0 failed, 14 skipped** |
| Frontend: full suite | **638 passed, 0 failed** |
| Frontend type check (`tsc --noEmit`) | Clean |
| Tab vs Excel, compared in the browser | **0 differences** on 3 documents |
| Source highlighting on field and row clicks | Exact region, correct value, on 3 documents |

Lint (`eslint`) on the changed frontend files reports 4 errors and 2 warnings.

**Disposition: carried over, not fixed in this release.** All six are on lines this change
doesn't touch (the diff only changes lines 360 and 653 of `document-workspace.tsx` and line
217 of `presentation-workspace.tsx`):

| File : line | Rule | Finding |
|---|---|---|
| `document-workspace.tsx:170` | `react-hooks/set-state-in-effect` | setState called directly in an effect |
| `document-workspace.tsx:198` | `react-hooks/set-state-in-effect` | setState called directly in an effect |
| `document-workspace.tsx:218` | `react-hooks/exhaustive-deps` (warning) | `datasets` changes the `useMemo` dependencies on every render |
| `document-workspace.tsx:241` | `react-hooks/set-state-in-effect` | setState called directly in an effect |
| `document-workspace.tsx:279` | `react-hooks/purity` | Impure call during render |
| `presentation-workspace.tsx:29` | `no-unused-vars` (warning) | `SelectedExportFormat` imported but unused |

Fixing them means changing the document workspace's loading effects, which is outside this
release. The build doesn't run ESLint and the tests pass, so none of them blocks the
deploy. They should be fixed in a separate change.

## Validation by item

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Current implementation kept; Advanced Grid unchanged | Pass | No file under `staging/`, Oracle, mapping or Advanced Grid code changed. The only diffs in workspace files are the tab label and the table-row source region. Advanced Grid / staging tests: 54 passed. |
| 2 | Item numbers and section labels once per group | Pass | Export test: "10." and "Acquisition Agency" appear once. UI test: one `rowspan` cell per item, covering its split rows. Browser comparison: identical item-number sequences in the tab and Excel. |
| 3 | Tables keep their headings, columns, rows, blank values and order | Pass | Export test: mod numbers 1–82 in order and printed headers unchanged. Hoisting test: every row kept in order and blank cells stay blank. Browser comparison: identical columns and row counts on 8 tables. |
| 4 | Multiple contracts: no metadata across contract boundaries | Pass | New `test_each_table_shows_only_its_own_contract_in_a_multi_contract_document` on a generated two-contract PDF; details below. The existing brief fixture's second contract (`C05550001.00.9999`) still gets only its own block. |
| 5 | Configurable label aliases, printed labels kept | Pass | New `metadata_aliases.json`, extendable with `METADATA_ALIASES_PATH`. Context lines show the label as printed ("Legal Entity: …", "Vendor Name: …"), with the concept name in the tooltip. Covered by `test_metadata_aliases_are_configurable_and_printed_labels_are_kept`. |
| 6 | Extraction quality kept apart from source location | Pass | The `unlocated` quality state is gone. A value without coordinates gets the neutral quality **Extracted value** and a separate `source_location` (`exact`, `page`, `none`). Covered by `test_source_location_is_kept_apart_from_data_quality` and a UI test. |
| 7 | Clicking a field or row highlights the right evidence | Pass | Browser check; details below. |
| 8 | Tab and Excel use the same hierarchy | Pass | Browser comparison; details below. |
| 9 | Frontend and backend integration, local | Pass | Local frontend (port 3123) against the local API (port 8001), checked by the API calls the browser made. No console errors on any page. |
| 10 | Regression: extraction, review, Advanced Grid, Oracle, exports | Pass | Full backend suite; by area below. |

### Item 4: multi-contract document

Generated PDF, in order:
1. Contract A (Vendor Name ALPHA LLC, Contract No. A-100) and its periods table;
2. Contract B (Agreement Number B-200 only) and its periods table;
3. an Accruals table whose rows name C-300;
4. a Funding table with rows for A-100 and B-200.

| Table | Shown above it | Why |
|---|---|---|
| Contract A Periods | Vendor Name: ALPHA LLC · Contract No.: A-100 | Nearest block before it |
| Contract B Periods | Agreement Number: B-200 | B's own block. **A's vendor is not carried in**, even though B printed no vendor. |
| Accruals | Contract No.: C-300, once (column hoisted) | Its rows name another contract, so nothing of B is inherited |
| Funding by Contract | Nothing. Each row keeps its own contract number. | Rows of several contracts, so nothing is inherited |

Rules, in `_apply_table_context` and `_reconcile_context`:
- A block replaces the previous one. It is never merged with it.
- A table's own contract-number column overrides inherited metadata. A different contract,
  or several, is treated as a boundary.

### Item 7: source highlighting (browser, 1600×1000)

| Document | Click | Source panel |
|---|---|---|
| Sample contract | Field Contract Number | Page 1 · exact region · highlights `FA30-001` |
| Sample contract | Table row Option 1 | Page 1 · exact region · the whole printed row boxed |
| Two contracts | Field Vendor Name | Page 1 · exact region · `ALPHA LLC` |
| Two contracts | Row Contract A Periods / Option 1 | Page 1 · exact region · that row, not contract B's Option 1 |
| Contract brief (6 pages) | Field Legal Entity | Page 1 · exact region · `ORBITAL FIELD SERVICES, LLC` |
| Contract brief | Row Contract Summary / OPTION YEAR | Page 3 · exact region · that row |
| Sample contract | ↳ Start Date sub-row | Opens Period of Performance and boxes the printed range |

The positions were checked against the page in the screenshots.

### Item 8: tab vs Excel (browser DOM vs downloaded workbook)

| Document | Sections | Tables | Comparisons | Differences |
|---|---|---|---|---|
| Sample contract | 2 | 1 | 4 | 0 |
| Two contracts | 6 | 4 | 11 | 0 |
| Contract brief | 4 | 3 | 8 | 0 |

Each comparison checks:
- section order;
- per section: item numbers, split-field rows and table count;
- per table: title, columns, metadata line and row count.

Every workbook has one sheet, `Original File`, and no merged cells.

### Item 10: backend regression by area

| Area | Passed | Failed | Skipped |
|---|---|---|---|
| Original File, layout and exports | 124 | 0 | 1 |
| Advanced Grid / staging | 54 | 0 | 0 |
| Oracle mapping | 42 | 0 | 1 |
| Review | 53 | 0 | 0 |
| Extraction, structure and OCR | 346 | 0 | 8 |
| Other | 717 | 0 | 4 |
| **Total** | **1,336** | **0** | **14** |

The skips are environment-gated tests, skipped as before. This change added none.

## What this change does

| Area | Behaviour |
|---|---|
| Tab | "Original Structure" is renamed **Original File**. No tab was added. |
| Parent information once | A table column naming the same contract, item, PO, invoice, account, vendor or other alias in every row is shown once above the table. A value that changes between rows stays in the rows. The cells are not changed. |
| Contract metadata | Shown once above a table, under its printed label. Inherited only from the nearest block, and never across a contract boundary. |
| Composite fields | A printed range of two dates gets **↳ Start Date** and **↳ End Date** rows, and the printed text is kept. An open range (`07/01/2025 -`) is not split. Nothing else is split. |
| Running page headers | A heading repeated on each page doesn't start a new section of the same name. A repeated header field is kept, marked as a repeat. |
| Tables across pages | Merged only where the structure reader linked the pages. A repeated page header in between doesn't block the merge, and row numbers may keep their step (260 → 270). |
| Empty artifacts | Fields with no value, no letters in the label, no extraction row, no flag and no review are left out. The count is shown and nothing is deleted. |
| Quality vs location | **Missing — Review Required** (printed but not extracted), **Blank in source**, **Extracted value** (no printed position, not an error). Location is reported separately: exact region, page only, or none. |
| Readable labels | Technical names become labels (`contract_no` → Contract Number). Printed labels are never changed. Field keys and Oracle mappings are untouched. |
| Excel | One sheet `Original File`, file `<name> - original file.xlsx`. Columns are sized to content (10–60) and long text wraps. Headings and the metadata line run across empty cells. Blank rows separate sections. No merged cells. Values are stored as text. Quality and location go in comments. |

## Exact changes needed to deploy

**Backend (Render service `data-agent-backend-qbmc`, manual deploy):**

| File | Change |
|---|---|
| `app/source_structure/original_layout.py` | Hierarchy, data quality, source location, aliases, contract boundaries, shared columns, composite parts, running headers, artifacts, table continuation |
| `app/source_structure/original_export.py` | `Original File` sheet, row builder, notes, widths |
| `app/source_structure/metadata_aliases.json` | **New file.** It must ship with the code; the layout reads it at start. |
| `app/core/config.py` | New optional setting `metadata_aliases_path` (env `METADATA_ALIASES_PATH`). Leave it unset to use the built-in list. |
| `app/api/original_structure.py` | Download name, CSV rows, selected-records stats |
| `app/api/document_workspace.py` | CSV uses the same row builder |
| `app/skills/business_data.py` | Smart Review candidates carry item and quality |

No database migration. No environment variable is required.

**Frontend (Vercel, deploys automatically from `main`):**

| File | Change |
|---|---|
| `components/original-structure/original-structure-view.tsx` | Grid, tables, context line, split rows, source location, tab text |
| `lib/original-structure.ts` | New layout fields |
| `components/verification/record-details.tsx`, `field-card.tsx`, `verification-workspace.tsx` | Data quality, source location, row region, tab label |
| `components/staging/presentation-workspace.tsx` | Tab label |
| `components/documents/document-workspace.tsx`, `lib/verification.ts` | Export entry "Excel → Original File" |

**Order:** deploy the backend to Render first, then merge to `main` for Vercel. The new
frontend still works against the old backend, but it shows no item numbers, split rows,
hoisted columns or source location, and the export keeps its old sheet name. After the
Render deploy, check that `GET /api/documents/{id}/original-structure` returns
`source_location` and `shared_columns`.

## Remaining limitations

1. **Composite splitting covers date ranges only.** Addresses, "City, ST ZIP" and amount-plus-currency are left whole.
2. **Group columns and metadata are recognised by wording.** It comes from the built-in identifier list plus the alias file. A shared column named otherwise stays in the rows until its wording is added to the alias file.
3. **A contract boundary is detected from the table's own contract-number column.** A contract that prints its block *after* its table, with no number in the rows, would still inherit the previous contract's block.
4. **Page headers are recognised by exact repetition only.** A varying header ("Page 2 of 3") still interrupts a section or table.
5. **Tables merge only where the structure reader linked the pages.** In the multi-page invoice fixture, pages 1–2 merge (43 rows) but page 3 stays separate.
6. **The tab hides two things the Excel export keeps:** unlabelled columns that are empty in every row, and fully empty ruled rows. This was already the case before this change, and the comparison documents had neither.
7. **No schema-required field list is consulted.** "Missing — Review Required" covers values the page shows but extraction missed, and extraction rows without a value.
8. **Image-only documents show no fields until OCR has run.** OCR was not run in these checks.
9. **CSV carries no quality, location or split comments.** A CSV can't hold comments.
10. **Local data:** two test documents were uploaded to the local development database (`sample-contract.pdf` `a93d15fe-…`, `two-contracts.pdf` `df508a78-…`). Nothing was sent to staging or production.
