# RC2-04 Completion Report — Professional Staging Workbook

**Status:** Implemented locally — awaiting review before RC2-03  
**Date:** 2026-10-08  
**Baseline:** RC2-02 Documents Repository (conditionally accepted) · RC2-01 shell  
**Commit/push/deploy:** Not performed

---

## A. Existing functionality reused

| Capability | Source |
|---|---|
| Application shell, breadcrumbs, semantic tokens | RC2-01 |
| Staging datasets, profile views, dynamic columns | Staging workbook API + profile `views` / `grid_fields` |
| Cell / row / column selection + Export Selected | `lib/table-selection`, `SelectionToolbar`, `downloadSelectedExport` |
| Sticky headers, frozen identifiers, resize, sort | `StagingDatasetTable`, `lib/data-grid`, `ResizeHandle` |
| Source evidence | `EvidenceDrawer`, `StagingRecordDrawer`, provenance-backed `cellSourceRequest` |
| FAR Part 52 / Final Rule / Oracle / contract / invoice / transcript tabs | Existing profile-declared presentations (not rebuilt) |
| Staging review vocabulary (`Verified` / `Needs Review`) | `review-status.tsx` — kept distinct from metadata Accepted |

Selection and export semantics were not rebuilt.

---

## B. Files modified

### Created
| File | Role |
|---|---|
| `frontend/lib/document-families.ts` | Shared persisted family labels (avoids circular imports) |
| `docs/rc2-04-completion-report.md` | This report |

### Modified
| File | Change |
|---|---|
| `frontend/components/documents/document-workspace.tsx` | Compact header (filename, type, profile, processing/review); return URL; reprocess + notice; Export menu a11y; dense grids by default; “Staging Verified” readiness label |
| `frontend/components/documents/documents-home.tsx` | Open/Review navigate with `return=` preserving repository filters |
| `frontend/components/staging/staging-dataset-table.tsx` | Value search, Columns visibility menu, staging-status filter wording, denser toolbar |
| `frontend/components/staging/evidence-drawer.tsx` | Focus restoration on close |
| `frontend/src/app/globals.css` | Cell checkboxes visible on focus / focus-within (not hover-only) |
| Tests | `document-workspace.test.tsx`, `data-grid.test.tsx`, `documents-home.test.tsx` updated/extended |

---

## C. UI/UX changes

- Near-full-width `workspace-page` with tighter padding
- Compact header: document filename as title; type · profile · processing · review status row
- ← Documents preserves repository query via `?return=`
- Reprocess control with actionable status notice (skips when already processing)
- Contextual Export menu (Export All / Export Selected) with outside-click + Escape dismiss
- Dataset/tab navigation unchanged in structure; denser default grids
- Grid toolbar: search values, staging status filter, Columns visibility

---

## D. Grid and selection behavior

| Behavior | Status |
|---|---|
| Sticky headers | Existing — retained |
| Frozen identifier columns | Existing — retained; recalculates on visible columns |
| Dynamic business columns | From dataset / `grid_fields` — unchanged |
| Column visibility | **New** Columns menu; cannot hide last column |
| Column resizing | Existing ResizeHandle — retained |
| Column / value search | **New** in-grid search |
| Sorting / filtering | Existing + search |
| Cell / row / column selection + indeterminate | Existing — retained |
| Select visible / select all filtered results | Existing SelectionToolbar — retained |
| Selection across pagination / sort | Existing store by stable ids — retained |
| Dense rows | Default for document workspace DatasetBody |

Selection is not equated with verification or metadata acceptance.

---

## E. Source evidence behavior

- Evidence drawer / record drawer unchanged in data contract
- Only provenance-backed page/region/locator/excerpt/confidence shown
- Focus restored to the previously focused element when the evidence drawer closes
- Cell checkboxes remain keyboard-reachable (focus-visible)

---

## F. Export contract verification

- Export All and Export Selected wiring unchanged
- Selected export still sends selection manifests (ids + fields) to existing backend endpoints
- No backend export semantics changes in RC2-04
- Backend export / Oracle / RBAC regression suite was started; see §I for results when complete

---

## G. Accessibility checks

| Item | Status |
|---|---|
| Cell checkboxes visible on focus / focus-within | Done (CSS) |
| Accessible column visibility menu | `aria-haspopup` / menuitemcheckbox labels |
| Export menu Escape / outside dismiss | Done |
| Staging status filter wording | “Staging status:” visible; aria-label remains “Review status” for staging vocabulary |
| Readiness footer | “Staging Verified” (not Metadata Accepted) |
| Evidence drawer focus restore | Done |
| Screen-reader selection counts | Existing SelectionToolbar live text |

---

## H. Performance findings

- Pagination (default 25) retained; full-text datasets keep configurable page size
- Column visibility reduces horizontal work for wide XML/clause schemas
- Dense mode reduces row height for large FAR tables
- Document route cold compile can take ~30s under Turbopack cache compaction; subsequent `/documents` stays sub-second
- No new grid library; no full-document in-memory rewrite

---

## I. Test results

See **`docs/rc2-04-verification-gate.md`** for the final verification gate.

| Suite | Result |
|---|---|
| Focused RC2-04 (workspace + grid + selection + documents-home), `--maxWorkers=1` | **55 passed / 0 failed** |
| Full frontend Vitest under load | Timeouts dominate; one flaky tab assertion that passes in isolation |
| TypeScript `tsc --noEmit` | **Passed** (after restoring `DOCUMENT_FAMILY_LABELS`) |
| Backend export / Oracle / RBAC | **49 passed**, 0 failed |
| Browser Playwright gate | **Passed** (return URL, search, columns, keyboard select, evidence focus, export selected) |

---

## J. Browser / manual verification

| Check | Result |
|---|---|
| `GET /documents` | **200** (Next log) |
| `GET /documents/{id}` | **200** (Next log; cold ~30s once during cache compaction) |
| Client markers (`document-workspace`, return link, Reprocess) | Client-rendered — confirm in browser after hydration |
| Return URL | Open from Documents with filters → header link should be `/documents?…` |

**Manual checklist:** open a FAR / XML / invoice document; toggle Columns; search values; select cells across pages; Export Selected; open evidence Details; Reprocess when idle; use ← Documents and confirm filters restored.

---

## K. Known limitations

1. Virtualization not added — pagination + dense mode used instead.
2. Column visibility is session-local (resets when dataset columns change); not persisted to localStorage.
3. Date-range filters remain out of scope (repository Sort covers dates).
4. Metadata Accept/Edit/Reject writes deferred to RC2-05 by design.
5. Contended Vitest runs can exceed 5s timeouts; suite config uses 15s for documents-home describe.

---

## L. Scope deviations

| Deviation | Reason |
|---|---|
| No new data-grid library | Existing architecture met requirements |
| No backend export contract changes | No confirmed defect |
| Family labels moved to `lib/document-families.ts` | Prevent circular import (workspace ↔ documents-home) |
| Type label from `document_families` when present | Avoid duplicating profile display name as both Type and Profile |

**Out of scope confirmed untouched:** extraction algorithms, silent reclassification, metadata review writes, Oracle send semantics, homepage marketing brand.

---

## Stop

RC2-04 is ready for review. **Do not start RC2-03 until approved.**  
No commit, push, or deploy performed.
