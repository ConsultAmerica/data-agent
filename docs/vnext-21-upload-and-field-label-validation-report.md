# Increment 7.3.3 — Upload Verification, Document Classification and Field Label Validation

Branch `feature/di-02-safety-foundation`. **Not committed, pushed or deployed. No production data was changed.**
All measurements below come from the test database, on documents built by the test suite.

## 1. Summary

Every document now passes through one validation framework, whatever its type. It reports what is known about the
upload and the extraction, and the evidence for it:

- **Processing stages:** Uploading → File Verified → Classifying → Extracting → Validating → Ready for Review.
  - Each stage's status comes from what actually happened: the job's stage history, the pages read, the stored
    classification and the validation report.
  - A failed stage shows its cause, and a Retry button when retrying can help.
- **File verification:** signature, size, page count, opens, password, duplicate upload, digital / scanned /
  mixed pages, fillable form fields, rotated pages, and readability after OCR.
  - It runs as its own job stage (`verifying_file`).
  - A file that fails it (corrupt, password-protected, wrong signature) fails the job as `file_invalid`, which is not
    retryable.
- **Classification:**
  - The existing engine's type, confidence and status.
  - A low-confidence type is held for review, never forced.
  - A strong alternative candidate is offered for a reviewer to confirm in one click.
  - Manual correction (the existing Type tag) triggers revalidation.
- **Label recognition:** for each value, the printed label, a clean display label, its item number and its business
  meaning, from per-document-type alias tables.
- **Label-to-value association:**
  - A label read as a value is never assigned. Example: "Contract Number → Solicitation Number" leaves Contract
    Number without a value and keeps the candidate.
  - Two identifiers sharing one value are marked Needs Review.
  - A value that isn't its label's type is flagged.
- **Completeness audit:** the source against the Original File layout, with counts:
  - pages processed, pages with readable text;
  - filled form fields, checkbox states;
  - detected tables and their rows;
  - numbered items, and values that need attention.
  - Coverage is claimed only where it was measured.
- **Original File / Excel consistency:**
  - The workbook is built, read back and compared with the tab's layout.
  - It checks sections, item numbers, field names, values, blank values, table titles, columns, rows and cells,
    parent metadata written once, one `Original File` sheet, and no merged cells.
- **Oracle mapping readiness:** Ready for Mapping / Ready with Warnings / Review Required.
  - It is a source-data state only and never blocks the mapping workspace.

The UI adds no tab. The workspace has one compact strip above the review counts: the stage steps plus chips for
readiness, file, type, coverage, labels and Excel. **Details** expands the checks behind each chip.

## 2. Files and functions changed

### New: `backend/app/document_validation/`

| File | What it does |
|---|---|
| `__init__.py` | **`layout_fields`**, **`layout_tables`**, **`business_fields`**: the one way the modules (and tests) walk a layout and a business-data result. |
| `file_check.py` | **`form_boxes_of(pdf)`** / **`read_form_boxes(path)`**: every form box with its state and whether it's filled (one rule, as the structure reader counts filled boxes); used by both the file check and the completeness audit. |
| `file_check.py` (cont.) | **`verify_stored_file(document, path)`:** signature by extension (PDF, images, Office, RTF, text), size, PDF opens / password / page count / damaged pages, text layer per page (digital, scanned, mixed, blank), form boxes and filled boxes, rotated pages, image resolution. **`readability_check(pages)`:** after OCR, scanned pages without text or with low OCR confidence. **`duplicate_check`**, **`file_status`**. |
| `labels.py` + `label_aliases.json` | **`recognize_label(printed, family, form=, name=, number=)`** → `RecognizedLabel` (printed, display, item_number, meaning, source, resolved). **`annotate_labels(layout, family)`** adds `label_info` to every field. **`label_audit`**. The alias tables are per document type: `labels` holds abbreviated spellings written out, `meanings` holds synonyms that set a business meaning without renaming the label. |
| `association.py` | **`looks_like_label`**, **`label_vocabulary`**, **`type_mismatch`**, **`shared_identifier_issues`**, **`layout_association_issues`** (values no skill field checks). |
| `completeness.py` | **`completeness_audit(...)`** → measures, gaps and review items (from the layout's own quality counts). |
| `consistency.py` | **`tab_export_consistency(layout, rows=None, workbook=None)`**. |
| `readiness.py` | **`mapping_readiness(...)`** → state, label, checks and the readiness note. |
| `service.py` | **`document_validation(db, document, refresh_file=, actor=)`**: the report, cached against a fingerprint of the document. **`processing_stages`**, **`file_verification`** (stored in `ingestion_provenance.file_verification`), **`entities`** (contracts in the document), **`forget`**. A snapshot of each report is kept in `ingestion_provenance.validation`. |

### Changed backend files

| File | Change |
|---|---|
| `app/api/document_workspace.py` | `GET /api/documents/{id}/upload-validation` and `POST /api/documents/{id}/upload-validation/revalidate` (`parts`: `all`, `file`). `workspace_context` annotates labels. |
| `app/api/original_structure.py` | The layout carries `label_info` for the document's current type. Reading the layout records nothing. |
| `app/api/jobs.py` | **`_active_job`:** a start request returns the job already running instead of reading the pages twice. Extraction jobs record their request. **`POST /v1/jobs/{job_id}/retry`:** a failed, retryable job runs again as a new job with `retry_count + 1` and `retry_of`. A job that isn't retryable gets 409. |
| `app/services/extraction_job_runner.py` | New stages `verifying_file` (after the file is local, before pages are read) and `classifying`. `FileVerificationError` and **`failure_reason(exc)`** add `result_json.failure` (stage, reason, retryable, message, type, time). The stage history and timings recorded before a failure are kept. An unexpected exception now fails the job visibly; before, it stayed "processing" until the heartbeat check presumed it dead. The `classifying` entry is no longer lost when the result payload is rewritten. |
| `app/services/job_recovery.py` | An interrupted job records `failure.reason = "interrupted"` (retryable). |
| `app/skills/business_data.py` | Fields try the recognized display label and meaning when the printed label doesn't match a skill alias ("P.O. No.", "Acct. No.", "Agreement Number", "Supplier"). New issues: `value_is_label` (the value is excluded and kept as a candidate) and `shared_identifier`. Each field has an `association` (confirmed / matched / needs_review / unresolved). A month and year ("NOV 2021") is a valid date. |
| `app/skills/validation.py` | Both new issues are reported under *Incorrect field associations*. Layout-level wrong-box readings are added without double-reporting a record. |
| `app/source_structure/original_layout.py` | Tables carry `source_tables` (the detected tables they were built from). Stats add `table_sources_set_aside`. |
| `app/source_structure/original_export.py` | A section whose only items repeat the form's boxes isn't written. |

### Frontend

| File | Change |
|---|---|
| `lib/document-validation.ts` (new) | Types and client calls: `getDocumentValidation`, `revalidateDocument`, `retryJob`, `FAILURE_REASONS`. |
| `components/verification/document-check-summary.tsx` (new) | The compact strip and its **Details**: stage steps, readiness, file, type (with the suggested type), coverage and gaps, labels and associations, Excel checks, readiness checks; **Retry**, **Validate again**, **Check the file again**. While a stage runs, it polls every 4 s. |
| `components/verification/verification-workspace.tsx` | Mounts the strip above the review counts. It reloads with the workspace's data. |
| `components/original-structure/original-structure-view.tsx` | A grid read over a form's ruled cells (`form_duplicate` table) is hidden as the export hides it. A section left empty by that isn't listed. The field-name tooltip adds "Reads as" and "Means". |
| `lib/original-structure.ts` | `label_info` on fields; `form_duplicate` on tables. |
| `components/extraction-live-progress.tsx`, `components/intake/processing-queue.tsx`, `lib/extraction-workflow.ts`, `lib/intake.ts` | Labels for the `verifying_file` and `classifying` stages. |

No database migration: everything new is stored in the existing `ingestion_provenance` and `extraction_jobs.result_json` JSON columns.

## 3. Supported document types

Classification is the existing engine (`app/classification`). The skills used for business fields are unchanged
except for the matching described above.

| Type | Skill (business fields) | Label aliases (`label_aliases.json`) |
|---|---|---|
| Federal contract / SF 33 / SF 1442 / SF 30 | Contract Recognition | contract |
| Commercial contract (MSA, supplier agreement, SOW, amendment) | Contract Recognition | contract (`Supplier` means Contractor, `Agreement Number` means Contract Number) |
| Invoice, credit note, quotation | Invoice | invoice |
| Receipt | — (its own labels) | invoice (shares spellings: Merchant, Transaction Date) |
| Purchase order | Purchase Order | purchase_order |
| Bank statement | Bank Statement | bank_statement |
| Financial statement / report | — (its own labels) | financial_statement |
| Passport, identity card, driving licence | Identity | passport |
| FAR / DFARS document | — (its own labels) | far_regulation |
| Other | — | common abbreviations only |

## 4. Validation rules

### File (`file_check.py`)

| Check | Failed when | Warning / info |
|---|---|---|
| Size | Empty | — |
| Signature | Content isn't the extension's format | Text that isn't UTF-8 |
| Opens | Corrupt or incomplete | Pages that can't be read |
| Password | Needs a password to open | Encrypted with permissions only (info) |
| Page count | No pages, or over `max_pdf_pages` | Differs from the upload record |
| Text layer | — | Scanned or mixed (info, with the page numbers) |
| Form fields | — | Box and filled-box counts (info) |
| Rotation | — | Rotated pages (info) |
| Image resolution | — | Under 600 px on a side |
| Duplicate | — | The same checksum in the caller's visible documents |
| Readability (after OCR) | — | Scanned pages with no text, or mean OCR confidence < 0.6 |

Upload still refuses unsupported types, wrong signatures, empty files, password-protected and corrupt PDFs, and
ZIP / EML / MSG (unchanged).

### Labels (`labels.py`)

- A form box's instructions are removed with `form_label` (Phase A).
- A technical name is put into words with `display_label`.
- An abbreviated spelling is written out only from the document type's table, plus a few safe everywhere: Acct,
  Amt, Qty, Addr, and a trailing No. / # after a word.
- A synonym records a meaning; the label is shown as printed.
- A bare leading number is an item number only for a form box's description, or when written "9." / "15A)".
- Form tool names (`Text1`, `Check Box3`) are unresolved.

### Association (`association.py`, `business_data.py`)

| Rule | Effect |
|---|---|
| The value reads exactly as a label ending in a naming word (Number, No, Date, Code, Name, Amount, …) and has no digit | Not assigned; kept as a candidate; *Incorrect field associations*; a required field becomes Not found |
| Two identifier fields share a value | Both Needs Review |
| A label naming a date / amount holds a value that can't be one (N/A, TBD, "See …" are allowed) | *Invalid dates* / *Invalid numeric formats* (warning) |
| Conflicting values (existing) | The field's association is Needs Review |

### Completeness (`completeness.py`)

| Measure | Source | Represented |
|---|---|---|
| Pages processed | `page_count` | Pages read |
| Pages with readable text | Pages read | Pages with text (missing: "Needs OCR" / "No text") |
| Filled form fields | Filled widgets in the file | Form-widget fields (by box rectangle) + boxes inside form tables (by name) |
| Checkbox states | Choice boxes | Choice boxes with a selected / not-selected state |
| Detected tables | Accepted table candidates | In a layout table (`source_tables`), shown as form boxes, or set aside as paragraphs |
| Table rows | Rows of those candidates | Rows shown |
| Numbered items | — | Distinct item numbers; numbers between printed ones are listed, not counted as gaps |

Overall status:
- `complete` only when every measure that applies is complete.
- `gaps` lists what's missing.
- `partial` when something couldn't be measured, for example when the file wasn't available.

### Readiness (`readiness.py`)

| Check | Blocker (Review Required) | Warning (Ready with Warnings) |
|---|---|---|
| File | Failed verification | — |
| Document type | Review required (low confidence) | Confirmation recommended |
| Source identifiers | A required identifier missing, or its value uncertain | No skill: the document's own labels are used |
| Relationships | — | No contractor / supplier / party found |
| Field-label confidence | — | Unresolved labels, uncertain non-required fields |
| Critical conflicts | Missing required, conflicting values, incorrect totals, cross-field | — |
| Table structure | — | Table / row gaps, cells that don't fit their column |
| Multiple contracts | — | More than one contract number |
| Source evidence | — | Values without a location (info: the values stay valid) |
| Filled form fields | — | Filled boxes not represented |

## 5. Before and after

| Case | Before | After |
|---|---|---|
| "P.O. No.: PO-2025-0042" on a purchase order | Shown as printed; the skill's Purchase Order Number reported **Not found**; mapping readiness unknown | Shown as printed; reads as *Purchase Order Number*; the skill field holds PO-2025-0042; Ready with Warnings (type to confirm) |
| "Acct. No.: 000123456789" on a bank statement | Account Number **Not found** | Account Number = 000123456789 |
| "Contract Number: Solicitation Number" | Contract Number = "Solicitation Number" (passed) | Contract Number has no value; the candidate is kept; *Incorrect field associations*; Review Required |
| Contract and Solicitation Number both FA8501-24-C-0042 | Both passed | Both Needs Review |
| Effective Date "NOV 2021" | Invalid date | Valid |
| A grid read over an SF33's ruled cells | In the tab, not in the Excel | In neither (the form's boxes are shown) |
| A section holding only such repeats | A title row in the Excel only | In neither |
| A job raising an unexpected error | "processing" until the heartbeat check marked it interrupted (3–30 min) | Failed at once, with stage, reason and message; retry available |
| Starting processing twice | Two jobs reading the same pages | The running job is returned |
| An SF33 whose text didn't classify | Generic, confidence 0, no hint | Generic, held for review, with "Use Government Contract (90%)" offered |

## 6. Test files and expected results

- **`backend/tests/validation_matrix.py`:** 17 documents built in code, with their expected labels, values and
  tables.
- **`backend/tests/test_upload_validation.py`:** 67 tests.
  - The label table (8 cases), meaningful words kept (5 cases), type-specific aliases, unresolved names.
  - Association rules.
  - Refusals: corrupt (the cause named), password-protected, wrong signature, ZIP and EML.
  - A duplicate is held, then flagged.
  - A tampered export is detected (lost table row, changed value).
  - Job retry, non-retryable refusal and active-job dedupe; failure reasons.
  - For every matrix document: all six stages done, type right or held for review, readiness state and note, tab =
    Excel.
  - Labels, values and tables for every document that defines them.
  - SF33 fillable: 6/6 filled boxes, item numbers, Contract and Solicitation Number kept separate, Selected, the
    duplicate printed value not a second field.
  - SF33 ruled: selected and not-selected boxes, Table of Contents and Acknowledgment of Amendments, the grid hidden
    in both views.
  - Blank boxes are Blank, not missing.
  - Wrong-box value never assigned; shared identifier; multiple contracts.
  - Scanned and mixed pages told apart; unread pages not claimed.
  - Multipage page count.
  - A correction revalidates without re-reading the file.
  - A processing job records `verifying_file` and `classifying`.
  - 300-page document.
- **`backend/tests/test_upload_validation_metrics.py`:** the accuracy run below, with thresholds.
- **`backend/scripts/upload_validation_metrics.py`:** prints it.
- **`frontend/components/verification/__tests__/document-check-summary.test.tsx`:** 5 tests.
  - The six stages and chips; details on demand.
  - A failure's cause and Retry; no Retry for `file_invalid`.
  - A low-confidence type isn't forced; the suggested type is confirmed and revalidated.
  - Coverage gaps and an Excel difference are shown, not hidden.
- **`frontend/components/original-structure/__tests__/original-structure.test.tsx`:** 2 new tests (grid duplicates
  hidden; Reads as / Means tooltip).

## 7. Results over the matrix

`python scripts/upload_validation_metrics.py` (OCR off, as in the suite; times on this workstation):

| Document | Type (status, confidence) | Labels | Values | Tables | Coverage | Excel | Readiness | Wrong-box findings |
|---|---|---|---|---|---|---|---|---|
| invoice_digital | invoice (classified, 1.00) | 4/4 | 4/4 | 1/1 | complete | consistent | Ready for Mapping | — |
| purchase_order | purchase_order (recommended, 0.65) | 2/2 | 3/3 | 1/1 | complete | consistent | Ready with Warnings | — |
| bank_statement | bank_statement (recommended, 0.62) | 2/2 | 3/3 | 1/1 | complete | consistent | Ready with Warnings | — |
| financial_statement | financial_statement (review, 0.41) | 1/1 | 2/2 | 1/1 | complete | consistent | Review Required | — |
| passport | passport (classified, 0.85) | 2/2 | 3/3 | — | complete | consistent | Ready for Mapping | — |
| receipt | receipt (review, 0.55) | 1/1 | 3/3 | 1/1 | complete | consistent | Review Required | — |
| far_document | **contract** (review, 0.30) | 1/1 | 2/2 | — | complete | consistent | Review Required | — |
| commercial_contract | contract (recommended, 0.72) | 1/1 | 3/3 | — | complete | consistent | Ready with Warnings | — |
| sf33_fillable | generic (review, 0.00; suggests government_contract 0.90) | 3/3 | 3/3 | — | complete (6/6 boxes) | consistent | Review Required | — |
| sf33_ruled_form | generic (review) | — | — | — | complete (18/18 boxes, 7/7 checkboxes) | consistent | Review Required | — |
| two_contracts | unknown (review) | — | 3/3 | — | complete (4/4 tables, 8/8 rows) | consistent | Review Required | — (3 contracts found) |
| ambiguous_association | government_contract (confirmed by decision) | — | 1/1 | — | complete | consistent | Review Required | value_is_label, invalid_date (both intended) |
| shared_identifier | government_contract (confirmed by decision) | — | 1/1 | — | complete | consistent | Review Required | shared_identifier (intended) |
| scanned_invoice | unknown (review) | — | — | — | gaps (page 1 needs OCR) | consistent | Review Required | — |
| mixed_pages | unknown (review) | — | — | — | gaps (page 2 needs OCR) | consistent | Review Required | — |
| multipage_invoice | invoice (recommended, 0.65) | — | 1/1 | — | complete (6/6 pages) | consistent | Review Required (no date or supplier printed) | — |
| blank_form_boxes | generic (review) | — | 1/1 | — | complete (1/1 filled, 1 not selected) | consistent | Review Required | — |

Totals:
- **Label accuracy:** 17/17 expected display labels.
- **Value accuracy:** 33/33.
- **Table accuracy:** 5/5 (columns and rows).
- **Excel consistent:** 17/17.
- **Association findings:** 0 false positives (wrong-box findings on documents built without one) and 0 false
  negatives (intended findings missed).
- **Classification:**
  - Of the 8 single-type documents, 7 got the right family.
  - Only 2 of them (invoice, passport) were confident enough to be *classified*; the rest are held for confirmation.
  - The FAR document was read as a contract, at 0.30, held for review.
  - **No document received a confident wrong type.**
- **Development measurements:** the first run found one false positive ("NOV 2021" flagged as an invalid date). It
  also found that the purchase order, bank statement and MSA reported their identifiers as Not found. Both are
  fixed (section 5).

## 8. Processing performance

The validation report is built on request and cached until the document changes. The cache key is the document's
pages, extraction values and review states, structure reviews, classification rows and jobs. The file's own checks
are stored per checksum.

| | 288-page digital document |
|---|---|
| Upload + page extraction (no OCR) | 1.9 s |
| First validation report | 1.8 s: file 0.08 s, layout 0.83 s, labels + business data 0.82 s, completeness 0.07 s, Excel check 0.01 s |
| Cached report | 5 ms |
| Small documents (matrix) | 30–130 ms per report |

- **Timeouts:** the job runner records `stage_history` with per-stage durations, plus `stage_timings_ms`. That now
  includes `file_verification_ms`. On failure, `failure` holds the stage and reason, and the timings recorded so far
  are kept.
- **Progress:** progress in the strip is stages done out of six. While pages are read, it shows *N of M pages* from
  the document's own counters, not an estimated percentage. The job's existing `progress` field is unchanged.
- **Real FA30:** a real FA30 (288 pages, 52+ filled boxes, OCR on scanned pages) was not available in the
  repository. Its OCR time depends on the OCR engine and isn't measured here.

## 9. Backend and frontend test counts

| Suite | Before (7.3.3 Phase B) | Now |
|---|---|---|
| Backend (`pytest`) | 1,382 passed, 14 skipped | 1,450 passed, 14 skipped |
| Frontend (`vitest run`) | 649 passed | 656 passed (93 files) |
| Frontend typecheck (`tsc --noEmit`) | clean | clean |

## 10. Remaining limitations

- **Classification on short documents.** The engine's confidence on one-page documents is often below the 0.85
  threshold, so most are held for review. This increment does not change the engine's selection: it would change
  staging profiles and saved Oracle mappings.
  - When the profile resolver is inconclusive but a candidate scores ≥ 0.85 (an SF33 by its form identifier), the
    candidate is offered as a suggestion, not applied.
  - Changing the engine to accept such candidates automatically is a separate decision.
- **Original File field names stay as printed.** The tab and the Excel keep the document's own field names
  (Phase A). The cleaned display label and meaning are shown in the tooltip and used for business fields,
  validation and readiness. Writing out abbreviations in the Excel "Field Name" column would change the export
  contract; it's left for a decision.
- **Rotation and image quality.** Rotation is the PDF's `/Rotate`. Skewed scans are corrected inside OCR (existing),
  not reported per page. Image quality is the OCR confidence after OCR and the resolution of uploaded images; there
  is no blur measure.
- **Multiple contracts.** These are found by every distinct value under a Contract Number label (fields and table
  columns). Business entities other than contracts (several suppliers or invoices in one file) are not counted.
- **Tables a reader never detected** can't be counted as missing: the table audit compares against detected tables.
  Pages with text but no fields or tables (clause pages) are not flagged.
- **Duplicate uploads** are found by identical checksum; a re-scanned copy of the same document isn't.
- **Background progress** is checked every 4 s while a stage runs; there is no push channel.
- **Real-document matrix.** The matrix uses documents built by the tests. Running the metrics over real FA30 and
  customer documents needs those files and their verified expected values.

## 11. Oracle mapping readiness

- The workspace strip and `GET /upload-validation` give one of Ready for Mapping, Ready with Warnings or Review
  Required, with the checks behind it.
- It describes the source data only. It doesn't check that an Oracle target schema is configured, or that an import
  would succeed; the mapping workspace's own validation does that.
- The mapping workspace stays open in every state.

## 12. Deployment dependencies

- **No migration:** new data is in existing JSON columns. `a7c9e1f3b5d7` (Phase B) is still required.
- **Backend and frontend together:** the frontend calls `/upload-validation`. If the backend isn't deployed with
  it, the strip shows "Document check unavailable" and nothing else is affected.
- **No new Python or npm packages:** PyMuPDF and openpyxl are already dependencies.
- **Running jobs:** jobs started before the deploy have no `verifying_file` or `classifying` stage and no
  `failure`. Their stages are still derived, and a failed old job is treated as retryable unless it says otherwise.
- **Alias tables:** `label_aliases.json` ships with the code. Changing it changes display labels and meanings, not
  stored values.
