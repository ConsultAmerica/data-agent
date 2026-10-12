# Data Agent RC2 — Enterprise Workspace Experience  
## Required First Response (A–L)

**Status:** Assessment approved; **RC2-01 implemented locally** — see `docs/rc2-01-completion-report.md`  
**Date:** 2026-10-08 (assessment); RC2-01 completed same day  
**Scope:** Assessment was read-only; RC2-01 implementation followed approval.  
**Live references:** [Frontend](https://data-agent-ca.vercel.app/) · [API](https://data-agent-backend-qbmc.onrender.com/) · [Architecture](https://data-agent-ca.vercel.app/architecture)  
**Source of truth:** repository code (not assumptions from live URLs alone)

---

## Executive verdict

Data Agent already has a **usable enterprise core**: staging workbook, profile adapters, dense grids with selection/export, metadata-field Accept/Edit/Reject, selective export by stable IDs, RBAC, and Oracle preview/send gates.

RC2 is **not a rebuild**. It is shell consistency, repository polish, staging flagship parity, honest dual-contract labeling, and ops/Oracle UI wiring.

| Package | Maturity | Primary blocker |
|---|---|---|
| RC2-01 Shell / design system | Partial | No sidebar; inconsistent max-widths |
| RC2-02 Documents repository | Strong base | Sort + bulk reprocess |
| RC2-03 Extraction workspace | Partial | Fixed 30/70; no user-resizable split |
| RC2-04 Staging workbook | Strong core | Column visibility, search, virtualization |
| RC2-05 Evidence & review | Split | Staging has no Accept/Edit/Reject writes |
| RC2-06 Export | Strong menus | Authoritative path clarity + menu unify |
| RC2-07 Governance / ops | Thin | Jobs UI + real Oracle preview in workspace |
| RC2-08 Certification | Backend-heavy | UI E2E / RC2 matrix |

**Dependencies:** `next`, `react`, `react-dom`, `lucide-react`, `react-dropzone` only. **No DataGrid library.** Prefer custom tables + existing primitives; do not introduce MUI/AG Grid/TanStack without an explicit approved dependency decision (virtualization may later justify `@tanstack/react-virtual` alone).

---

## A. Current UI/UX audit

### Strengths
- Document workspace and staging grids are already dense and selection-aware.
- Cell/row/column selection uses stable `document_id` / `dataset_id` / `record_id` / field IDs (`lib/table-selection.ts`).
- PDF review path (`/documents/[id]/review`) has Accept / Edit / Reject.
- Export Selected is server-validated (manifest of IDs → persisted values).
- Design tokens exist in `globals.css` (Sirion teal / purple identity).
- Recent local work: Data Agent logo, column resize hardening, TextBlock → resizable table, bullet glyph normalize.

### Defects / friction
1. **Shell inconsistency** — Hero + 80rem vs full-width workspace vs 1440px extraction bars; `.page-container-wide` is not wider than narrow.
2. **No collapsible sidebar** — Horizontal mega-menus only; RC2 IA (Overview / Documents / Workbook / …) not reflected as primary nav.
3. **No app-wide breadcrumbs** — Only upload `WorkflowBreadcrumb`.
4. **Dual status vocabulary** — Staging `Verified/Needs Review/Missing` ≠ metadata `pending/accepted/edited/rejected`. Easy to mislabel “review” and “export authoritative.”
5. **Oracle UI simulated** on Integrations; `getOraclePayloadPreview` client unused by document workspace.
6. **Token drift** — Older surfaces still use Tailwind `slate-*` / `blue-*`.
7. **Grid parity uneven** — FAR / invoice / documents list lag the shared staging toolkit (visibility, search, sort).

### Accessibility (baseline)
- Strengths: focus-visible rings, many `aria-label`s / `aria-sort`, reduced-motion CSS.
- Risks: hover-revealed cell checkboxes; export menus inconsistent; no systematic WCAG 2.2 AA pass yet.

---

## B. Existing route / component inventory

### Routes (primary)
| Path | Role |
|---|---|
| `/` | Marketing home (preserve brand) |
| `/documents`, `/repository` | Repository (`DocumentsHome`) |
| `/documents/[documentId]` | Staging / presentation workbook |
| `/documents/[documentId]/review` | PDF + field review |
| `/extraction/new` | Upload + extract |
| `/review-queue`, `/explorer`, `/ask`, `/search` | Review / intelligence |
| `/clauses`, `/relationships`, `/insights`, `/analytics` | Specialized intelligence |
| `/integrations`, `/architecture`, `/audit-log`, `/activity`, `/settings/*`, `/api-keys` | Governance / ops |
| Hub pages `/platform`, `/intelligence`, `/review`, `/governance` | Mega-menu landings |

### Navigation IA today (`nav-config.ts`)
Top menus: **Documents · Platform · Intelligence · Review · Governance** (mega-menu tiles).  
RC2 recommended IA (Overview, Documents, Extraction, Workbook, Review Queue, Explorer, Exports, Governance, Settings) must be **mapped onto existing routes**, not replace them by deletion.

### Component families
| Domain | Key paths |
|---|---|
| Shell | `layout/AppShell.tsx`, `PageHero.tsx`, `ContentSection.tsx`, `StatusState.tsx` |
| Nav | `navigation/GlobalHeader.tsx`, `MegaMenu.tsx`, `MobileNavigation.tsx`, `nav-config.ts` |
| Documents | `documents/documents-home.tsx`, `document-workspace.tsx` |
| Staging | `staging-dataset-table.tsx`, `presentation-workspace.tsx`, `far-records-view.tsx`, `selection-toolbar.tsx`, `evidence-drawer.tsx`, `resize-handle.tsx`, `sortable-header.tsx` |
| Extraction | `extraction/*`, `document-uploader.tsx` |
| Review | `review-field-list.tsx`, `extraction/fields-table.tsx` |
| Export | Workspace Export menu, `export-menu.tsx`, `lib/staging-workbook.ts`, `lib/reviewed-export.ts` |

---

## C. Reusable components and dependencies

### Reuse (do not rebuild)
- `AppShell`, `PageHero`, `ContentSection`, `StatusState`
- Staging grid stack: `staging-dataset-table`, `ResizeHandle`, `SortableHeader`, `SelectCheckbox`, `SelectionToolbar`, `useTableSelection`
- Evidence: `evidence-drawer`, `staging-record-drawer`, `PdfPageViewer`, `source-verification-*`
- Review actions: `ReviewFieldList`, extraction `fields-table`
- Documents: search/filter/delete patterns in `documents-home`
- Tokens / buttons / chips in `globals.css`

### Dependencies policy
- **Keep:** Next/React/lucide/dropzone/Tailwind.
- **Avoid:** Second component framework, AG Grid, MUI.
- **Optional later (RC2-04, approved separately):** `@tanstack/react-virtual` for large FAR sets only if pagination proves insufficient.

---

## D. Gap analysis against RC2

### RC2-01 Design system & shell
| Requirement | Status |
|---|---|
| ~95–98% content width for data screens | Partial (docs/staging yes; many pages 80rem) |
| Collapsible sidebar | **Missing** |
| Compact top header | Partial (exists; competes with mega-menu) |
| Breadcrumbs | **Missing** (workflow only) |
| Semantic tokens | Mostly present; need consolidation + elevated/focus aliases |
| Shared component kit | Partial; names differ |

### RC2-02 Documents repository
| Requirement | Status |
|---|---|
| Full-width table + search + filters | Present |
| Sort by upload/update | **Missing** |
| Bulk delete | Present |
| Bulk reprocess | **Missing** |
| Classification labels from persisted profile | Present via family/profile helpers |
| Suggested columns (Records, Uploaded, Review Status) | Partial |

### RC2-03 Extraction workspace
| Requirement | Status |
|---|---|
| 30/70 desktop layout | Present (CSS fractions) |
| User-resizable panels | **Missing** |
| Classification trust / no silent reclass | Needs explicit UX + guardrails |
| Clear progress / retry | Partial |

### RC2-04 Staging workbook
| Requirement | Status |
|---|---|
| Dense grid, sticky, freeze, resize, sort, selection, export selected | **Strong** on shared grid |
| Column visibility | **Missing** |
| Free-text search on main grid | **Missing** |
| Virtualization | **Missing** (pagination only) |
| Profile-specific schemas | Present via adapters |
| Evidence drawer | Present (inspect-focused) |

### RC2-05 Source evidence & review
| Requirement | Status |
|---|---|
| Split PDF + fields with Accept/Edit/Reject | Present on `/review` |
| Same on Staging Data tab | **Missing** writes |
| Machine vs effective value clarity | Partial; dual vocabulary confusion |

### RC2-06 Export
| Requirement | Status |
|---|---|
| Export All / Selected Excel·CSV·JSON | Present in document workspace |
| Selection = IDs only; server resolves values | Present |
| Authoritative-only path | Backend yes; UI affordance weak |
| Unified export dialog / menu styling | Split (workspace vs slate `export-menu`) |

### RC2-07 Governance / ops
| Requirement | Status |
|---|---|
| Job status / retry UI | Thin (embedded in extract/reprocess) |
| Real Oracle preview in workspace | **Missing** (API exists) |
| Role-aware controls | Partial |

### RC2-08 Testing
| Requirement | Status |
|---|---|
| Backend cert suites | Strong |
| Frontend Vitest unit/component | Moderate (~34 files) |
| Playwright/Cypress E2E | **Missing** |
| WCAG 2.2 AA systematic | **Not done** |

---

## E. Proposed design tokens

Start from existing Sirion identity. Consolidate aliases; do not invent a new brand.

| Semantic token | Maps to (today) | Notes |
|---|---|---|
| `--color-page` | `--background` / `--bg-main` `#eef3f4` | Page background |
| `--color-surface` | `--surface` `#ffffff` | Cards / tables |
| `--color-surface-elevated` | `--surface` + `--shadow-elevated` | Drawers / menus |
| `--color-border` | `--border` `#c8dadc` | |
| `--color-primary` | `--primary` / `--sirion-teal` `#0d5b61` | |
| `--color-text` | `--foreground` `#071d26` | |
| `--color-text-secondary` | `--text-secondary` | |
| `--color-text-muted` | `--text-muted` | |
| `--color-success` | `--success` | |
| `--color-warning` | `--warning` | |
| `--color-error` | `--danger` / `--error` | |
| `--color-focus` | `--accent-lavender` (existing focus ring) | Focus ring |
| `--color-cell-selected` | `--selection-tint` + `--selection-edge` | |
| `--color-row-hover` | `--row-hover` | |
| `--color-review-needs` | warning family | Review state chips |
| `--color-review-verified` | success family | Staging QA (label distinctly from Accepted) |
| `--radius-card` / `--radius-button` | keep `18px` / `10px` | |
| `--space-*` | document Tailwind scale in RC2-01 | 4/8/12/16/24/32 |

**RC2-01 rule:** data workspaces use `.content-section-wide` (or successor `--layout-workspace` with ~2–4% side padding). Marketing home keeps current hero brand (non-negotiable #9).

---

## F. Work-package implementation order

| Order | Package | Why this order |
|---|---|---|
| 1 | **RC2-01** | Shell + tokens unlock consistent width/nav for all later UI |
| 2 | **RC2-02** | Repository is the entry point; uses new shell |
| 3 | **RC2-04** | Flagship workbook; already strong — close visibility/search/parity |
| 4 | **RC2-03** | Extraction polish without pipeline changes |
| 5 | **RC2-05** | Requires dual-contract decision (Option A recommended) |
| 6 | **RC2-06** | Unify export UX on top of staging + authoritative APIs |
| 7 | **RC2-07** | Jobs + real Oracle preview once export/review paths are clear |
| 8 | **RC2-08** | Continuous tests each package; certification gate at end |

Each package: inspect → propose files → smallest cohesive change → tests → stop for review.  
**No commit/push/deploy without approval.**

---

## G. Backend API changes actually required

| Need | Action |
|---|---|
| List / search / status-counts | **None** — exists |
| Single + bulk delete | **None** — exists + ownership |
| Per-doc reprocess (`jobs/process`) | **None** — exists |
| Bulk reprocess | **Optional new** thin batch (or careful N× `jobs/process`) |
| Staging read + selection export | **None** — exists |
| Authoritative export + Oracle preview/send | **None** — exists; UI must wire |
| Metadata Accept/Edit/Reject | **None** — exists |
| Staging → metadata review bridge | **Enhance only if** RC2-05 writes from staging (reuse review endpoints) |
| Schema migration | **None under Option A** |

---

## H. Data migration requirements

**None for Option A (recommended).**

- Staging workbook remains a read-time view + profile pin.
- Human authority remains on `DocumentMetadataField` (`value`, `evidence_json.machine_value`, `review_status`).
- Migration only if Option B (dual-write domain tables) is approved later — out of RC2-01…04 scope.

### Dual-contract decision (needed before RC2-05)

| Option | Recommendation |
|---|---|
| **A. Bridge** — Staging presents; Accept/Edit/Reject writes metadata by `canonical_field` | **Prefer for RC2** |
| B. Dual-write into domain entities | Higher risk; post-RC2 RFC |
| C. Explicit dual UX forever | Fails “one authoritative model” unless exports strictly gated |

---

## I. Risks and regression impact

| Risk | Impact | Mitigation |
|---|---|---|
| Conflating staging Export with authoritative/Oracle | High — wrong values leave the system | Label menus; keep Oracle on `reviewed_export` only |
| Sidebar IA breaks deep links | High | Map tiles; keep redirects for `/repository`, hubs |
| Bulk reprocess floods review queue | Medium | Confirm dialog; respect `machine_value` locks |
| Introducing a grid library | Medium — pattern break | Stay custom; optional virtualizer only |
| Silent classification change mid-review | High | Guardrails in RC2-03 |
| Layout change on homepage brand | Policy violation | Home stays marketing shell |
| Production delete/smoke | High | No destructive prod tests without approval |

---

## J. Files expected to change (by package)

### RC2-01 (after approval)
- `frontend/components/layout/AppShell.tsx`
- New: `SidebarNavigation` (or equiv.), `TopBar`, `Breadcrumbs`, `PageHeader` refinements
- `frontend/components/navigation/GlobalHeader.tsx`, `nav-config.ts`, `MobileNavigation.tsx`
- `frontend/components/layout/ContentSection.tsx`
- `frontend/src/app/globals.css` (tokens + workspace width)
- Migrate slate consumers incrementally (`export-menu.tsx`, etc.)
- **Do not** change homepage hero brand identity

### Later packages (preview)
- RC2-02: `documents-home.tsx`, `lib/documents.ts`, tests  
- RC2-04: `staging-dataset-table.tsx`, `presentation-workspace.tsx`, FAR/invoice views, column-visibility module  
- RC2-03: `extraction/new/page.tsx`, results workspace, splitter  
- RC2-05: `evidence-drawer.tsx`, staging review bridge, review page splitter  
- RC2-06: `document-workspace.tsx`, `selection-toolbar.tsx`, merge `export-menu.tsx`  
- RC2-07: jobs UI, `integrations/page.tsx`, wire `lib/reviewed-export.ts`  
- RC2-08: Vitest expansions; optional Playwright; update `documentation/RELEASE_CANDIDATE.md`

---

## K. Test strategy

### Per package
1. Unit/component Vitest for new behaviors (nav collapse, sort, selection indeterminate, column visibility persistence).
2. Existing backend cert suites must remain green (`test_rbac_oracle_certification`, `test_export_*`, `test_governance_*`, selection export).
3. Manual fixture pass: FAR 52/51, Final Rule, clause XML, contract, native + OCR invoice, transcript.

### RC2-08 certification gate
- [ ] Frontend Vitest green  
- [ ] Backend cert green  
- [ ] Export field-by-field vs staging/authoritative as applicable  
- [ ] RBAC denied paths  
- [ ] Keyboard / focus / checkbox naming sample  
- [ ] Performance notes with **measured** baselines (no invented claims)  
- [ ] Production smoke only with approval  

### Accessibility
Target WCAG 2.2 AA; triage blockers before RC2 ready tag. Prefer axe + keyboard scripts over claims.

---

## L. Acceptance checklist (program-level)

- [ ] Consistent workspace shell (~95–98% width) on Documents, Document, Review Queue, Explorer  
- [ ] Sidebar + breadcrumbs without breaking deep links  
- [ ] Documents: sort, filters stable, bulk delete permissioned, optional bulk reprocess  
- [ ] Extraction: clear type/profile; no misleading Invoice-on-FAR-XML; resizable panels  
- [ ] Staging: visibility + search; selection ≠ review; Export Selected sparse-correct  
- [ ] Review: machine vs effective distinct; corrections persist; audit append-only  
- [ ] Oracle: preview + confirm + RBAC; never one-click send  
- [ ] Profiles preserved; no fabricated evidence  
- [ ] Homepage brand preserved  
- [ ] No commit/push/deploy without approval  
- [ ] RC2-08 gates closed before “RC2 ready”

---

## Proposed RC2-01 scope (for approval)

Implement **only after explicit approval**:

1. Introduce **Marketing shell** (home) vs **Workspace shell** (data routes).  
2. Add **collapsible sidebar** mapped from existing routes (preserve mega-menu or demote to secondary — propose keep compact top actions).  
3. Add **breadcrumbs** on document/extraction/review routes.  
4. Consolidate semantic token aliases; fix false “wide” container; lift unnecessary 80rem/1440 caps on data screens.  
5. Shared `PageHeader` / empty-error-loading consistency via existing `StatusState`.  
6. Keyboard-operable sidebar + focus indicators.  
7. Vitest for shell collapse + landmark roles.  

**Out of RC2-01:** repository sort/bulk reprocess, staging column visibility, review writes, Oracle UI, homepage redesign.

---

## Stop for review

Please approve or amend:

1. This A–L assessment  
2. Dual-contract **Option A** for later RC2-05  
3. Work-package order in §F  
4. **RC2-01 scope** above  

No code will be changed for RC2 until you approve RC2-01.
