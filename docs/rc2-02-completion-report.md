# RC2-02 Completion Report — Enterprise Documents Repository

**Status:** Implemented locally — awaiting review before RC2-04  
**Date:** 2026-10-08  
**Baseline:** RC2-01 shell (conditionally accepted) · `docs/rc2-enterprise-workspace-assessment.md`  
**Commit/push/deploy:** Not performed

---

## A. Existing functionality reused

| Capability | Source |
|---|---|
| Application shell, sidebar, breadcrumbs, `PageHeader`, semantic tokens | RC2-01 |
| Document search / status-counts / delete / process-job APIs | `backend/app/api/documents.py`, `frontend/lib/documents.ts` |
| Persisted Type / Profile labels | Staging workbook resolution on `DocumentSummary` (`profile_id`, `profile_label`, `type_label`, `staging_status`) via `presentDocument` |
| Export | Existing staging profile export capabilities + `downloadExport` |
| Reprocess | Existing `startProcessingJob` / process endpoint (no parallel store) |
| Delete contract | Existing bulk delete (authz, ownership, storage cleanup, shared reference data preserved) |
| Workspace isolation / RBAC | Existing `scope_documents` + actor dependencies on search/delete/process/export |

No new document repository or parallel store was introduced.

---

## B. Files created / modified

### Created
| File | Role |
|---|---|
| `docs/rc2-02-completion-report.md` | This report |

### Modified
| File | Change |
|---|---|
| `frontend/components/documents/documents-home.tsx` | Full-width repository workspace: summary metrics, toolbar, sticky table, row/bulk actions, URL-persisted filters, delete confirm, reprocess states |
| `frontend/components/documents/__tests__/documents-home.test.tsx` | Vitest coverage for RC2-02 behaviors |
| `frontend/lib/documents.ts` | Client search params: `profileId`, `sortBy`, `sortDir` |
| `frontend/lib/workspace-nav.ts` | Family crumb labels aligned with persisted classification vocabulary |
| `frontend/lib/__tests__/workspace-nav.test.ts` | Expect singular family crumb labels |
| `backend/app/api/documents.py` | Search: `profile_id`, `sort_by`, `sort_dir` (+ `_filter_by_profile`; `updated_at` via summary sort) |
| `backend/tests/test_repository_search_audit.py` | Contract test for profile + sort params |

Unrelated RC2-01 / audit docs may also be present locally (`docs/rc2-01-completion-report.md`, phase-1 audit, assessment).

---

## C. UI improvements

- Full-width workspace page (no `max-w-*` content clamp)
- Header: **Documents** / “Manage, review and export documents” / **Upload Document**
- Summary: Total Documents · Needs Review · Ready · Failed
- Toolbar: Search · Document Type · Profile · Status · Sort · Clear Filters
- Table columns: Selection · Name · Type · Profile · Processing · Review · Records · Uploaded · Updated · Actions
- Sticky table header; compact rows; document icon; responsive column visibility
- Row menu: Open · Review · Export · Reprocess · Delete (accessible `role="menu"`)
- Bulk bar: Select visible · Reprocess selected · Delete selected · Clear selection
- Loading skeletons, empty states, failure/retry via `ErrorState`, status notices for partial bulk results
- Filter state preserved in URL (`q`, `filter`, `family`, `profile`, `sort`, `dir`, `offset`) when returning from a document

---

## D. Backend / API changes

| Change | Detail |
|---|---|
| `GET /api/documents/search` | Optional `profile_id`; `sort_by` ∈ `{uploaded_at, updated_at}`; `sort_dir` ∈ `{asc, desc}` |
| Profile filter | SQL filter on `DocumentStagingWorkbook.profile_id` (scoped by actor) |
| `updated_at` sort | Uses capped materialize path (same as status/confidence filters) because last_updated is computed on summary |

No changes to delete, reprocess, export, staging, extraction, or Oracle contracts beyond search query parameters.

---

## E. Security checks

| Control | Enforcement |
|---|---|
| Workspace isolation | Search/counts/delete/process remain behind `scope_documents` / actor |
| Document ownership | Bulk delete returns per-id `deleted` / `forbidden` / `not_found`; UI reports partial failures |
| Role permissions | Not UI-gated alone — APIs enforce; Export disabled client-side only when not staged (server still authorizes export) |
| Safe deletion | Existing contract: source + dependent artifacts; shared regulatory reference data not removed; confirmation required |
| Authorized reprocess | Existing process job endpoint; skips already-processing; reports per-document failures |
| Authorized exports | Existing staging export path |

Hidden/disabled controls are UX only; authorization is server-side.

---

## F. Test results

| Suite | Result |
|---|---|
| Frontend Vitest (full) | **38 files, 219 tests passed**, 0 failed |
| RC2-02 DocumentsHome tests | **11 passed** (render, search, filters, sort, pagination, selection, bulk reprocess partial failure, delete confirm, export/review permissions, empty/loading, reprocess-disabled-when-processing) |
| Backend `test_search_profile_id_and_sort_params` + deletion + isolation | **16 passed** |
| Backend regression (`test_rbac_oracle_certification`, `test_export_consistency`, `test_selected_export`) | **49 passed**, 0 failed |

---

## G. Screenshots / browser verification

Automated screenshot capture was not available in this session. Local smoke:

| Check | Result |
|---|---|
| `GET http://localhost:3000/documents` | **200**; HTML contains Documents header, subtitle, Upload Document, `documents-home`, table headers |
| `GET http://localhost:8001/health` | **200** |
| `GET /api/documents/search?limit=3&sort_by=uploaded_at&sort_dir=desc` | **200**; `total=1403`; summaries include persisted `profile_id` / `type_label` / `staging_status` (e.g. `xml_document` / `FAR Clause XML`, not filename guesses) |

**Manual review checklist:** open `/documents`, apply Type/Profile/Status/Sort, open a document and use browser Back (filters should remain), exercise row menu Delete/Reprocess, select multiple and confirm partial-failure messaging if one fails.

---

## H. Known limitations

1. **No date-range filter control** — toolbar Sort covers Uploaded/Updated ordering; range filtering (`uploaded_from`/`to`) was not added.
2. **Select filtered (all pages)** — “Select visible” covers the current page; cross-page “select all matching filters” is not implemented (would need a server-side id list endpoint).
3. **`updated_at` sort** uses the capped scan path (same tradeoff as status filters) for large corpora.
4. **Classification labels** are whatever the staging resolution persisted (e.g. `FAR Clause XML` / `XML Document`); UI does not silently rename historical rows to marketing vocabulary.
5. **Review Status** is a table column derived from operational status; toolbar Status filter uses processing statuses (`review_required`, `completed`, …), not a separate review-enum filter.
6. Screenshot image files were not generated automatically.

---

## I. Deviations from scope

| Deviation | Reason |
|---|---|
| Date range filter omitted | Sort by uploaded/updated delivers primary date UX; range filter would be a new API contract |
| No “select all filtered results” | Not supported by current search API without a dedicated id enumeration endpoint |
| Column header “Processing” / “Review” | Compact labels for Processing Status / Review Status; same vocabulary in cells |
| Did not add Playwright E2E | Vitest + API contract tests cover repository behaviors; browser smoke via HTTP |

**Out of scope confirmed untouched:** extraction algorithms, silent historical reclassification, staging QA dual-contract, Oracle send, homepage marketing brand, new document store.

---

## J. Recommendation for RC2-04

Proceed to **RC2-04 (Document Workspace polish)** next: deepen the per-document workspace (open/review chrome, evidence/source grounding presentation, action consistency with repository vocabulary) while leaving repository list behavior stable.

Suggested RC2-04 focus:
1. Align document workspace header/actions with repository status vocabulary (Processing / Review / Ready / Failed).
2. Ensure Open → workspace and Review → review route preserve return URL / repository filters.
3. Surface reprocess job state and actionable errors inside the document workspace (not only the list notice).
4. Keep dual value contract and RBAC unchanged; no classification rewrites.

Do **not** start RC2-03/RC2-04 until this report is reviewed.

---

## Stop

RC2-02 is ready for review. **No commit, push, or deploy performed.**
