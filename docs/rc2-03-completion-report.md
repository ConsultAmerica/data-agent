# RC2-03 Completion Report — Extraction Workspace

**Status:** Implemented locally — awaiting review before RC2-05  
**Date:** 2026-10-08  
**Baseline:** RC2-04 Staging Workbook (accepted for continued local work) · RC2-02 · RC2-01  
**Commit/push/deploy:** Not performed

---

## A. Reused components

| Capability | Source |
|---|---|
| Upload / warm-up / duplicates / portfolio | `DocumentUploader`, `ImportSourceTabs`, `lib/upload`, `lib/backend-warmup` |
| Process + extract jobs | `processDocumentViaJob`, `extractTargetsViaJob`, backend `jobs.py` / `extraction_job_runner` |
| Schema discovery API + picker | `discoverSchema` / `getTargets`, `AnalysisRequest`, `TargetPicker`, `SuggestedExtraction` |
| Staging profile resolution | `getStagingProfile`, persisted `document_families` / profile display names |
| Live progress + details drawer | `ExtractionLiveProgress`, `DocumentStatusSummary`, `ProcessingDetailsDrawer` |
| Results surfaces | `TargetResults`, `UniversalResults`, `ExtractionResultsWorkspace` |
| Shell / tokens | RC2-01 `ContentSection`, `PageHero`, workspace CSS tokens |
| Family vocabulary | `lib/document-families.ts` (`FAMILY_LABELS`) |

No extraction algorithms, profile resolvers, review contracts, exports, or Oracle/RBAC paths were rewritten.

---

## B. Files changed

### Created
| File | Role |
|---|---|
| `frontend/lib/extraction-workflow.ts` | Product steps, classification display, actionable errors, file-type helper |
| `frontend/lib/__tests__/extraction-workflow.test.ts` | Unit coverage for steps / classification / errors |
| `frontend/components/__tests__/document-overview.test.tsx` | Overview + unresolved classification |
| `frontend/components/__tests__/analysis-request-rc2.test.tsx` | Schema panel, search, select-all, duplicate-submit |
| `frontend/components/__tests__/workflow-breadcrumb.test.tsx` | Six-step breadcrumb |
| `docs/rc2-03-completion-report.md` | This report |

### Modified
| File | Change |
|---|---|
| `frontend/src/app/extraction/new/page.tsx` | Compact header when loaded; 30/70 split; classification wiring; workflow step; actionable errors; duplicate-submit guards; empty-state 6-step copy |
| `frontend/components/document-overview.tsx` | Filename, type, size, family, profile, status, source preview; no fabricated confidence |
| `frontend/components/workflow-breadcrumb.tsx` | Upload → Understand → Discover Schema → Extract → Validate → Prepare Staging |
| `frontend/components/extraction-live-progress.tsx` | Product-step labels; `aria-live` status region |
| `frontend/components/analysis-request.tsx` | Profile-specific headings; unresolved classification; extract a11y; clear selection |
| `frontend/components/extraction/target-picker.tsx` | Search label; checkbox roles; Clear selection / Select all toolbar |
| `frontend/lib/document-families.ts` | `xml_data` → **FAR Clause XML** |
| `frontend/lib/workspace-nav.ts` | Same family label |
| `frontend/components/documents/documents-home.tsx` | Profile filter label aligned to FAR Clause XML |
| `frontend/src/app/globals.css` | Extraction split stacking + reduced-motion |

---

## C. UI/UX improvements

- Full-width extraction workspace retained; desktop **~30% Document Overview / ~70% Schema & Extraction** (`extraction-split`)
- Compact page header (filename + Open workspace) once a document is loaded; marketing hero only on empty upload
- Empty state lists the full product workflow (six steps)
- Overview shows business facts only (no parser/OCR internals in the primary card)
- Schema panel retitled **Schema & Extraction** with family-specific subtitles (XML / FAR / invoice / transcript / contract)
- Clearer primary extract CTA; clear selection control next to it

---

## D. Classification behavior

- Prefer **persisted staging profile** (`getStagingProfile` → `document_families` + `display_name`) over discovery hints
- Discovery family/confidence shown only when no persisted resolution and backend provided values
- **Never** inferred from filename alone
- Explicit **Classification unresolved** when unknown / missing
- Presented profiles (FAR / XML with views) still short-circuit the field picker and deep-link to the document workspace — profile is not silently swapped in the UI
- Canonical labels: FAR Regulation · FAR Final Rule · FAR Clause XML · Government Contract · Invoice · Academic Transcript · Generic Document

---

## E. Schema discovery behavior

- Search, Select all (visible), Clear selection retained and labeled for a11y
- Group headings via existing `groupTargets` / suggestion groups
- Profile-specific panel copy avoids implying generic invoice fields for regulatory XML
- Empty / discovery-error / processing skeleton states with Retry on discovery failure
- Required/optional indicators unchanged (only where backend already supports them)

---

## F. Processing and error states

| Topic | Behavior |
|---|---|
| Step progression | Breadcrumb + live progress map confirmed backend stages only |
| Percentages | Still only when job/progress APIs provide them — not invented |
| Duplicate submit | `processInFlightRef` / `extractInFlightRef` + disabled Extract while busy |
| Retry | Actionable retry for timeout / backend / extraction failures; replace document always offered |
| Error kinds | Unsupported file, upload failure, timeout, extraction failure, missing source, backend unavailable, permission denied |

---

## G. Accessibility

- Workflow breadcrumb uses ordered list + `aria-current="step"`
- Live progress and schema discovering regions: `role="status"` / `aria-live="polite"` / `aria-busy`
- Schema field toggles: `role="checkbox"` + `aria-checked` + `aria-label`
- Search input labeled; selection toolbar labeled; extract errors `role="alert"`
- Workflow errors announced via `role="alert"`
- Responsive: split stacks to one column under 1024px; reduced-motion disables pulse/fade in the workspace

---

## H. Test results

| Suite | Result |
|---|---|
| Focused RC2-03 (workflow, overview, breadcrumb, analysis-request, target-picker) | **17/17 passed** |
| Related frontend (workspace-nav, documents-home, `components/extraction/__tests__`) | **58/58 passed** |
| TypeScript `tsc --noEmit` | **Passed** |
| Backend `test_document_isolation` / `test_dynamic_schema_picker` | **Not run** — local shell missing `pdfplumber` (`ModuleNotFoundError` in conftest). No backend code changed for RC2-03. |
| Export / RBAC | **Not affected** — no API or export path changes |

---

## I. Browser verification

Not run in this package (no commit/deploy; local Vitest + tsc only). Recommend manual check on `/extraction/new`:

1. Upload XML clause file → Overview shows FAR Clause XML / XML Document when profile resolves  
2. Confirm sort of workflow steps while processing  
3. Schema search / select all / extract once (second click disabled)  
4. Force error (stop backend) → actionable message + Retry  
5. Narrow viewport → stacked panels, no clipped CTA  

---

## J. Known limitations

- Panels are fixed ~30/70 fractions (not user-draggable splitter) — assessment noted resizable split as nice-to-have; CSS fractions meet the mission’s approximate layout
- Presented-profile documents skip the field picker by design (open workspace CTA)
- Backend regression not executed in this environment due to missing Python dependency
- Full frontend suite / RC2 release stability remains an open release issue (per RC2-04 acceptance note)
- Confidence % shown only for schema-discovery source when the API returns it — never fabricated

---

## K. Contract preservation

| Contract | Status |
|---|---|
| Upload route `/extraction/new` | Preserved |
| `?documentId=` / `?focus=` reopen | Preserved |
| Document workspace deep links | Preserved |
| Process / extract job APIs | Unchanged |
| Staging profiles / prepare_staging | Unchanged (UI only maps stage names) |
| Review / export / Oracle / RBAC | Untouched |
| Dual review vocabulary | Untouched (RC2-05) |

---

## L. Recommendation for RC2-05

Proceed to **RC2-05 Evidence & review** after accepting RC2-03:

1. Bridge staging evidence drawer with Accept / Edit / Reject (or Option A dual-contract labeling from the assessment)
2. Keep staging `Verified / Needs Review` distinct from metadata `accepted / edited / rejected`
3. Reuse Overview → workspace deep links added here for “open evidence in context”
4. Do not expand extraction progress into review writes

**Stop for review.** No commit, push, or deploy performed.
