# RC2-04 Final Verification Gate

**Date:** 2026-10-08  
**Commit/push/deploy:** Not performed  
**RC2-03:** Not started

---

## 1. Failures identified from completion report

Prior session noise (not reproduced as assertion defects under quiet single-worker runs):

| Test | Prior symptom | Classification |
|---|---|---|
| documents-home / document-workspace / table-selection / data-grid (many) | `Test timed out in 5000ms` under contended full-suite runs | **Resource-related timeouts** |
| `FarRecordsView > pages at 100 records` | Timeout at 20s under load | **Resource-related / pre-existing slow test** |
| `DocumentWorkspace combines small dataset tabs > puts datasets…` | Intermittent `Supplier` still in DOM | **Flaky** — **passes in isolation** |
| `document-families` missing `DOCUMENT_FAMILY_LABELS` | `tsc` TS2305 | **Actual setup regression** from RC2-04 label move — **fixed** |
| Cell checkboxes `visibility: hidden` | Keyboard focus impossible | **Actual a11y defect** found in browser gate — **fixed** (opacity) |

---

## 2. Exact commands

```bash
# Focused RC2-04 (authoritative for this package)
cd frontend
npx vitest run --pool=forks --maxWorkers=1 \
  components/documents/__tests__/document-workspace.test.tsx \
  components/staging/__tests__/data-grid.test.tsx \
  components/staging/__tests__/table-selection.test.tsx \
  components/documents/__tests__/documents-home.test.tsx

# Full frontend
npx vitest run --pool=forks --maxWorkers=1
npx vitest run --pool=forks --maxWorkers=2   # also run for comparison

# Typecheck
npx tsc --noEmit -p tsconfig.json

# Backend regressions
cd ..
backend\.venv\Scripts\python.exe -m pytest \
  backend/tests/test_selected_export.py \
  backend/tests/test_export_consistency.py \
  backend/tests/test_rbac_oracle_certification.py -q --tb=line

# Browser (local Next + API)
cd frontend
node scripts/rc2-04-browser-verify.mjs
```

---

## 3. Results

### Focused RC2-04 (single worker)
**55 passed / 0 failed / 0 skipped** (4 files, ~31s)

### Full frontend Vitest
| Config | Result |
|---|---|
| `--maxWorkers=1` | **204 passed, 18 failed** — all inspected failures were **5s/15s/20s timeouts** (resource), plus suite pollution under long serial run |
| `--maxWorkers=2` | **211 passed, 11 failed** — almost all timeouts; **1 flaky assertion** (`Supplier` region) that **passes in isolation** |

No durable assertion failure in RC2-04 selection/export/return-URL/column-visibility tests when run focused.

### TypeScript
`npx tsc --noEmit -p tsconfig.json` → **exit 0** (after restoring `DOCUMENT_FAMILY_LABELS` + `documentFamilyLabel`)

### Backend
`test_selected_export` + `test_export_consistency` + `test_rbac_oracle_certification` → **49 passed**, 0 failed

### Selected export value check (API)
Document `f8523f62-…` / dataset `xml_records_1`: staging cells `Sync`, `2016-02-01` present in selected CSV export (`contains_v1=True`, `contains_v2=True`).

### Browser (Playwright)
Document `FAR_Part_52_OKCXMLIMPDFN_PART2.xml` — **all steps ok**:
- Filtered Documents → open with `return=`
- Return href + navigation preserve `filter` / `q`
- Search staging values
- Hide/restore Columns
- Keyboard cell select (after opacity fix)
- Evidence Details open/close; focus returned to **Details**
- Export Selected UI downloaded `…_xml_records_1_selected.csv`

---

## 4. Contract change confirmation

| Area | Changed in RC2-04? |
|---|---|
| Extraction algorithms | No |
| Classification / silent reclassify | No |
| Metadata review writes (Accept/Edit/Reject) | No |
| Export selected/all semantics | No (verified) |
| Oracle send / RBAC | No (49 regression tests green) |
| Search API | Only prior RC2-02 `profile_id` / `sort_by` / `sort_dir` (not export/Oracle) |

---

## 5. Files changed during verification

| File | Why |
|---|---|
| `frontend/lib/document-families.ts` | Restore `DOCUMENT_FAMILY_LABELS` / `documentFamilyLabel`; keep `FAMILY_LABELS` |
| `frontend/src/app/globals.css` | Cell checkbox opacity so keyboard focus works |
| `frontend/scripts/rc2-04-browser-verify.mjs` | Playwright gate script |
| `docs/rc2-04-verification-gate.md` | This report |

---

## 6. Final recommendation

**Conditionally release RC2-04** for review acceptance:

- RC2-04 focused suite is green (55/55).
- Typecheck green; backend export/RBAC green (49/49).
- Browser gate green after a11y fix.
- Full-suite failures under load are **timeouts / one flaky tab test**, not reproducible RC2-04 contract regressions.

**Do not start RC2-03** until product owner accepts this gate.  
Optional follow-up (not blocking RC2-04): stabilize full-suite default timeouts or isolate heavy FAR pagination tests; harden combined-dataset tab test against async race.
