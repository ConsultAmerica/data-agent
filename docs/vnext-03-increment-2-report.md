# VNEXT-03 — Increment 2 Report: Classification, Schema Selection and Dynamic Labels

**Status:** implemented and tested locally; **not committed, pushed or deployed**.
**Date:** 2026-10-29 · **Base:** `main` @ `bbd7210` plus Increment 1 (uncommitted)
**Scope:** brief "Dataomatix VNext — Increment 2". Closes gap 2 of `docs/vnext-01-gap-report.md`.

---

## 1. Architecture assessment (before the change)

What existed:
- **Automatic classification:** `app/staging/resolver.py` already chose a staging profile from the document's own content, never the file name. In order, it used:
  1. structural recognizers declared by profiles (passport MRZ, FAR Part headings, XML records, licence layout);
  2. keyword families (`structure_detection`);
  3. letter structure (→ correspondence);
  4. the stored AI document type;
  5. contract structure (clause listing + contract number).

  After staging, layout recognizers (invoice, transcript) could still settle an unconfident result.
- **Schema registry:** the staging profile registry (`app/staging/registry.py`) already is one. Each profile defines datasets, field ids, display labels, value types, grouping, repeating tables, validation and extraction. Increment 2 reuses it and adds no parallel schema store.
- **Labels:**
  - **canonical / display labels:** per profile (canonical field + display label);
  - **broad category:** from the earlier categories work;
  - **Oracle display / technical labels:** from Increment 1.

What was missing:
- **Uncertainty was invisible.** The resolver kept only the winner, so there were no scores, alternatives or stored evidence, and no review status. An uncertain document fell back to the generic profile silently.
- **No way to correct the type.** There was no override and no history of decisions.
- **No subtypes beyond SF 1442** in the listing label.

## 2. What was built

| Area | Implementation |
|---|---|
| Classification engine | `app/classification/engine.py`. Collects candidates from every signal above, plus profile layout recognizers on a stored structure and Standard Form identifiers on the first two pages. Each candidate carries a score (0–1, evidence strength), the evidence found and the signal it came from. **The selected type is exactly the resolver's choice** (`predict_profile`, plus the same structure refinement staging uses), so automatic results and everything built on them are unchanged. |
| Subtypes | Government contract: SF 1442 award, SF 30 modification, SF 33 solicitation/award, OASIS+ IDIQ, SF 26, DoD/UCF. Invoice: standard, PO-referenced. Purchase order: order, amendment. Transcript: university, school (chosen by a person). Detected from form identifiers and phrases in the text, with the match quoted as evidence. |
| Status and thresholds | Thresholds are configurable: `CLASSIFICATION_HIGH_CONFIDENCE` = 0.85 and `CLASSIFICATION_LOW_CONFIDENCE` = 0.60. **classified** means the score is at or above high and no other type scores as high. **review recommended** means a score between the thresholds, or contested evidence. **review required** means a score below low, or no specific type recognized. Nothing is silently generic. |
| Persistence | New table `document_classifications`, append-only: kind (prediction / confirmation / override), type, subtype, category, schema, score, status, candidates, evidence, method, engine version, thresholds, actor, reason, time. Current = latest decision, else latest prediction. Every decision is also written to the existing `classification_audit_log`. |
| When it runs | Automatically at the end of processing (before extraction), and again at staging once a source structure exists. An unchanged result adds no row. |
| Decisions | `POST /api/documents/{id}/classification/decision` with `confirm` (optionally a different subtype) or `override` (another type, or a **new category** by name, staged with the general schema). Needs `review.accept` and the review-mutation gate. `apply` (default on) re-stages with the chosen schema ("Re-extract using selected schema"). The resolver honours the decision in all later staging. |
| No data loss | Re-staging rebuilds the workbook from the stored extraction. Pages, extracted values, earlier predictions and decisions are kept, and the decision can be reversed. Tested: page count unchanged, workbook readable after override. |
| Unknown documents | Status *Classification review required*, candidate categories listed, general schema meanwhile, all text and tables kept, a new category can be created. |
| Dynamic labels | The confirmed type selects the staging profile, so the workspace shows that profile's sections and labels (e.g. Invoice Summary / Supplier / Lines; Contract Summary / CLINs / Clauses / Sections). A decided subtype becomes the listed type and selects the Contract Data column set (SF 1442 / OASIS+ / DoD-UCF). Oracle labels still appear only in the Mapping Designer's Oracle views. |
| Oracle mapping integration | Classification does not use Oracle templates. Validation flags (1) **error** `source_missing` when a mapping points at a field the document no longer has, e.g. after reclassification; and (2) **warning** `classification_unconfirmed` while the type needs review. Mappings and their versions and export history are untouched. The classification panel lists saved mappings made for the previous schema. |
| API | `GET /api/documents/{id}/classification` · `POST …/classification/classify` (re-run, `extraction.run`) · `POST …/classification/decision` · `GET /api/classification/types` (category → type → schema, subtypes, datasets) · `GET /api/classification/queue` (workspace-scoped) |
| UI | **Classification tag** in the document workspace header opens a drawer showing: detected type and subtype, category and schema, status, confidence (level and score, labelled *not a calibrated probability*), evidence, scored alternatives (each with "Use"), Confirm / Change document type / Re-extract using selected schema / Re-run, and history. A **Classification review** page (sidebar) lists documents needing review, most uncertain first, with the document beside the panel. The Documents list marks *Confirm type* on documents whose type needs review. |
| Security | Content is treated as data: classification is deterministic pattern and structure matching, so document text can't instruct it (tested with an injection document). Existing document isolation and permissions apply, the queue is workspace-scoped, and decisions are audited. |

## 3. Classification accuracy (measured separately from extraction)

`tests/test_classification_accuracy.py` covers 13 labelled documents: 3 regression contracts, 2 FAR files, 4 invoice fixtures (the scanned one needs Tesseract and was skipped), plus generated passport, US and EU licences, and a transcript.

| Measure | Result |
|---|---|
| Family accuracy | **13 / 13** |
| Subtype accuracy (labelled) | **2 / 2** (SF 1442, SF 33) |
| Sent to review | 1 / 13 (EU licence, score 0.50) |

In the local database (12 documents), `sample3.pdf` (a contract without a form identifier, 0.45) goes to review required and `FA.jpg` (a school certificate; layout evidence 0.80) to review recommended. Both are correct outcomes for their evidence.

**Limits of this measurement:**
- 13 documents is far too few to estimate accuracy in general.
- Several are synthetic.
- **Scores are not calibrated probabilities, and no calibration was tested.** The UI and API say so.

A real benchmark needs the permissioned corpus described in `docs/di-01-benchmark-plan.md`.

## 4. Test evidence

| Suite | Result |
|---|---|
| `tests/test_classification.py`: correct classification (invoice, SF 1442, FAR structural); low confidence and unknown → review required and queued; injection text; override with history, audit, re-stage and no data loss; confirm with a different subtype → listed type changes; new category; invalid decisions refused; type registry; reclassification flags a saved Oracle mapping (`source_missing`) and restoring clears it | **13 passed** |
| `tests/test_classification_accuracy.py` | **1 passed** (report above) |
| Increment 1 `tests/test_oracle_templates.py` | **28 passed** |
| Backend full suite | **1147 passed, 13 skipped, 0 failed** (stress test excluded, as before) |
| Frontend full suite (incl. 6 new classification tests) | **486 passed / 80 files** (`--maxWorkers=2`) |
| Type check / lint on new files | clean (lint findings in `document-workspace.tsx` predate this work) |
| Migration `f6b8d0e2a4c7` | upgrade → downgrade → upgrade on SQLite: OK; single head |

**Browser walkthrough** on the local app:
1. **Queue:** *Classification review* lists `sample3.pdf` (review required, 45%, alternatives Contract 33% and SOW 24%) and `FA.jpg` (review recommended, 80%). Selecting `FA.jpg` shows the certificate image beside its evidence; **Confirm** removes it from the queue.
2. **Override:** in FA300224C0008's workspace the drawer shows *Government Contract — SF 33*, classified at 90%, with "STANDARD FORM 33" quoted as evidence. Changing it to *Invoice* re-stages it, and the page turns into the invoice layout.
3. **Mapping flagged:** the saved Increment 1 Contract mapping now shows **4 errors** ("mapped to a field this document doesn't have — was the document reclassified?").
4. **Restored:** changing it back to *Government Contract — SF 33* makes the mapping import-ready again.
5. **History:** both predictions and both decisions, with actor and reason.

## 5. Limitations

- **Mostly deterministic scoring.** Scores come from deterministic evidence (structure, layout, form identifiers, keywords). No new AI model was added; an AI classifier could become one more signal behind the existing provider policy. Keyword-only evidence is capped at 0.95.
- **Category coverage follows the existing families and profiles.** Bank statements, resumes, insurance and medical documents can be classified by keywords (some have families), but most have no dedicated schema yet and use the general one. The brief's longer list of categories (NDA, lease, sales order, expense report, …) still needs families and profiles.
- **Subtype detection** is implemented for contracts, invoices and purchase orders. Transcript subtypes are selectable but not detected.
- **New categories are lightweight.** A person-created category is recorded per document (family `custom:<name>`, general schema). It isn't yet a reusable definition with its own fields; that is the Schema & Labels increment.
- **Re-staging is synchronous** inside the decision request. It takes seconds on large documents; a job would suit very large files.

## 6. Deployment readiness

Ready for review together with Increment 1. Before deploying:
- **Migrations:** `e5a7c9d1f3b6` and `f6b8d0e2a4c7` run on startup. Both are additive and tested on SQLite only.
- **Existing documents** get a prediction on their next processing or staging, or when their classification is first opened. The queue lists only documents that have one.
- **Not done:** no commit, push or deploy.
