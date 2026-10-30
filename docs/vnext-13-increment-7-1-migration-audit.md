# VNext Increment 7.1 — Render-to-Vercel Migration Audit and Durable IDR Architecture

Status: audit, measurements, fixes and proof of concept done locally; **nothing committed, pushed, deployed, migrated or deleted**. No production data was read or changed.
Date: 2026-10-29 · Branch: `feature/di-02-safety-foundation`

## 0. Findings that need attention first

1. **Production backend is not running the latest code.** `GET /ready` on Render reports `git_sha d942fbc` (hours after `542c117` was pushed to `main`). The live frontend (Vercel, `542c117`) calls endpoints the live backend lacks (`/source-view`, `/intelligence`, `/staging-workbook/export-custom/preview` → 404). Check the Render dashboard: auto-deploy, failed builds, deployed branch.
2. **The production database is documented as Supabase Postgres, not Neon.** `render.yaml` and `docs/neon-migration-assessment.md` (2026-10-12, "Prepared — not executed") both say Render's `DATABASE_URL` is Supabase Postgres; file storage is a Supabase bucket. Whether the `dataomatix-db` Neon database is in use cannot be confirmed without credentials (§2).
3. **Large PDFs can run Render's free instance out of memory.** Measured on the 288-page contract: table prefetch with 6 worker processes peaks at **532 MB** (process + workers) — over the free plan's 512 MB before the web server is counted. The worker count came from `os.cpu_count()`, which reports the host's cores inside containers. **Fixed**: the pool is now sized from the container's cgroup CPU quota and memory limit (a 512 MB instance reads sequentially, 144 MB peak), with a `TABLE_PREFETCH_WORKERS` override.
4. **A job whose worker died stayed "processing" for up to 30 minutes.** In-process background tasks die with the process (restart, out-of-memory, deploy). **Fixed**: jobs beat every 20 s; silence for 3 minutes marks them interrupted.

## 1. Architecture audit (inventory)

| Component | Where / how | Notes |
|---|---|---|
| Frontend | Next.js (`frontend/`), Vercel project `data-agent`, domains dataomatix.com, www.dataomatix.com, data-agent-ca.vercel.app | `.vercelignore` uploads only the frontend |
| Backend | FastAPI `backend/app/main.py`, uvicorn, **one** process, Docker on **Render free** (`render.yaml`, `backend/Dockerfile`, python:3.12-slim) | Health `/health`, readiness `/ready` |
| API routes | Routers under `/api/documents`, `/api/...`, jobs under `/v1/jobs` | Document isolation by router dependency (`enforce_document_access`) |
| Background work | FastAPI `BackgroundTasks` → `run_in_worker_thread` (own event loop, thread pool) inside the web process | **No queue**: Celery/Redis are in `requirements.txt` but never imported |
| Parallelism | `ProcessPoolExecutor` table prefetch for PDFs of 24+ pages | Now sized from container limits |
| Database | SQLAlchemy 2 + psycopg 3; `DATABASE_URL`; Alembic (`migrations/`) **plus** start-up column checks (`database/migrate.py`) | Documented as Supabase Postgres |
| Auth | Entra JWT (not configured in production: `entra_configured false`), service API keys, `actors` table; anonymous **browser workspaces** via `X-Workspace-Token` (localStorage) | RBAC enforced in production |
| File storage | Supabase Storage bucket (required in production); local cache on the container disk (`ensure_local_copy`) | Container disk is ephemeral |
| PDF | PyMuPDF 1.28, pdfplumber/pdfminer | Wheels, no system packages |
| OCR | Tesseract (Debian package) through PyMuPDF and pytesseract; optional RapidOCR (onnxruntime) + OpenCV | **System binary** |
| Office | LibreOffice (`soffice`, Debian packages) for legacy .doc/.xls/.ppt | **System binary**, ~hundreds of MB |
| AI | Gemini (production), OpenAI, Ollama, Convera, fallback chain; session wrapper records every call (`RecognitionRun`) | Network only |
| Oracle | Templates, mapping profiles, preview/validation; `oracle_dry_run true` | No live Oracle calls |
| Unused heavy packages | Celery, Redis, LangGraph/LangChain, Numba + llvmlite (147 MB), SymPy (73 MB), boto3/botocore (29 MB), tiktoken, pypdfium2 | ≈ 260 MB removable |

## 2. Neon database verification

**Verified from the repository (no credentials used):** production `DATABASE_URL` is intended to be Supabase Postgres; a Neon migration runbook, validation checklist and rollback plan exist and are unexecuted; storage stays on Supabase in that plan.

**Not verified (needs access):** the live host behind Render's `DATABASE_URL`, its Alembic version, row counts. To verify without exposing secrets, run read-only against **each** candidate (Render's `DATABASE_URL` and Neon `dataomatix-db`) and compare:

```sql
select inet_server_addr(), current_database(), version();          -- identity
select version_num from alembic_version;                            -- schema version (expect a7c9e1f3b5d8 or later)
select count(*) from documents; select count(*) from extraction_jobs;
select max(uploaded_at) from documents; select max(id) from extraction_jobs;   -- recency fingerprint
select count(*) from document_metadata_fields; select count(*) from metadata_field_audit_log;
select count(*) from oracle_mapping_profiles;                       -- table name per models/oracle_template.py
```

The database with recent rows and `max(id) ≥ 153` in `extraction_jobs` is the live one. Optionally, a later deploy can add a non-secret `database_provider` (host suffix only) to `/ready`.

**Backup and restore** (from `neon-migration-runbook.md`, unchanged): `pg_dump --no-owner --no-acl --exclude-schema=auth --exclude-schema=storage --exclude-schema=realtime …` from the source, restore into a **new** Neon branch, run the validation checklist, never overwrite the source. A restore drill on a Neon branch is the first step once access is granted.

## 3. Stuck-job investigation (288-page contract, job 153, "Job not found")

**Not confirmable without production data.** What the code and measurements establish:

| Possible cause | Evidence | How to confirm |
|---|---|---|
| **Worker killed by memory** (Render free, 512 MB) | Measured 532 MB peak with 6 table workers on this document; `os.cpu_count()` sizing | Render → Events / Logs: "Out of memory" or restarts at the upload time |
| **Job orphaned after the worker died** | In-process jobs; old stale rule = 30 min of age | `select status, stage, started_at, completed_at, error_message, retry_count from extraction_jobs where id = 153;` — `processing` with an old `started_at`, or `failed` "Interrupted by a server restart" |
| **"Job not found" = different browser workspace** | `/v1/jobs/{id}` answers 404 "Job not found" both for a missing job **and** for a document outside the caller's workspace (deliberate, no disclosure). The workspace token is per origin: dataomatix.com and www.dataomatix.com both serve the app **without redirecting**, so they are separate workspaces; private windows or blocked storage have none | `select d.id, d.original_filename, d.owner_workspace from extraction_jobs j join documents d on d.id = j.document_id where j.id = 153;` — compare with the uploading browser's workspace |
| Job id belongs to another document | Possible if the UI showed a stale id | Same query: `original_filename` |
| Database mismatch (frontend → backend → different DB) | Ruled out for one deployment: one backend, one `DATABASE_URL` | §2 identity queries |
| Lost in-memory state | Job state is in the database, not memory | — |
| Stale frontend polling | The queue polls the id from the upload/start response; after a page reload, `?batch=` restores items from the server | Browser network log |

Most likely chain (to be confirmed with the logs): the 288-page upload starts the processing job in the web process → table prefetch spawns 6 workers → the instance exceeds 512 MB and restarts → the job stays `processing` (30-minute rule) → the queue shows Processing/Extracting for 15+ minutes; a reload from the other domain (or storage cleared) then gets "Job not found". **Recommended now:** redirect www → apex (one origin, one workspace) and deploy the memory and heartbeat fixes.

## 4. Processing-stage timing (operational)

Implemented in 6C.1 (`docs/vnext-12-increment-6c1-report.md`): per-job `metrics` (queue wait, worker start-up, page loading/OCR, structure detection, AI calls with latency/retries/failures, classification, field extraction, validation, database writes, profile/staging, key dates, an "unmeasured" remainder) and `job_stage_timing` events; `scripts/pipeline_timing_report.py`. The 14 requested stages map to these; schema selection, indexing and finalization are inside "profile_resolution" and "unmeasured" and can be split further when they show up as significant.

Measured locally (288 pages, 3 runs): processing 27.7 → **19.4 s**, end to end 47–49 → **27–33 s**, identical record counts. Sequential page reading (as on a small instance) took 49.5 s at 144 MB.

## 5. Vercel compatibility matrix

Facts from Vercel's documentation (Functions limits page, updated 2026-08-24; Python runtime page, 2026-08-12): Python runtime **GA** (3.12 default, 3.13, 3.14); bundle **500 MB** uncompressed (Large Functions beta up to 5 GB); max duration **300 s** (Hobby) / **800 s** (Pro, 1,800 s beta); memory 2 GB/1 vCPU (Hobby), up to 4 GB/2 vCPU (Pro); **request/response body 4.5 MB**; no system-package installation in the Python runtime. Container runtime (Dockerfile) and Daemons are **beta**; Python Queues and Workflow SDKs are **beta**.

| Component | Disposition |
|---|---|
| Next.js frontend | **Compatible** (already on Vercel) |
| FastAPI HTTP API (reads, review, exports, Oracle mapping) | **Compatible after refactoring**: ASGI app runs as Python Functions; remove start-up schema mutation; pooled DB URL |
| Upload endpoint (up to 100 MB) | **Different strategy**: 4.5 MB body limit → browser uploads straight to storage with a signed URL; the API registers the object |
| Background processing (in-process tasks) | **Different strategy**: functions end with the response; needs the durable job model (§7) driven by a queue/cron/worker |
| PyMuPDF, pdfplumber, openpyxl, python-docx/pptx, lxml | **Compatible** (wheels) — bundle size to prove |
| Tesseract OCR | **Blocked pending proof** in Python Functions (system binary). Options: Container runtime (beta), RapidOCR (onnxruntime wheel, already pluggable), or an external OCR provider |
| LibreOffice (.doc/.xls/.ppt) | **Blocked** in Python Functions; Container runtime (beta) or a separate conversion service, or drop legacy formats |
| Table prefetch worker processes | **Compatible after refactoring**: one function invocation per page batch instead of processes |
| AI providers | **Compatible** (HTTP) |
| Supabase Storage | **Compatible** (HTTP); Vercel Blob is an alternative |
| Neon / Postgres | **Compatible**; use the pooled connection string, small pool per function |
| Celery, Redis, LangGraph, Numba, SymPy, boto3 | Unused → **remove** (≈ 260 MB) |

**Proof of concept on Vercel: not run** — it requires a preview deployment (a deploy). Plan: a separate Vercel project (no production domain) with one Python Function that downloads a fixture PDF from storage and runs `extract_page_structure` + `sorted_page_text` on 25 pages, reporting duration, memory and bundle size; plus one Container-runtime function with Tesseract.

## 6. High-performance IDR architecture

```
Browser ──signed upload──► Object storage (Supabase / Blob)
   │                              │
   └─► API (Vercel Python Functions, FastAPI) ──► Neon Postgres (runs, tasks, results, review, audit)
                                   │ enqueue
                                   ▼
        Workers (bounded concurrency): container worker / queue consumer / scheduled function
        claim page-batch task (lease) → read pages (native text; OCR only where needed)
        → structure + fields + tables → checkpoint batch result → heartbeat → complete
                                   │ all batches done
                                   ▼
        Merge in page order → classification & schema → validation → staging → review queue
```

- Pages read once (native text first, OCR only on pages that need it — already decided per page), results checkpointed per batch, merged in page order (table continuity rules from 6C.1).
- Bounded concurrency per document and globally; AI calls bounded and side by side; nothing re-done on retry (idempotent batch keys).
- Review readiness separated from indexing: a document becomes reviewable when its batches are merged; indexing can follow.
- Batch size to be benchmarked (10/25/50 pages) on the target runtime — not hard-coded.

## 7. Durable workflow — proof of concept

`backend/app/workflow/durable_jobs.py` (own tables, not wired in) with `tests/test_durable_jobs_poc.py` (5 tests, passing):

| Property | Shown by |
|---|---|
| Persistent run per document, idempotency key (same input → same run) | `test_enqueue_is_idempotent` |
| Page-batch tasks, results in page order (288 pages, 3 workers) | `test_a_288_page_document_is_processed_in_order_by_several_workers` |
| Worker lease; crashed worker's batch taken over after the lease; its late answer refused (no duplicate) | `test_a_crashed_worker_s_batch_is_taken_over_and_its_late_answer_refused` |
| Heartbeat extends a lease; another worker can't extend it | `test_heartbeat_keeps_a_long_batch_from_being_taken` |
| Bounded attempts; failed run; retry count and stalled batches in progress | `test_a_batch_that_keeps_failing_fails_the_run_after_bounded_attempts` |

Atomic claims use a conditional `UPDATE … WHERE status/lease/attempts` (one winner per task), which works the same on Postgres. Vercel Workflows/Queues (beta) could later drive the same tables; the design doesn't depend on them.

## 8. Migration plan (not executed)

1. **Stabilise Render** (no migration yet): deploy the memory/heartbeat/review fixes; redirect www → apex; fix the auto-deploy so the backend matches the frontend.
2. **Database:** confirm the live database (§2); restore drill into a Neon branch; validation checklist; cutover only with approval (`neon-migration-runbook.md`). Keep Supabase intact for rollback.
3. **Uploads:** signed direct-to-storage uploads (removes the 4.5 MB limit issue on any host).
4. **Processing:** wire the durable job model behind the existing job API (same `/v1/jobs` contract for the frontend); run workers on the chosen runtime; prove OCR and LibreOffice there.
5. **API on Vercel:** a separate Vercel project/service for FastAPI; environment variables copied (secrets via Vercel env, never in the repo); `NEXT_PUBLIC_API_URL` switched per preview first.
6. **Monitoring:** job metrics + stage events, stalled-task alerts (tasks leased past their lease), `/ready` showing git SHA.
7. **Cutover** by DNS/API URL switch; Render kept running read-only until sign-off.

**Rollback:** API URL back to Render (unchanged service), database `DATABASE_URL` back to Supabase per `neon-migration-rollback.md`, storage unchanged in both directions. No step deletes Render or Supabase.

## 9. Cost and resources

- Render free: 512 MB, shared CPU, sleeps when idle — insufficient for 288-page documents with parallel table reading; sequential reading fits (144 MB measured) but is slower.
- Vercel Functions bill active CPU and provisioned memory (rates not quoted here — check the current pricing page); a 288-page document is ~20–30 s of CPU locally; a 300 s Hobby limit is enough per **batch**, not necessarily per whole document on slower CPUs — hence page-batch tasks.
- Neon: storage and compute pricing to be taken from the current plan; branches make restore drills cheap.

## 10. Test and rollback strategy

Done locally: small invoice, medium contract (SF1442, 33 pages), large contract (288 pages, 3 runs each), searchable PDFs, scanned PDF and image (OCR), complex/continued tables (fixture), worker interruption (heartbeat rule; lease takeover in the PoC), retry without duplication, human corrections across re-runs (bug fixed), classification and date extraction (existing suites), Oracle mapping and custom export (existing suites; unchanged code paths). Still to run on the target platform: the same set against the preview deployment, plus a restore drill.

## 11. Changed in this increment

- `app/services/generic_table_extractor.py`, `app/core/config.py` — worker pool from container limits; `TABLE_PREFETCH_WORKERS`.
- `app/services/target_result_store.py` — corrections survive re-extraction unless the extraction changed.
- `app/workflow/durable_jobs.py` — durable processing PoC (not wired).
- Tests: `test_table_prefetch_workers.py`, `test_durable_jobs_poc.py`, `test_job_recovery_and_metrics.py`.

## 12. Needs your authorization

1. Read-only access to the production database(s) (or someone running §2's queries) to confirm the live database and job 153.
2. Render dashboard events/logs for the 288-page upload time.
3. A preview deployment on a separate Vercel project for the runtime proof of concept.
4. Deploying the fixes (memory, heartbeat, review preservation) and the www → apex redirect.
