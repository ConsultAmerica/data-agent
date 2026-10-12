# RC2-05 Completion Report — Source Evidence & Human Review

**Status:** Implemented locally — awaiting review before RC2-06  
**Date:** 2026-10-08  
**Baseline:** RC2-04 Staging Workbook (accepted) · RC2-03 Extraction Workspace (conditionally accepted) · RC2-02 · RC2-01  
**Commit/push/deploy:** Not performed

---

## A. Existing contracts reused

| Capability | Source | Notes |
|---|---|---|
| Metadata field model + review API | `DocumentMetadataField`, `POST …/metadata-fields/{field_key}/review` | Accept / edit / reject / mark_unknown; permissions `review.accept` / `review.edit` / `review.reject` |
| Accept-all pending | `POST …/metadata-fields/accept-all` | Skips rejected (existing behavior) |
| Field audit log | `MetadataFieldAuditLog` + `GET …/audit-log` | Actor, request_id, previous/new value & status |
| Extracted vs effective value | `evidence.machine_value` / `original_value` vs `value` | Surfaced as `extracted_value` on `MetadataFieldResult` |
| Source evidence | Persisted `evidence_json` (page, source_text, source_reference) | Shown only when present; empty state when not |
| Workspace isolation | Router-level `enforce_document_access` on contract_analysis | Workspace actors scoped by `owner_workspace` |
| Review workspace UI | `/documents/[documentId]/review` split PDF + field list | Enhanced, not replaced |
| Staging workbook / selection / export | RC2-04 surfaces | Unchanged export semantics |
| Reviewed / Oracle export | `reviewed_export.py` | Authoritative = accepted/edited; Oracle skips pending/rejected |
| Dual vocabulary (Option A) | Assessment recommendation | Staging Verified ≠ Metadata Accepted; no second review store |

No second authoritative review store was created. Staging continues to present; metadata mutations go through existing review APIs only.

---

## B. Data-flow and mapping findings

### Current data flow

```
Upload → process/extract → DocumentMetadataField rows
         (contract extractor | target extract | V3 all-fields)
                ↓
         review API (accept | edit | reject)
                ↓
         value = effective; evidence.machine_value = machine extract
         MetadataFieldAuditLog on success only
                ↓
         reviewed_export / Oracle preview (status-gated)
```

Staging workbook is a **presentation** layer over staging datasets/records. Staging `Verified` / `Needs Review` / `Missing` is QA state on staging cells — **not** written by metadata Accept/Edit/Reject.

### Mapping gap (documented, not invented)

| Staging | Metadata |
|---|---|
| Cell / column labels | No stable `field_key` map from staging labels |
| Staging review_status | Distinct from `DocumentMetadataField.review_status` |
| Evidence drawer | Can open document-level **Metadata review**; no field-ID deep-link invented |

**Option A bridge:** workspace header + evidence drawer link to `/documents/{id}/review` without guessing metadata field IDs.

### Contracts are not interchangeable

- Metadata: `pending | accepted | edited | rejected | unknown`
- Staging: `Verified | Needs Review | Missing` (UI labels: Staging Verified / Staging Needs Review)
- Changing one must not auto-mutate the other (preserved)

---

## C. Files changed

### Created
| File | Role |
|---|---|
| `backend/tests/test_human_review_preservation.py` | Accept/edit/reject survive re-analyze; reject not wiped by accept-all |
| `frontend/components/__tests__/review-field-list.test.tsx` | Extracted/effective, Accept, empty evidence, Edit validation |
| `frontend/components/__tests__/status-badge-metadata.test.tsx` | Metadata * labels ≠ Staging Verified |
| `docs/rc2-05-completion-report.md` | This report |

### Modified (RC2-05-relevant)
| File | Change |
|---|---|
| `backend/app/services/contract_metadata_extractor.py` | Human-locked upsert (no DELETE+recreate); conflict → pending without overwriting `value`; API returns **persisted** rows after re-analyze |
| `backend/app/services/all_fields_builder.py` | Same human-locked upsert for V3 all-fields |
| `backend/app/api/contract_analysis.py` | Preserve `machine_value` on review; `human_approved` on accept/edit |
| `backend/app/schemas/contract_analysis.py` | `extracted_value` on `MetadataFieldResult` |
| `frontend/components/review-field-list.tsx` | Extracted vs effective columns; Metadata status; save feedback; unsaved edit guard; empty evidence; a11y |
| `frontend/components/status-badge.tsx` | Field labels: Metadata Pending / Accepted / Edited / Rejected / Unknown |
| `frontend/components/staging/review-status.tsx` | Staging Verified / Staging Needs Review labels + title |
| `frontend/components/staging/evidence-drawer.tsx` | Open metadata review entry + vocabulary note; empty evidence copy |
| `frontend/components/documents/document-workspace.tsx` | Metadata review entry point |
| `frontend/components/staging/presentation-workspace.tsx` (+ invoice/transcript workbooks) | Pass `metadataReviewHref` into evidence drawer |
| `frontend/src/app/documents/[documentId]/review/page.tsx` | Mobile document/data tabs for stacked review |
| `frontend/types/document.ts` | `extracted_value` on metadata field types |
| `frontend/components/staging/__tests__/table-selection.test.tsx` | Assert Staging Needs Review labels |

No database migration.

---

## D. Review actions implemented

| Action | Behavior | API |
|---|---|---|
| **Accept** | Sets `review_status=accepted`, `human_approved=true`; keeps effective `value`; records audit | Existing |
| **Edit** | Requires corrected value; sets `edited`; preserves machine extract in `machine_value` / `extracted_value`; audit previous→new | Existing |
| **Reject** | Sets `rejected`; not treated as authoritative for Oracle; accept-all skips rejected | Existing |
| **Accept all pending** | Existing bulk accept of pending only | Existing |

UI shows save notices, validation (“A corrected value is required”), and busy/disabled states. Failed mutations do not claim success (no audit write on failure — audit is written then committed with the field update).

---

## E. Source evidence behavior

- Field selection navigates PDF panel to `evidence.page_number` and highlights `evidence.source_text` when present.
- **View Source** on a field opens the evidence panel; if page/snippet absent → clear empty state (“No source evidence…”).
- Confidence shown only from persisted `field.confidence` (not invented).
- Staging evidence drawer: real provenance only; “No source evidence was recorded…” when missing; does not fabricate locations or scores.
- Staging → metadata: document-level review link only (no invented field-level linkage).

---

## F. Value preservation and reprocessing behavior

| Rule | Implementation |
|---|---|
| `extracted_value` = machine | `evidence.machine_value` → `original_value` → fallback |
| `value` = effective / authoritative | Updated only by edit (or initial extract when not human-locked) |
| Human lock | Status in `{accepted, edited, rejected}` |
| Re-analyze / re-extract | Upsert: refresh machine evidence; **never overwrite** locked `value` |
| Machine ≠ human value | Reopen `pending` for review; keep human `value` |
| Machine == human value | Keep prior review status |
| Drop obsolete unlocked keys | Allowed; human-locked rows never deleted |

Verified by `test_human_review_preservation.py` (accepted/edited survive re-analyze; reject survives accept-all).

---

## G. Audit and RBAC

### Audit (on successful commit)
- Document ID, field key, action, actor id/type/role, `changed_by`, timestamp  
- Previous/new status and previous/new effective value  
- `request_id` via `get_request_id()`  
- Reason strings for accept/edit/reject  

Failed requests raise before commit → no success audit row.

### RBAC
- Per-action permissions enforced in `review_metadata_field` / `accept_all`
- Document access via `enforce_document_access` on the contract_analysis router
- Cross-workspace UUID access returns 404 for workspace-scoped actors

---

## H. Concurrency behavior

**Finding:** Review API has **no** optimistic concurrency (`version` / `If-Match` / `updated_at` check). Last write wins.

**Smallest safe enhancement (proposed, not implemented — would need migration or existing column use):**

1. Add/use `DocumentMetadataField.updated_at` (or integer `review_version`).
2. Require client to send `expected_updated_at` / `expected_version` on review POST.
3. On mismatch → `409 Conflict` with current field payload; no silent overwrite.

Documented as a known limitation for RC2-05; no migration performed (stop condition).

---

## I. Export consistency

Export pipeline **not rewritten**.

| Case | Behavior (existing policy) |
|---|---|
| Accepted / edited | Included as authoritative (`value`) |
| Pending / rejected / unknown | Present in rich reviewed export with `review_status`; **excluded** from Oracle downstream payload |
| Extracted vs effective | Export columns include both |

Covered by `tests/test_export_api_integrity.py` (Oracle excludes pending/rejected). No policy change to rejected-field handling.

---

## J. Test results

| Suite | Result |
|---|---|
| Backend focused: human preservation + export integrity + accept/edit/reject/audit | **18 passed** |
| Backend full suite (`backend/.venv`) | **769 passed**, 1 skipped, **2 failed** (see below) |
| Frontend RC2-05: review-field-list, status-badge-metadata, table-selection, reviewed-export | **31 passed** |
| TypeScript `tsc --noEmit` | **Passed** |

### Full-suite failures (not RC2-05 regressions)

`tests/test_ingestion_ocr_matrix.py` — `test_native_text_formats_do_not_need_ocr`, `test_png_raster_ocr_expected`:

- Expect HTTP **201**; got **200** `duplicate_pending` because identical fixtures already exist in the local shared DB (`data_agent_v2.db` / prior uploads).
- Environment/state pollution, not metadata-review logic. pdfplumber path works under `backend/.venv`.

---

## K. Browser verification

Not run in this package (no commit/deploy; Vitest + pytest + tsc only). Recommend manual check:

1. Open a contract with analysis → `/documents/{id}/review`  
2. Confirm Extracted vs Effective columns and Metadata * status labels  
3. Accept → refresh → status/value persist  
4. Edit with correction → refresh → effective value held; extracted unchanged  
5. Reject → Oracle preview excludes field; staging Verified unchanged  
6. From staging workbook → Evidence → **Open metadata review** (document-level)  
7. Reprocess/re-analyze → human values survive; conflict reopens pending without overwrite  
8. Narrow viewport → Document / Extracted intelligence tabs  

---

## L. Known limitations and contract gaps

1. **No staging ↔ metadata field_key map** — bridge is document-level only (by design for RC2-05).  
2. **No optimistic concurrency** on review mutations — last-write-wins; enhancement proposed in §H.  
3. **Staging Verified never auto-syncs** with Metadata Accepted — future reconciliation needs a separate approved contract.  
4. **Rejected export policy** — Oracle excludes rejected; rich export still emits the row with status. Policy left unchanged.  
5. **Review page confidence average** — uses persisted field confidences only; not fabricated.  
6. **OCR matrix tests** fail against a polluted local DB (duplicate_pending); unrelated to RC2-05.  
7. **mark_unknown** remains API-supported; UI emphasis is Accept / Edit / Reject per mission.

### Stop conditions checked

| Condition | Outcome |
|---|---|
| Replace staging authoritative values for metadata review | **Avoided** (Option A) |
| Invent field IDs from staging labels | **Avoided** |
| APIs cannot preserve human corrections | **Fixed** (upsert + persisted return) |
| Rejected export needs policy change | **Not changed** — documented |
| Cross-tenant isolation undemonstrable | **Router enforcement present**; workspace isolation architecture unchanged |
| Database migration required | **None** |

---

## Acceptance criteria

| Criterion | Status |
|---|---|
| Inspect field + real source evidence + accept/correct + persist + refresh recovers value/status | Met (API + UI + tests) |
| Mutations authorized and auditable | Met |
| Human corrections survive reprocessing | Met |
| Staging verification distinct from metadata acceptance | Met (labels + no auto-sync) |

---

**Stop for review.** No commit, push, or deploy performed. Await approval before RC2-06.
