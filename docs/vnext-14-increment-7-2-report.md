# VNext Increment 7.2 — Vercel API, Neon and Durable Processing (Proof of Concept)

Status: **proof of concept deployed to its own Vercel project; database step waiting for the Neon branch URL.** Nothing committed or pushed; Dataomatix production (dataomatix.com, Render, Supabase) untouched.
Date: 2026-10-29

## 1. What exists now

| Item | State |
|---|---|
| Vercel project `dataomatix-api-poc` (team n-sfds-projects) | Created; deployed to its own URL **https://dataomatix-api-poc.vercel.app** (no custom domain; per-deployment URLs are behind Vercel Deployment Protection) |
| Functions | `fastapi` **79.3 MB** and queue subscriber `_py_subscribers/poc__queue` **79.3 MB** (limit 500 MB) |
| Runtime | Python **3.12.15**, uv install, 2-vCPU build machine; `/health` live |
| Private Blob store | `dataomatix-poc-documents` (`store_yTLbgNvzkcJhvmNn`, iad1, **private**), linked to the POC project only |
| Environment (Production of the POC project) | `APP_ENV=production` (RBAC enforced, no dev actors), `RBAC_ENFORCED`, `DB_NULL_POOL`, `DB_REQUIRE_TLS`, batch/concurrency/lease settings, `AI_PROVIDER=disabled`, random `POC_ADMIN_KEY` / `POC_LINK_SECRET`, `BLOB_READ_WRITE_TOKEN` (from the store link) |
| **Missing** | `DATABASE_URL` — the pooled connection string of a **new branch** of `dataomatix-db`, to be added by you |

`/health` today: `{"status":"degraded","python":"3.12.15","database":{"ok":false},"storage":"BlobStorage","ocr":{"engine":"tesseract (MuPDF built-in)","language_data":true},"libreoffice":false,…}`.

## 2. API migration

Route audit (existing FastAPI app): lightweight reads (jobs, documents, staging, review, exports), database writes (review, mapping), uploads (≤ 100 MB today), CPU-heavy work (page reading, OCR, structure, staging), long jobs (processing/extraction in in-process background tasks).

The POC (`poc/vercel-api/`) runs the **application's own code** — `app` package copied at build time by `build.py` (auth, RBAC, models, page reader, structure extractor, classification, key dates, durable jobs) — with 19 pinned dependencies instead of the full set:

| Route | Behaviour |
|---|---|
| `GET /health` | Runtime, non-secret database identity, storage, OCR data, LibreOffice presence, queue settings |
| `POST /api/documents/upload` | PDF ≤ 4.3 MB (Vercel's 4.5 MB body limit); private Blob object `documents/<uuid>.pdf`; document row with filename, MIME, size, SHA-256, object reference, upload time, status, owner workspace. Legacy .doc/.xls/.ppt → **415 with the reason** (no silent omission) |
| `POST /api/documents/{id}/jobs/process` | One transaction: job + durable run + page-batch tasks; then queue messages. **No extraction in the request** (job creation 6–14 ms). Same input → same job |
| `GET /v1/jobs/{id}` | Same contract (`queued/processing/complete/failed`) plus `state`, pages done/total, batches, retries, last progress, stalled batches; re-dispatches stalled batches |
| `POST /v1/jobs/{id}/cancel`, `/retry`, `GET …/diagnostics` | Cancel stops further batches; retry resumes only unfinished batches; diagnostics per batch (no document text) |
| `GET /api/documents/{id}/file-link` → `/file?token=` | Access-checked, **5-minute HMAC-signed** link (the Python Blob SDK has no signed URLs); private, no-store |
| `POST /admin/identity`, `/admin/migrate` | Key-protected; migrations run **only** on this explicit call, never on cold start |

Authentication is unchanged: Bearer Entra token or service key; otherwise the anonymous browser-workspace role scoped by `X-Workspace-Token`, documents outside the workspace answering 404.

## 3. Neon

- Code: `DB_NULL_POOL` (no pool kept between invocations; Neon's PgBouncer pools) and `DB_REQUIRE_TLS` (`sslmode=require`); sessions close per request.
- **Found and fixed: migrations alone did not build the schema.** Three tables (`actors`, `document_extracted_tables`, `integration_audit_log`) and 15 columns only ever came from start-up `create_all` / column patches — a new Neon branch built by Alembic would have had no `actors` table (service-key auth broken). Migration `c4e6a8b0d2f5` adds them only when missing (no-op on production); test `test_migrations_complete.py` now proves an Alembic-only database matches every model.
- **Not yet done (needs the URL):** identity check (`POST /admin/identity`: database name, server version, SSL, Alembic version, row counts), migration of the **branch**, connectivity test. The main branch of `dataomatix-db` is never touched.

## 4. Durable processing

Postgres holds the run, its page-batch tasks (stable ids `run:seq`), leases, attempts and checkpoints (`app/workflow/durable_jobs.py`). Vercel Queues (push subscriber, `max_concurrency` from `POC_CONCURRENCY`, bounded attempts) carries one message per batch; delivery is at-least-once, so:

- a batch is **leased**; a duplicate of a finished batch is acknowledged; one leased elsewhere is retried after the lease;
- a batch's page rows commit **in the same transaction as its completion**, which is refused if the lease was lost — no conflicting or duplicate rows;
- finalisation is elected once (conditional job update) and runs classification and key-date detection;
- status polls re-dispatch batches whose worker stopped (expired lease), so recovery needs no open connection;
- cancel and retry act per batch; completed batches are never redone.

Verified locally (9 tests, `poc/vercel-api/tests`), including **end to end through Vercel's own queue SDK** (embedded queue service), a simulated worker killed mid-batch (lease expiry → re-dispatch → completed, late commit refused, every page exactly once), duplicate deliveries (no change), cancel/retry.

## 5. PDF and OCR

- Page-aware: native text first (`sorted_page_text`), OCR **only** for pages `detect_ocr_requirement` flags; page numbers, reading order and structure from the existing extractor.
- **OCR without system packages:** PyMuPDF contains MuPDF's Tesseract engine; only `eng.traineddata` (tessdata_fast, 4 MB, Apache-2.0) is bundled. On the scanned-invoice fixture (99 ground-truth tokens): Tesseract recall 0.869 / precision 0.945 / **0.47 s**; RapidOCR 0.939 / 0.979 / 6.90 s. Tesseract kept (same engine as Render, 15× faster); RapidOCR remains an accuracy fallback.
- **LibreOffice:** no in-process replacement; legacy Office uploads are refused with the reason on this runtime. Options: Vercel Container runtime (beta) with LibreOffice, or keep conversion on the existing service.

## 6. Measurements (local, same POC code path)

| Test | Pages | Total | Largest batch | Records | Classification · dates |
|---|---|---|---|---|---|
| A small invoice | 1 | 0.6 s | 0.2 s | 9 fields, 1 table | invoice 0.47 · 1 |
| B SF1442 contract | 33 | 1.1 s | 0.7 s | 64 fields, 15 tables | government contract 0.90 · 2 |
| **C 288-page contract** | **288/288** | **27.3 s** (12 batches) | **6.7 s** | 4,071 fields, 21 tables | government contract 0.90 · 2 |
| D scanned invoice | 1 | 0.8 s (OCR 0.74 s) | 0.8 s | OCR text | invoice 0.78 · 1 |

Completeness vs the existing pipeline: page text **identical** character for character (1,845 / 95,474 / 926,879). The largest batch (6.7 s) is far inside the 300 s function limit.

**On Vercel: pending the database** (upload, Blob round trip, processing, interruption, function resource use).

## 7. UI

Queue (works with the current and the POC backend): badges for Interrupted / Partially complete / Cancelled when reported; **"Status unavailable"** (not "Failed") when a job lookup returns 404, with Retry; **Diagnostics** dialog (job, state, stage, times, retries, error, per-stage timings). Original Structure first and Summary last are unchanged.

## 8. Tests

| Suite | Result |
|---|---|
| POC (`poc/vercel-api/tests`, run on its own) | **9 passed** |
| Backend full suite | **1,286 passed, 14 skipped, 0 failed** |
| Frontend | tsc clean · **604 passed** |

## 9. Acceptance status

| # | Criterion | Status |
|---|---|---|
| 1 | POC API runs on Vercel | **Done** (`/health` live) |
| 2 | Neon connectivity | Pending branch URL |
| 3 | Secure store/retrieve | Local done; Blob store live; round trip pending database |
| 4 | Job without extraction in upload | Done locally; Vercel pending database |
| 5 | Survives worker interruption | Done locally, incl. Vercel queue SDK; Vercel pending |
| 6 | Retries don't duplicate | Done (tests) |
| 7 | Native PDF extraction | Done (identical text) |
| 8 | OCR or verified replacement | Done locally (in-process Tesseract, language data deployed) |
| 9 | Progress persisted | Done |
| 10 | Smart Review functional | Done (frontend suite) |
| 11 | Oracle mapping/export intact | Done (full backend suite passes; no mapping/export code changed) |
| 12 | 288-page reaches terminal state | Done locally (27 s); Vercel pending |
| 13 | Performance documented | Local done; Vercel pending |
| 14 | No production data lost | Nothing in production touched |
| 15 | Render available for rollback | Untouched |

## 10. Production migration readiness: **NO-GO** (for now)

Blocking: Vercel run of tests A–C and interruption on Neon; uploads above 4.5 MB need browser-direct upload (JS client upload to Blob); LibreOffice path; the full extraction/staging/review API is not yet on Vercel (only these routes); Vercel Queues and the Python SDKs are beta.

## 11. Files

- New: `poc/vercel-api/` (`poc_api.py`, `poc_queue.py`, `poc_processing.py`, `poc_storage.py`, `build.py`, `pyproject.toml`, `vercel.json`, `tessdata/eng.traineddata`, `tests/`), `backend/migrations/versions/c4e6a8b0d2f5_tables_missing_from_chain.py`, `backend/tests/test_migrations_complete.py`.
- Changed: `backend/app/core/config.py`, `backend/app/database/session.py` (null pool, TLS), `backend/app/workflow/durable_jobs.py` (job link, atomic completion, cancel, claim of a named batch), frontend queue (`batch-queue.ts`, `processing-queue.tsx`, `types/document.ts`).
