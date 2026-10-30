# VNext Increment 6C.1 — Extraction Workspace Redesign and Processing Bottlenecks

Status: implemented locally and tested; **not committed, pushed or deployed**.
Date: 2026-10-29 · Branch: `feature/di-02-safety-foundation` (working tree)

## 1. UI changes

| Requirement | Implementation |
|---|---|
| Tab order | Extraction workspace (`PresentationWorkspace`): **Original Structure** first, then Content, Contacts, (profile groups), Line Items, Table Data, Other Information, and **Summary always last** (`orderGroups`). The document page's view switch also starts with Original Structure (the default when no view was chosen). |
| Tab kept during review | The chosen tab is stored per document (session storage), so reloads and remounts after review actions keep it. |
| Original Structure | Sections in document order (from the document's headings). Fields use the columns **Category / Section · Field / Label · Extracted Value · Evidence · Review Status · Type · Found By · Source Page** (the last three always last). Blank printed fields are shown as "Blank in document", never hidden. Sections collapse without removing records. Extracted values with no place in the layout are listed under "Other extracted fields". |
| Tables | Printed headers, one row per record; a table continued across pages is merged only when the structure links them **and** row numbers carry on (rows 36 → 37); a following table whose rows restart stays separate. Rows over 100 are behind "Show all"; nothing is dropped. Cells that don't fit their column (e.g. `#########`, `0/10/2025`) are flagged. |
| Record details | Original label, original source text, printed value, extracted value, reviewed value, validation, review status, flags, source page, extraction method, Oracle mapping state (or "No Oracle mapping configured"), View in source, link to Metadata review. |
| Field quality | All extraction candidates for one printed field are grouped ("2 candidates"); details list each with value or *(empty)*, **confidence, validation and review kept in separate columns**. Nothing is auto-approved. |
| Label/value reconciliation | Flags (each → Needs review): extraction read another value for this label; extraction found no value where the page shows one (the `contract_no 25% —` case); value belongs to another label; several different values for one field; different source page. Printed values are never replaced. |
| Processing monitor | Each queue row: current stage in words, elapsed time, place in line, and a detail panel with **pages read (x of y), OCR pages, extraction batches, last update, retries, error**. More than 3 minutes without a backend report is flagged as possibly stalled. Only reported values, no percentages. Files waiting on a duplicate decision say so. |

## 2. Layout reconstruction (backend)

- New relation `ruled_form_row` in the source-structure extractor: captions on the left, the value written on a drawn underline at the right; the left-most caption groups the indented ones under it; empty blanks kept (as rejected, so never staged). Box borders (lines met by vertical rules, as on SF 1442/SF 33) are excluded; several blanks on one line each take only their own caption. Extractor version 11 → 12 (stored structures rebuild).
- Fixture (`tests/contract_brief_fixture.py`): the layout of the supplied `aa.pdf` (form page, Q&A page, summary table, 82-row modifications table continued without a header, a second contract block) with **made-up values** — the original is marked *Company Proprietary* and the repository is pushed to GitHub. `all_fields_form_layout.xlsx` was not available locally.
- Result on the fixture: labelled values found **10 → 54 of 54**; modifications table read with its printed headers as 82 rows instead of cell fragments.
- Real local PDFs, before → after (accepted pairs): SF1442 unchanged; FA300224C0008 266 → 267 (adds the SF 33 offer date `12 Feb 2024`); 47QRC unchanged; 383 structure/staging tests pass.
- API: `GET /api/documents/{id}/original-structure`.

## 3. Pipeline findings and timings

Instrumentation: every processing and extraction job now records `metrics` — queue wait, worker start-up, each stage with its share, an **unmeasured** remainder (so stages always add up), OCR pages, AI calls (count, failures, retries, latency from the per-call `RecognitionRun` rows) and record counts — and logs one structured `job_stage_timing` event per stage (no document content). `scripts/pipeline_timing_report.py` aggregates recent jobs.

**Queue time.** The server picks jobs up in 0.02 s (median; max 0.6 s). The waiting users saw was in the browser: two slots each held through upload, the whole processing job and classification, then extraction one file at a time.

**288-page contract (`Contract - FA300224C0008`), 3 runs, local, no OCR needed:**

| Stage | Before p50 | After p50 |
|---|---|---|
| Processing total | 27.7 s | **19.4 s** |
| · page loading (text + tables) | 25.6 s (92%) | 17.5 s |
| Extraction total | 19.2 s | 12.2 s (not targeted — run-to-run variance) |
| End to end | 47–49 s | **27–33 s** |

Slowest three stages (before): page loading 25.6 s, field extraction 4.9 s, key-date detection 4.6 s. Within page loading, PyMuPDF's sorted-text helper was 14.9 s of 26 s (Python `Rect` objects for every word and union, called for every page).

Other documents (p50 before → after): SF1442 (33 pages) processing 9.3 → 5.0 s; 1-page invoice 1.2 → 1.0 s.

## 4. Optimizations (each from a measurement)

| Change | Measured effect |
|---|---|
| **Sorted page text on float tuples** (`sorted_page_text.py`) — same algorithm, flags, tolerance and spacing as PyMuPDF's | **Byte-identical on 1,884 pages of 413 local PDFs**; 6.1× faster (40.0 → 6.6 s across them) |
| **AI document-family call runs beside label enrichment, both bounded** (it was unbounded and sequential; it only names the type — targets are re-sorted either way) | Controlled latency: 7.1 → 3.6 s (3.5 s per call); a hanging call 23.7 → 5.1 s. Same targets with or without it (test) |
| **Two extractions at a time** in the batch queue (processing stays at two) | Removes the one-file-at-a-time extraction queue |
| **Heartbeat for running jobs** (`extraction_jobs.heartbeat_at`, every 20 s) | A job whose worker died is marked interrupted after 3 min of silence instead of 30 min of age |

Not changed (measured, deferred): pdfplumber table detection is the rest of page loading (already gated per page and parallel for 24+ pages); replacing it would change `tables_json` for every reader.

## 5. Accuracy and completeness

- Record counts identical across all 6 benchmark runs (3 before, 3 after): invoice 11 targets / 8 values / 3 unresolved; SF1442 48 / 30 / 1 table / 15; 288-page contract 82 / 76 / 1 table / 3.
- Page text byte-identical (above). Discovery targets identical with and without the AI family call.

## 6. Failure recovery

- Stale jobs: heartbeat rule (above); jobs from older code keep the 30-minute rule; a rolling deploy's old instance keeps beating, so its jobs aren't misjudged.
- Retries don't duplicate records (test: re-running extraction leaves the row count unchanged).
- **Fixed:** re-running extraction reopened **every** human correction for review (it compared the new machine value with the *reviewed* value, which a correction always differs from). It now compares with the previous *machine* value: an unchanged extraction keeps the correction and its approval; a changed one still reopens the field (`extraction_differs_from_reviewed`), value preserved — covered by the existing governance tests and a new one.

## 7. Tests

| Suite | Result |
|---|---|
| Backend `pytest` | 1,274 passed before the last fixes; final run on the finished code in §7.1 report |
| Frontend `tsc` / `vitest` | clean / **601 passed** |
| New backend tests | original structure (9), sorted text (3), AI concurrency (3), job recovery & metrics (4), table workers (5), durable jobs (5) |
| Browser | Original Structure (first tab, column order, sections, merged 82-row table, flagged field details, collapse) and a 4-file batch (stages, pages read 3 of 6, place in line, done times) — no console errors |

## 8. Remaining risks

- The structure detector is geometric; unusual forms (underlines drawn as images, scanned forms) fall back to the previous detectors.
- `heartbeat_at` is a new nullable column: added by Alembic (`b8d2f4a6c1e3`) **and** by the start-up column check, i.e. a deploy adds it to the production database automatically.
- "Normalized table" views and notes/footnotes as their own regions are not implemented (Content shows document text).
- The production 15-minute stall is analysed in the 7.1 report (memory, worker loss, workspace scoping) — not reproduced locally.
