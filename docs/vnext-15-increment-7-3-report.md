# Increment 7.3 — Intelligent Document Structure & Unified Verification Workspace

Branch `feature/di-02-safety-foundation`. Nothing is committed, pushed or deployed.

## Summary

The document page now has one verification workspace. Its tabs are, in order:
Original Structure, Business Data, Tables, Validation, Oracle / Mapping, History and Summary.
Summary stays last. Smart View and Advanced Grid are kept under "More views" as two more
views of the same records.

Every tab, and every new export, is built from one representation. That representation is
the document's original layout joined to extraction and review. As a result, a record has
one key everywhere: selecting, correcting or approving it in one tab shows in every other
tab and in the downloads.

The existing extraction engines are unchanged. No stored data is migrated or rewritten.
Existing extraction rows, review decisions, evidence and Oracle mappings are read as they
are.

## What was built

### 7.3.1 Classification
- Every document family maps to one of eight classes: Contract, Invoice, Purchase Order,
  Bank Statement, Financial Statement, Passport / Identity Document, Academic Document and
  General Document. The mapping is in `app/classification/document_class.py`.
  - The finer families and categories are unchanged.
  - Families without a class (correspondence, résumé, custom types) are General Documents.
    Their data is still shown.
- A new `bank_statement` family was added, with keywords that only banks print.
- Subtypes were added for bank statements, financial statements, passports and identity
  cards. A subtype is recorded only when the document states it; it is never guessed.
- The classification response now includes:
  - `document_class` and `document_class_label`;
  - `review_status`. This is "Confirmed" only after a person confirmed or changed the type.
    High confidence never confirms it.
- Correcting the classification goes through the existing decision endpoint. It re-pins
  the staging profile and deletes nothing. A test shows that the layout's records are the
  same before and after a correction.

### 7.3.2 Original structure engine
- **UCF contract parts.** "Section A – …" to "Section M – …" are level-1 sections wherever
  they are printed, including inside paragraphs. Other printed headings become level-2
  subsections under their part.
- **Text that never opens a section:** codes (`F2X3C34150A001`), dates (`(Dec 2018)`),
  form footers, column captions ("Unit Price", "Title") and field values.
- **"Document start" is gone** when the document identifies its first section. Leading
  fields take, in order of preference:
  1. the printed title;
  2. the first contract part on the next page (an SF 33 cover is Section A);
  3. the first heading on their page.
- **Headings are never fields.** A blank "field" captioned with a heading's own words is
  dropped.
- **Extracted values with no exact position** are placed in the section printed on their
  page, marked "placed by page". They no longer go to a catch-all "Other" list. Only
  values with no page at all remain "other".
- **Repeating extraction keys** (a value per CLIN or contact) are no longer flagged as
  conflicts. On FA30 this cut the false conflicts from 419 to 0.
- **Stable record keys** for every field (`field:<page>:<item>:<label>:<n>`), table
  (`table:<page>:<n>`) and row (`…:row:<i>`).
- **Earlier aa.pdf fixes** (this branch):
  - tables ruled with thin filled rectangles are now found;
  - label/value rows above a grid are trimmed off it;
  - values that run past their underline are kept;
  - "Contractor Name" and "Mod Description" now have their values, and are no longer
    false headings.

Results on real documents:

| Document | Sections | Notes |
|---|---|---|
| aa.pdf (contract brief) | A. General Information (1. Contractor Information, 2. Contract Information, …), B. Contract Clauses and Special Provisions, C. Summary of Contract Modifications | The modifications table is merged across pages 4–5 (82 rows), plus the page-6 table |
| Contract - FA300224C0008 (288 pages) | Section A – Solicitation/Contract Form through Section J – List of Attachments | Subsections include SOLICITATION / OFFER / AWARD, Key Position, FAR/DFARS clause lists. No "Document start" |

### 7.3.3 Taxonomy
Business Data follows the path category → type → canonical section → field / table →
record / cell. It comes from the document's skill.

Original Structure keeps the document's own headings. The two hierarchies are never mixed:
- Business Data shows the printed label each value was found under ("Printed as 'Legal
  Entity'").
- Values that no category claims appear under **Other Extracted Data**. They are never
  hidden.

### 7.3.4 Unified verification workspace
- **Tab bar** under the document header.
  - Tables appears only when the document has tables.
  - Oracle / Mapping is hidden for identity and academic documents.
  - No data is hidden.
- **Source verification** sits under the tabs and above the content. It is collapsible
  and resizable, and remembers its state per browser. It offers page navigation, zoom and
  search.
- **Clicking a field or row** opens its page. The exact region is highlighted when the
  layout recorded coordinates; otherwise the page is searched for the text, and the header
  says which.
- **Record details:**
  - original label, printed value, extracted value and reviewed value;
  - every extraction candidate, with confidence, validation and review status kept apart;
  - flags, extraction method and Oracle mapping status;
  - Approve, Correct and Reject, and Add row for tables.

### 7.3.5 Selection
- Checkboxes for select-all, each section, each field run, each field, each table and each
  table row. Mixed (indeterminate) states are shown.
- Selection uses `layout:<record key>` ids in the shared selection (`lib/record-selection`).
  Original Structure, Business Data, Tables and Validation therefore select the same
  records.
- The Staging Workbook links its values to layout records when page and value match
  uniquely. This uses the same rule as its existing link to extracted fields.
- **Toolbar** (sticky at the bottom): N selected records · Review selected · Export
  selected (Excel / CSV / JSON) · Clear selection.
  - **Review selected** steps through the records, opening each one's source.
    - **Approve & Next** and **Reject & Next** save the decision and move on.
    - **Correct** saves a correction for review.
  - Selecting never approves a record.

### 7.3.6 Validation
`GET /api/documents/{id}/validation-summary` groups every exception, most serious first.
The kinds are:
- missing required fields;
- values extraction missed;
- conflicting values: competing only within the same page, section and numbered item;
- duplicate candidates;
- incorrect field associations;
- invalid dates, identifiers (with patterns: CAGE 5 characters, UEI 12) and amounts;
- table cells that don't fit their column;
- incorrect totals: subtotal + tax = total; opening + credits − debits = closing;
- cross-field checks: start before end, award before expiry, exercised ≤ potential value,
  issued before expiry.

Confidence, validation and review are separate fields everywhere. A correction keeps the
printed value, either on the extraction row (`original_value`, `machine_value`) or in
`structure_record_reviews.original_value`.

### 7.3.7 Dates
`GET /api/documents/{id}/document-dates?warning_days=` lists dates by meaning: issue,
award, effective, start, end, expiration, renewal, due and period.
- **Sources:** the skill's fields, plus the existing key-date detector.
- **Basis:** each date is marked explicit or inferred. For example, a contract with no
  printed expiry takes the last period end, and says so.
- **Status:** Active, Expiring Soon, Expired, Not Applicable or Unknown.
  - A status is computed only from an identified expiration date.
  - An open period ("07/01/2025 -") is never treated as an end date.
- **Threshold:** comes from the `key_date_expiring_days` setting. Summary lets the reader
  switch between 30, 60, 90 and 180 days.

### 7.3.8 Targeted extraction
`POST /api/documents/{id}/find` with a query such as "Extract Contract Number", "Find
Supplier Tax Identifier", "Find Contract Expiration Date" or "Identify FAR Clauses".
- **It returns** the value, the label it was printed under, the page, evidence,
  confidence, validation status and review status.
- **Clause questions** use the existing FAR/DFARS citation scanner.
- **An expiry question** with no printed expiry returns the inferred date, labelled
  "Inferred".
- **When nothing is found** it says "wasn't found". Nothing is generated.
- **In the UI**, the Find box is on Business Data.

### 7.3.9 Document skills
`app/skills/definitions.py` defines five versioned skills: Contract, Invoice, Purchase
Order, Bank Statement and Passport Recognition. Each skill contains:
- class, families and subtypes;
- canonical sections;
- fields, with the printed aliases they go by, type, required flag, identifier pattern and
  date role;
- table definitions;
- cross-field rules;
- review requirements;
- extraction targets;
- export mapping references.

Two constraints apply to these definitions:
- **No Oracle column names.** The export mapping points to the staging profile, whose
  configured Oracle templates apply.
- **Versions are stored.** The first use stores each version in
  `document_skill_versions`, together with its content hash. A test pins each hash, so a
  definition can't change without a new version.

There is no autonomous retraining.

Endpoints: `GET /api/document-skills` and `GET /api/document-skills/{id}`.

### 7.3.10 Exports
The Export menu → **Document structure** has three new exports:
- **Original Structure (Excel).** Sections, numbered items and tables in document order.
  Every value is stored as text exactly as printed, so Excel never turns it into a date or
  number. Text that looks like a formula is never executed.
- **All Extracted Fields (CSV).** Columns in exactly this order: Category | Field | Value |
  Type | Found By | Source Page | Evidence | Review Status.
- **Structured JSON.** Classification, skill, original structure, business data,
  validation and dates in one file.

Selected records export as Excel, CSV or JSON from the selection toolbar.

Existing exports are unchanged:
- Organized Business Data Excel (staging export);
- Oracle Fusion templates;
- Custom Export;
- metadata exports.

The default grid still ends with Type, Found By and Source Page.

### Review of layout records (backend)
`POST /api/documents/{id}/original-structure/review` takes record keys and one of
`accept`, `reject`, `correct`, `reset` or `add_row`.
- **Fields with an extraction row** are reviewed on that row through the existing
  metadata review state machine. It applies the same permissions, validation-override
  gate, approved-document lock and audit log. The decision therefore reaches staging and
  Oracle mapping.
- **Other fields and table rows** are reviewed in a new table, `structure_record_reviews`.
  - The printed value stays in `original_value`.
  - A correction goes to `reviewed_value`.
  - Earlier decisions are kept in `history`.
- **Added rows** are marked "Added" and still need approval.

### UI additions requested during the increment
- **Smart Review cards** in Business Data. Each card shows:
  - the label and a required marker;
  - **confidence** (a percentage, or "Printed" when read from the layout);
  - **validation**: Valid, Check, Invalid, Missing or Not found;
  - **review status**;
  - the source label and page, and the competing candidates;
  - inline Approve, Correct and Reject.
- **Light and dark themes.** Light is the default. The toggle is in both headers, is
  remembered per browser, and is applied before first paint.
- **Large documents:** sections over 400 fields start collapsed, and field lists and
  tables show the first 100 rows until asked. FA30 opens with 8 rows rendered instead of
  over 4,000.

## Tests

| Suite | Result |
|---|---|
| Backend: `test_original_structure.py` (layout, review, add row, selected export, FA30 headings) | 16 passed |
| Backend: `test_document_workspace.py` (classes, subtypes, skills pinned, business data, validation, dates, find, classification correction, CSV/JSON/skills endpoints) | 20 passed |
| Backend: classification suites | 20 passed (family accuracy 100%) |
| Backend: `test_migrations_complete.py` (Alembic alone builds every table) | passed |
| Backend: full suite | 1316 passed, 14 skipped (the one date-dependent test noted below deselected) |
| Frontend: `verification-workspace.test.tsx` (tabs, shared selection, export selected, exact-region source, Approve & Next, separate confidence/validation/review, inline correction, find not-found, validation order, Summary last) | 7 passed |
| Frontend: full suite (before the verification tests were added) | 622 passed |
| Browser walkthrough, aa.pdf and FA30 | passed, no console errors, no horizontal overflow at 390 px |

The browser walkthrough checked:
- tab order;
- sections;
- the exact-region source;
- the selection toolbar, and selection kept in sync between tabs;
- the Business Data cards;
- find;
- the tables;
- the validation groups;
- the Summary (classification, expiration status);
- the export menu;
- dark mode;
- FA30's Sections A–J;
- the mobile layout.

The test documents in the brief that the repository doesn't have (purchase order, bank
statement, passport) are covered by synthetic layouts in the unit tests. Real invoice
fixtures exist under `backend/tests/fixtures/invoices` and are covered by the existing
invoice tests.

## Limitations and outstanding issues

1. **Sample documents.** There are no real purchase order, bank statement or financial
   statement samples in the repository. Those skills are tested on synthetic layouts only.
   Their alias lists should be tuned on real samples.
2. **Financial Statement has no skill yet.** Its Business Data shows the document's own
   sections. The same applies to Academic and General documents.
3. **Purchase Order and Bank Statement have no staging profile.** Their Oracle and staging
   exports use the generic profile.
4. **FA30 Contractor Name is reported missing.** The SF 33 offeror block isn't read as a
   label/value pair. It is reported, never guessed.
5. **Smart View is not part of the shared selection.** Original Structure, Business Data,
   Tables, Validation and the Staging Workbook are.
6. **No "Save Draft" button.** Corrections are already saved as pending, which works as a
   draft.
7. **Document-level "Approve & Next document" is not built.** Approve & Next works per
   record within the selection. Document approval stays in the Actions menu.
8. **The dark theme covers token-based styles and hard-coded white backgrounds.** A few
   components with literal light colours may still need adjusting.
9. **One date-dependent backend test**
   (`test_key_dates.py::test_expired_and_expiring_documents_in_the_portfolio`) fails late
   in the evening. It compares local and UTC dates, and is unrelated to this increment.
10. **New tables.** `structure_record_reviews` and `document_skill_versions` come from
    migration `d5f7b9c1e3a6`. Run it before deploying; local development creates them at
    start-up.
