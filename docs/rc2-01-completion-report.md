# RC2-01 Completion Report — Enterprise Application Shell & Design System

**Status:** Implemented locally — awaiting review before RC2-02  
**Date:** 2026-10-08  
**Baseline:** `docs/rc2-enterprise-workspace-assessment.md`  
**Commit/push/deploy:** Not performed

---

## 1. Files modified

### Created
| File | Role |
|---|---|
| `frontend/lib/workspace-nav.ts` | Workspace IA, marketing vs workspace path helpers, breadcrumbs, active matching |
| `frontend/components/layout/SidebarNavigation.tsx` | Collapsible / mobile-drawer sidebar |
| `frontend/components/layout/WorkspaceTopBar.tsx` | Compact workspace header (no mega-menu) |
| `frontend/components/layout/Breadcrumbs.tsx` | Route + document-context breadcrumbs |
| `frontend/components/layout/PageHeader.tsx` | Compact workspace page header |
| `frontend/components/layout/document-chrome-context.tsx` | Document title for breadcrumbs |
| `frontend/lib/__tests__/workspace-nav.test.ts` | Unit tests |
| `frontend/components/layout/__tests__/app-shell.test.tsx` | Marketing vs workspace shell |
| `frontend/components/layout/__tests__/sidebar-navigation.test.tsx` | Collapse / a11y / active |
| `frontend/components/layout/__tests__/breadcrumbs.test.tsx` | Document context crumbs |
| `docs/rc2-01-completion-report.md` | This report |

### Modified
| File | Change |
|---|---|
| `frontend/components/layout/AppShell.tsx` | Dual shell: marketing homepage vs workspace |
| `frontend/src/app/globals.css` | Semantic token aliases; workspace/sidebar styles; true `page-container-wide`; workspace full-width content |
| `frontend/components/documents/documents-home.tsx` | `PageHeader` + tighter workspace padding |
| `frontend/components/documents/document-workspace.tsx` | Publish document title to breadcrumbs |
| `frontend/src/app/documents/[documentId]/review/page.tsx` | Publish document title to breadcrumbs |

---

## 2. Components created or reused

| Created | Reused |
|---|---|
| `SidebarNavigation`, `WorkspaceTopBar`, `Breadcrumbs`, `PageHeader`, `DocumentChromeProvider` | `AppShell`, `DataomatixLogo`, `BackendStatusPill`, `GlobalHeader` + `AnnouncementBar` (marketing only), `GlobalSearch`, `StatusState`, existing btn/nav CSS |

No new npm dependencies.

---

## 3. Before / after UI (visual)

Automated screenshot capture was not available in this session. Verify locally at http://localhost:3000:

| Surface | Before | After |
|---|---|---|
| `/` | Announcement + mega-menu header | **Unchanged marketing shell** (intentional) |
| `/documents` and other app routes | Mega-menu header only; often 80rem content | Compact top bar + collapsible sidebar + breadcrumbs; near-full-width content |
| Document `/documents/[id]` | Filename in page body only | Breadcrumb: Workspace › Documents › {filename} |
| Review `/documents/[id]/review` | Same | Breadcrumb ends with Review; link back to workbook |

**How to capture screenshots for review:** open `/` and `/documents` side-by-side before/after refresh; toggle sidebar collapse; open a document to confirm breadcrumbs.

---

## 4. Routes tested

HTTP smoke (local Next.js): `/`, `/documents`, `/extraction/new` → **200**.

Preserved deep-link targets (nav hrefs unchanged):
- `/documents`, `/repository`, `/documents?family=*`, `/documents/[id]`, `/documents/[id]/review`
- `/extraction/new`, `/review-queue`, `/explorer`, `/ask`, `/clauses`, `/integrations`
- `/governance`, `/architecture`, `/audit-log`, `/activity`, `/risk`, `/settings`, `/api-keys`
- Hub pages `/platform`, `/intelligence`, `/review`

Browser back/forward: uses standard Next routing (no history API overrides).

---

## 5. Accessibility findings

| Item | Status |
|---|---|
| Focus-visible outline uses `--color-focus` | Done |
| Sidebar toggle `aria-expanded` / `aria-controls` | Done |
| Active nav `aria-current="page"` | Done |
| Collapsed icons keep accessible names (`sr-only` labels) | Done |
| Breadcrumb `nav` + `aria-current` on last crumb | Done |
| Mobile drawer backdrop dismiss + link closes drawer | Done |
| Keyboard: toggle and links are native buttons/anchors | Done |

**Residual:** Mega-menu remains on marketing home only (not duplicated in workspace). Hover-revealed staging cell checkboxes unchanged (out of RC2-01 scope). Full WCAG 2.2 AA audit deferred to RC2-08.

---

## 6. Test counts and failures

| Suite | Result |
|---|---|
| Frontend Vitest (full) | **38 files, 212 tests passed**, 0 failed |
| RC2-01 new tests | **13 passed** (workspace-nav, app-shell, sidebar, breadcrumbs) |
| Backend regression (`test_rbac_oracle_certification`, `test_export_consistency`, `test_selected_export`) | **49 passed**, 0 failed |
| `tsc --noEmit` | **Passed** |

Note: jsdom logs `Not implemented: navigation to another Document` during Next `Link` clicks; does not fail tests.

---

## 7. Known limitations

1. **Workbook** is not a permanent sidebar item — it is document-scoped via breadcrumbs (avoids a dead link with no `documentId`).
2. **Exports & Oracle** sidebar item points at existing `/integrations` (no new Exports route).
3. Some intelligence routes (`/analytics`, `/insights`, …) highlight **Governance** via match prefixes — acceptable grouping for RC2-01; can refine in RC2-07.
4. Hub pages may still render their own `PageHero` copy inside the workspace shell (full-width, not homepage redesign).
5. Sidebar collapse persistence uses `localStorage` key `da-sidebar-collapsed`.
6. Before/after screenshot image files were not generated automatically.

---

## 8. Deviations from approved scope

| Deviation | Reason |
|---|---|
| No permanent “Workbook” sidebar entry | Requires document context; breadcrumbs cover it |
| Marketing shell = homepage only (`/`) | Matches “preserve homepage brand”; architecture/gov pages use workspace shell |
| Did not migrate all slate-* pages to tokens | Out of RC2-01 “consolidate aliases”; full migration can continue incrementally |
| No Playwright E2E | Not in RC2-01; Vitest covers shell/nav/a11y-sensitive interactions |

**Out of scope confirmed untouched:** extraction algorithms, classification, staging selection/export logic, metadata review writes, Oracle backend, migrations, profiles, homepage redesign.

---

## Stop

RC2-01 is ready for review. **Do not start RC2-02 until approved.**
