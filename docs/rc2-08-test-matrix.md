# RC2-08 Test Matrix

**Environment:** Windows 10 · Node (Next 16.3.0 / React 19.2.8 / Vitest 4.1.11) · Python FastAPI 0.141.1 / SQLAlchemy 2.0.51 · local API `:8001` · local FE `:3000`  
**Baseline HEAD:** `16b1039` · Working tree: dirty (RC2 local changes uncommitted)

## Frontend

| Suite | Command | Result | Duration / notes |
|---|---|---|---|
| TypeScript | `npx tsc --noEmit -p tsconfig.json` | **PASS** exit 0 | — |
| Full Vitest (run A) | `npx vitest run --pool=forks --maxWorkers=2` | **257/260** — 3 timeouts (FAR/selection) | ~189–260s; timeouts **not** raised |
| Full Vitest (run B, stability) | same | **260/260** | ~197s |
| Isolated re-run of flaky + documents-home | maxWorkers=1 | **44/44** | Confirms R4 intermittency |
| Focused RC2 (governance/audit/oracle/ops-health) | prior RC2-07 | **16/16** | — |
| Documents home sort | `documents-home.test.tsx` | `uploaded_at` only | RC2-08 sort disable |
| Production build | `npm run build` | **PASS** exit 0 | Next 16.3.0 Turbopack |
| Browser certify | `node scripts/rc2-08-browser-certify.mjs` | **11/11** steps | Screenshots under `docs/rc2-08-browser-evidence/` |

## Backend

| Suite | Result | Notes |
|---|---|---|
| `test_human_review_preservation` | included in cert set | Human correction survives re-analyze |
| `test_metadata_review_by_id` | included | Duplicate-key by-id path |
| `test_metadata_field_duplicate_key` | included | Fail-closed 409 on ambiguous key |
| `test_document_isolation` | included | Cross-workspace denial |
| `test_rbac_oracle_certification` | included | Oracle preview/send RBAC |
| `test_export_consistency` / `test_selected_export` | included | Export integrity |
| `test_repository_search_audit` | included | Audit filters + search |
| `test_security_certification` / `test_rc_security` | included | AuthZ negative paths |
| Cert set aggregate | **103 passed** (~11m) | venv `backend/.venv` |

## Journey coverage (evidence type)

| Journey | Automated | Browser / API smoke | Gaps |
|---|---|---|---|
| A Lifecycle | Partial (upload/extract/review/export tests) | Staging/workspace scripts | Full upload→export single script not newly authored |
| B Repository | documents-home + search tests | `/documents` smoke | `updated_at` sort disabled in UI |
| C Staging | data-grid / selection / export tests | Playwright staging grid | Flaky selection timeout under load |
| D Metadata review | preservation + by-id + duplicate-key | Review page smoke | Concurrent LWW unmitigated (R2) |
| E Oracle | panel tests + RBAC/oracle cert | Integrations page; **no live send** | Live gate closed (R1/R5) |
| F Governance | governance-ops + audit-log tests | `/governance`, `/audit-log` | Export/Oracle global metrics N/A |

## Fixtures available (`reference/regression`)

| Asset | Present |
|---|---|
| FAR Part 51 PDF | Yes |
| FAR Part 52 HTML | Yes |
| FAR Final Rule 2026-04912 PDF | Yes |
| Government contracts (FA3002, SF1442, 47QRCA, etc.) | Yes |
| FAR Clause XML (via staged `xml_document` profiles in DB) | Runtime DB / prior uploads |
| FAR Parts 1–53 complete set | **No** — do not claim |
| Six invoice fixtures (named set) | Not verified as complete named set on disk |
| Academic documents | Not confirmed in `reference/regression` |

## Performance smoke (local API, 2026-10-09)

| Call | Observed |
|---|---|
| `GET /api/documents/search?limit=25` | ~7412 ms · total 1403 |
| `GET /api/dashboard/portfolio` | ~2771 ms · 1403 docs |
| `GET /api/documents/audit-log?limit=20` | ~997 ms · total 325 |

Conditions: cold-ish local SQLite/Postgres-backed workspace; not a load test; no invented SLOs.
