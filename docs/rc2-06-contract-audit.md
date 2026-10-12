# RC2-06 Contract Audit — Exports & Oracle Integration

**Date:** 2026-10-08  
**Scope:** Read-only inspection before RC2-06 UX work  
**Stop conditions:** None triggered for UX-only work that reuses existing APIs without policy changes

---

## Distinct value contracts

| Surface | Value source | Review filter |
|---|---|---|
| **Staging export** (All / Selected) | `StagingCell.value` from persisted workbook; manifest = IDs only | Staging QA labels only; not metadata Accepted |
| **Reviewed metadata export** | `DocumentMetadataField.value` (+ `extracted_value`) | Optional `authoritative_only` → accepted\|edited |
| **Oracle payload** | Authoritative metadata `value` only | Always excludes pending/rejected/unknown; send requires clean set |

These must not be conflated in the UI.

---

## Data flow

```
Staging workbook (assembled view)
  → Export All (profile capabilities) / Export Selected (manifest IDs)
  → Server resolves cells → xlsx/csv/json download

DocumentMetadataField
  → GET /export|/export.csv|/export.xlsx (?authoritative_only)
  → GET /oracle-payload (preview; send_allowed forced false)
  → POST /oracle-send {confirm:true} → IntegrationAuditLog
       dry_run=true → simulated 200
       dry_run=false → 501 not configured (no invented success)
```

---

## Preview vs send

- Preview never authorizes send (`send_allowed: false` on preview response).
- Send requires `oracle.send`, `confirm: true`, authoritative_count > 0, skipped_count == 0.
- Successful preview ≠ successful send.

## Idempotency

- No send idempotency key. Repeat dry-run creates another audit row.
- Live path unwired (501). Client must not blind-retry after timeout without reconciliation.

## Proceed

UX improvements only: export scope/feedback, wire real Oracle preview/send/history, keep policies intact.
