# RC2-06 Completion Report — Enterprise Exports & Oracle Integration UX

**Status:** Implemented locally — awaiting review before RC2-07  
**Date:** 2026-10-08  
**Baseline:** RC2-05 / RC2-05B accepted · contract audit `docs/rc2-06-contract-audit.md`  
**Commit/push/deploy:** Not performed

---

## A. Existing contracts reused

| Contract | Reuse |
|---|---|
| Staging Export All | Profile `export_capabilities` → `downloadExport` |
| Staging Export Selected | Selection manifest (IDs only) → `downloadSelectedExport` / field selection |
| Reviewed metadata export | `GET …/export`, `/export.csv`, `/export.xlsx` (+ optional `authoritative_only`) |
| Oracle preview | `GET …/oracle-payload` (`oracle.preview`; `send_allowed` forced false) |
| Oracle send | `POST …/oracle-send` `{confirm:true}` (`oracle.send`; dry-run audit or 501) |
| Integration history | `GET …/integration-audit` |
| RBAC / workspace isolation | Unchanged server enforcement |
| Rejected/pending Oracle exclusion | Unchanged `build_oracle_payload_preview` |
| Selection integrity | No client values in exports; server resolves cells |

No new export engine or Oracle architecture.

---

## B. Files created / modified

### Created
| File | Role |
|---|---|
| `docs/rc2-06-contract-audit.md` | Mandatory pre-edit audit |
| `frontend/components/oracle-integration-panel.tsx` | Real preview → confirm → send → history UI |
| `frontend/components/__tests__/oracle-integration-panel.test.tsx` | Preview/send/permission tests |
| `docs/rc2-06-completion-report.md` | This report |

### Modified
| File | Change |
|---|---|
| `frontend/lib/reviewed-export.ts` | `sendOraclePayload`, `listIntegrationAudit`, actor on preview type |
| `frontend/components/documents/document-workspace.tsx` | Export scope summary; staging vs metadata sections; busy/success/error; Oracle panel toggle |
| `frontend/src/app/integrations/page.tsx` | Replaced mock dry-run with real document-scoped panel |
| `frontend/components/staging/selection-toolbar.tsx` | Accessible export busy/error announcements |
| `frontend/components/documents/__tests__/document-workspace.test.tsx` | Export scope + Oracle toggle coverage |

---

## C. Export UX improvements

- Export menu shows **scope**: document filename, profile, active dataset, selection counts (or “No staging cells selected”)
- Clear sections: **Staging — Export All**, **Staging — Export Selected**, **Metadata export** (distinct contract copy)
- Metadata JSON/CSV/Excel + authoritative JSON (accepted/edited only)
- Download busy (“Exporting…” / “Preparing download…”), success status, error alert (`aria-live`)
- Empty selection: Export Selected disabled + validation message if invoked without selection
- “Open Oracle preview / send…” from Export menu; Oracle button toggles panel
- No new standalone Exports page; workspace + Integrations hub reuse existing routes

---

## D. Selected export consistency

Unchanged backend path: manifest carries record/field IDs only; server validates ownership and resolves `StagingCell.value`. Frontend still builds manifests via `selectionManifest()`. Sparse selection and identifier carriage preserved (covered by `test_selected_export.py`).

---

## E. Oracle preview / send workflow

Implemented in `OracleIntegrationPanel`:

1. Generate payload preview (authorized API)  
2. Show destination (`erp_target`), operation/mode, dry-run flag  
3. Show authoritative vs skipped counts; list excluded fields with status/reason  
4. Explicit confirmation checkbox  
5. Confirm and send → existing `oracle-send`  
6. Display status, audit ID, response code/message (no invented transaction IDs)  
7. Integration history from `integration-audit` (operation, actor, timestamp, correlation id, outcome)

Preview never enables send by itself (`send_allowed` remains false from API; UI gates on `can_send`, clean set, checkbox).

---

## F. Validation and rejection handling

| State | UX |
|---|---|
| Pending/rejected in review set | Listed under “Blocked from Oracle payload”; send disabled |
| 403 | Permission message |
| 404 | Document/fields not found |
| 409 | Backend detail (empty authoritative / unclean set) |
| 501 | Live Oracle not configured (truthful) |
| Timeout / network | **Outcome unknown** — instruct reconcile history before retry |

---

## G. RBAC and audit

- Preview/send/history still server-enforced (`oracle.preview` / `oracle.send`)
- Workspace isolation unchanged on document routes
- Successful dry-run and rejected live attempts continue to write `IntegrationAuditLog`
- UI displays audit id + request correlation; does not show credentials or full sensitive payloads

---

## H. Retry / idempotency findings

| Finding | Detail |
|---|---|
| Idempotency key | **None** on `oracle-send` |
| Dry-run re-send | Creates a **new** audit row each time |
| Live path | Returns **501** + rejected audit — no external delivery |
| Client policy | Unknown/timeout → do not blind-retry; reconcile history first |

Documented; not changed (would be a policy/API enhancement).

---

## I. Frontend / backend test results

| Suite | Result |
|---|---|
| `oracle-integration-panel.test.tsx` | **3 passed** |
| `document-workspace.test.tsx` (+ export/Oracle) | **passed** (suite green with related files) |
| `table-selection.test.tsx` | **passed** |
| Focused FE batch (oracle + workspace + table-selection) | **38 passed** |
| `tsc --noEmit` | **Passed** |
| Backend `test_export_api_integrity` + `test_rbac_oracle_certification` + `test_selected_export` | **43 passed** |

No production Oracle submissions; dry-run / mocks / isolated APIs only.

---

## J. Browser verification

Not run in this package (Vitest + pytest + tsc only). Recommend manual:

1. Document workspace → Export → confirm scope / Export Selected disabled then enabled  
2. Metadata JSON download  
3. Oracle panel → preview with skipped fields → send disabled  
4. Clean review set + confirm → dry-run audited + history row  
5. Integrations page with `?documentId=`  

---

## K. Known limitations

1. Live Fusion HTTP still unwired (501 when `oracle_dry_run=false`) — intentional  
2. No send idempotency — repeat dry-run allowed; unknown timeout requires human reconciliation  
3. Workspace role still cannot Oracle preview/send (RBAC matrix unchanged)  
4. Staging Verified ≠ Metadata Accepted — export menus label contracts separately  
5. Assessment previously listed Oracle page under RC2-07; RC2-06 authorization included it — implemented with real APIs, no mock success  

---

## L. Recommendation for RC2-07

**Accept RC2-06** for continued local work. Suggested RC2-07 focus:

- Jobs / bulk operations UX  
- Optional send idempotency + Fusion client design (separate approval)  
- Broader Vitest/Playwright certification (RC2-08)

**Stop before RC2-07.** No commit, push, or deploy performed.
