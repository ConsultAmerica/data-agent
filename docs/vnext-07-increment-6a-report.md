# VNext Increment 6A — Smart Review UI, Dedicated Contract Tables, Intelligent Columns and Record Details

Status: implemented locally and tested; **not committed, pushed or deployed**.
Date: 2026-10-29 · Branch: `feature/di-02-safety-foundation` (working tree)

This is a presentation-layer change only. No extraction, parser, canonical field, mapping, export header or backend code was changed.

## 1. Existing component assessment (step 1)

| Brief item | What already existed (Increment 4) | Reused / changed |
|---|---|---|
| Category navigation | `contract-smart-view.tsx`: categories derived from each record's section and record type; tabs with counts from the data | Reused. The clause tab now counts clauses only (183); the 13 references in the text keep their own sub-tab. |
| Clause / line / delivery tables | Dedicated `SmartDataGrid` per category | Extended (see section 2) |
| Table component | `smart-data-grid.tsx`: search, filters, chips, sort, pagination, selection, pinning, resizing, reordering, density, text modes, CSV export | Extended (section 3) |
| Record details | `IntelligencePanel` in `smart-workspace.tsx`: review signals and extracted values. It is the side panel on wide screens and the drawer on narrow ones. | Enhanced into a full details component (`record-details.tsx`) in the same panel and drawer, not a duplicate |
| Source viewer | `SourceVerificationPanel` (page render plus text or region highlight) | Reused; the drawer now passes the recorded region and evidence excerpt |
| Oracle mapping | `oracle-status.ts`: saved mapping profiles previewed on the document | Reused; the drawer reads each profile's column mappings and template labels |
| Review gate | `lib/review-gate.ts` (`metadata_review_mutations_enabled`) | Respected: the drawer shows the read-only notice when the gate is off |

## 2. Dedicated tables

All three tables show the **Review status** column, which is the automatic evidence check (worded "Evidence verified" / "Needs review"). It is not a person's approval.

**FAR/DFARS Clauses (183 in the SF 1442 award)**
- Columns: Clause Number (pinned), Regulation, Clause Title, Effective Date, Alternate/Deviation, Incorporation, Source Section, Review status.
- Regulation comes from the extraction when it records one. Otherwise it is taken from the section and labelled "Regulation (from section)"; nothing is invented.
- Search by number or title, regulation and review-status filters, sort, pagination, row selection and details.
- References found in the text stay on their own sub-tab.

**Contract Lines (4)**
- Columns: CLIN (pinned; leading zeros kept), Description, Quantity, Unit, Unit Price, Amount, Currency (as printed), Performance Period (from delivery records), Review status.
- Currency is only what the amount prints (`USD`, `$`); `$` is never converted to USD.
- Amount, unit price and quantity have **range filters**, and they sort by the number they state. A value with no number ("NSP", "UNDEFINED") is never treated as 0.
- Line amounts come only from line records, never from contract-level totals.
- Row expansion still shows delivery schedules, destination and Oracle status.

**Deliveries & Performance (8)**
- Columns: Related CLIN, Delivery Description, Performance Start and End, Destination and DODAAC (from CLIN details), Quantity, Source Reference, Review status.
- Records without a CLIN are kept.
- **No Delivery Date column:** the extraction records performance periods, not a separate delivery date, and none is inferred.
- In the SF 1442 award the period, destination and DODAAC fields are empty, so those columns are hidden automatically and can be revealed with Show all fields.

**All Records (244)**
- Unchanged dataset: every record and every column, with existing filters, sorting and export.

## 3. Intelligent column visibility

- **Hiding:** a column is hidden by default only when it is empty for **every row in the filtered result**, across all pages, not just the current page.
- **Values versus absence:** literal values such as `0`, `false` and `-` count as values; null or absent does not.
- **Always shown:** identifier columns (pinned, or marked `essential`) and the review-status column, even when empty.
- **Controls:**
  - **Show all fields (+N)** / **Hide empty columns** toggle, now remembered per table.
  - **Reset columns** in the toolbar as well as the column menu. It resets visibility, order, widths and pins, and keeps density and page size.
  - The **column selector** shows which columns are empty.
- **Precedence:** the user's own show and hide choices override the automatic defaults and are kept per table in this browser. Existing saved preferences still load.
- **Density:** comfortable and compact (existing).

## 4. Record details (`record-details.tsx`)

Opens on record selection: the side panel on wide screens (re-opened if collapsed), the drawer under 1280 px. The row stays selected; Close returns the panel to its summary.

| Section | Content |
|---|---|
| A. Summary | Record type (category and extracted record type), identifier, title or description, source section, evidence check |
| B. Extracted data | Every extracted value in full (long text wraps, nothing truncated), its canonical field, the as-printed value when it differs from the normalized one, the data type, and the fields not found (on request). Full values load from the record endpoint. |
| C. Source evidence | Document, page, section path, source reference, sheet/cell when recorded, the recorded region in PDF points, and the evidence excerpt. **View in source** opens the page with the region and highlight. When neither a region nor a highlight exists, the drawer says exact highlighting is unavailable and that the page will be searched. While the full record loads it says "Loading source evidence…", never "no page recorded". |
| D. Validation | Evidence check, validation result, missing required fields, data-type issues, other failed checks, and model confidence ("Not provided by the extraction" when absent), all kept separate |
| E. Human review | Review status, reviewer, timestamp and approved value. These show "Not recorded" because staging records carry no human decisions; approvals live in Metadata review, which is linked. The read-only release notice appears when review mutations are disabled. |
| F. Oracle mapping | For each saved mapping exporting this category: Oracle object, template version, mapping name and version, validation state, and for each column reading this record's fields its Oracle display label, technical attribute and mapped value. The value is shown only when the mapping reads the record's own dataset; otherwise "From <dataset>, matched at export". Otherwise **"No Oracle mapping configured."**, plus "No verified Oracle import destination exists for this record type." for clauses, deliveries, sections and attachments. |

## 5. Tests

- New `components/smart-view/__tests__/review-6a.test.tsx`, **21 tests**, against the real SF 1442 award: `fixtures/sf1442-workbook.json` (contract_data and contract_overview from the staging workbook endpoint) and `fixtures/sf1442-records.json` (four full records with provenance from the record endpoint).
- Coverage by brief item:
  - **Classification:** clause, line and delivery classification; no record left uncategorised (244 of 244).
  - **Counts and navigation:** counts from data (4 / 183 / 8 / 244); category switching; All Records preserved with every column revealable.
  - **Tables:** regulation and review-status filters; clause search; CLIN leading zeros; amount range filter and value sort.
  - **Columns:** empty-column detection across pages, with literal `0` and essential columns kept; user overrides remembered and Reset; Show all fields remembered.
  - **Drawer:** opening and closing with the row kept selected, and the record loaded once; full-value rendering; source evidence, the inexact-highlight note and recorded coordinates; validation, model confidence and human review kept apart, plus the read-only gate; Oracle mapping display and the missing-mapping wording; the loading state.
  - **Keyboard and export:** Enter opens a record; export regression.
- Two existing smart-view tests were updated for the new wording and control (the Show all fields button; the drawer's Oracle sentence).

| Suite | Result |
|---|---|
| Frontend full suite (`vitest run --maxWorkers=2`) | **85 files, 543 tests passed** |
| `tsc --noEmit` | clean |
| ESLint `components/smart-view` | clean |
| Backend export and Oracle regression (`test_export_consistency.py`, `test_oracle_templates.py`) | **39 passed, 1 skipped** |

## 6. Local browser walkthrough (Chromium 1680×1050, Next dev server + local FastAPI, SF 1442 award)

- **Tabs:** Contract Header 57 · Contract Lines 4 · Parties & Contacts 8 · Deliveries & Performance 8 · FAR/DFARS Clauses 183 · Sections 0 · Attachments 2 · All Records 244.
- **Clauses:** Regulation = DFARS gives 52 of 183. Selecting 252.201-7000 opened its details with page 10, section "00 70 00 – Conditions of the Contract", recorded region and excerpt. View in source opened page 10 with the clause number highlighted.
- **Lines:** Amount ≥ 1,000 gives 1 line (0001, $600,000,000.00 NTE; currency "$" as printed). The other three lines read "NSP" and are not treated as 0.
- **All Records:** 21 columns, 22 with Show all fields.
- **At 820 px:** selecting a clause opened the details drawer, showing page 8 and its region once the record loaded.
- **Page errors:** none.
- **Timings (dev mode, warm):** workspace 1.7 s · open clauses 0.25 s · select → details 0.15 s · View in source 1.7 s (PDF page render) · lines 0.13 s · deliveries 1.0 s · All Records 0.4 s. The first, cold load compiled the route in 14.8 s.

Screenshots are in the session scratchpad `shots/`: `6a-1-overview`, `6a-2-clauses-dfars`, `6a-3-clause-details`, `6a-4-clause-source`, `6a-5-lines-amount-filter-details`, `6a-6-deliveries`, `6a-7-all-records-show-all`, `6a-8-narrow-drawer`.

Found and fixed during the walkthrough: the drawer said "No page recorded" while the full record was still loading (grid rows carry no provenance). It now shows a loading state.

## 7. Also in this round (from review feedback)

**"Accept all pending" did nothing**
- Production (`/ready` on Render) reports `metadata_review_mutations_enabled: false`, running backend `821a2a3`. Every Accept therefore returned 403, and the document review page swallowed the error.
- The page now says why Accept was refused (the gate, a permission, or a missing reviewer name). After a partial accept it says how many flagged values still need individual decisions.
- The current build already disables the button and shows the read-only notice when the gate is off.
- Enabling review in production needs `METADATA_REVIEW_MUTATIONS_ENABLED=true` on Render, a deliberate DI-02 safety setting left for the owner.

**Clauses only where clauses exist**
- On the document review page, the **Clauses** tab and the Clauses sub-tab ("Extract Clauses") appear only for documents classified as contracts or FAR documents (`government_contract`, `contract`, `far_regulation`, `far_regulatory_change`), or that already have extracted clauses.
- An invoice or image document shows Overview / Data / Relationships / Documents / Activity, with Tables and Signatures still available.
- The clause panel is no longer shown twice: it was under the viewer and on the right at the same time.

**FAR / DFARS sidebar item removed**
- The `/clauses` page still works by URL and from breadcrumbs.
- Contract documents keep their FAR/DFARS Clauses category in Smart View.

New `components/__tests__/review-clause-scope.test.tsx` (5 tests) and one sidebar test cover these.

## 8. Incomplete or not available

- **Human review per record:** no reviewer, timestamp or approved value exists for staging records. The drawer says so and links to Metadata review; it does not invent one.
- **Delivery Date, Currency, Destination:** the extraction has no delivery-date or currency field. Currency is shown only as printed. Destination and DODAAC come from CLIN details, which are empty for this award.
- **Related clauses per line:** still "not linked"; the extraction doesn't link clauses to lines.
- **Oracle mapped values** for mappings that read another dataset (e.g. `line_items`) are resolved at export, not shown per record.
- **Virtualization:** rows are paginated (at most 250 per page), not virtualized.

## 9. Separate, uncommitted work in the same tree

The working tree also holds the **Increment 5 follow-up** (ZIP/EML release gate, queue Skipped/origin/attachment nesting, JSON tree, source-file card), which is outside 6A's scope. It awaits your approval separately. Its files:
- backend `documents.py`, `intake.py`, `config.py`, `office_text_parsers.py`, `native_ingest.py`, `upload_processing.py`, `test_format_coverage.py`
- frontend `components/intake/*`, `lib/intake.ts`, `src/app/extraction/new/page.tsx`, `json-source-tree.tsx`, `source-file-card.tsx`, `source-file.test.tsx`, and parts of `smart-workspace.tsx` and `document-workspace.tsx`

6A's own files:
- `contract-smart-view.tsx`, `smart-data-grid.tsx`, `record-details.tsx`, `review-6a.test.tsx`, `fixtures/sf1442-*.json`, `smart-view.test.tsx`
- review feedback: `review/page.tsx`, `review-field-list.tsx`, `contract-tabs.tsx`, `extraction-workspace.tsx`, `workspace-nav.ts` and their tests
- the record-details wiring in `smart-workspace.tsx`

Nothing has been committed, pushed or deployed.
