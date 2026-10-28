# Neon Migration Assessment — Supabase PostgreSQL → Neon

**Date:** 2026-10-12  
**Scope:** Authoritative PostgreSQL only (Consult America / Dataomatix)  
**Mode:** Discovery + plan — **no production DB access, no cutover, no config changes, no commit**  
**RC2 posture preserved:** metadata review mutations fail-closed in production; Oracle dry-run / no live send

---

## 1. Executive summary

| Finding | Detail |
|---|---|
| What moves | **PostgreSQL** currently pointed at by Render `DATABASE_URL` (documented as Supabase Postgres) |
| What stays | **Supabase Storage** (`SUPABASE_URL` + service role + bucket `documents`) — object bytes for uploads |
| Auth | **Not** Supabase Auth — Entra JWT + service API keys + `actors` table |
| RLS | App-level workspace scoping (`owner_workspace` / `scope_documents`) — **not** Supabase RLS dependency in application code |
| Neon fit | Standard SQLAlchemy/Alembic Postgres schema is Neon-compatible; avoid restoring Supabase system schemas (`auth`, `storage`, `realtime`, etc.) |
| Recommendation | **CONDITIONAL GO for staging preparation** · **NO-GO for production cutover** until staging validation completes and cutover is explicitly approved |

---

## 2. Current Supabase dependencies

| Service | Used? | Evidence | Neon impact |
|---|---|---|---|
| **PostgreSQL** | **Yes (production)** | `render.yaml` comments: metadata lives in Supabase Postgres via `DATABASE_URL` | **Migrate to Neon** |
| **Storage** | **Yes (production required)** | `document_storage.py`; production startup requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | **Keep on Supabase** (or later S3-compatible replacement — out of scope) |
| **Auth** | **No** | `app/core/auth.py` — Entra + API keys | None |
| **RLS policies** | **Not used by app** | Isolation in application layer | Do not migrate Supabase RLS catalog |
| **Realtime / Edge / Functions** | **No** | Not referenced | None |

**Critical split:** Migrating Postgres to Neon **does not** remove Supabase. Production still requires Supabase Storage credentials after cutover.

---

## 3. Connection and configuration

| Variable | Where | Role |
|---|---|---|
| `DATABASE_URL` | **Render only** (sync:false) | SQLAlchemy engine (rewritten to `postgresql+psycopg://`) |
| `SUPABASE_URL` | Render | Storage API base |
| `SUPABASE_SERVICE_ROLE_KEY` | Render | Storage auth (secret) |
| `SUPABASE_STORAGE_BUCKET` | Render (default `documents`) | Bucket name |
| `DB_POOL_SIZE` / `DB_MAX_OVERFLOW` | Render | Pool sizing |
| `NEXT_PUBLIC_API_URL` | Vercel | Frontend → API only — **no direct Postgres** |
| Entra `NEXT_PUBLIC_*` | Vercel | Browser auth — not DB |

**Cutover config change (future, not now):** replace Render `DATABASE_URL` with Neon connection string (pooled vs direct — see runbook). Leave all `SUPABASE_*` storage vars unchanged unless Storage is redesigned separately.

Local `.env` uses SQLite — not a migration source of truth.

---

## 4. Schema management

| Mechanism | Role |
|---|---|
| Alembic (`backend/migrations/`) | Production startup runs `run_alembic_upgrade()` when `APP_ENV=production` |
| Runtime `_ensure_columns` | Additive column patches every boot (incl. `metadata_field_audit_log.metadata_field_id`) |
| `Base.metadata.create_all` | Local/dev only |

**Implication for Neon:** Prefer restore of application schema + data **or** empty Neon + Alembic upgrade + data load. Do **not** dump/restore Supabase-only schemas. After restore, confirm `alembic_version` matches expected head and ensure-column is idempotent no-op.

---

## 5. Application tables (data inventory — logical)

Authoritative app tables (SQLAlchemy `__tablename__`):

| Domain | Tables |
|---|---|
| Core docs | `documents`, `document_pages`, `page_text_blocks`, `document_attachments`, `staged_uploads` |
| Metadata / review | `document_metadata_fields`, `metadata_field_audit_log`, `target_corrections`, `document_qa_reviews` |
| Staging | `document_staging_workbooks`, `document_source_structures`, `document_contract_structures`, `document_far_records`, `document_extracted_tables` |
| Extraction | `extraction_jobs`, `extraction_models`, `extraction_fields`, `document_detected_targets`, `document_structure_summaries` |
| Contract detail | clauses, contacts, addresses, line items, funding, delivery, signatures, WAWF, insurance, key positions, order ranges, performance periods, amendment history, contract summaries, clause references |
| Reference | `far_master_clauses` |
| Governance | `actors`, `classification_audit_log`, `relationship_audit_log`, `integration_audit_log` |
| Alembic | `alembic_version` |

**Production row counts:** not collected in this assessment (no production credentials used). Obtain during an approved discovery window via read-only SQL (see validation doc).

---

## 6. Workspace / tenant model

- `documents.owner_workspace` — workspace token hash for anonymous isolation  
- `documents.organization_id` / `owner_id` — optional org ownership  
- Access control: `scope_documents` + RBAC — not Postgres RLS  

Neon must preserve these columns and indexes exactly for RC2 isolation behavior.

---

## 7. Background processing

| Pattern | Storage |
|---|---|
| FastAPI `BackgroundTasks` / in-process job runner | `extraction_jobs` rows in Postgres |
| No Supabase cron / pg_cron dependency found | — |

After cutover, in-flight jobs on old DB may orphan; prefer write-freeze until jobs drain (runbook).

---

## 8. PostgreSQL extensions

Application migrations do not require exotic extensions (no `pgvector` / `uuid-ossp` mandates found in app migrations). Neon supports common Postgres features.

**Do not** restore Supabase extension catalogs blindly. Create only extensions Alembic/app actually need (typically none beyond defaults).

---

## 9. Neon compatibility findings

| Topic | Status |
|---|---|
| SQLAlchemy + psycopg v3 URL rewrite | Compatible |
| JSON / TIMESTAMPTZ / BOOLEAN dialects | Compatible |
| Connection pooling | Prefer Neon **pooled** URL for Render web; **direct** for migrations/`pg_dump` restore |
| SSL | Require `sslmode=require` (or Neon defaults) |
| Supabase `auth`/`storage` schemas | **Exclude** from dump |
| Ensure-column ALTER at startup | Works on Neon if role allows; prefer schema complete before boot |
| Storage URLs in DB | Filenames/object keys only — Storage host remains Supabase |

---

## 10. Estimated downtime (cutover, when approved)

| Mode | Estimate |
|---|---|
| Small DB + maintenance window (write freeze → dump → restore → swap `DATABASE_URL` → smoke) | **15–45 minutes** typical |
| Large corpus / slow dump | **1–3 hours** — measure after discovery counts |
| Zero-downtime logical replication | Possible later; **not** in initial plan |

Staging verification: **no production downtime**.

---

## 11. Open blockers

| ID | Blocker | Severity |
|---|---|---|
| B1 | No approved read-only access to source Supabase Postgres for live counts/sizes | High for schedule accuracy |
| B2 | Neon project/branch for Consult America not provisioned in this exercise | High |
| B3 | Production `DATABASE_URL` value unknown here (secret) — must be confirmed in Render dashboard at cutover | High |
| B4 | In-flight `extraction_jobs` during cutover | Medium — drain/freeze |
| B5 | Ensure-column role privileges on Neon | Medium — grant or pre-migrate |
| B6 | Accidental overwrite of existing Neon data | High — use empty branch; never restore onto populated DB without approval |

---

## 12. GO / NO-GO

| Decision | Scope |
|---|---|
| **CONDITIONAL GO** | Create Neon staging branch; take **approved** read-only source dump; run validation checklist; keep Supabase Storage |
| **NO-GO** | Production `DATABASE_URL` swap, deletion of Supabase Postgres/Storage data, or any live cutover |

**Stop.** Awaiting approval to proceed to staging execution (Phase C) under a separate authorization.
