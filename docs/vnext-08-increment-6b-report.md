# VNext Increment 6B — Format-Aware Document Viewer Framework

Status: implemented locally and tested; **not committed, pushed or deployed**.
Date: 2026-10-29 · Branch: `feature/di-02-safety-foundation` (working tree)

## 1. Repository audit

| Area | Found | Outcome |
|---|---|---|
| PDF/image viewer | `SourceVerificationPanel` + `PdfToolbar` + `PdfPageViewer`: server-rendered pages, page navigation, zoom, fit width, rotation, text search with results, highlight box from page coordinates, next-page prefetch, text fallback (422) for non-paged files | **Reused and extended** (fit page, keyboard), not duplicated |
| Preview APIs | `/pages/{n}/render` (PDF/image), `/pages` (page text), `/source-json` (JSON, Increment 5 follow-up) | Reused; new `/source-view` for structured formats |
| Evidence model | `CellProvenance` (page, bbox, evidence, highlight, `source_locator` with dom_path / section_path / row / column / sheet / cell) | Reused as the single evidence source; no parallel format |
| What evidence is actually recorded | PDF and images: page + bbox. XML profile: `dom_path`. HTML: DOM path. **Spreadsheet, CSV, JSON and DOCX values: page (sheet index) + text only; no cell, row or path** | Viewers treat those as approximate and say so |
| Spreadsheets | Native ingest reads values only (`data_only=True`); merged cells and formulas aren't kept | New server reader reads formulas and cached values separately |
| Legacy DOC/XLS | LibreOffice conversion to a **temporary** file during extraction; the copy is deleted | Viewer shows the converted page text, labelled; no re-conversion per view |
| Workspace layout | Smart View (6A) three-panel layout; Advanced Grid split view | Both now host the router |

## 2. Architecture

```
DocumentViewer (router) ── GET /source-view → { viewer, format, verified, note, content }
  ├─ pdf / image / text → SourceVerificationPanel (existing; + Fit page, keyboard)
  ├─ spreadsheet → SpreadsheetViewer  (+ GET /source-view/sheets/{i})
  ├─ delimited   → DelimitedViewer     (SmartDataGrid)
  ├─ json        → JsonSourceTree      (extended)
  ├─ xml         → XmlViewer
  ├─ word        → WordViewer
  └─ unsupported → explanation, no guess
EvidenceBanner + resolveLocation(): provenance → typed SourceLocation + precision
```

- **Choosing the viewer.** The stored file's upload spec gives a candidate type, and its first bytes must pass the same magic-byte check as at upload; the file name alone is never trusted. A mismatch shows "can't be previewed" with the reason.
- **Format viewers.** Each is lazy-loaded (`React.lazy`), so a viewer's code downloads only when that format opens. Every structured viewer keeps a **Page text** tab showing what extraction read.
- **Caching.** The source view and each sheet are fetched once per document per visit and kept in memory only, never in browser storage.
- **Location model** (`lib/source-view.ts`).
  - Kinds: `page_region`, `page`, `sheet_cell`, `sheet`, `row`, `json_value`, `xml_path`, `word_text`, `none`.
  - Precision: **exact** means recorded coordinates, cell, row or path. **Approximate** means a recorded page, sheet or section, with the value found by its text. **Unavailable** means nothing was recorded.
  - Every viewer shows this in the evidence banner, in words. Nothing is invented.

## 3. Viewers

| Format | Delivered | Not delivered (reason) |
|---|---|---|
| **PDF** | Page navigation, zoom, fit width, **fit page**, rotation, search with result navigation, recorded-region overlay (page-coordinate fractions inside the rotated page box, so it stays aligned at any zoom or rotation), View in source from records, **keyboard**: PageUp/PageDown, ←/→, +/−, R | Thumbnails: each would be a server page render; omitted to avoid N extra renders per document |
| **Image** | Same viewer: zoom, rotate, fit, scroll-pan, recorded-region highlight | Separate OCR word overlay (not exposed by the API; highlight uses the recorded region or text match) |
| **Word (DOCX)** | Headings, paragraphs, lists (with level), tables, hyperlink targets shown as text, outline navigation, search with match navigation, metadata (title/author), evidence by text within the recorded section | Fonts, images, page layout. Links are shown, not followed. Legacy DOC uses page text (labelled) |
| **Spreadsheet (XLSX/XLSM/ODS)** | Sheet tabs, row numbers, column letters, cell selection, search with next/previous, Go to cell, zoom, frozen panes (rows and columns), merged ranges marked, **formula shown as written beside the cached value the file stores**; "None stored in the file" when the formula was never calculated; row virtualization; exact cell evidence when a cell ref is recorded, otherwise the sheet and a value match, labelled | Merged cells drawn as one spanning cell (marked instead). Columns past CZ are reached by search or Go to. XLS (legacy) uses page text |
| **CSV/TSV** | Rows exactly as text (leading zeros and quoted delimiters kept), detected encoding (guessed ones flagged), delimiter, header detection with a toggle, warnings (guessed encoding, uneven rows, truncation), search, sort, filters, column visibility, pagination, row details, evidence row | Re-parsing with another delimiter (would need the versioned backend workflow the brief requires) |
| **JSON** | Expand and collapse, full paths, search keys and values, copy path, copy value, arrays of objects as tables, evidence value opens its branch with a breadcrumb, 200 children per page | Path-exact evidence (JSON ingestion records no path; matched by value, labelled approximate) |
| **XML** | Elements, attributes, text, namespaces (prefix + URI), qualified names, expand and collapse, search, copy path, repeated elements as a table, exact navigation to recorded element and attribute paths (same path format as XML extraction) | — |

**Security**
- The server never evaluates formulas, never loads VBA (`keep_vba=False`), and parses XML with entities, DTDs and network access disabled (an XXE sample is refused in tests).
- Word becomes typed data blocks rendered by React, so there is no HTML to inject; a `<script>` in a document shows as text.
- External links aren't followed and no external resources are loaded.
- Size and count caps apply: 25 MB per source, 200,000 cells, 50,000 rows, 20,000 XML nodes, 20,000 Word blocks. A capped view says so.

## 4. Split view

- **Modes:** Smart View has three: **Split view** (document beside the data, resizable by drag or arrow keys), **Source only** and **Data only**. The mode and widths are kept in this browser (`dx-smart-layout`).
- **From Data only:** "View in source" switches to Split view and keeps the record selected.
- **Small screens:** under 1280 px, Source and Intelligence open as drawers.
- **Advanced Grid:** its split view uses the same router.

## 5. Also fixed (found during the walkthrough)

- **Spreadsheet and CSV documents couldn't open their workspace.**
  - Native ingest stores tables as lists of rows, but the generic key/value scanner (and four other table readers) assumed `{headers, rows}`. `GET /staging-workbook` therefore returned **500** for XLSX/CSV/ODS on the generic profile, and the page never left its loading skeleton. This was pre-existing and affects production.
  - The new `app/services/table_shapes.py` reads both shapes; stored data is unchanged. Regression tests were added.
- **XLSX labelled "XML".** The file-type label read "XML" for Office files, because their MIME type contains "openxmlformats". Exact XML types are now required; a test was added.

## 6. Tests

| Suite | Result |
|---|---|
| New backend `tests/test_source_view.py` | **26 passed**: viewer routing for 12 types, mismatch refused, formula vs cached value (and none stored), XLSM macro note, ODS positions/spans/formulas, CSV dialect and warnings, XML namespaces and extraction-matching paths, XXE refused, Word blocks as data, size cap, API routes, table shapes, XLSX/CSV staging workbook regression |
| New frontend `components/viewers/__tests__/viewers-6b.test.tsx` | **20 passed**: location precision, cell refs, routing/fallback/unsupported, PDF keyboard/zoom/fit/rotate, region alignment under zoom+rotation, spreadsheet formula/value + missing cached value, sheet navigation, search, Go to, exact and approximate cell evidence, 20,000-row virtualization, CSV provenance/leading zeros/header toggle/evidence row, JSON search/copy/table/evidence, XML namespaces/path/attribute/missing path/search/copy, Word structure without markup or live links, section-scoped evidence, missing evidence |
| Layout modes (`smart-view.test.tsx`) | 2 new: Split/Source/Data, remembered, resize; View in source from Data only |
| Frontend full suite (`vitest run --maxWorkers=2`) + `tsc --noEmit` | **86 files, 565 tests passed**; TypeScript clean; ESLint clean on all new and changed files except one existing error in `source-verification-panel.tsx` (present at HEAD) |
| Backend full suite (excluding the stress test) | **1,215 passed, 13 skipped**. One earlier run had a single failure in `test_dashboard.py::test_review_queue_buckets_rejected_and_unknown_first` that didn't reproduce in three reruns (alone, its file twice, and the full suite). That run overlapped the walkthrough on the same local database, so it's recorded as intermittent |

## 7. Browser walkthrough (local, Chromium 1680×1050 and 820 px)

Run against the repo's Next dev server on :3000 and this backend on :8001, with the SF 1442 award plus one generated document per format (XLSX with a formula, cached value, merge and frozen panes; Windows-1252 semicolon CSV; JSON; namespaced XML; DOCX with headings, list, table and link).

| Step | Result |
|---|---|
| SF 1442: clause → View in source | Page 8 with the recorded region highlighted (≈0.12–0.16 s after the record loaded) |
| Source only + Fit page / Data only | Layout switched; document fit to the panel |
| XLSX | Viewer "spreadsheet"; D2 shows `Formula =B2*C2 · Cached value 1250` |
| CSV | "Encoding: CP1250 (guessed) · Delimiter: Semicolon · header detected"; `0001`, `Labor; senior` kept |
| JSON / XML / DOCX | Tree with search · namespaces `inv`/`cac` listed · outline "1. Scope / 1.1 Schedule" |
| 820 px | Source opens in the drawer |
| Page errors | **none** |

- **Open times (dev mode, warm):** PDF workspace 2.3 s · XLSX 0.6–1.2 s · CSV 0.7 s · JSON 0.6 s · XML 1.1 s · DOCX 0.6–1.1 s.
- **Source view API:** 0.55 s for the XLSX (two openpyxl reads).
- **The CSV encoding result is a real example of the guessed-encoding warning:** the file was written as Windows-1252 and detected as CP1250. Both decode it identically.

Screenshots are in the session scratchpad `shots/`: `6b-1-pdf-split-evidence`, `6b-2-pdf-source-only-fit-page`, `6b-3-data-only`, `6b-4-spreadsheet-formula`, `6b-5-csv`, `6b-6-json-search`, `6b-7-xml`, `6b-8-word`, `6b-9-narrow-source-drawer`.

## 8. Known limitations

- **No recorded locations for most formats.** Extraction records no cell, row or path for spreadsheet, CSV, JSON or DOCX values, so their evidence navigation is approximate (sheet or section plus text match), and labelled so. Recording locators at extraction is the change that would make it exact.
- **Not shown in the browser:** the generic Smart View for these test documents had no records to select, so record-to-evidence navigation for non-PDF formats is verified by automated tests, not in the browser.
- **Not built:** thumbnails, a separate OCR word overlay, drawing merged cells as spans, columns past CZ in the grid, and CSV re-parsing.
- **Legacy DOC/XLS** show converted page text only.
- **Pre-existing, not changed:** the generic summary card shows "File Type XLSX" for CSV files (staging maps `.csv` to the spreadsheet source type).
- **Load time:** structured views load the whole capped source per document; very large workbooks (up to 25 MB) take longer on the first open.

## 9. Files

- **Backend:**
  - new: `app/source_view/`, `app/api/source_view.py`, `app/services/table_shapes.py`, `tests/test_source_view.py`
  - router mount: `app/main.py`
  - table readers now using `page_tables`: `generic_kv_scanner.py`, `clin_block_detector.py`, `page_retrieval.py`, `structure_detection.py`, `target_extraction_service.py`
- **Frontend:**
  - new: `lib/source-view.ts`, `components/viewers/*` (router, evidence banner, spreadsheet, delimited, XML, Word, tests)
  - extended: `json-source-tree.tsx`, `source-verification-panel.tsx`, `pdf-toolbar.tsx`, `smart-data-grid.tsx` (`focusId`), `smart-workspace.tsx` (router + layout modes), `document-workspace.tsx` (router in split view), `record-details.tsx` (locator), `extraction-workflow.ts` (XML label)
  - tests updated: `smart-view`, `review-6a`, `source-file`, `document-workspace`, `extraction-workflow`

Nothing has been committed, pushed or deployed.
