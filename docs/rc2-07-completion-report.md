# RC2-07 Completion Report — Enterprise Governance & Operations

**Status:** Implemented locally — awaiting review before RC2-08  
**Date:** 2026-10-08  
**Baseline:** RC2-06 accepted · contract audit `docs/rc2-07-contract-audit.md`  
**Commit/push/deploy:** Not performed

---

## A. Existing contracts reused

| Contract | Reuse |
|---|---|
| Portfolio metrics | `GET /api/dashboard/portfolio` |
| Dashboard stats | `GET /api/dashboard/stats` |
| Status counts | `GET /api/documents/status-counts` |
| Document search (failed) | `GET /api/documents/search?status=failed` |
| Metadata audit log | `GET /api/documents/audit-log` (+ new optional filters) |
| Process job | `POST /api/documents/{id}/jobs/process` |
| Actor / RBAC hints | `GET /api/actors/me` permissions |
| Health / ready | `GET /health`, `GET /ready` |
| Oracle preview/send/history | Unchanged document-scoped APIs (RC2-06 panel) |
| Workspace isolation | `scope_documents` on audit + portfolio (unchanged) |

No parallel operational stores. No Oracle send semantic changes. No migrations.

---

## B. Files created / modified

### Created
| File | Role |
|---|---|
| `docs/rc2-07-contract-audit.md` | Mandatory pre-edit audit |
| `docs/rc2-07-oracle-idempotency-proposal.md` | R1 design only (not implemented) |
| `docs/rc2-07-completion-report.md` | This report |
| `frontend/lib/ops-health.ts` | Live `/health` + `/ready` probe |
| `frontend/components/governance/governance-ops-dashboard.tsx` | Ops dashboard |
| `frontend/lib/__tests__/ops-health.test.ts` | Health state tests |
| `frontend/components/__tests__/governance-ops-dashboard.test.tsx` | Metrics / retry / roles |
| `frontend/src/app/audit-log/__tests__/audit-log-page.test.tsx` | Filter + render tests |

### Modified
| File | Change |
|---|---|
| `backend/app/api/documents.py` | Optional audit-log query filters (same table) |
| `backend/tests/test_repository_search_audit.py` | Filter regression |
| `frontend/types/document.ts` | `GlobalAuditLogFilters` |
| `frontend/lib/documents.ts` | Pass filters to audit-log |
| `frontend/src/app/governance/page.tsx` | Renders ops dashboard |
| `frontend/src/app/audit-log/page.tsx` | Audit explorer UI |
| `frontend/src/app/activity/page.tsx` | Points to explorer for filters |
| `frontend/vitest.setup.ts` | `matchMedia` stub for jsdom |

---

## C. Governance dashboard

| Metric | Source | Displayed |
|---|---|---|
| Total documents | portfolio `totals.documents` | Yes |
| Needs review | portfolio `review.pending` | Yes |
| Processing failures | portfolio `totals.failed` | Yes |
| Active processing | portfolio `totals.processing` | Yes |
| Review decisions | portfolio accepted+edited+rejected | Yes |
| Recent review activity | audit-log limit 8 | Yes |
| Recent exports | **No global API** | Explicitly not fabricated |
| Oracle outcomes (global) | **Document-scoped only** | Explicitly not fabricated |
| Operational warnings | `/health` + `/ready` | Yes |

Every card shows a `Source:` line. No client-side aggregation over full record sets for counts.

---

## D. Audit explorer

Server filters: `document_id`, `actor_id`, `changed_by`, `action`, `outcome` (`new_status`), `request_id`, `from`, `to`.

Columns: actor, action, outcome, document, field, values, correlation, timestamp.

Event category for this API is metadata review only — Oracle/export/classification remain on their own APIs. Missing history is not invented. Append-only policy unchanged.

---

## E. Processing operations

Mapped labels: Queued / not processed, Processing, Completed, Failed (retryable via job), Review required, Unknown/unavailable.

Failed document table: link, status label + raw status, timestamp, **Retry reprocess** (guarded against duplicate in-flight POSTs). No automatic retries.

---

## F. Oracle operational safety

Dashboard copy + RC2-06 panel distinguish preview vs send vs simulated vs unknown vs unconfigured (501).

Idempotency: **not implemented** — proposal in `docs/rc2-07-oracle-idempotency-proposal.md`. No auto-retry of sends.

---

## G. Role-aware controls

Action chips from `/api/actors/me` permissions (`review.*`, `export.read`, `extraction.run`, `oracle.*`, `admin.providers`). Retry hidden without `extraction.run`. UI hints only — API still enforces.

---

## H. Security and tenant isolation

- Audit log still scoped via `scope_documents`.
- Isolation covered by existing `test_document_isolation.py`.
- No secrets in health UI; readiness exposes only dry-run / RBAC flags already on `/ready`.
- Safe error strings; no cross-tenant metrics (portfolio/search scoped).

---

## I. Accessibility

Page headers, compact tables, filter form labels, `aria-live` for load/reprocess status, role alerts, keyboard-focusable links/buttons, responsive grids. Marketing homepage + RC2 shell preserved.

---

## J. Test results

### Frontend focused (RC2-07)
`ops-health`, `governance-ops-dashboard`, `oracle-integration-panel`, `audit-log-page` — **16 passed**.

### Frontend full suite
`npx vitest run --pool=forks --maxWorkers=2` — **48 files, 260 tests passed** (~323s). Timeouts were not increased.

### TypeScript
`npx tsc --noEmit -p tsconfig.json` — **exit 0**.

### Backend
- Audit + isolation focused — **11 passed**.
- `test_repository_search_audit` + `test_document_isolation` + `test_rbac_oracle_certification` + `test_export_consistency` + `test_selected_export` — **70 passed** (~13m).

Honest notes: R4 remains open historically (resource timeouts / flaky dataset-tab on some machines); this run’s full FE suite was green without timeout bumps.

---

## K. Browser verification

Local smoke against running Next (`:3000`) and API (`:8001`):

- `/governance` — HTTP 200; markers for Operations, Portfolio metrics, Processing operations, Oracle operational safety, Role-aware, Audit explorer. “Service health” is client-hydrated after `/health`+`/ready` probes (not in static HTML).
- `/audit-log` — HTTP 200; Audit explorer, Apply filters, Correlation present.
- `/health` → `{"status":"ok",...}`; `/ready` → `status:ready`, `oracle_dry_run:true`.
- Portfolio live: `documents=1403`, `failed=0`, `pending=1969` (authoritative API, not inferred from page paint).

---

## L. Updated risk register & RC2-08 readiness

| ID | Severity | Impact | Current mitigation | Permanent fix | Release-blocking? | Evidence for closure |
|---|---|---|---|---|---|---|
| **R1** Oracle send lacks idempotency | High | Duplicate Fusion posts if live send enabled | Dry-run / 501; UI no auto-retry; unknown ≠ failed | Approve + implement request-key design | **Yes for live Oracle** | Idempotent send tests + Fusion sandbox cert |
| **R2** Metadata review last-write-wins | Medium | Concurrent reviewers overwrite | Audit trail of changes | Optimistic concurrency / version field | No for RC2 preview | Conflict 409 tests |
| **R3** `metadata_field_id` ensure-column | Medium | Runtime schema drift | Ensure-column helper | Proper Alembic migration | Prefer before prod scale | Migration applied in all envs |
| **R4** FE suite resource timeouts / flaky dataset-tab | Medium | CI noise | Focused runs; matchMedia stub | Stabilize suite / isolate flaky test | No for local RC2 | Green full suite without timeout bumps |
| **R5** Live Oracle not certified | High | Incorrect ERP writes | Live path 501 | Certified Fusion client + R1 | **Yes for live Oracle** | Certification report |
| **R6** Repository `updated_at` capped scan | Low–Med | Stale sort on large corpora | Documented cap | Indexed sort / server-side cursor | No for RC2 preview | Search correctness at scale |

**None of R1–R6 marked resolved.**

### RC2-08 readiness
Operational workspace is review-ready for local RC2-07 acceptance. RC2-08 should not assume live Oracle, global export audit metrics, or new idempotency without separate approval.

**Stop:** Awaiting review before RC2-08. No commit, push, or deploy performed.
