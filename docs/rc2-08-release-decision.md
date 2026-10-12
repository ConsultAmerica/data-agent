# RC2-08 Release Decision

**Date:** 2026-10-09  
**Decision authority:** Local certification evidence (RC2-08)  
**Overall recommendation:** **CONDITIONAL GO**

---

## Surface-by-surface

| Surface | Decision | Bound / exclusion |
|---|---|---|
| **Core document intelligence** (upload, classify, extract, staging workbook, repository with `uploaded_at` sort) | **CONDITIONAL GO** | Exclude claiming global `updated_at` sort (UI disabled). Exclude full FAR Parts 1–53 coverage claim. |
| **Metadata review** (single-operator Accept/Edit/Reject, by-id for duplicates, human preservation on reprocess) | **CONDITIONAL GO** | **Exclude concurrent multi-reviewer editing** — last-write-wins can destroy authoritative corrections (**R2 release-blocked** for that workflow). |
| **Staging exports** (Export All / Selected / reviewed metadata JSON·CSV·XLSX) | **CONDITIONAL GO** | Server-resolved values only; no client-invented cells. |
| **Governance** (ops dashboard, audit explorer filters, health probes, role hints) | **CONDITIONAL GO** | No fabricated export/Oracle global counts. |
| **Live Oracle sending** | **NO-GO** | R1 idempotency + R5 uncertified Fusion client. Dry-run / 501 only. |

---

## Why not full GO
- Live Oracle gates unmet.
- Concurrent metadata review unmitigated.
- Full FE suite not stably green under parallel load (R4).
- Runtime ensure-column still preferred as controlled migration (R3).
- Local cert environment has `rbac_enforced:false` — production must force RBAC.

## Why not full NO-GO
- Backend certification set **103 passed**.
- TypeScript **exit 0**; production `next build` **exit 0**.
- Core RBAC/isolation/export/Oracle-auth tests green.
- Governance/audit/sort honesty fixes applied within approved contracts.
- Dry-run Oracle + preview path remain safe when live send stays disabled.

## Required mitigations before any production promote
1. Keep `ORACLE_DRY_RUN=true` (or accept 501) — **no live send**.
2. Operate metadata review as **single-writer** (or accept R2 residual until optimistic concurrency ships).
3. Deploy with `APP_ENV=production` (RBAC on).
4. Prefer pre-applied schema migration for audit columns (R3).
5. Do not advertise Updated-column global sort; UI already disabled.
6. Treat FE parallel-suite flakes as known — do not raise timeouts to fake green.

## Explicit non-authorization
No commit, push, production deployment, database migration execution, or live Oracle submission is authorized by this decision document alone.
