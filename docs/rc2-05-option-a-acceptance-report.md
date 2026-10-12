# RC2-05 Option A — Implementation & Acceptance Report

**Status:** Local Option A complete — awaiting acceptance before RC2-06  
**Date:** 2026-10-08  
**Baseline:** Option A approved · `docs/rc2-05-contract-audit.md`  
**Commit/push/deploy:** Not performed

---

## 1. Implementation summary

Option A keeps **`DocumentMetadataField` as the sole authoritative review store**. Staging remains a presentation workbook. Accept / Edit / Reject go only through existing metadata review APIs.

| Authorized item | Status |
|---|---|
| Reuse review APIs for Accept / Edit / Reject | Done |
| Source-grounded metadata review workspace | Done — `/documents/{id}/review` + extracted/effective columns + evidence |
| Preserve `value` / `machine_value` / status / audit / RBAC | Done |
| Human-locked values survive reprocessing | Done — contract, target, V3 upserts |
| Document-level staging → metadata review navigation | Done — workspace + evidence drawer links only |
| Staging Verified ≠ Metadata Accepted | Done — distinct labels + copy |
| Rejected/pending export policy unchanged | Verified — Oracle still excludes; no export rewrite |
| Source evidence + refresh persistence | Done — real evidence only; empty states |
| FE/BE regression tests | Done (see §3–4) |

**Prohibited work avoided:** no staging field map, no field-level staging mutations, no second store, no staging↔metadata auto-sync, no export/Oracle policy change, no DB migration, no optimistic concurrency implementation.

---

## 2. Duplicate-key investigation findings

### Facts

| Fact | Evidence |
|---|---|
| No unique constraint on `(document_id, field_key)` | Model PK is `id` only; indexes are non-unique |
| Live DB has same-key duplicates | e.g. one document: `v3_telephone` × 419 (all `extraction_source=v3`); another: `v3_telephone_no` × 2 |
| Cross-source duplicates | 0 in sampled local DB, but schema allows them |
| Legacy `get_metadata_field` | Returned `scalar()` / first ordered row — **silent pick** |
| Target corrections API | Already scopes `extraction_source == "target"` |
| Review mutation API | Previously used unscoped `get_metadata_field` — **unsafe when duplicates exist** |
| Analysis GET | Returns **all** rows — UI can list duplicate `field_key`s |

### Verdict

**Ambiguity affects review mutations.** Silently choosing an extraction source (or the first row) is prohibited.

### Smallest safe correction applied (fail-closed, no migration)

1. `list_metadata_fields_by_key` / `require_unique_metadata_field`  
2. `POST …/metadata-fields/{field_key}/review` uses unique lookup  
3. On duplicates → **HTTP 409** with candidate `{id, extraction_source, review_status, value}`  
4. **No row is mutated** when ambiguous  
5. Tests in `tests/test_metadata_field_duplicate_key.py`

Non-mutation callers may still use legacy `get_metadata_field` (first ordered id) — documented as unsuitable for Accept/Edit/Reject.

### Follow-up contract (needs separate approval — not implemented)

Review-by-**primary key** `id` (or require `extraction_source` + uniqueness within source), expose `id` + `extraction_source` on `MetadataFieldResult`, and optionally a unique index after data cleanup. That may include migration and is **out of RC2-05 Option A**.

---

## 3. Review and authorization test evidence

| Suite | Result |
|---|---|
| `test_metadata_field_duplicate_key.py` | **2 passed** (unique require + 409) |
| `test_human_review_preservation.py` | **2 passed** |
| `test_export_api_integrity.py` | **passed** (incl. Oracle excludes pending/rejected) |
| `test_rbac_oracle_certification.py` | **passed** (`review.accept` gating) |
| `test_document_isolation.py` + contract review filters | **19 passed** |
| Focused backend total this gate | **18 + 19** green on listed runs |
| Frontend: review-field-list, status-badge-metadata, table-selection, document-workspace, reviewed-export | **43 passed** |

Authorization path: permissions on review actions; document access via router `enforce_document_access`; ambiguous field_key refused (409) rather than writing the wrong row.

---

## 4. Reprocessing preservation evidence

`test_human_review_preservation.py`:

- Accepted `governing_law` remains accepted after re-analyze; value preserved  
- Edited `payment_terms` keeps effective value `Net 30` after re-analyze  
- Rejected field is not flipped by accept-all; re-analyze does not replace effective value  

Implementation: human-locked upsert in `contract_metadata_extractor`, `target_result_store`, `all_fields_builder` — refresh `machine_value` only; conflict reopens `pending` without overwriting `value`.

---

## 5. Concurrency risk assessment

| Topic | Assessment |
|---|---|
| Current behavior | **Last-write-wins** |
| Optimistic concurrency | **Not supported** — do not claim it |
| Model | No `review_version` / mutation `updated_at` precondition |
| Race | Two reviewers editing the same unique field_key: later commit overwrites earlier without 409 |

### Proposed precondition contract (not implemented)

| Element | Proposal |
|---|---|
| Column | `review_version INTEGER NOT NULL DEFAULT 1` **or** trusted `updated_at` |
| Migration | Required for new column (or careful use of existing timestamp if added) |
| Request | `expected_version` (or `expected_updated_at`) on review POST |
| Success | Apply mutation; increment version |
| Conflict | `409` with current field payload; no write |
| Compatibility | Old clients omitting precondition: either reject (breaking) or allow last-write-wins until clients upgrade (compatibility mode) — product choice |
| Cleanup | Pair with review-by-`id` so duplicates are not conflated with version conflicts |

**Requires explicit approval before implementation.**

---

## 6. Remaining contract gaps

1. **Review-by-id** not shipped — 409 fail-closed only when `field_key` collides  
2. **V3 duplicate key pollution** in some documents (data quality) — separate cleanup  
3. **Analysis UI React keys** still use `field_key` — duplicate rows can collide in the list until API exposes stable `id`  
4. **Optimistic concurrency** — proposed only  
5. **Staging ↔ metadata field map** — still absent (correct under Option A)  
6. Browser verification of the review panel — not run in this package  

---

## 7. Files changed (RC2-05 Option A focus)

### Created
- `backend/tests/test_human_review_preservation.py`
- `backend/tests/test_metadata_field_duplicate_key.py`
- `frontend/components/__tests__/review-field-list.test.tsx`
- `frontend/components/__tests__/status-badge-metadata.test.tsx`
- `docs/rc2-05-contract-audit.md`
- `docs/rc2-05-completion-report.md`
- `docs/rc2-05-option-a-acceptance-report.md` (this file)

### Modified (material)
- `backend/app/services/contract_metadata_extractor.py` — human-locked upsert; unique lookup helpers; 409 path support  
- `backend/app/services/all_fields_builder.py` — human-locked upsert  
- `backend/app/api/contract_analysis.py` — machine_value on review; **409 on ambiguous field_key**  
- `backend/app/schemas/contract_analysis.py` — `extracted_value`  
- `frontend/components/review-field-list.tsx` — extracted/effective; Metadata labels; a11y; save feedback  
- `frontend/components/status-badge.tsx` — Metadata * vocabulary  
- `frontend/components/staging/review-status.tsx` — Staging * vocabulary  
- `frontend/components/staging/evidence-drawer.tsx` — document-level metadata review link  
- `frontend/components/documents/document-workspace.tsx` — Metadata review entry  
- `frontend/components/staging/presentation-workspace.tsx` (+ invoice/transcript) — `metadataReviewHref`  
- `frontend/src/app/documents/[documentId]/review/page.tsx` — mobile panels; surface review errors  

---

## 8. Recommendation for RC2-05 acceptance

**Recommend conditional acceptance of RC2-05 Option A** for local/dev continuation:

- Authoritative metadata review path is implemented and tested for unique `field_key`s  
- Staging bridge is document-level only  
- Dual vocabulary preserved  
- Export/Oracle policies untouched  
- Duplicate-key mutations fail closed (409) instead of silent wrong-row writes  

**Before treating review-by-key as production-hard for all pipelines:** approve a follow-up for review-by-`id` (and optional uniqueness cleanup). **Do not** start RC2-06 until this report is accepted.

No commit, push, or deploy performed.
