# RC2-08 Deployment Runbook

**Status:** Prepared — **not executed**  
**No production deployment, migration, or live Oracle send is authorized by RC2-08.**

## 1. Environment variable inventory (names only — no secret values)

### Backend (Render)
| Variable | Purpose |
|---|---|
| `APP_ENV` | Must be `production` to force RBAC |
| `DATABASE_URL` | Postgres connection |
| `FRONTEND_URL` | CORS allowlist (comma-separated OK) |
| `ORACLE_DRY_RUN` | Keep `true` until live Oracle certified |
| `METADATA_REVIEW_MUTATIONS_ENABLED` | Leave **unset** or `false` for RC2 core-platform (fail-closed in production). Set `true` only with explicit waiver. |
| `ORACLE_BASE_URL` / `ORACLE_API_VERSION` | Fusion endpoint metadata |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` | AI providers |
| `AI_PROVIDER` / `AI_PROVIDER_MODE` | Provider selection; use `production` mode in prod |
| `AI_FALLBACK_ENABLED` | Escalation toggle |
| `RBAC_ENFORCED` | Explicit; production forces true via `APP_ENV` |
| `PUBLIC_WORKSPACE_ACCESS` | Unauthenticated workspace role |
| `ENTRA_TENANT_ID` / `ENTRA_API_AUDIENCE` / `ENTRA_CLIENT_ID` | JWT validation |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_STORAGE_BUCKET` | Durable uploads |
| `SEARCH_SCAN_CAP` | Search materialize cap (default 500) |
| Service API keys (actor keys) | Admin/service credentials — rotate offline |

### Frontend (Vercel)
| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_API_URL` | Public API base (Render URL) |

## 2. Database backup plan
1. Take a managed Postgres snapshot / logical dump (`pg_dump`) before any deploy that may run ensure-column ALTERs.
2. Record schema version / git SHA deployed.
3. Retain dump until post-deploy verification passes (minimum 24h recommended).

## 3. Schema migration assessment
- Runtime `_ensure_columns` adds missing columns (including `metadata_field_audit_log.metadata_field_id`) at startup — **idempotent** (skips existing), **additive nullable**.
- Concurrent multi-instance startup: racing identical `ADD COLUMN` may error on one replica (usually harmless if column appears); prefer single migrate job.
- Production DB role must allow `ALTER TABLE … ADD COLUMN` **or** apply a controlled Alembic migration offline before deploy (recommended for R3).
- **Do not** run destructive DDL. Old audit rows remain readable (`metadata_field_id` NULL).
- Rollback of additive column: leave column in place (safe); do not drop without separate approval.

## 4. Vercel frontend plan
1. Build locally: `cd frontend && npm ci && npm run build` (cert evidence).
2. Deploy preview first; point `NEXT_PUBLIC_API_URL` at staging API if available.
3. Promote to production only after CONDITIONAL GO exclusions accepted.
4. Smoke: `/`, `/documents`, `/governance`, `/audit-log`.

## 5. Render backend plan
1. Deploy Docker image / service from approved SHA.
2. Confirm `APP_ENV=production`, `ORACLE_DRY_RUN=true`.
3. Watch startup logs for ensure-column success/failure.
4. Smoke: `/health`, `/ready` (expect `rbac_enforced:true`, `oracle_dry_run:true`).

## 6. Health / readiness smoke
```
GET /health  → status ok
GET /ready   → status ready; database ok; storage ok; auth mode documented
```
Do **not** infer health from frontend HTML alone.

## 7. Rollback procedure
1. Redeploy previous known-good Render revision + Vercel deployment.
2. Restore DB only if schema/data corruption confirmed (from pre-deploy dump).
3. Re-run `/health` + `/ready` + one authenticated document search.
4. Communicate Oracle remains dry-run / disabled.

## 8. Post-deployment verification checklist
- [ ] `/health` and `/ready` green; RBAC enforced in prod
- [ ] Upload small fixture → process → open workspace
- [ ] Metadata review Accept → audit row visible
- [ ] Staging Export Selected (if staged doc available)
- [ ] Oracle preview only; confirm send still dry-run or 501
- [ ] Workspace isolation: second workspace cannot see first’s docs
- [ ] Governance portfolio totals match API
- [ ] No secrets in client bundles / error messages

## 9. Production monitoring plan
- Render metrics: CPU, memory, restart count, response latency
- Application: 5xx rate, job failure rate, Oracle integration audit failures
- Alerts on `/ready` not_ready, DB pool exhaustion, storage errors
- Audit sampling: review + oracle dry-run rows after release

## 10. Explicit non-actions
- No production deploy from RC2-08
- No live Oracle submission
- No unapproved concurrency/idempotency implementation
