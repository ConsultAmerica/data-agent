# DI-03 Completion Report — Pluggable OCR and Structured Extraction Engine

**Status:** Implemented locally on branch `feature/di-02-safety-foundation` (on top of DI-02) — awaiting review
**Date:** 2026-10-26
**Commit / push / deploy:** Not performed. **No external provider was called**: Azure and Google adapters were exercised only against `httpx.MockTransport`; no credentials are configured.

> Scope note: DI-01's backlog named DI-03 "invoice matching and inbox". DI-03 was re-scoped by the product owner to the pluggable recognition engine; invoice matching moves to a later phase.

---

## A. What was built

| Component | File | Notes |
|---|---|---|
| Layout types | `app/recognition/layout.py` | Words, lines, tables with an explicit coordinate space (`pdf_points` / `ocr_pixels`). |
| Provider contract | `app/recognition/types.py` | `RecognitionProvider`, request (file, pages, prior results, wanted fields), result (pages, tables, fields, usage). |
| Local providers | `app/recognition/providers/local.py` | `native_text` (PyMuPDF words), `tesseract` (existing word layer), `mrz` (ICAO 9303 on text read by an earlier step; check-digit result reported, never corrected). |
| Azure AI Document Intelligence | `providers/azure_di.py` | REST, API version pinned (`2024-11-30`); submit → poll; words/lines/tables; prebuilt invoice and ID field maps to canonical ids. Values kept **as printed** for re-grounding; vendor-normalised value kept separately. |
| Google Document AI | `providers/google_docai.py` | REST v1, service-account token (google-auth) or injected; tokens, entities (invoice parser map); 0-based page refs converted. |
| LLM structured extraction | `providers/llm.py` | Wraps the configured `AIProvider`; sees only text an earlier step read; asked to quote. |
| Registry | `app/recognition/registry.py` | All adapters always registered; each reports `configured` + reason. |
| Strategies | `app/recognition/strategies.py` | Ordered steps with `when` (`always` / `no_text` / `fields_missing`), timeout, max attempts, required. Invoice: native → Tesseract if no text → Azure → Google → LLM, each only if fields are still missing. |
| Engine | `app/recognition/engine.py` | Per step: configured? condition? policy (external)? budget? → run with timeout; retry **only** transient errors (timeout/429/5xx); record every attempt and refusal. Then ground and merge (below). |
| Page-OCR seam | `app/recognition/page_ocr.py`; `services/page_text_extractor.py`; `services/document_extraction.py` | `OCR_ENGINE=tesseract` (default) resolves no engine → pipeline unchanged. Another engine, when configured **and** policy-approved, reads the same page image Tesseract would; its boxes land in the same pixel space; failure falls back to Tesseract per page. |
| API | `app/api/recognition.py` | `GET /api/recognition/providers`; `POST /api/documents/{id}/recognize` (workspace-isolated, `extraction.run`). Returns steps, merged fields with evidence, rejected candidates, cost. Writes run records only — **not** the staging workbook. |
| Run usage | migration `c3e5a7b9d1f2` | `model_version`, `pages`, `input_tokens`, `output_tokens`, `estimated_cost_usd` on `recognition_runs`. |

## B. "Never invent values" — enforced by the engine, not the providers

1. A candidate without evidence (page ≥ 1 and source text) is rejected.
2. When the platform has its own text for that page (native or Tesseract), the value must be readable in it (strict grounding) — otherwise rejected with the reason. Accepted candidates are marked `locally_confirmed`.
3. Candidates are merged per canonical field: agreeing providers → `agreed`; one provider → `single`; disagreement → `conflict` (for a person to decide). No winner is chosen in a conflict.

## C. Cost and versions

- Cost is computed **only** from the operator-configured per-page price (`AZURE_DI_PRICE_PER_PAGE_USD`, `GOOGLE_DOCAI_PRICE_PER_PAGE_USD`); no prices are assumed. `RECOGNITION_BUDGET_USD_PER_DOCUMENT` stops paid steps once reached.
- Every run row records provider, model, model version / API version, pipeline version, data class, pages, cost, duration, status and error class.

## D. Configuration (all off by default)

`OCR_ENGINE`, `AZURE_DI_ENDPOINT`, `AZURE_DI_KEY`, `AZURE_DI_MODEL`, `AZURE_DI_API_VERSION`, `AZURE_DI_PRICE_PER_PAGE_USD`, `GOOGLE_DOCAI_PROJECT`, `GOOGLE_DOCAI_LOCATION`, `GOOGLE_DOCAI_PROCESSOR_ID`, `GOOGLE_DOCAI_PROCESSOR_VERSION`, `GOOGLE_DOCAI_PROCESSOR_KIND`, `GOOGLE_DOCAI_CREDENTIALS_FILE`, `GOOGLE_DOCAI_PRICE_PER_PAGE_USD`, `RECOGNITION_BUDGET_USD_PER_DOCUMENT`. External engines additionally need policy: OCR at upload sees an **unclassified** document, which under `enterprise` needs an approval for class `unclassified`.

## E. Not done / next

- Engine results are not yet written into staging workbooks (deliberate: the reviewed workbook stays the single export source; wiring is a design decision for the next phase).
- No real-provider evaluation: needs DPA/region approval, credentials and a permissioned document set (benchmark plan).
- Table merge from external providers into invoice line items; tokens for LLM usage (providers don't report them yet).
- Convera document mode remains outside the policy (off by default).

## F. Verification (combined DI-02 + DI-03)

| Check | Result |
|---|---|
| Backend suite | **1023 passed, 0 failed, 15 skipped** (13 min; DI-01 baseline was 877 passed / 11 failed / 14 skipped) |
| DI-03 tests (`tests/test_recognition_engine.py`) | 25 passed |
| Frontend type check | clean |
| Frontend suite | 446 / 446 on a quiet machine; two existing timing-sensitive tests in untouched files (`document-compare`, `document-workspace`) flake under CPU load and pass on rerun |
| Regression snapshot vs `main` (14 documents) | business outputs identical (DI-02 report §C) |
| Lint on changed frontend files | only pre-existing findings (same on `main`) |
