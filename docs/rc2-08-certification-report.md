# RC2-08 Certification Report — Enterprise Release Readiness

**Status:** Certification complete locally — awaiting human release decision  
**Date:** 2026-10-09  
**Mode:** Evidence-based readiness (not a feature package)  
**Commit / push / deploy / migration / live Oracle:** **Not performed / not authorized**

Companion artifacts:
- `docs/rc2-08-test-matrix.md`
- `docs/rc2-08-risk-register.md`
- `docs/rc2-08-deployment-runbook.md`
- `docs/rc2-08-release-decision.md`
- Browser evidence directory: `docs/rc2-08-browser-evidence/` (Playwright screenshots when generated)

---

## A. Scope and baseline

### Git / tree
| Item | Value |
|---|---|
| Branch | `main` tracking `origin/main` |
| HEAD | `16b10393d162c6140b2d6fc320540a356a1a1a87` |
| Working tree | **Dirty** — RC2-01…07 (and RC2-08 cert fixes) uncommitted |
| Unapproved product policy changes | None observed beyond authorized RC2 UX/API filter work and RC2-08 sort honesty fix |

### Versions
| Component | Version |
|---|---|
| Frontend package | `dataomatix@0.1.0` |
| Next.js | 16.3.0 |
| React | 19.2.8 |
| Vitest | 4.1.11 |
| FastAPI | 0.141.1 |
| SQLAlchemy | 2.0.51 |

### Environment (local cert)
- API `http://127.0.0.1:8001` · FE `http://127.0.0.1:3000`
- `/ready`: `environment=development`, `oracle_dry_run=true`, `rbac_enforced=false`, `entra_configured=false`
- DB: local workspace (~1403 documents in portfolio at cert time)
- Config requirements: see deployment runbook (env names only)

### RC2 completion chain inspected
`rc2-01` … `rc2-07` completion reports + contract audits + Oracle idempotency **proposal** (not implemented).

### Small cert fix applied (approved-contract scope)
Repository UI **disabled** `updated_at` sort (capped scan ≠ globally accurate under pagination). Column remains display-only; deep links coerced to `uploaded_at`. Backend API still accepts `sort_by=updated_at` within `search_scan_cap` (default 500) — documented as approximate if called directly.

---

## B. Functional test evidence

| Journey | Evidence | Verdict |
|---|---|---|
| **A Lifecycle** | Backend extract/review/export suites; workspace components | **Pass with fixture limits** |
| **B Repository** | documents-home tests; search API; UI sort honesty | **Pass** (`uploaded_at` only in UI) |
| **C Staging** | data-grid / selection / export tests; Playwright staging | **Pass with flake risk** (selection timeout under parallel load) |
| **D Metadata review** | `test_human_review_preservation`, by-id, duplicate-key 409 | **Pass single-writer**; concurrent **blocked** (R2) |
| **E Oracle** | Panel unit tests; RBAC/oracle cert; dry-run / 501 code path | **Pass dry-run path**; **live NO-GO** |
| **F Governance** | ops dashboard + audit explorer tests; live `/governance` `/audit-log` | **Pass** |

---

## C. Data-integrity results

| Check | Result |
|---|---|
| Classification / staging tabs | Exercised via existing staging/profile tests + DB corpus |
| Source-grounded / no invented export cells | Selected export + export consistency tests |
| Human correction preservation | `test_human_review_preservation` — accepted/edited survive re-analyze |
| Duplicate field keys | Fail-closed 409 + by-id independent review |
| Oracle payload policy | Unchanged: pending/rejected excluded; confirm required |
| FAR Parts 1–53 complete | **Unavailable** — Parts 51, 52 HTML, Final Rule PDF, contracts present under `reference/regression` |
| Six named invoice fixtures | **Not certified as complete set** on disk |

---

## D. Security results

| Control | Evidence | Result |
|---|---|---|
| Workspace isolation | `test_document_isolation` | Pass |
| RBAC / Oracle authZ | `test_rbac_oracle_certification`, `test_security_certification`, `test_rc_security` | Pass |
| Review / export / Oracle permissions | Negative 403 paths in security suites | Pass |
| Duplicate-key fail-closed | `test_metadata_field_duplicate_key` | Pass |
| Review-by-ID ownership | by-id tests + document_id match | Pass |
| UI-hidden ≠ security | Documented; backend remains mandatory | Pass (principle) |
| Local RBAC relaxed | `/ready` `rbac_enforced:false` in development | **Prod must set `APP_ENV=production`** |

Backend cert aggregate: **103 passed** (~11m) across preservation, by-id, duplicate-key, isolation, oracle RBAC, export, search/audit, security suites.

---

## E. Accessibility results

| Area | Method | Finding |
|---|---|---|
| Page headers / filter labels | Code + prior RC2 UX | Present on audit/governance/repository |
| `aria-live` status | Governance reprocess; export busy | Present |
| Keyboard tables / selection | Staging selection tests (when stable) | Partial — flake under load |
| Focus traps / drawers | Evidence drawer / review | Not fully automated AA audit |
| Contrast / zoom / reduced motion | `matchMedia` stub for reduced-motion in Vitest; no instrumental contrast scan | **Gap:** no automated WCAG 2.2 AA full audit |
| Mobile nav | Playwright mobile viewport step | Evidence in browser script |

**Severity:** Medium process gap — no claim of full WCAG 2.2 AA certification. Primary workflows use semantic controls; residual risk on complex grids.

---

## F. Performance results

Observed local API (not load-tested SLOs):

| Endpoint | Latency | Payload |
|---|---|---|
| Document search `limit=25` | ~7412 ms | total 1403 |
| Portfolio | ~2771 ms | 1403 docs |
| Audit log `limit=20` | ~997 ms | total 325 |

No invented benchmarks. Large FAR grid / selected-export timings not instrumented in this pass beyond existing unit coverage.

---

## G. Browser evidence

Playwright script: `frontend/scripts/rc2-08-browser-certify.mjs`  
**Result: 11/11 steps passed** (fixture: `FAR_Part_52_OKCXMLIMPDFN_PART2.xml` / `xml_document`).  
Screenshots in `docs/rc2-08-browser-evidence/`:
`01-marketing-home`, `02-documents-repository`, `03-extraction-workspace`, `04-staging-workbook`, `05-export-menu`, `06-oracle-preview`, `07-metadata-review`, `08-governance-dashboard`, `09-audit-explorer`, `10-mobile-navigation`.  
**Live Oracle send was not invoked.**

---

## H. Database / schema assessment (`metadata_field_id`)

| Question | Finding |
|---|---|
| Idempotent? | **Yes** — `_ensure_columns` skips existing column names |
| Concurrent startup safe? | **Mostly** — racing `ADD COLUMN` may fail one replica; prefer single migrate |
| Prod permissions? | Requires `ALTER TABLE` unless pre-migrated |
| Old audit rows readable? | **Yes** — nullable INTEGER; NULL for legacy |
| Rollback safe? | Leave column; do not drop without approval |
| Recommendation | Controlled Alembic/offline migration before multi-instance prod (R3) — **not executed** |

---

## I. Oracle release gate

| Gate | Status |
|---|---|
| Approved idempotency design implemented | **No** (proposal only) |
| Duplicate submission controlled | **No** for live |
| Unknown-outcome reconciliation process | UI guidance only |
| Oracle config validated for live | **No** |
| Isolated E2E live delivery | **No** |
| RBAC + audit for dry-run | **Yes** |
| Dry-run ≠ live certification | Affirmed |

**Live Oracle: NO-GO.**

---

## J. Open defects and risks

See `docs/rc2-08-risk-register.md`. Summary:
- **R1/R5** live Oracle blocked
- **R2** concurrent metadata review release-blocked
- **R3** ensure-column → prefer migration
- **R4** FE parallel suite flakes (3 timeouts in full run; **44/44** pass in isolated re-run)
- **R6** UI mitigated; API `updated_at` still capped
- **R7** prod RBAC must be forced
- **R9** incomplete FAR fixture set

---

## K. Deployment and rollback readiness

Prepared in `docs/rc2-08-deployment-runbook.md` (env inventory, backup, Vercel/Render plans, health smoke, rollback, monitoring).  
**No production action taken.**

---

## L. Final recommendation

### Overall: **CONDITIONAL GO**

| Surface | Decision |
|---|---|
| Core document intelligence | CONDITIONAL GO |
| Metadata review (single-writer) | CONDITIONAL GO |
| Staging exports | CONDITIONAL GO |
| Governance | CONDITIONAL GO |
| Live Oracle sending | **NO-GO** |
| Concurrent multi-reviewer metadata | **NO-GO / release-blocked** |

### Reliability evidence snapshot
| Check | Result |
|---|---|
| TypeScript | PASS exit 0 |
| `next build` | PASS exit 0 |
| Full Vitest run A (parallel) | 257 pass / **3 fail** (timeouts — R4) |
| Full Vitest run B (parallel) | **260/260** |
| Flaky suite isolated re-run | **44/44** |
| Backend cert set | **103 passed** |
| Browser certify | **11/11** |

### Stop
Await human acceptance of CONDITIONAL GO bounds. No commit, push, or deploy from this certification exercise.
