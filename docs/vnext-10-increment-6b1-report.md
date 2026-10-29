# VNext Increment 6B.1 — Viewer Framework, Classification and Date Intelligence

Status: implemented locally and tested; **not committed, pushed or deployed**.
Date: 2026-10-29 · Branch: `feature/di-02-safety-foundation` (working tree)

## 1. Repository audit (what existed)

| Area | Found | Decision |
|---|---|---|
| Viewers | 6B router (`DocumentViewer`), PDF/image panel, spreadsheet/CSV/JSON/XML/Word viewers, evidence model (`resolveLocation`), split view | Reused. Added the two missing pieces: `ViewerErrorBoundary` and `UnsupportedPreview` |
| Classification | `app/classification` (Increment 2, engine `cls-1`): family, category, subtype, confidence plus level, evidence, alternatives, method, engine version, review-required status, audited confirm / override with history and re-staging | **No new pipeline.** Exposed through the new intelligence response; corrections use the existing panel |
| Dates | `app/key_dates` (detector, `DocumentKeyDate`, `/key-dates` API, Expirations page): expiry, valid-until, renewal, termination, period-end, due, issue and effective dates from the MRZ, labelled text and the contract schedule | Extended (section 3) |
| Approved values | `DocumentMetadataField` with `review_status` accepted / edited (Metadata review) | Used as approved lifecycle dates |
| Storage | `document_key_dates.details` (JSON) | Holds original text, ambiguity and both readings, so **no migration** |

## 2. Architecture

```
GET /api/documents/{id}/intelligence?warning_days=30|60|90
  classification ← existing classification state (_state)
  date_candidates ← DocumentKeyDate rows (extracted) + approved Metadata review dates
  lifecycle ← app/key_dates/lifecycle.evaluate(family, candidates, today[tz], warning)
Document list ← per-row lifecycle from stored dates (+ ?lifecycle= filter)
```

- **One evaluator** (`lifecycle.py`) serves the intelligence response, the document list and its filters.
- **Approved values win and are never overwritten:** re-detection rebuilds only extracted rows.
- **Extracted and approved values stay separate in the response,** each with its own `review_status`.
- **"Today" is a calendar date** in `Settings.lifecycle_timezone` (default `UTC`).
- **Warning window:** the default is now **30** days (`key_date_expiring_days`, previously 90); 60 and 90 can be chosen per request.

## 3. Date intelligence

- **Canonical concepts, mapped to existing kinds rather than new identifiers:**
  - `issue` → issue_date · `award` → award_date (new kind)
  - `effective` → effective_date · `start` → start_date (new kind; "start/commencement date", and the first date of a "period … through …" range)
  - `period_end` → end_date · `expiry` / `valid_until` → expiration_date
  - `renewal` → renewal_date · `due` → payment_due_date · `termination` → termination_date
- **Each date carries:** original text, normalized date (only when unambiguous), date type, source (MRZ / text / contract schedule / Metadata review), page, evidence text, confidence, validation status (valid / ambiguous / unreadable) and review status (approved / not reviewed).
- **Ambiguous dates are never silently decided.** `03/04/2031` keeps both readings. It is resolved only by the document's own context:
  - its other, unambiguous numeric dates, all pointing the same way;
  - or a US federal form (contract profile), read month-first.
  - Otherwise it stays ambiguous: lifecycle **Needs Review**, key-date status `ambiguous` (never counted as expired or expiring), and no date shown in the list or header.
- **No date is derived** (e.g. no expiry from an issue date).
- **Detector version** is now `key-dates-v2`. Older rows are re-read on next access, using page text only.

## 4. Lifecycle rules

| Family | Rule |
|---|---|
| Invoice, receipt, statement (bank), financial reports, transcripts, tax / pay documents, lab reports… | **Not Applicable.** An invoice's due date is reported as a payment date, not an expiry |
| Passport, ID, driving licence, insurance policy | End = stated expiry / validity. A missing expiry is "No Expiration Date" with "normally states one" |
| Contracts | Start = effective, then start, then award. End = stated termination / expiry, else the **base** period end; option periods count only if nothing else is stated, and are flagged for review |
| Others | Evaluated from stated dates only |

- **Statuses:** Active · Not Yet Effective · Expiring Soon · Expires Today · Expired · No Expiration Date · Needs Review · Not Applicable.
- **Conflicts:** different end dates of the same kind (e.g. MRZ vs printed expiry) give **Needs Review** unless a person approved one.

## 5. UI

- **Document list:**
  - new Format, Effective / start, Expiration and Lifecycle columns (dates are calendar dates, the same day in every timezone);
  - new **Lifecycle** filter: Expired, Expiring soon, Missing dates, Needs review, Active, Not yet effective. It combines with the existing category tabs and Document Type filter, and the choice is kept in the URL.
- **Document Intelligence card** (Smart View panel):
  - category / type, confidence level, method and engine version, secondary categories, "Why this type" evidence;
  - Confirm or change type (existing audited panel);
  - lifecycle badge, reasons, days left, and a warning-period selector;
  - start, expiration, renewal and payment-due dates with printed text, source and page, "Approved" marking, both readings when ambiguous, and **View in source** (opens the page with the date highlighted);
  - review items, and all dates found.
- **Header expiry pill and Expirations page:** an ambiguous date shows as printed with "(ambiguous)" and "Date needs review", never as a countdown.
- **Viewer framework:** `ViewerErrorBoundary` (a failing format viewer falls back to page text with the reason) and `UnsupportedPreview`.

## 6. Tests

- **Backend — new `tests/test_document_intelligence.py` (18 tests):**
  - lifecycle: expired, expires today, expiring soon, active, the 60-day window, not yet effective;
  - not-applicable documents: invoice due date, transcript;
  - missing expiration, MRZ / printed conflict, ambiguous end date, approved value settling it, contract base vs option periods;
  - detection: effective, start, expiration and award dates with original text; period start and end; ambiguity and its readings; document-context resolution;
  - API: passport (Identity, MRZ expiry with page and evidence), bank statement and invoice (Finance, not applicable, payment due), unknown document (confirmation required);
  - ambiguous expiry (no normalized date, Needs Review), human review preserved across re-detection, warning period 30/60/90 (45 refused), list lifecycle columns and Expired filter, ambiguous date never counted as expired or shown in the list.
- **Existing suites still pass:** `test_key_dates.py` and `test_classification.py` (invoice, contract, unknown needs review, audited override).
- **Frontend — new `document-intelligence.test.tsx` (6 tests):** card content and evidence navigation; ambiguous date with both readings; approved marking and warning-period refetch; invoice "payment date, not an expiry"; calendar-date formatting; error-boundary fallback and reset. Plus a list test (lifecycle badges, format, Lifecycle filter request).
- **Full suites:** see the completion note.

## 7. Browser walkthrough (local, Chromium 1680×1050)

Run against the repo's dev server and this backend, on generated documents (active passport, expired passport, certificate of insurance expiring in 20 days, ambiguous certificate, invoice) and the SF 1442 award.

| Step | Result |
|---|---|
| Document list | Format / dates / Lifecycle columns; SF 1442 Active with end Sep 28, 2028; invoice Not Applicable; FAR documents No Expiration Date |
| Lifecycle = Expired | 2 rows, both Expired (expired passport, sample3) |
| Lifecycle = Expiring soon | Expiring Soon rows only |
| Passport card | Identity Documents / Passport · structural recognizer · Active, 1,995 days left · expiration Apr 15, 2032 from the MRZ, p. 1 · View in source opened page 1 |
| Ambiguous certificate | Needs Review · "03/04/2031 (ambiguous)", could be Mar 4 or Apr 3, 2031 · header "Expiry 03/04/2031 (ambiguous) · confirm the date" |
| Invoice card | Financial / Invoice · Not Applicable · "payment date, not an expiry" |
| SF 1442 card | Contracts & Awards / Government Contract — SF 1442 Contract Award · Active, 700 days left |
| Page errors | none |

Screenshots in the session scratchpad `shots/`: `6b1-1-list`, `6b1-2-list-expired`, `6b1-3-passport-card-source`, `6b1-4-ambiguous-needs-review`, `6b1-5-invoice-not-applicable`, `6b1-6-contract-card`.

## 8. Known limitations

- **Classifier accuracy:** confidence is uncalibrated (it says so). A *certificate of liability insurance* was classified as a generic business document (low confidence, flagged for confirmation); its lifecycle was still evaluated from its stated dates.
- **List lifecycle** uses stored dates. A document read by the older detector is re-read on its first listing (one-time, page text only); the first list load after deploying can be slower.
- **Lifecycle filters** use the existing capped scan for computed filters (`search_scan_cap`), like the status filter.
- **Approved-date fields:** human-approved dates come from Metadata review keys (`effective_date`, `expiration_date`, `start_date`, `end_date`, `renewal_date`, `termination_date`, `award_date`, `issue_date`, `due_date`, `payment_due_date`). Profiles with other date keys aren't used yet.
- **Not built:**
  - per-date review actions (review happens in Metadata review);
  - insurance coverage vs policy dates as separate concepts;
  - contract option exercise tracking.
- **Lint:** `documents-home.tsx`'s existing React-compiler error on `clearFilters` repeats once more because of the added filter setter (the same error at HEAD).

## 9. Readiness

- **Deployment:** no migrations, no data changes. Re-reading dates uses stored page text only.
- **Behaviour change:** the expiring-soon default drops from 90 to 30 days (per the brief), so the Expirations page's "Expiring soon" list shortens.
- **Blockers remain the same as before:**
  - Render builds fail on Python 3.14 (pin 3.12);
  - `main` still has ZIP/EML enabled until 6B.0 lands;
  - `main` has a CORS commit to reconcile;
  - all of this work is uncommitted.
