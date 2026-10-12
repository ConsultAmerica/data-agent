# Neon Migration Runbook — Supabase PostgreSQL → Neon

**Status:** Prepared — **not executed**  
**Companion:** `docs/neon-migration-assessment.md`  
**Restrictions:** No production changes, no live cutover, no secret exposure in this doc

---

## 0. Prerequisites (approval gates)

- [ ] Neon project under Consult America Vercel/Neon team created  
- [ ] Empty **staging** Neon branch (or dedicated staging DB) — **never** restore onto a populated Neon DB without approval  
- [ ] Read-only source credentials for Supabase Postgres (discovery/staging only)  
- [ ] Confirmed: Supabase **Storage** remains configured on Render after Postgres cutover  
- [ ] RC2 gates remain: `ORACLE_DRY_RUN=true`; metadata review mutations fail-closed in production  

---

## 1. Source backup procedure

### 1.1 Pre-backup checks (read-only)

```sql
-- Run against SOURCE (Supabase Postgres) with read-only role
SELECT version();
SELECT current_database(), pg_size_pretty(pg_database_size(current_database()));
SELECT schemaname, COUNT(*) AS tables
FROM pg_tables
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
GROUP BY 1
ORDER BY 1;
```

List application schemas only (`public` expected). Note any `auth`, `storage`, `extensions`, `realtime` — **exclude from app dump**.

### 1.2 Logical dump (application data)

Prefer custom format for selective restore:

```bash
# Placeholders only — never commit real URLs/passwords
export SRC_DATABASE_URL='postgresql://USER:PASS@HOST:5432/DB?sslmode=require'

pg_dump "$SRC_DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --verbose \
  --schema=public \
  --file="data-agent-public-$(date -u +%Y%m%dT%H%M%SZ).dump"
```

Also capture schema-only SQL for review:

```bash
pg_dump "$SRC_DATABASE_URL" \
  --schema=public \
  --schema-only \
  --no-owner \
  --no-acl \
  --file="data-agent-public-schema-only.sql"
```

### 1.3 Backup of Storage (unchanged)

Postgres migration does **not** move object storage. Optionally inventory bucket object count via Supabase dashboard (no deletion).

### 1.4 Store backups

Encrypt and store dump off-repo (secure bucket / secrets manager). Retain until post-cutover soak completes.

---

## 2. Neon target schema preparation

1. Create Neon project (Postgres version **≥ source major** when possible).  
2. Create branch `staging/data-agent-migrate` (empty).  
3. Note two connection strings (store in password manager only):  
   - **Direct** (migrations / `pg_restore`)  
   - **Pooled** (Render runtime)  
4. Confirm empty:

```sql
SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public';
-- expect 0 application tables (or only Neon defaults)
```

**Never** point restore at a Neon database that already holds other app data without explicit overwrite approval.

---

## 3. Compatible restore method

### Option A — Dump/restore into empty public schema (recommended for staging)

```bash
export NEON_DIRECT_URL='postgresql://USER:PASS@HOST/DB?sslmode=require'

pg_restore \
  --dbname="$NEON_DIRECT_URL" \
  --no-owner \
  --no-acl \
  --verbose \
  --exit-on-error \
  data-agent-public-YYYYMMDD.dump
```

### Option B — Empty Neon + Alembic + data-only load

1. Point a throwaway backend at Neon direct URL with `APP_ENV=production` **or** run `alembic upgrade head` with `DATABASE_URL`.  
2. `pg_restore --data-only` for `public` tables.  
3. Riskier for FK order — prefer Option A unless dump includes schema conflicts.

### Post-restore

```bash
# Optional: alembic check (should already match)
# alembic current
```

Boot app against staging Neon once; ensure-column should be no-op if dump included all columns.

---

## 4. Sequence and foreign-key validation

```sql
-- Sequences (example pattern for SERIAL/IDENTITY tables)
SELECT sequencename, last_value
FROM pg_sequences
WHERE schemaname = 'public'
ORDER BY 1;

-- Orphan spot-checks (extend per FK)
SELECT COUNT(*) AS orphan_pages
FROM document_pages p
LEFT JOIN documents d ON d.id = p.document_id
WHERE d.id IS NULL;

SELECT COUNT(*) AS orphan_fields
FROM document_metadata_fields f
LEFT JOIN documents d ON d.id = f.document_id
WHERE d.id IS NULL;

SELECT COUNT(*) AS orphan_audit
FROM metadata_field_audit_log a
LEFT JOIN documents d ON d.id = a.document_id
WHERE d.id IS NULL;
```

Reset sequences if needed after data-only loads (Option B):

```sql
-- Example only; generate per SERIAL table
SELECT setval(pg_get_serial_sequence('extraction_jobs','id'),
              COALESCE((SELECT MAX(id) FROM extraction_jobs), 1));
```

---

## 5. Table-by-table record count comparison

```sql
-- Run on SOURCE and TARGET; diff externally
SELECT relname AS table_name, n_live_tup AS approx_rows
FROM pg_stat_user_tables
ORDER BY relname;

-- Exact counts for critical tables
SELECT 'documents' AS t, COUNT(*) FROM documents
UNION ALL SELECT 'document_metadata_fields', COUNT(*) FROM document_metadata_fields
UNION ALL SELECT 'metadata_field_audit_log', COUNT(*) FROM metadata_field_audit_log
UNION ALL SELECT 'document_staging_workbooks', COUNT(*) FROM document_staging_workbooks
UNION ALL SELECT 'extraction_jobs', COUNT(*) FROM extraction_jobs
UNION ALL SELECT 'actors', COUNT(*) FROM actors
UNION ALL SELECT 'integration_audit_log', COUNT(*) FROM integration_audit_log;
```

Record results in `docs/neon-migration-validation.md` evidence table (counts only — no PII dumps).

---

## 6. Referential integrity checks

- All FK constraints valid: `\d+ documents` / `pg_constraint`  
- Spot-check workspace columns populated as on source  
- `alembic_version.version_num` equals source  

---

## 7. Controlled write-freeze and final sync (production cutover only)

When **separately approved**:

1. Announce maintenance.  
2. Set Render to maintenance / scale to 0 **or** block writes (API drain).  
3. Wait for `extraction_jobs` in `queued`/`processing` to finish or mark safely.  
4. Final `pg_dump` of source.  
5. Restore to **production** Neon branch (empty).  
6. Validate counts (§5–6).  
7. Update Render `DATABASE_URL` to Neon **pooled** URL (`sslmode=require`).  
8. Keep `SUPABASE_*` storage vars unchanged.  
9. Deploy/restart backend; smoke `/health` `/ready`.  
10. Keep Supabase Postgres **read-only retain** until soak period ends — **do not delete**.

---

## 8. Staging verification pointer

Execute checklist in `docs/neon-migration-validation.md` against staging Neon + staging/local API with:

- `METADATA_REVIEW_MUTATIONS_ENABLED=false` (or production fail-closed)  
- `ORACLE_DRY_RUN=true`  

---

## 9. Configuration change checklist (future cutover)

| System | Change |
|---|---|
| Render `DATABASE_URL` | Supabase Postgres → Neon pooled |
| Render `SUPABASE_*` | **Unchanged** (Storage) |
| Vercel | **No Postgres vars** — no change for DB |
| Secrets in git | **Never** |

---

## 10. Roles

| Role | Connection |
|---|---|
| Migrator | Neon direct, DDL/DML during restore |
| Runtime (Render) | Neon pooled, least privilege DML + SELECT; ALTER only if ensure-column required |

Stop after staging success; request cutover approval separately.
