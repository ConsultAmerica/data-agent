# Data Agent — Enterprise Workspace Transformation  
## Phase 1: Audit, Design Foundation & Implementation Backlog

**Status:** Assessment complete — awaiting approval before Phase 2  
**Date:** 2026-10-08  
**Scope:** Read-only inspection. No application code changed.

---

## 1. Executive summary

Data Agent already has strong foundations for an enterprise Document Intelligence Workspace: a persisted staging workbook pin, profile adapters (contract, FAR, invoice, academic, generic, XML), dense data grids with resize/sort/selection/export, human review on metadata fields, selective export, and RBAC-gated Oracle preview/send.

The product does **not** yet feel like one cohesive workspace. The highest-leverage gaps are:

1. **Dual value contracts** — Staging cells use QA status (`Verified` / `Needs Review` / `Missing`); human authority (`accepted` / `edited` / `rejected`) lives on `DocumentMetadataField`. UI, Excel, CSV, JSON, and Oracle can diverge.
2. **Inconsistent page shells** — Hero + 80rem content vs full-width document workspace vs ad-hoc `max-w-*`.
3. **Grid toolkit parity** — Shared staging grid is strong; FAR, invoice, documents list, and especially **full-text / resume-like TextBlocks** lack resize, sort, or proper glyph handling.
4. **Observed defect (user screenshot)** — Private-use / Wingdings-style bullet characters render as empty boxes (`□` / `☒`) in presentation `TextBlock` lines; there is no row/column resize on that surface.

**Recommendation:** Approve Phase 1; start Phase 2 with shell unification + token hygiene, then Phase 3 with full-text/bullet fidelity and grid parity (including resize on all tabular surfaces). **Do not deepen staging Accept/Edit/Reject until the dual-contract decision is approved** (see §7).

---

## 2. Route and workflow map

### Intended happy path

```
Documents → Extraction → Staging Workbook → Source Verification → Review → Export → Oracle
```

### Current routes

| Path | Purpose | Shell | Notes |
|---|---|---|---|
| `/` | Marketing home | PageHero + ContentSection | Preserve branding (principle 8) |
| `/documents`, `/repository` | Document repository | Full-width, no hero | Duplicate routes, same `DocumentsHome` |
| `/documents/[id]` | Staging / presentation workspace | Full-width tabs | Primary business surface |
| `/documents/[id]/review` | PDF + field review split | Two-column | Accept/Edit/Reject here |
| `/extraction/new` | Upload + extract | PageHero + wide ContentSection | |
| `/review-queue` | Cross-doc review | PageHero + 80rem | Accept All; deep links |
| `/explorer` | Field explorer | PageHero + 80rem | |
| `/integrations` | Oracle / workflows | PageHero | **Simulated** dry-run UI |
| `/activity`, `/audit-log` | Ops / audit | Mixed | |
| Hub pages (`/platform`, `/intelligence`, …) | Mega-menu hubs | PageHero compact | |
| `/ask`, `/search`, … | Secondary | Ad-hoc max-width | Inconsistent shells |

### Shell patterns in conflict

1. `PageHero` + `.content-section` (`max-width: 80rem`)
2. Document / staging full-width workspace
3. Legacy `.page-container` / `.page-container-wide` (**same** 80rem — “wide” is a misnomer)
4. Extraction bars capped at `1440px`

---

## 3. Component inventory

### Layout / navigation
- `frontend/components/layout/AppShell.tsx`, `PageHero.tsx`, `ContentSection.tsx`, `StatusState.tsx`
- `frontend/components/navigation/*`, `nav-config.ts`
- Legacy: `page-header.tsx`, unused `coming-soon-page.tsx`

### Staging / grids
- `document-workspace.tsx` — document shell, tabs, export
- `presentation-workspace.tsx` — business Data view (lists, **TextBlock**, composed grids)
- `staging-dataset-table.tsx` — shared dense grid (resize, sort, freeze, selection, pagination, status filter)
- `far-records-view.tsx`, `far-workbook.tsx`, `invoice-workbook.tsx`, `transcript-workbook.tsx`
- `resize-handle.tsx`, `sortable-header.tsx`, `selection-toolbar.tsx`, `select-checkbox.tsx`
- `evidence-drawer.tsx`, `staging-record-drawer.tsx`
- Libs: `lib/data-grid.ts`, `table-selection.ts`, `table-sort.ts`, `staging-workbook.ts`, `far-records.ts`

### Extraction
- `frontend/components/extraction/*` — fields table (Accept/Edit/Reject), `table-result.tsx` (resize+sort), drawers

### Documents
- `documents-home.tsx` — search, filters, bulk delete, per-row reprocess/export

### Review / evidence
- `review-field-list.tsx`, review-queue page, source verification panels

### Export / Oracle
- Workspace Export + `SelectionToolbar`
- Older `export-menu.tsx` (slate styling)
- `lib/reviewed-export.ts` — `getOraclePayloadPreview` **client exists, unused by pages**
- Integrations page: simulated Oracle payload

---

## 4. Design token specification (current)

Source: `frontend/src/app/globals.css`

### Color

| Token | Value | Role |
|---|---|---|
| `--sirion-bg-deep` / `--text-dark` / `--foreground` | `#071d26` | Primary text / deep brand |
| `--sirion-teal` / `--primary` | `#0d5b61` | Primary actions |
| `--sirion-teal-dark` | `#07383d` | Deep teal |
| `--text-teal` | `#08616b` | Teal emphasis text |
| `--accent-purple` / `--accent` | `#a33eb2` | Accent |
| `--background` / `--bg-main` | `#eef3f4` | App background |
| `--surface` | `#ffffff` | Cards / tables |
| `--surface-soft` / `--bg-soft` | `#f2f7f7` / `#e6eff0` | Soft fills |
| `--border` | `#c8dadc` | Borders |
| `--text-secondary` | `#3d5a60` | Secondary text |
| `--text-muted` | `#6b8489` | Muted |
| `--success` / `--warning` / `--danger` | `#29976a` / `#c58b27` / `#d44e4e` | Status |
| `--selection-tint` / `--selection-edge` | teal rgba | Cell selection |

### Shape / elevation / type

| Token | Value |
|---|---|
| `--radius-card` | `18px` |
| `--radius-button` | `10px` |
| `--shadow-soft` / `--shadow-elevated` | soft teal-tinted |
| Fonts | Geist Sans / Mono via `--font-geist-*` |

### Layout classes to standardize (Phase 2)

| Class | Today | Target direction |
|---|---|---|
| `.content-section` | `max-width: 80rem` | Keep for marketing / light pages |
| `.content-section-wide` | `max-width: none` | Default for data workspaces |
| `.page-container-wide` | Same as narrow (bug) | Either real wider width or remove alias |
| `.extraction-*-inner` | `1440px` | Lift cap in data mode |

### Token debt
Many older components still hardcode Tailwind `slate-*` / `blue-*` (export menu, some extraction/clause UIs). Phase 2 should migrate these to CSS variables without changing homepage brand.

---

## 5. Backend / data-model findings

### Two parallel contracts

| Surface | Status vocabulary | Persistence | Used for |
|---|---|---|---|
| Staging workbook cells | `Verified` / `Needs Review` / `Missing` | Read-time view over profile domain tables + pin | Presentation, selective staging export |
| `DocumentMetadataField` | `pending` / `accepted` / `edited` / `rejected` | Persisted; `machine_value` protected on re-extract | Human review, authoritative export, Oracle |

Workbook content is **not** a JSON blob: `DocumentStagingWorkbook` pins `profile_id` / family; content is assembled at read time (`backend/app/staging/service.py`).

### Profiles preserved (do not break)

`contract_v3`, `invoice`, `far_part_52`, `far_regulatory_change`, `academic_transcript`, `generic_business_document` (+ v1), `xml_document` — via `backend/app/staging/registry.py`.

### Must not break
- Profile pin rows and adapters  
- `machine_value` / human lock on metadata fields  
- Append-only audit logs  
- Oracle `preview` vs `send` + `confirm:true`  
- Selective export manifest (ids only; values from staging assembly)  
- Staging QA vocabulary without an explicit migration  

---

## 6. Exists vs mission gaps (Phases 2–7)

| Capability | Status | Primary gap |
|---|---|---|
| Full-width dense grid | Partial | Strong on staging-dataset-table; weak on TextBlock / FAR / invoice |
| Column resize | Partial | Missing FAR, invoice, documents list; TextBlock is not a grid |
| Row height resize | Partial | Same parity issue |
| Column visibility | **Missing** | No picker / persistence |
| Sort | Partial | Staging + table-result yes; FAR / docs list no |
| Selection + Export Selected | Present | Staging / presentation / FAR |
| Free-text search on main grid | Weak | Status filter only on `staging-dataset-table` |
| Evidence drawer | Present | Staging is inspect-heavy; Accept/Edit/Reject on PDF review path |
| Repository bulk delete | Present | Bulk **reprocess** missing |
| Real Oracle UI | **Missing** | Client helper unused; Integrations is simulation |
| One authoritative export path | **Risk** | Staging vs reviewed_export vs V3 |

---

## 7. Design decision required before Phase 5–6 deepen

**Question:** What is the single authoritative human-edited value for business cells shown in the Staging Workbook?

**Options (do not implement until chosen):**

| Option | Pros | Cons |
|---|---|---|
| **A. Bridge:** Staging remains presentation; Accept/Edit/Reject writes to `DocumentMetadataField` keyed by `canonical_field` | Least breakage; Oracle path already works | Mapping staging cells ↔ metadata keys can be incomplete for FAR/invoice lines |
| **B. Dual-write into domain tables** with `machine_value`/`value` on staged entities | True single model for grids | Larger migration; high production-data risk |
| **C. Explicit dual UX** — label staging QA vs human review clearly; Oracle only from metadata | Honest about current architecture | Fails principle 1/5 unless exports are strictly gated |

**Phase 1 recommendation:** Prefer **A** for near-term UI work; schedule a dedicated data-model RFC before claiming “one persisted model.”

---

## 8. Observed defect — bullets & non-grid text (user screenshot)

**Symptom:** Resume / skills-style extracted text shows empty square glyphs between lines instead of bullets; layout is a plain vertical text dump with no resize controls.

**Likely surface:** `TextBlock` in `frontend/components/staging/presentation-workspace.tsx` — splits `formatCellValue` on `\n` and renders each line as `<p>` with **no** glyph normalization and **no** row/column resize.

**Also related:** `staging-dataset-table.tsx` collapses whitespace (`replace(/\s+/g, " ")`) then truncates — harmful for `full_text` / multi-line content.

**Phase 3 backlog items (not implemented in Phase 1):**
1. Normalize PUA / Wingdings / checkbox-like bullets → `•` (or structured list markup) before render  
2. Preserve newlines for full-text / TextBlock surfaces  
3. Provide resize (and where tabular, sort) on **all** output tables; for long text blocks, at least controllable block height / width  

---

## 9. Prioritized implementation backlog

### P0 — Trust & dense UX (start after Phase 1 approval)

| ID | Item | Phase | Touchpoints |
|---|---|---|---|
| P0-1 | Normalize bullet/glyph + preserve multi-line full text | 3 | `presentation-workspace.tsx` TextBlock; staging full_text path |
| P0-2 | Unify document/repository workspace shell (full-width dense chrome) | 2 | `document-workspace.tsx`, `documents-home.tsx`, ContentSection |
| P0-3 | Wire real Oracle preview into document/export flow; label or replace simulation | 6 | `lib/reviewed-export.ts`, `integrations/page.tsx`, document workspace |
| P0-4 | Decide dual-contract bridge (Option A/B/C) before staging review writes | 5–6 | Design RFC; then API |
| P0-5 | Free-text search on `staging-dataset-table` | 3 | `staging-dataset-table.tsx` |

### P1 — Grid / repository / review parity

| ID | Item | Phase |
|---|---|---|
| P1-1 | Column visibility picker (+ local persistence) | 3 |
| P1-2 | FAR grid: ResizeHandle + SortableHeader | 3 |
| P1-3 | Invoice / lagging tables → shared grid primitives | 3 |
| P1-4 | Repository bulk reprocess | 4 |
| P1-5 | Optional staging + source split panel | 5 |
| P1-6 | Retire/restyle duplicate `export-menu.tsx` | 2–6 |
| P1-7 | Fix `.page-container-wide` alias | 2 |

### P2 — Consistency & certification

| ID | Item | Phase |
|---|---|---|
| P2-1 | Migrate slate/blue hardcodes → tokens | 2 |
| P2-2 | Sortable denser documents list | 4 |
| P2-3 | Demote pipeline/technical tabs for business users | 2–3 |
| P2-4 | Align Accept vs Verified language; consolidate review entry | 5 |
| P2-5 | A11y: selection checkboxes focus-within; export menus | 8 |
| P2-6 | Certification suite on FAR, XML, invoice, contract, transcript, scans | 8 |

---

## 10. Proposed Phase 2 scope (for approval)

Implement **only** after explicit approval:

1. Define two shells: **Marketing** (hero + 80rem) vs **Workspace** (full-width, compact title bar).  
2. Apply Workspace shell to Documents, Document detail, Review Queue (dense mode), Explorer.  
3. Fix `.page-container-wide`; document token usage rules.  
4. Begin token migration on export/review chrome only (no homepage brand change).  
5. No staging review write-path changes; no Oracle live send changes.

**Out of Phase 2:** bullet glyph fix (Phase 3 P0-1), column visibility, Oracle wiring (Phase 6).

---

## 11. Success criteria for Phase 1 (this document)

- [x] UI/UX audit  
- [x] Component inventory  
- [x] Design token specification  
- [x] Route and workflow map  
- [x] Backend/data-model risks vs 10 principles  
- [x] Prioritized backlog mapped to Phases 2–8  
- [x] User-reported bullet/resize issue captured as P0-1 / Phase 3  
- [x] No application code changed  

---

## 12. Stop for review

Please approve or amend:

1. Phase 1 findings (especially dual-contract Option A recommendation)  
2. Phase 2 scope in §10  
3. Whether P0-1 (bullet glyphs + TextBlock resize) may be pulled forward into an early Phase 3 spike immediately after Phase 2 shell work  

No commits, pushes, or deploys were made.
