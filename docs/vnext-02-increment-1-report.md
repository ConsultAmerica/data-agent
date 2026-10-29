# VNEXT-02 — Increment 1 Report: Oracle Template Manager and Exact-Header Export

**Status:** implemented and tested locally; **not committed, pushed or deployed**.
**Date:** 2026-10-28 · **Base:** `main` @ `bbd7210`
**Scope:** brief "Dataomatix — Increment 1" (template upload, dynamic mapping, smart suggestions, label views, exact-header CSV, validation, interface). Closes gap 1 of `docs/vnext-01-gap-report.md`.

---

## 1. What a user can do now

1. **Upload a template** in *Mapping Studio* (new sidebar entry). CSV, XLSX or XLSM files as downloaded from Oracle Import Management. Dataomatix:
   - stores the file byte for byte;
   - detects the technical attribute names, the display labels (when the template has a label row), the column order, the sheet and the import object;
   - versions templates per object; re-uploading identical bytes returns the stored template.
2. **Map a document** to a template in the three-panel *Mapping Designer*:
   - **Left:** the document, with the selected value highlighted on its page.
   - **Centre:** the extracted fields, with a switch between document labels, Dataomatix labels, Oracle display labels and Oracle technical names. Only the labels change, never the values.
   - **Right:** one row per template column, showing:
     - the Oracle display label and technical name;
     - a searchable source picker, or a constant;
     - the value, a format (as extracted, trim, upper case, date → YYYY-MM-DD, number), the match method and confidence, and a validation badge;
     - a key toggle.
3. **Smart suggestions** fill the mapping when no saved mapping exists. In order of precedence: previously approved mapping (95%), exact name (90%), Oracle label (85%), known synonym (75%), similar wording (≤ 70%). Every suggestion is marked *Review* until a person saves the mapping. Suggestions are deterministic. No AI model is called, and no value is ever invented.
4. **Save** the mapping. Each save is a new version, with history (who and when).
5. **Preview and validate**:
   - the first rows of the file, with technical-name headers, or display labels for preview only;
   - a validation list;
   - the extracted data that the file doesn't use, which stays in the staging workbook and its other exports.
6. **Export the CSV, or regenerate it after changes.** The file has:
   - the template's exact header strings, in its order;
   - one row per document, or one per record of a chosen table (e.g. Line Items);
   - UTF-8 without a byte-order mark, and text values as-is, so leading zeros are kept.

   The export is refused while validation finds errors, unless the user chooses to download anyway; the response then says it's not import-ready.
7. **Link and bundle files.** A child mapping (e.g. Contract Line) names its parent mapping; link columns are suggested by name (`HeaderExtKey → ExtKey`), and every child row must match a parent row. Several saved mappings export as one ZIP, each file named after its template (`Contract.csv`, `Contract_Line.csv`).

## 2. Rules the implementation keeps

- **Oracle names come only from uploaded templates.** No Oracle attribute name is hard-coded anywhere in the code. The header lists supplied with the brief were used only as **test templates**; they are not treated as verified Oracle metadata.
- **"Required" is applied only when the template marks it** (a `*` on the label). Otherwise the UI and the template detail say "required not marked" and no required check runs.
- **Lookup values are not checked.** The templates carry no lookup lists, and each preview says so.
- **No Oracle connection.** Files are generated for a person to load; live contract creation stays off.
- **Macro-enabled workbooks are read as data only.** openpyxl never runs macros.
- **Values come from the staging workbook as reviewed there.** Cells that still need review are flagged in validation.

## 3. Validation (before a file is import-ready)

| Check | Severity |
|---|---|
| Mapping names a column the template version doesn't have | error |
| Template-required column unmapped, or empty in a row | error |
| Format conversion failed (e.g. "Not to Exceed" as a number, an unreadable date): kept as printed, never guessed | error |
| Key column empty / duplicate key | error |
| Child row with no matching parent row | error |
| Value still needs review in Dataomatix | warning |
| Identical rows (no key columns set) | warning |
| Column not mapped (will be empty) | info |
| Lookup values not checked | info |

## 4. Changes

**Database** (migration `e5a7c9d1f3b6`, additive; verified up/down/up on SQLite; not run on Postgres):
- `oracle_templates`: original bytes, checksum, object, version, sheet, header rows, columns JSON, warnings, environment, status, owner workspace, uploader.
- `oracle_mapping_profiles`: template, staging profile, row table, mappings JSON (field references, never values), key columns, parent link, version, history, owner workspace.

**API:**

| Method | Path | Permission |
|---|---|---|
| POST | `/api/oracle/templates` | `admin.integrations` |
| GET | `/api/oracle/templates`, `/api/oracle/templates/{id}`, `/api/oracle/templates/{id}/original` | `documents.view` |
| POST | `/api/oracle/templates/{id}/retire` | `admin.integrations` |
| GET / POST | `/api/oracle/templates/{id}/profiles`; GET `/api/oracle/profiles` | view / `oracle.preview` |
| PUT | `/api/oracle/profiles/{id}` | `oracle.preview` |
| GET | `/api/documents/{id}/oracle/fields` | `oracle.preview` |
| POST | `/api/documents/{id}/oracle/templates/{tid}/suggest`, `/preview`, `/export` | `oracle.preview` |
| POST | `/api/documents/{id}/oracle/export-bundle` | `oracle.preview` |

Document routes use the existing per-document isolation. Templates and mappings are scoped to the owner workspace for anonymous workspace callers. Every export writes an `integration_audit_log` row (`action=export`, file checksum, row count, template version). CORS now exposes `X-Import-Ready`.

**Files**

- Backend (new):
  - `app/oracle_templates/parser.py`
  - `app/oracle_templates/mapping.py`
  - `app/api/oracle_templates.py`
  - `app/models/oracle_template.py`
  - `migrations/versions/e5a7c9d1f3b6_oracle_templates.py`
  - `tests/test_oracle_templates.py`
- Backend (changed): `app/main.py` (routers, model import, CORS header).
- Frontend (new):
  - `lib/oracle-templates.ts`
  - `src/app/mapping/page.tsx` (Template Manager)
  - `src/app/mapping/designer/page.tsx`
  - `components/mapping/mapping-designer.tsx`
  - tests in `lib/__tests__/oracle-templates.test.ts` and `components/mapping/__tests__/mapping-studio.test.tsx`
- Frontend (changed): `lib/workspace-nav.ts` and `components/layout/SidebarNavigation.tsx` (Mapping Studio entry and breadcrumbs).

**Reused:**
- the staging workbook as the single value source;
- the label/value and table structures already used by Custom Export;
- the existing source viewer (`SourceVerificationPanel`) for the left panel;
- the document isolation dependency;
- the RBAC permissions;
- the integration audit log.

## 5. Test evidence

| Suite | Result |
|---|---|
| `tests/test_oracle_templates.py` (parser layouts, XLSM, refusals, rows and transforms, exact CSV, validation, suggestions, and an API end-to-end run on the SF1442 regression contract) | **28 passed** |
| Backend full suite | **1133 passed, 13 skipped, 0 failed** (stress test excluded, as before) |
| Frontend full suite (incl. 6 new tests) | **480 passed / 79 files** (`--maxWorkers=2`) |
| Type check / lint on new files | clean |
| Browser walkthrough on the local app (FA300224C0008) | upload → detect 13 columns → suggest → change 3 mappings by hand → save (v1, then v2) → download `Contract.csv`: header line identical to the template, no BOM, constant `DATAOMATIX`, `EstimatedAmount` `24131140.28`, unmapped column empty; source highlight shown on page 1 |

Acceptance tests from the brief:

| # | Test | Evidence |
|---|---|---|
| 1 | Upload a Contract header template | API test and browser walkthrough |
| 2 | Detect technical headers and display labels | Parser tests (all four layouts); API test checks labels |
| 3 | Map extracted contract values | API end-to-end on SF1442; browser walkthrough on FA30 |
| 4 | Modify a mapping manually | API test (constant change); browser walkthrough (3 edits) |
| 5 | Save the mapping | Versions 1 → 2 with history (API and browser) |
| 6 | Generate an Oracle-compatible CSV | Export endpoint and browser download |
| 7 | Exact column names and order | Header line compared to the template, byte for byte |
| 8 | Regenerate after mapping changes | API test: the changed constant appears in the regenerated file |
| 9 | Preserve unmapped source data | Preview lists unmapped fields; the staging workbook is unchanged |
| 10 | Existing extraction still works | Full backend and frontend suites |

## 6. Limitations and next steps

- **Template verification.** The parser was tested with test templates, not with a file downloaded from a real Oracle Fusion pod. Before relying on exports, upload one real template per object and compare the detected columns with Oracle's documentation for that release.
- **Lookups and data types** are only checked where the template declares them: required via `*`, and the formats a user picks. Oracle lookup validation (contract types, party roles, business units) needs reference lists, which aren't loaded yet.
- **Suggestions** are deterministic (names, labels, synonyms, wording similarity, prior approvals). An AI-assisted suggestion step could be added behind the existing provider policy, but would still need review before saving.
- **One row table per file.** Combining several tables in one file isn't supported, matching the existing Custom Export rule.
- **Exports are CSV/ZIP only.** XLSX output in a template's layout is not built.
- **Panels:** the document panel collapses but panels don't drag-resize.

## 7. Deployment readiness

Ready for review. Before deploying:
1. Review and commit (not done).
2. The migration runs automatically on startup (`alembic upgrade head`). It is additive, but it was tested only on SQLite.
3. Production RBAC: uploading templates needs `admin.integrations`, and mapping and export need `oracle.preview`. The anonymous `workspace` role has neither, so the hosted demo's anonymous users won't see templates. This matches the existing rule that Oracle actions need real credentials.
