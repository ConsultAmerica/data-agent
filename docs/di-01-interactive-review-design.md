# DI-01 — Interactive Document Viewer and Review Design

**Status:** design proposal · **Date:** 2026-10-26
**Starting point (exists):** dual-pane review page `frontend/src/app/documents/[documentId]/review/page.tsx:920-1024` (`ResizableSplit` + `PdfToolbar` + `PdfPageViewer` + `ReviewFieldList`); server-rendered page PNGs with highlight location `backend/app/api/page_extraction.py:419-516`; deep links `?view=source&page=N&hl=…` in `frontend/components/documents/document-workspace.tsx:124-133`; field audit trail `frontend/components/review/document-audit-trail.tsx`.

## 1. Non-negotiable constraints

1. **Backend feature gates are authoritative.** All review mutations go through routes guarded by `require_metadata_review_mutations_enabled()` (`backend/app/core/feature_gates.py`), which is **fail-closed in production** unless `METADATA_REVIEW_MUTATIONS_ENABLED=true` is set with a waiver. The UI must read the gate (exposed by `/ready`, `frontend/lib/ops-health.ts:71-85`) and render read-only mode when closed — today it does not hide controls. The UI never works around a 403.
2. Approve/promote are brought under the same gate and RBAC (today they have neither — `api/contract_analysis.py:874-948`).
3. Reviewer identity comes from the authenticated actor, not a free-text name (today defaults to "Dataomatix").
4. No new route may bypass `enforce_document_access` (router dependency in `main.py`).

## 2. Layout

```text
┌──────────────────────────── Header ──────────────────────────────────────┐
│ Doc name · profile@ver · data class badge · processing ▸ review ▸ ERP     │
│ [Read-only: review disabled for this release]  (when gate closed)         │
├─────────────── Left: Original ───────────┬──────── Right: Fields ─────────┤
│ toolbar: ◀ page n/N ▶ · zoom −/+/fit ·    │ filter: All | Needs review |   │
│ rotate · search · thumbnails · layers ☐OCR│  Exceptions | Missing | Changed│
│ ☐all boxes ☐selected only                 │ ┌ Section (dataset) ─────────┐ │
│                                           │ │ Field  Value  ●conf  ✓/!/∅  │ │
│  page image (PNG today; tiles for zoom)   │ │  checks: ✓ arithmetic       │ │
│  ▭ evidence boxes (colour = state)        │ │  evidence p.2 “Total Due…” │ │
│  ▭ selected box pulses                    │ │  [Accept] [Edit] [Reject]  │ │
│                                           │ └────────────────────────────┘ │
│                                           │ Exceptions panel · History tab │
└───────────────────────────────────────────┴────────────────────────────────┘
```

Both panes resize (existing `ResizableSplit`); on narrow screens they stack with a sticky "show on page" button.

## 3. Feature specification

| Feature | Behaviour | Exists? | Change needed |
|---|---|---|---|
| Original PDF/image | Server-rendered PNG per page | ✅ | Add tiled/hi-DPI render at zoom > 200%; cache per (doc, page, dpi) |
| Non-PDF sources | HTML/XML/Office show source transcription with DOM/element path highlight | ◐ (text fallback) | Use existing provenance (DOM selector / element path) to highlight in transcription |
| Page navigation, thumbnails | prev/next, jump, thumbnail strip | ◐ (no thumbnails) | Thumbnails endpoint (low-DPI) |
| Zoom / fit / rotate | | ◐ zoom only | Fit-width/page; rotate view (non-destructive) |
| Evidence boxes | All boxes for visible page, colour by state (Verified / Needs Review / Edited / Rejected) | ◐ one box per render | Return all evidence geometry for a page in one call; convert `ocr_pixels`→page space server-side |
| Click-to-highlight | Field → page + box; box → field | ◐ field→box only | Reverse lookup (box click selects field) |
| Confidence | Show OCR confidence, extraction confidence, and validation **separately** | ◐ | Three indicators, never a single blended "%" as approval signal |
| Validation results | Per-field check list with message and rule id; document-level exceptions panel | ◐ (QA tab) | Exceptions panel with severity ordering |
| Human correction | Edit with: value, optional **re-select evidence by drawing a box** or selecting text, mandatory reason for Block-severity overrides | ◐ edit value only | Evidence reselection; reason field (add to `target_corrections`) |
| Review history | Per field and per document: who (actor id + role), when, old→new, reason, request id | ✅ field level | Add document events (approve/return), classification and relationship events with actor id |
| Conflict detection | See §4 | ✗ | New |
| Reprocessing safeguards | See §5 | ◐ | Extend |
| Keyboard | `j/k` next/prev field, `a` accept, `e` edit, `r` reject, `n` next exception | ✗ | New; disabled when gate closed |
| Masking | Restricted fields masked; "reveal" requires permission and writes an access-audit event | ✗ | New (with security work) |
| Batch actions | Accept only fields satisfying the profile review policy (not server accept-all) | ◐ frontend filter; server accept-all accepts everything | Server endpoint takes explicit field ids + policy check; deprecate unconditional accept-all for non-admins |

## 4. Conflict detection (concurrency)

Today there is no version check; last write wins.

- Add `row_version` (integer) to `document_metadata_fields` and to the document review record; every mutation sends `If-Match: <version>`; mismatch → **409** with current value, actor and time.
- UI on 409: show "Changed by <actor> at <time>: <value>" with *Keep theirs* / *Apply mine* (re-submit with new version) — never silent overwrite.
- Soft presence: show other reviewers currently viewing the document (lightweight heartbeat; optional).
- Assignment: when a document is assigned, other reviewers see read-only unless they take over (audited).

## 5. Reprocessing safeguards

Existing behaviour (`services/target_result_store.py:70-110, 241-276`): reviewed values are locked; differing machine output resets status to pending with reason; `clear_stale_target_values` deletes only pending rows without audit history.

Additions:

| Safeguard | Design |
|---|---|
| Confirm dialog | Re-extract on a document with any reviewed field shows counts: *n reviewed fields will be preserved; m may return to pending*; requires `extraction.run` + explicit confirm |
| Blocked states | Re-extraction disabled for documents `submitted` to ERP or `approved` (unless returned first) |
| Diff view | After rerun: field-level diff (old machine value, new machine value, reviewed value) |
| Version pinning | Rerun uses document's pinned profile version unless the user explicitly upgrades (existing pinning respected) |
| Provider policy | Rerun cannot add an external provider step that policy forbids, even if the user requests "AI" |
| Audit | Rerun event with actor, reason, pipeline version before/after |

## 6. Review states shown to users

| Label | Meaning | Source |
|---|---|---|
| Missing | Expected field not found | engine |
| Needs review | Machine could not verify (evidence, check, OCR) | engine |
| Evidence-verified | Machine found value in evidence and checks passed (today labelled "Verified") | engine |
| Accepted / Edited / Rejected | Human decision | review |
| Approved for submission | Document-level human approval | review |
| Submitted / Accepted by Oracle / Rejected by Oracle | ERP states | ERP reconciliation only |

Rename recommendation: "Verified" → "Evidence-verified" in staging UI and exports, so machine status is not read as human sign-off (today staging exports carry machine status only — `staging/engine.py:112-143`).

## 7. API additions (proposed)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/documents/{id}/pages/{n}/evidence` | All boxes for page with field ids and states |
| GET | `/api/documents/{id}/pages/{n}/thumbnail` | Low-DPI image |
| PATCH | existing field review routes | + `If-Match`, `reason`, optional `evidence` reselection; gate + RBAC unchanged |
| POST | `/api/documents/{id}/review-events` | approve / return / reopen; gate + RBAC + audit; replaces free-text `approved_by` |
| GET | `/api/documents/{id}/history` | unified field + document + classification events |

## 8. Acceptance tests

- Gate closed ⇒ every mutation control disabled and every mutation route returns 403 (backend test + Playwright).
- Two sessions edit the same field ⇒ second gets 409 and sees the first change.
- Re-extraction never changes an Accepted/Edited value (existing test extended to approve/submit states).
- Click field ⇒ correct page and box (golden test on fixtures, including OCR pixel → page conversion on scanned fixture f2).
- Masked field never appears unmasked in DOM, network response or logs without `reveal` permission.
