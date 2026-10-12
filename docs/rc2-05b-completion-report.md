# RC2-05B Completion Report — Unambiguous Metadata Review by ID

**Status:** Implemented locally — awaiting approval before RC2-06  
**Date:** 2026-10-08  
**Baseline:** RC2-05 Option A (conditionally accepted)  
**Commit/push/deploy:** Not performed

---

## A. API contract changes

| Endpoint | Role |
|---|---|
| `POST /api/documents/{document_id}/metadata-fields/by-id/{metadata_field_id}/review` | **New** — Accept/Edit/Reject against exact `DocumentMetadataField.id` |
| `GET /api/documents/{document_id}/metadata-fields/by-id/{metadata_field_id}/audit-log` | **New** — audit rows for that exact id |
| `POST …/metadata-fields/{field_key}/review` | **Preserved** — unique key only; **409** when duplicates (points callers to by-id) |
| `POST …/metadata-fields/accept-all` | Unchanged semantics; audit now stores `metadata_field_id` |

**Response enrichment (`MetadataFieldResult`):**
- `id` — persisted primary key  
- `extraction_source` — `contract` \| `target` \| `v3` (distinguishes duplicate keys)

**Audit (`FieldAuditEntry` / `MetadataFieldAuditLog`):**
- `metadata_field_id` recorded on successful mutations  

Lookup never resolves by `field_key` then guesses `extraction_source`. ID path requires `row.document_id == path document_id` or returns the same 404 as a missing field.

**Schema note:** `metadata_field_id` on the audit log uses the existing startup `ensure_metadata_field_audit_log_columns` additive-column path (same mechanism as `actor_id` / `request_id`). No Alembic migration; no table rewrite. Required to meet “record exact field ID” without inventing a side channel.

---

## B. Files modified

### Created
- `backend/tests/test_metadata_review_by_id.py`
- `docs/rc2-05b-completion-report.md`

### Modified
- `backend/app/api/contract_analysis.py` — shared `_apply_metadata_field_review`; by-id review + audit-log  
- `backend/app/services/contract_metadata_extractor.py` — `get_metadata_field_by_id`; `field_to_result` includes id/source  
- `backend/app/schemas/contract_analysis.py` — id, extraction_source, audit metadata_field_id  
- `backend/app/models/metadata_field_audit_log.py` — `metadata_field_id` column  
- `backend/app/database/migrate.py` — ensure column definition  
- `frontend/lib/documents.ts` — `reviewMetadataFieldById`, `getFieldAuditLogById`  
- `frontend/types/document.ts` — MetadataField.id / extraction_source  
- `frontend/components/review-field-list.tsx` — id-keyed rows; source labels; id-targeted actions  
- `frontend/src/app/documents/[documentId]/review/page.tsx` — prefer by-id mutations  
- `frontend/components/__tests__/review-field-list.test.tsx` — duplicate-row + id targeting  

---

## C. Authorization verification

| Check | Mechanism |
|---|---|
| Authenticate | `get_current_actor` |
| Workspace / document | Router `enforce_document_access` on contract_analysis |
| Field belongs to document | `get_metadata_field_by_id` requires `document_id` match |
| Review permission | `review.accept` / `review.edit` / `review.reject` |
| Cross-document id | **404** “Metadata field not found.” (no leakage) |
| Cross-workspace | **403/404** under enforced RBAC + workspace token (tested) |
| 409 candidates | Only for authorized document’s own duplicate rows |

---

## D. Duplicate-key test evidence

`tests/test_metadata_review_by_id.py` + `tests/test_metadata_field_duplicate_key.py`:

- Two rows same `field_key` → accept id A and edit id B independently  
- Field-key path still **409**  
- Id from doc A used under doc B path → **404**, no mutation  
- Invalid id → **404**  
- Cross-workspace review denied  
- Reject by id survives accept-all on the other duplicate  

---

## E. Review UI behavior

- Rows keyed by `meta-{id}` (not `field_key`)  
- Duplicate keys render as separate rows with **Source:** Contract analysis / Target extraction / All fields (V3) and `#id`  
- Accept / Edit / Reject call `reviewMetadataFieldById` when `id` is present  
- Audit history loads by id when available  
- Staging still only offers document-level **Open metadata review** (no field map)  
- Status vocabulary unchanged (Metadata * vs Staging *)  

---

## F. Audit evidence

Successful by-id (and unique field-key) mutations write `MetadataFieldAuditLog` with:

- `metadata_field_id` = exact row id  
- document_id, field_key, action, previous/new value & status, actor, request_id, changed_by  

Failed lookups (404/403/409) do not commit review audit rows. Tests assert accept/edit audit ids match the mutated rows.

---

## G. Reprocessing / export regression

- Human-locked reprocess tests still pass (`test_human_review_preservation.py`)  
- Export / Oracle integrity unchanged (`test_export_api_integrity.py`) — pending/rejected still excluded from Oracle authoritative payload  
- No export or Oracle code changes in RC2-05B  

---

## H. Frontend / backend test counts

| Suite | Result |
|---|---|
| `test_metadata_review_by_id.py` | **6 passed** |
| `test_metadata_field_duplicate_key.py` | **2 passed** |
| `test_human_review_preservation.py` + `test_export_api_integrity.py` | **included; green** |
| Focused backend batch (by-id + dup + preserve + export) | **16 passed** |
| Contract accept/edit/audit + RBAC filter | **7 passed** |
| Frontend `review-field-list` RC2-05B | **5 passed** |
| Related FE (status-badge, table-selection, document-workspace) | **green with review-field-list suite** |
| `tsc --noEmit` | **Passed** |

---

## I. Remaining risks

1. **Last-write-wins concurrency** — ID addressing does **not** prevent two reviewers overwriting the same row; optimistic concurrency still not implemented (by design for RC2-05B).  
2. **V3 duplicate data volume** — some documents still have many rows sharing a key; UI lists them separately (no auto-dedup). Cleanup is a separate data-quality task.  
3. **Field-key clients** — legacy callers without ids still hit 409 on ambiguous keys; must migrate to by-id.  
4. **Browser verification** — not run in this package.  

---

## J. Recommendation for RC2-05 closure

**Recommend accepting RC2-05 + RC2-05B as a closed Option A package** for continued local work:

- Unique and duplicate keys can both be reviewed safely (by-id for exact rows; field-key fail-closed when ambiguous)  
- Staging bridge remains document-level only  
- Export/Oracle/RBAC/reprocess contracts preserved  
- Concurrency limitation documented, not papered over  

**Do not start RC2-06** until this report is explicitly approved.

No commit, push, or deploy performed.
