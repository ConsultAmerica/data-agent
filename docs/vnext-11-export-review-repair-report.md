# VNext — Custom Export Repair, Extraction Review Workflow and UI Cleanup

Status: implemented locally and tested; **not committed, pushed or deployed**.
Date: 2026-10-29 · Branch: `feature/di-02-safety-foundation` (working tree)

## 1. Custom export

### Root cause
`Export → Custom → Open custom export…` set `customExportOpen`, but `<CustomExportDialog>` was rendered **only inside the Advanced Grid branch** of `document-workspace.tsx`. Smart View has been the default view since Increment 4, so in the default view the click did nothing. The existing test forced Advanced Grid mode, so it never caught this.

**Fix:** the dialog now mounts outside both views. New test: *"opens Custom export from Smart View too (the default view)"*.

### Designer repairs and additions
| Requirement | Result |
|---|---|
| Select datasets and fields, rename, reorder, combine | Existing designer, now reachable from both views |
| Preview | Comes from the server (`POST …/staging-workbook/export-custom/preview`) using the same builder as the download, and shows the file's real row count ("first 25 of 500 rows in the file") |
| Per-column transforms | `as_is`, `trim`, `upper`, `lower`, `date_iso`. Ambiguous dates (e.g. 03/04/2031) stay as printed and are never guessed |
| Templates | Saved with name, category (document type), version and updated-at; saving under the same name produces a new version (`· v2`) |
| CSV / XLSX | Both use `safe_cell()` for headers and values |
| Header vs line items | One repeating dataset per export. Document fields are repeated as columns on each line row, and no header rows are interleaved |
| Default columns | Now start from the structured fields, one per label. Previously the 2,509-entry "All Fields" scan added flattened `Line 1 / …` columns and duplicate `Invoice Number 2` columns. Key/value pairs are still the starting point for types that have no structured fields |

### Data integrity (backend tests, `tests/test_custom_export_designer.py`)
500 invoice lines are exported exactly once each with the invoice number on every row. Leading zeros (`0001`, `0500`), decimals, Unicode and multiline text are preserved; values missing from the source export as empty cells, never invented. XLSX has 501 rows; the preview matches the export; headers are protected against formula injection.

### Browser walkthrough (500-line invoice, Smart View)
- The dialog opened from Smart View.
- Rows were set to "One row per Invoice Lines record (500)"; the preview read "first 25 of 500 rows in the file".
- The template was saved and then updated to v2. Reopening the dialog and applying it restored all 25 columns.
- **CSV:** 500 data rows under a single header row, 500 distinct line numbers (0001–0500).
- **XLSX:** 501 rows.
- No console errors after the fix below.

### Also fixed
The Export menu used `capability_id` as the React key, and every dataset's CSV entry is `dataset_csv`. That caused "duplicate key" warnings (pre-existing). The key now includes the dataset id.

## 2. Extraction review workflow (Review queue → Inspect)

### Root cause of the wrong "original text"
For values it could not resolve, target extraction wrote its failure reason into `evidence.source_text` (`"candidate failed label/value validation"`), and every screen showed that as source text.

- The writer (`_needs_review_null_result`) now stores `""`. The reason stays in `field_evidence.consensus_reason` and `validation.warnings`.
- **Existing rows** are cleaned when read. The new `app/services/evidence_text.source_text_of()` is used by the metadata API, the target result store, the review queue, review routing, the V3 reader and the reviewed export.
- The drawer shows "Original source text unavailable." when no text was recorded.

### Behaviour
| Requirement | Implementation |
|---|---|
| Editable value, Save correction | Always editable. **Save correction** is enabled only when review is permitted and the value is changed and non-empty. Otherwise the reason is shown under the button. On approved (locked) documents the server refuses with 409 |
| Save flow | New action `correct` on the existing review endpoint. It validates the input, keeps `original_value`, records the reviewer and time, updates the effective value, **re-runs validation** on the new value, and leaves the field **pending (no auto-approve)**. The source-presence check is marked "skipped" because a reviewer typed the value |
| Validation display | Separate section showing status, failed rule(s), message, suggested correction ("None available" unless extraction stored one; never invented), evidence page and any override |
| Blocking failures | Ordinary Approve is refused: the server returns 409, and the row and drawer Approve buttons are disabled with an explanation. "Approve selected" skips these values and says so |
| Audited override | "Approve with override…" requires a reason. The server records `validation_override` {reason, reviewer, time, failed rules} on the field plus an audit row `override_accept` with the reason |
| Separate actions | Approve, Reject and Save correction are independent; Reject is never blocked by validation |

### Browser walkthrough
- **Issued By** (stored failure reason):
  - Original text: "Original source text unavailable."
  - Validation: Failed, with the message shown.
  - Approve disabled.
  - Override approved; audit row `override_accept` with the reason.
- **Order Date**:
  - Correction "later": saved but still failing and still blocked.
  - Correction "10/15/2026": validation passed, Approve enabled, status still `pending`.
  - Two `correct` audit rows, with `original_value` "soon" kept.

## 3. Other items in this round
- **Home page:** the Trust & deployment section and its link have been removed.
- **Header:** the backend status badge ("Local · Backend waking up…") has been removed. Health checks and error handling are unchanged.
- **Metadata read-only gate:** Edit, Accept and Reject in the extraction fields table are disabled with an explanation ("Read-only in this release"). The explanation was also added to the gated buttons in Metadata review, the Review queue and Documents.
- **Smart View:** invoice (and other schema) field cards are selectable by click or keyboard. A card opens its details (value, how it was found, printed label, evidence check, page) and jumps to the source page.

## 4. Verification
| Suite | Result |
|---|---|
| Backend `pytest` (full, excluding e2e) | **1257 passed, 14 skipped, 0 failed** |
| Frontend `tsc --noEmit` | clean |
| Frontend `vitest` | 590 tests. One full run had 2 timeouts while the backend suite ran in parallel; both files pass when run alone (43/43) |
| ESLint on changed files | No new errors. The remaining 5 (in `document-workspace.tsx` and `fields-table.tsx`) exist at HEAD |

Known pre-existing flake: `test_dashboard.py::test_review_queue_buckets_rejected_and_unknown_first` fails in about 1 of 5 runs, and does so at HEAD too.

## 5. Limitations and proposals
- **Templates are browser-local** (localStorage, per document type). Sharing them across users needs a server table and migration (proposal, not done).
- **Custom export reads staging values**, not values approved in Metadata review. Using approved values needs a mapping from staging fields to metadata fields.
- **Audit `changed_by`** is the name the page sends (the Review queue sends a default reviewer name), as before. Real identity needs authentication.
- "Locked" means the document has been approved (`approved_at`). There is no reopen flow.

## 6. Not done
Nothing has been committed, pushed or deployed. Open decisions carried over: Render `PYTHON_VERSION=3.12.10`, the `METADATA_REVIEW_MUTATIONS_ENABLED` production setting, and reconciling CORS commit `d942fbc`.
