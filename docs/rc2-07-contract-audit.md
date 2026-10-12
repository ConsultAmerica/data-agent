# RC2-07 Contract Audit — Governance & Operations

**Date:** 2026-10-08  
**Method:** Read-only inspection before edits  
**Stop conditions:** None for UI + thin audit query filters on existing table

---

## Authoritative metric sources

| Metric | Source | Notes |
|---|---|---|
| Total documents | `GET /api/dashboard/portfolio` → `totals.documents` | Server-scoped |
| Needs review | portfolio `review.pending` / `review.low_confidence_documents` | Field-level pending counts |
| Processing failures | portfolio `totals.failed` | Do not invent |
| Active processing | portfolio `totals.processing` | |
| Recent review activity | `GET /api/documents/audit-log` (paged) | MetadataFieldAuditLog only |
| Review decision totals | portfolio `review.accepted|edited|rejected` | Aggregate, not full log scan |
| Oracle outcomes | `GET …/integration-audit` per document | No global list API |
| Exports | No dedicated export-audit API | Do not fabricate export counts |
| Health | `GET /health`, `GET /ready` | Do not infer from page render |

## Gaps (not invented)

- Global audit filters were limit/offset only → add optional query filters (same table).
- No global Oracle audit list → document-scoped panel only.
- No job list API → surface failed docs from portfolio + reprocess via existing `jobs/process`.
- Activity page = same audit log (no separate store).

## Proceed

Governance dashboard from portfolio/stats/ready; audit explorer filters; processing failed list + guarded reprocess; role-aware action hints from `/api/actors/me`; Oracle safety labels already in RC2-06 panel.

## Post-implementation notes

- Audit filters shipped on existing `MetadataFieldAuditLog` query (no new store).
- Export / global Oracle metrics remain unavailable — UI states the gap.
- Idempotency proposal only: `docs/rc2-07-oracle-idempotency-proposal.md`.
