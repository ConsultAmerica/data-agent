# Neon Migration Validation Checklist

**Status:** Template — **no staging execution performed in this assessment**  
**Environment under test:** Neon staging branch + API pointing at that DB (when approved)  
**RC2 gates:** metadata review mutations **disabled**; Oracle **dry-run only** (no live send)

---

## A. Pre-conditions

| Check | Pass? | Notes |
|---|---|---|
| Target Neon DB was empty before restore | ☐ | |
| Dump excluded Supabase `auth`/`storage`/system schemas | ☐ | |
| `alembic_version` matches source | ☐ | |
| `/ready` shows `oracle_dry_run=true` | ☐ | |
| `/ready` shows `metadata_review_mutations_enabled=false` (prod/staging RC) | ☐ | |
| `SUPABASE_*` storage still configured | ☐ | |

---

## B. Data integrity evidence

| Table / metric | Source count | Neon count | Match? |
|---|---|---|---|
| `documents` | | | ☐ |
| `document_pages` | | | ☐ |
| `document_metadata_fields` | | | ☐ |
| `metadata_field_audit_log` | | | ☐ |
| `document_staging_workbooks` | | | ☐ |
| `extraction_jobs` | | | ☐ |
| `actors` | | | ☐ |
| `integration_audit_log` | | | ☐ |
| `target_corrections` | | | ☐ |
| Orphan `document_pages` | 0 | 0 | ☐ |
| Orphan metadata fields | 0 | 0 | ☐ |

Add rows for other tables if counts diverge.

---

## C. Functional verification (staging API)

Keep mutations gated; do not enable live Oracle.

| Area | Test | Pass? |
|---|---|---|
| Authentication | Service key / Entra token resolves actor | ☐ |
| Workspace isolation | Workspace A cannot see B’s documents | ☐ |
| Document repository | Search + open document | ☐ |
| Extraction / staging | Open staged workbook / FAR or contract tabs | ☐ |
| Metadata **read** | Field list + audit history visible | ☐ |
| Metadata **mutation** | Accept/Edit/Reject → **403** when gated | ☐ |
| Staging exports | Export All or Selected downloads | ☐ |
| Governance | Portfolio metrics load | ☐ |
| Audit explorer | Filters return scoped rows | ☐ |
| Background jobs | Start process job or observe existing job poll | ☐ |
| Health | `/health` ok; `/ready` ready | ☐ |
| Storage | Open source PDF (local cache or Supabase fetch) | ☐ |

---

## D. Sample document lifecycle

Pick 2–3 known document IDs from source (record IDs only in this sheet):

| Document ID (truncated OK) | Open workspace | Staging visible | Export OK | Audit rows present |
|---|---|---|---|---|
| | ☐ | ☐ | ☐ | ☐ |
| | ☐ | ☐ | ☐ | ☐ |

---

## E. Performance spot-check (optional)

| Call | Latency | Notes |
|---|---|---|
| `GET /api/documents/search?limit=25` | | |
| `GET /api/dashboard/portfolio` | | |
| `GET /api/documents/audit-log?limit=20` | | |

---

## F. Sign-off

| Role | Name | Date | Result |
|---|---|---|---|
| Engineer | | | ☐ Staging GO / ☐ NO-GO |
| Approver | | | ☐ Approve cutover prep / ☐ Hold |

**Staging GO** means data + functional checks passed; it does **not** authorize production `DATABASE_URL` change.
