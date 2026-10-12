# RC2-05 Contract Audit & Gap Assessment

**Status:** Audit complete — gap verdict below  
**Date:** 2026-10-08  
**Scope:** Models, review APIs, staging↔metadata mapping, value preservation, export, RBAC, audit, concurrency  
**Commit/push/deploy:** Not performed  
**Method:** Code inspection of current local tree (including uncommitted RC2 work). No new migrations. No inventing of field maps.

---

## 1. Executive verdict

| Stop condition | Triggered? | Action |
|---|---|---|
| Metadata review requires replacing staging authoritative values | **No** | Staging remains a read-time view; authority stays on `DocumentMetadataField` |
| Field IDs cannot be mapped reliably | **Yes — for field-level staging writes** | Do **not** Accept/Edit/Reject from staging cells by guessing `field_key` from labels/`canonical_field` |
| Review APIs cannot preserve human corrections | **No** (current tree) | Human-locked upsert on contract / target / V3 reprocess preserves `value` |
| Rejected-value export needs a policy change | **No** | Policy already defined; do not rewrite export in RC2-05 |
| Cross-tenant isolation cannot be demonstrated | **No** | Router-level `enforce_document_access` + workspace scoping |
| Database migration becomes necessary | **No for Option A UI** | Optimistic concurrency would need a later approved change |

**Safe to implement (or keep) under Option A:** metadata review workspace + Accept/Edit/Reject via existing review APIs + document-level staging bridge + dual vocabulary labeling.

**Must not implement without separate approval:** field-level write bridge from staging cell → metadata `field_key` (assessment Option A “by `canonical_field`” is **not** reliably supported today).

---

## 2. Data-flow diagram (current)

```
Source file
   → process / extract / analyze-contract
   → DocumentMetadataField rows
        (extraction_source: contract | target | v3)
        value              = effective / authoritative
        original_value     ≈ first machine value
        evidence_json.machine_value = latest machine extract
        review_status      = pending|accepted|edited|rejected|unknown
   → POST /metadata-fields/{field_key}/review  (accept|edit|reject|mark_unknown)
        + MetadataFieldAuditLog (same transaction)
   → Export:
        rich JSON/CSV  → both extracted_value + value + review_status
        authoritative_only → accepted|edited only
        Oracle preview/send → never pending|rejected|unknown

Parallel path (not the same store):
   → staging preparation (profile adapters)
   → StagingWorkbook (ephemeral view)
        cells keyed by canonical_field
        review_status = Verified | Needs Review | Missing
   → staging selection export (presentation values)
```

**These contracts are not interchangeable.** Staging QA status must not be equated with metadata Accept/Edit/Reject.

---

## 3. DocumentMetadataField (authoritative store)

| Column / concept | Role |
|---|---|
| `document_id` + `field_key` | Identity for review API (lookup is by these; **no unique constraint** on `(document_id, field_key, extraction_source)` in the model) |
| `value` | Authoritative effective value |
| `original_value` | Historical / fallback machine value |
| `evidence_json.machine_value` | Preferred machine extract for `extracted_value` |
| `review_status` | Governance: `pending` \| `accepted` \| `edited` \| `rejected` \| `unknown` |
| `human_approved` | True after accept/edit |
| `verified` | Extraction-time flag — **not** Staging Verified |
| `evidence_json` | page_number, source_text, source_reference, plus machine/review keys |
| `extraction_source` | `contract` / `target` / `v3` — parallel writers into the same table |
| `extracted_at` | Last machine extract time — **not** used as concurrency token |

API projection: `MetadataFieldResult.extracted_value` resolves via `extracted_value_for()` (`machine_value` → `original_value` → `value`).

---

## 4. Staging models (presentation view)

| Concept | Role |
|---|---|
| `StagingWorkbook` | Profile-assembled **view**, not a second persistence of review authority |
| `StagingCell.canonical_field` | Profile vocabulary (e.g. dotted business keys) |
| `StagingCell.review_status` | `Verified` \| `Needs Review` \| `Missing` only |
| `CellProvenance` | Real source coordinates when extraction provided them |

Staging preparation (`backend/app/staging/`) does **not** join to `DocumentMetadataField` by a shared ID for Accept/Edit/Reject. Contract/invoice/transcript profiles build cells from domain/profile pipelines, not from metadata review rows as the single write target.

---

## 5. Review API contract

| Endpoint | Behavior |
|---|---|
| `POST …/metadata-fields/{field_key}/review` | Actions: accept / edit / reject / mark_unknown → status map; edit requires value; updates `value` only on edit; preserves `machine_value`; writes audit; commit |
| `POST …/metadata-fields/accept-all` | Accepts **pending only**; skips accepted/edited/rejected/unknown |
| `GET …/metadata-fields/{field_key}/audit-log` | Append-only history |

**Transitions:** Any action may overwrite current status (no state-machine guard). Rejected → Accept (single-field) is allowed; Accept-all will not touch rejected.

**Permissions:** `review.accept` / `review.edit` / `review.reject` checked server-side.

**Document access:** `contract_analysis` router mounted with `enforce_document_access` (workspace actors scoped by `owner_workspace`; foreign UUID → 404).

**Lookup gap (addressed fail-closed under Option A approval):** `get_metadata_field` remains best-effort for non-mutations. Review mutations use `require_unique_metadata_field` and return **HTTP 409** with candidate ids when duplicates exist — never a silent extraction-source pick. Review-by-primary-key remains a separately approved follow-up.

---

## 6. Value preservation / reprocessing

| Writer | Human-locked statuses | Behavior |
|---|---|---|
| Contract metadata extractor | accepted, edited, rejected | Upsert; refresh machine evidence; keep `value`; conflict → reopen `pending` without overwriting effective value; never delete locked rows |
| Target result store | same | Same pattern |
| V3 all-fields builder | same | Same pattern |

**Conclusion:** Human corrections survive reprocessing in the current tree. Re-analyze return path must return **persisted** rows (not ephemeral pending snapshots) — present in current extractor.

---

## 7. Source evidence

Metadata evidence: persisted `evidence_json` keys (`page_number`, `source_text`, `source_reference`). Absent → empty / zero page — UI must not fabricate.

Staging evidence: `CellProvenance` only when populated; OCR confidence only when set by structure provenance.

Review UI can navigate PDF highlight from metadata evidence when page/text exist.

---

## 8. Export resolution

| Surface | Rejected / pending handling |
|---|---|
| Rich JSON / default CSV | Includes row; `value` + `extracted_value` + `review_status`; `authoritative` flag false for non-accepted/edited |
| `authoritative_only=true` | Only `accepted` \| `edited` |
| Oracle preview / send | Explicitly excludes pending / rejected / unknown |

**Gap assessment:** Behavior is **defined**, not ambiguous. Spec stop (“ambiguous rejected export → stop before changing semantics”) does **not** fire. RC2-05 must not rewrite the export pipeline.

Note: default business CSV still emits the rejected field’s current `value` string with `review_status=rejected`. Downstream consumers must read status (or use `authoritative_only` / Oracle path). That is existing policy, not a hole requiring invention.

---

## 9. Audit & RBAC

Successful review mutations write `MetadataFieldAuditLog` with: document_id, field_key, action, previous/new value & status, reason, request_id, actor_id/type/role, changed_by, changed_at — then commit with the field update. Failures before commit produce no success row.

RBAC: permission gates on review mutations; export/oracle have separate permissions; workspace isolation via router dependency.

---

## 10. Concurrency

| Question | Finding |
|---|---|
| Optimistic concurrency on review API? | **No** — no version / If-Match / expected_updated_at |
| Model support? | No `updated_at` / `review_version` on `DocumentMetadataField` |
| Risk | Last write wins between concurrent reviewers |

**Smallest safe enhancement (proposed; requires approval — may imply migration):**

1. Add `review_version` (int) or use a dedicated `reviewed_at`/`updated_at`.
2. Client sends `expected_version` on review POST.
3. Mismatch → `409` with current field; no silent overwrite.

**Not implemented in RC2-05** (would trigger migration stop if forced now). Document as limitation; do not fake client-only locking.

---

## 11. Staging ↔ metadata mapping (critical)

| Claim | Reality |
|---|---|
| Assessment Option A: “writes metadata by `canonical_field`” | **Unsafe today** — no durable map from staging `canonical_field` / display label → `DocumentMetadataField.field_key` |
| Same string equality | Occasional coincidence only; not a contract |
| Dual vocabulary | Staging Verified ≠ Metadata Accepted — must stay distinct; no auto-sync |

**Stop condition triggered for field-level staging mutations.**

**Allowed without approval:** document-level entry points (“Open metadata review” → `/documents/{id}/review`) with explicit copy that staging verification is not metadata acceptance.

**Not allowed:** inventing IDs from labels, silently dual-writing staging Verified into metadata Accepted, or treating staging export as Oracle authority.

---

## 12. Gap assessment vs RC2-05 objectives

| Objective | Supported by existing contracts? | Gap |
|---|---|---|
| Accept / Edit / Reject | Yes — review API | None for metadata workspace |
| Preserve extracted vs effective | Yes — machine_value + value | UI must display both |
| Survive reprocess | Yes — human-locked upsert | Covered by tests in current tree |
| Real source evidence only | Yes if UI honest | Empty states required when missing |
| Dual status vocabulary | Yes if UI labels carefully | Staging vs Metadata wording |
| Audit every mutation | Yes | None |
| RBAC / tenant isolation | Yes (router + permissions) | Demonstrate in tests |
| Optimistic concurrency | **No** | Propose enhancement; no silent overwrite workaround |
| Staging field-level bridge | **No reliable map** | **Stop** — document-level only |
| Export consistency | Yes — leave pipeline alone | Document rejected/default CSV vs Oracle |
| Second review store | Must not create | Option A / document bridge only |

---

## 13. Implementation gate

### Proceed without further approval (Option A — metadata-centric)

1. Review workspace UX over existing analysis/review APIs  
2. Accept / Edit / Reject + extracted/effective display  
3. Evidence navigation from real evidence only  
4. Distinct Metadata * vs Staging * labels  
5. Document-level staging → metadata review links  
6. Tests for preservation, RBAC, export policy, UI actions  
7. Completion report A–L  

### Requires explicit approval before coding

1. Field-level Accept/Edit/Reject from staging cells (canonical_field → field_key map or new join table → **migration / new contract**)  
2. Auto-reconciling Staging Verified with Metadata Accepted  
3. Changing rejected/pending export semantics  
4. Adding optimistic concurrency columns/migration  

---

## 14. Local tree note

Uncommitted local work already includes human-locked reprocess, review UI vocabulary, document-level staging bridge, preservation tests, and `docs/rc2-05-completion-report.md`. That work aligns with the **safe** gate above and correctly **avoids** inventing field-level mapping.

This audit is the mandatory baseline. Treat any field-level staging write as out of scope until a mapping contract is approved.

---

## 15. Recommendation

1. **Accept this audit** as RC2-05 contract baseline.  
2. **Approve continued Option A** (metadata review workspace + document-level bridge only).  
3. **Defer** field-level staging linkage and concurrency migration to a separately approved contract.  
4. Use existing `docs/rc2-05-completion-report.md` for A–L verification after audit acceptance — or request a refresh pass.  
5. **Stop before RC2-06** until RC2-05 is explicitly accepted.

No commit, push, or deploy performed.
