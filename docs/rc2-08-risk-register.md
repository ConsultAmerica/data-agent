# RC2-08 Risk Register

**Date:** 2026-10-09  
**Baseline SHA:** `16b10393d162c6140b2d6fc320540a356a1a1a87` (branch `main`, dirty working tree with RC2-01…07 local work)  
**Authority:** Certification evidence only — risks not silently closed

| ID | Title | Severity | Impact | Current mitigation | Permanent fix | Release-blocking? | Evidence for closure |
|---|---|---|---|---|---|---|---|
| **R1** | Oracle send lacks idempotency | High | Duplicate Fusion posts if live send enabled | Dry-run / HTTP 501; UI no auto-retry; unknown ≠ failed; proposal only (`docs/rc2-07-oracle-idempotency-proposal.md`) | Approved request-key + reconciliation | **Yes — live Oracle** | Idempotent send tests + sandbox cert |
| **R2** | Metadata review last-write-wins | High (multi-reviewer) | Concurrent Accept/Edit/Reject on same field silently overwrites authoritative human value; audit appends both, effective value is last writer | Append-only audit; no ETag/version; no UI concurrent warning found | Optimistic concurrency (`If-Match` / `expected_status` + 409) | **Yes — concurrent multi-reviewer metadata workflow** | Conflict 409 tests + UX warning |
| **R3** | Audit `metadata_field_id` via runtime ensure-column | Medium | Schema drift / permission failures on restricted DB roles; concurrent startup ALTER race possible | Idempotent `_ensure_columns` (skip if present); additive nullable INTEGER; old rows remain readable with NULL id | Controlled Alembic migration in deploy runbook | Prefer before prod scale; not blocking dry-run preview if column already present | Migration applied + startup without ALTER privilege needed |
| **R4** | Frontend suite resource timeouts / flaky staging tests | Medium | CI / cert noise | Run A: 3 timeouts; isolated + run B green; `matchMedia` stub; timeouts not raised | Isolate/stabilize FAR + selection tests under parallel load | No for CONDITIONAL GO preview; **yes for claiming always-green CI** | ≥2 consecutive green full suites on CI agents |
| **R5** | Live Oracle delivery not certified | High | Incorrect ERP writes | Live path returns 501 when `oracle_dry_run=false`; dry-run audited only | Certified Fusion client + R1 | **Yes — live Oracle** | Isolated E2E delivery + RBAC/audit evidence |
| **R6** | Repository `updated_at` capped scan sort | Medium | Approximate order presented as global | **RC2-08 fix:** UI disabled Updated sort; column display-only; deep links coerced to `uploaded_at`. Backend still accepts `sort_by=updated_at` within `search_scan_cap` (default 500) | Indexed persisted `updated_at` or remove API sort | Mitigated for UI; API still approximate if called directly | API rejects or documents non-global sort; or SQL-backed global sort |

## Additional certification findings

| ID | Title | Severity | Notes |
|---|---|---|---|
| **R7** | Local/dev RBAC often relaxed | Medium | `/ready` may show `rbac_enforced:false` in development; production forces RBAC via `app_env=production` | Confirm prod env before GO |
| **R8** | No global export / Oracle audit federation | Low | Governance correctly refuses to invent counts | Optional future API; not blocking |
| **R9** | FAR Parts 1–53 complete corpus not present as fixtures | Medium | `reference/regression` has Part 51, Part 52 HTML, Final Rule PDF, contracts; not full Parts 1–53 | Do not claim full FAR coverage |

**None of R1–R5 marked resolved. R6 UI presentation mitigated; backend path remains approximate.**
