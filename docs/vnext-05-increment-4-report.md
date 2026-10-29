# VNext Increment 4 — Smart View, Smart Tables and Contextual Review

Status: implemented locally, tested, **not committed, pushed or deployed**.
Date: 2026-10-28 · Branch: `feature/di-02-safety-foundation` (working tree)

Principle: *show the right information, in the right layout, for the right document type.*

## 1. UI audit (before this increment)

| Problem in the existing workspace | Effect on the user |
|---|---|
| One wide technical grid per dataset; all 20+ `contract.data.*` slots shown for every record type | Clauses showed empty pricing columns; CLINs showed empty clause columns |
| Clauses, CLINs, deliveries, sections and references mixed in one "Contract Data" table | The user had to filter by Section to find anything |
| Source viewer, data and review status shared one split, which didn't persist | Evidence was lost when the user scrolled or switched tabs |
| "Verified" status read as approval | Automatic evidence checks were confused with a person's approval |
| No per-category Oracle status | Clauses and deliveries looked exportable to Oracle when no import object exists for them |
| Column choices weren't remembered; no column pinning, reordering or global search | Analysts set up the grid again on every visit |

## 2. What was built

### Two modes on the document workspace
- **Smart View (default)**: content organised by document type, showing only relevant fields, with source evidence next to the values.
- **Advanced Grid (optional)**: the existing workspace, unchanged. All datasets, every column through the column selector, plus the existing review, export and Oracle actions.
- The choice is stored per browser (`dx-workspace-mode`).

### Three-panel contextual review (`smart-workspace.tsx`)
- Panels: **Source** (PDF/image evidence, highlighted page) | **Data** (category view) | **Intelligence** (review signals, extracted values, classification, Oracle status).
- Side panels can be collapsed, and resized by drag or arrow keys (source 300–820 px, intelligence 260–520 px). Layout is saved in `dx-smart-layout`.
- Under 1280 px the side panels become drawers opened with *Source* / *Intelligence* buttons. In the walkthrough at 820 px no side panel was shown inline.
- Selecting a record loads the full record and opens its source page, highlighting the extracted text.

### Contract categories (`contract-smart-view.tsx`)
Records are grouped by the extraction's section, which works the same across the DoD, OASIS and SF 1442 profiles:

| Tab | Content | Notes |
|---|---|---|
| Overview | Metric cards | Counts come from the data. Empty categories are dimmed but can still be opened. |
| Contract Header | Field cards grouped as on the form, each with its evidence badge | "Correct" links to Metadata review. Amounts are never added together. |
| Contract Lines | CLIN (pinned), description, quantity, pricing, amount, performance period | Rows expand to show pricing, delivery schedules, destination/DODAAC/FOB and Oracle mapping. Related clauses say "not linked" because the extraction doesn't link them. |
| Parties & Contacts | Grid | |
| Deliveries & Performance | Grid plus an optional **timeline** | The timeline uses only valid printed start and end dates and follows the table's search and filters. |
| FAR/DFARS Clauses | Clauses and *References in the text* in separate sub-tabs | Regulation filter. When the extraction gives no regulation, it is derived from the section and labelled "Regulation (from section)". |
| Sections A–J, Attachments | Grids | |
| All Records | Every column of the dataset | |
| Oracle Mapping | Status per category | Object names come only from saved mappings on uploaded templates. Clauses, deliveries, attachments and sections show **"No Verified Oracle Import Destination"**. |

### Other document types (`GenericSmartView`)
- Invoices, passports, transcripts and unknown types use the document's assigned schema (Increment 3) and render as a schema form.
- Clicking a value opens its evidence in the source panel. Example: the invoice `f1_digital_simple.pdf` is organised by "Invoice v1.0" with Summary, Lines, Taxes and Totals tabs.

### SmartDataGrid (`smart-data-grid.tsx`), reusable
- **Columns:** resize, drag to reorder, show/hide, pin/unpin (pinning is turned off under 768 px), reset.
- **Empty columns:** columns that are empty for every filtered row are hidden. "Show all fields (+N empty)" brings them back.
- **Sorting:** numeric-aware, so 0002 sorts before 0010. Empty values sort last.
- **Search and filters:** global search; per-column text or option filters, shown as filter chips with "Clear all".
- **Display:** one-line, two-line or wrapped text; comfortable or compact density; pagination at 25/50/100/250 rows.
- **Selection:** row selection and select-all-results. Bulk actions are limited to **export selected** and **copy**. No bulk approval, so no review state is changed from the grid.
- **Copy and keyboard:** copy a cell by button or Ctrl/Cmd+C; arrow keys move between cells; Enter opens a record.
- **Export:** export filtered or selected rows as CSV.
- **Saved settings:** stored per table in `dx-grid:<table>`.

### Review signals kept separate (`review-indicators.tsx`)
| Signal | Source | When not available |
|---|---|---|
| Evidence check | Automatic check that the value appears on the page | "Not checked" |
| Validation | The field's checks | "Not checked" |
| Model confidence | OCR confidence, only when the extraction reports it | "Not provided by the extraction". No score is ever made up. |
| Human review | A person's decision | "Not reviewed". Approvals stay in Metadata review. |

The panel also states on screen that "Evidence verified" is an automatic check, not a person's approval.

## 3. Architecture

```
document-workspace.tsx ── mode toggle ──┬── Advanced Grid: original workspace (unchanged)
                                        └── SmartWorkspace
                                             ├── SourceVerificationPanel (existing)
                                             ├── ContractSmartView  (profile contract_v3)
                                             │     └── SmartDataGrid × category
                                             ├── GenericSmartView   (all other types → SchemaForm)
                                             └── IntelligencePanel (ReviewSignals, classification, Oracle status)
oracle-status.ts: saved mappings → previewMapping() per document → ready / validation required / unmapped
```

- No backend changes in this increment.
- Data comes from the existing staging-workbook, record, classification, doc-schema and oracle-template APIs.
- Workspace access checks (`enforce_document_access`) and RBAC still apply to every call.
- Document content is shown only as data and is never interpreted as instructions.

## 4. Test evidence

| Suite | Result |
|---|---|
| New: `components/smart-view/__tests__/smart-view.test.tsx` | **11 passed** |
| Frontend full suite (`vitest run --maxWorkers=2`) | **82 files, 505 tests passed** |
| Backend full suite (`pytest`, excluding the stress test) | **1,167 passed, 13 skipped** |
| `tsc --noEmit` | clean |
| ESLint, `components/smart-view` | clean |
| ESLint, `document-workspace.tsx` / `documents-home.tsx` | 11 errors, the same count as at HEAD. All are in older load effects; none are new. |

The new tests cover:
- **Grid:** empty-column hiding and Show all fields; numeric sort; pagination; filters, chips and Clear all; pinning; column choice saved across remounts; export of selected rows; arrow-key navigation; cell copy.
- **Contract view:** categorisation and counts; clause columns, with regulation derived from the section and labelled; references kept separate; leading zeros kept on CLINs; CLIN performance period taken from its delivery record; CLIN expand.
- **Timeline:** drawn only from valid dates ("TBD" is excluded) and follows table filters.
- **Oracle and intelligence panel:** clauses never get an Oracle object; evidence, validation, confidence and human review stay separate; the source page opens on selection.
- **Other document types:** generic schema view for an invoice, with evidence on click.

Existing workspace tests run in Advanced Grid mode, so they still cover the unchanged workspace.

## 5. Browser walkthrough (local, Next dev server + FastAPI, Chromium 1680×1050)

Document: `Contract - FA300224C0008 (2).pdf` (288 pages, 1,234 contract-data records, 2,006 workbook records in total).

**Contract (FA300224C0008)**
1. Smart View opened by default.
2. Tabs and counts: Header 36 · Lines 421 · Parties 7 · Deliveries 422 · Clauses 300 (200 clauses + 100 references) · Sections 71 · Attachments 0 (dimmed) · All 1,234.
3. Clause metric: 200 = 124 FAR · 69 DFARS · 7 other (AFFARS).
4. **Contract Lines:**
   - Page 1 of 9; columns CLIN | Description | Quantity/Period | Unit Price | Amount | Performance Period (from delivery records) | Evidence.
   - Expanding CLIN 0001 showed Unit Price USD 142,035.17, amount USD 1,420,351.70, and POP 01 Oct 2024 to 31 Jul 2025 from p. 3.
5. **Clauses:**
   - Filter Regulation = DFARS → chip "Regulation: DFARS", 69 of 200.
   - Selecting 252.245-7001 opened p. 82 with the clause number highlighted.
   - Intelligence panel: Evidence verified · Validation Passed · Model confidence *Not provided by the extraction* · Human review *Not reviewed* · Oracle *No Verified Oracle Import Destination*.
6. **Deliveries:** "Timeline (383 dated)"; shows the first 80 and says so on screen.
7. **Oracle Mapping:**
   - Contract Header → *Contract v1 · 5/13 columns · Ready for export* (the user's saved mapping).
   - Lines and Parties → *No saved mapping yet*.
   - Deliveries, Clauses and Attachments → *No Verified Oracle Import Destination*.
8. **Advanced Grid:** switched to it, and the original workspace rendered unchanged.

**Invoice (`f1_digital_simple.pdf`)**
- Organised by the Invoice v1.0 schema: 16 found, 12 not found, Invoice Number BOS-24-1187.

**Narrow screen (820 px)**
- Source and Intelligence moved into drawers; the metric cards reflowed to 2 columns.

Page errors during the walkthrough: **none**.

## 6. Performance (FA300224C0008, local dev mode, unminified)

| Action | Time |
|---|---|
| Workspace load, reload until overview shown | 6.4–9.6 s (the backend workbook fetch alone takes 4.3 s) |
| Open Contract Lines (421) | 0.38–0.69 s |
| Open Clauses (300) | 0.17–0.38 s |
| Open All Records (1,234) | 0.55–0.59 s |
| Sort 421 lines by amount | 0.13–0.23 s |
| Global search across lines | 0.05–0.10 s |
| Regulation filter on clauses | 0.10–0.46 s |
| 250 rows per page on All Records | 0.66–0.89 s |
| Select a record → evidence and signals | 2.1–3.1 s (record fetch 0.5 s; the rest is PDF page rendering) |

Ranges come from two walkthrough runs. A production build will be faster on the client side. The main cost is the 4.3 s workbook fetch, which existed before this increment.

## 7. Screenshots

Saved in the session scratchpad:
- `i4-1-overview.png`
- `i4-2-header.png`
- `i4-3-lines-expanded.png`
- `i4-4-clauses-evidence.png`
- `i4-5-deliveries.png`
- `i4-6-oracle.png`
- `i4-7-advanced.png`
- `i4-8-invoice.png`
- `i4-9-narrow.png`

## 8. Issues found and fixed during verification
- The "other" clause count missed AFFARS clauses (7). It now counts every clause that isn't FAR or DFARS.
- The timeline hint said "filter the table to narrow", but the timeline ignored filters. The grid now reports its filtered rows (only when they change, which avoids a render loop) and the timeline follows them.
- The overview card was renamed to "Contract data records", so it doesn't look like it contradicts the workbook total in the header.

## 9. Known limitations
- **No row virtualization:** rows are paginated instead, so the page holds at most 250 rows at a time.
- **Evidence highlighting** works for PDF, image, HTML and XML only; Excel and CSV cells are not highlighted.
- **Settings scope:** grid and layout settings are saved per browser, not per user account.
- **Staging records** have no reviewer notes or human approvals; those stay in Metadata review.
- **Clause-to-line links** are not produced by the extraction, so the UI says "not linked".
- **Timeline** draws at most 80 bars, with an on-screen note when there are more.
- **Workbook load time** (4.3 s on the backend) is unchanged by this increment.

## 10. Deployment readiness
- Frontend only; no migrations in this increment.
- Increments 1–3 add three alembic migrations (`e5a7c9d1f3b6`, `f6b8d0e2a4c7`, `a7c9e1f3b5d8`). These need explicit approval before any production run.
- Nothing has been committed, pushed or deployed.
