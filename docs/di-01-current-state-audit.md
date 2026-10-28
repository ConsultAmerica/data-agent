# DI-01 — Current-State Audit (Implemented / Partial / Missing)

**Product:** Dataomatix
**Assessment date:** 2026-10-26 · **Commit audited:** `821a2a3` on `main` (clean tree)
**Method:** direct reading of backend (`backend/app`), frontend (`frontend/`), migrations, config and tests. Every row below was confirmed in code and, for runtime capabilities, confirmed to be wired to a registered route or job path. UI labels and documentation were not accepted as evidence. High-severity findings were re-verified line-by-line by the assessor after the initial sweep.

Status key: **Implemented** = present, wired and exercised by code paths · **Partial** = present but incomplete, unwired in places, or weaker than its name suggests · **Missing** = not found in code.

---

## 1. Executive summary

Dataomatix today is a **deterministic-first, single-tenant-style document staging platform** optimised for U.S. government contracts, FAR regulation text and (since Sept 2026) invoices and academic transcripts. Its strongest assets are:

- a generic, profile-driven **staging engine** (`backend/app/staging/`) with per-cell provenance and three cell states (Verified / Needs Review / Missing);
- a **schema-neutral source-structure layer** (`backend/app/source_structure/`) covering native PDF, OCR'd scans, HTML DOM and XML;
- **local OCR** (Tesseract) with word-level OCR geometry, image preprocessing and targeted re-OCR;
- a working **dual-pane review page** with server-rendered page images and click-to-highlight evidence;
- a **field-level review audit log** and a **dry-run-only Oracle send** behind an explicit confirm step.

The largest gaps against the DI-01 target are:

1. **Document coverage** — 8 registered staging profiles; none for identity documents, cheques, bank statements, receipts, purchase orders, insurance, healthcare, HR, tax or logistics.
2. **Recognition providers** — only LLM providers (Gemini/OpenAI/Ollama/Convera). No Azure Document Intelligence, Google Document AI, MRZ or MICR engine; no per-value model/version or cost tracking.
3. **Invoice business validation** — arithmetic is good; supplier master, PO matching, duplicate-invoice detection and business-unit derivation are absent.
4. **Learning** — corrections are stored but never reused.
5. **Security for sensitive documents** — no data classification, no app-level encryption, no retention, no redaction before third-party AI, anonymous processing on by default, and a **hard-coded service API key that is seeded and re-activated in every environment including production** (see §9, finding S-1).
6. **Oracle** — dry-run only; no live client, FBDI, or status reconciliation (which is correct for the current release scope, but means IDR parity is a later phase).

Baseline automated test status at audit time (actual run): **877 passed, 11 failed, 14 skipped** — failures are test-isolation and workstation-environment issues, triaged in the appendix.

---

## 2. Capture and ingestion

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| File-type allowlist (ext + MIME + magic bytes) | Implemented | `backend/app/services/security_validation.py:64-295` | PDF, DOCX/XLSX/PPTX, DOC/XLS/PPT, TXT, CSV, RTF, HTML, XML, PNG, JPG, TIFF, BMP, WEBP. Explicitly "not antivirus" (`:17-19`). |
| Single-file upload API | Implemented | `backend/app/api/documents.py:316-615` | <10 MB processed inline, larger queued (`services/upload_size_tiers.py:29`). |
| Streaming save + SHA-256 | Implemented | `backend/app/services/file_upload.py:94-148` | |
| Batch upload | Partial | `frontend/components/intake/batch-queue.ts`; `api/documents.py:334` (`batch_id`) | Browser-side queue of single uploads; no multi-file or ZIP endpoint. |
| ZIP / archive ingestion | Missing | `.zip` absent from `UPLOAD_TYPES` | |
| Email / SFTP / scanner inbox | Missing | — | No mailbox or watched-folder capture. |
| PDF portfolio (embedded files) | Implemented | `api/documents.py:377-412` | User selects the embedded file. |
| Exact-duplicate file detection | Implemented | `api/documents.py:126-133` | SHA-256 within caller scope only. |
| Storage | Implemented | `services/document_storage.py:39-60, 312-333` | Local disk + optional Supabase Storage backup (required in production, `main.py:368-374`). `boto3` is in requirements but never imported. |
| Encryption at rest (application) | Missing | no encrypt/KMS code | Depends on provider defaults (unverified). |

## 3. Text, layout and structure

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Native PDF text (PyMuPDF) | Implemented | `services/page_text_extractor.py:191-199` | |
| OCR-needed detection | Implemented | `services/ocr_detection.py:105`; `core/config.py:123-135` | Coverage, image ratio, bad-glyph ratio. |
| OCR (Tesseract via MuPDF; pytesseract fallback) | Implemented | `page_text_extractor.py:272-280, 354-389` | 45 s per-page timeout; default language `eng` only. |
| Image preprocessing (deskew/contrast) | Implemented | `services/image_preprocess.py:44` | Only for degraded pages. |
| Word-level OCR boxes + confidence | Implemented | `services/ocr_word_layer.py:70, 257`; `models/document_page.py:82` | Stored as JSON in OCR pixel space. |
| Native text geometry | Partial | `models/page_text_block.py` | Block-level only; pytesseract fallback stores the whole page as one block. |
| Coordinate-space tagging | Implemented | `services/evidence_geometry.py:26-35` | `pdf_points` vs `ocr_pixels`. |
| Targeted re-OCR of a region | Implemented | `services/targeted_ocr.py:29` | |
| Tables (pdfplumber; OpenCV raster grids) | Implemented | `services/generic_table_extractor.py`; `source_structure/raster_tables.py` | |
| AcroForm fields | Implemented | `services/pdf_form_extractor.py` | |
| HTML DOM / XML / Office | Implemented | `source_structure/html_structure.py`; `xml_records/parse.py`; `services/native_ingest.py` | XML parser hardened (no entities/DTD/network). |
| Schema-neutral source structure | Implemented | `backend/app/source_structure/`; `staging/preparation.py` | Built only when the resolved profile needs it. |
| Dead parsers | — | `parsers/pdf_parser.py`, `excel_parser.py`, `video_parser.py` | No callers. |

## 4. Classification and document profiles

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Profile resolver | Implemented | `staging/resolver.py:128-256` | Order: profile document-recogniser (≥0.8) → keyword family → AI `document_type` → contract structure → generic; structural recogniser (≥0.6) only if unconfident. |
| Keyword family classifier | Implemented | `services/structure_detection.py:347-430, 766-793` | Deterministic keyword scoring; includes `invoice`, `purchase_order`, `statement` families. |
| AI classification | Partial | `services/contract_classifier.py:11` | Contract-oriented; first 3 pages. |
| Registered staging profiles | Implemented | `staging/registry.py:62-81` | `contract_v3@1`, `generic_business_document@1/@2`, `invoice@1`, `far_part_52@1`, `far_regulatory_change@1`, `academic_transcript@1`, `xml_document@1`. |
| PO, statement profiles | Missing | `resolver.py:204-210` | Families exist but fall back to the generic profile. |
| Identity, cheque, bank statement, receipt, insurance, healthcare, HR, tax, logistics profiles | Missing | — | |
| Per-profile review policy | Missing | `staging/profile.py:207-238` | No thresholds / straight-through policy field. |
| Per-profile security classification | Missing | `staging/profile.py:207-238` | |
| Document splitting (multi-document PDFs) | Missing | — | |

## 5. Extraction providers

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| LLM provider interface | Implemented | `services/ai_provider.py:12-96` | extract / classify / extract_fields / extract_clauses / extract_signatures / extract_structured_tables / enrich_schema. LLM-shaped, not OCR/layout-shaped. |
| Gemini (default), OpenAI, Ollama, Convera | Implemented | `gemini_provider.py:237-295`; `openai_provider.py:189-240`; `ollama_provider.py:202-240`; `convera_ai_provider.py:210-244` | Default model `gemini-3.6-flash` (`config.py:48`). |
| Fallback chain | Implemented | `services/fallback_ai_provider.py:47-118` | ≤3 providers, 45 s per attempt. |
| Session timeout / bounded retry / circuit breaker | Implemented | `services/ai_enrichment.py:163-211, 237-283` | AI only when deterministic result is insufficient. |
| Azure Document Intelligence / Google Document AI / Textract | Missing | grep: none | |
| MRZ parser / MICR parser | Missing | grep: none | |
| Provider + model recorded per value | Partial | `ai_enrichment.py:148-159, 243`; `extraction_job_runner.py:636,650` | Per run only; fields record only `extraction_method="ai"`. Fallback runs can be labelled with the wrong model. |
| Processing version per value | Partial | `services/processing_versions.py:12-37` | Per document/job only. |
| Cost / token accounting | Missing | grep: none | Call counts only. |
| Job queue / worker | Partial | `services/extraction_job_runner.py:59-73`; `workers/__init__.py` empty | In-process BackgroundTasks + thread pool; Celery in requirements but unused. |
| Job retry / recovery | Partial | `services/job_recovery.py:11`; `main.py:411-445` | Stale jobs marked failed after 30 min; never re-queued; `retry_count` never incremented. |

## 6. "No invented values" safeguards

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| AI value must be grounded in page text | Partial | `services/source_validator.py:47-92`; `services/ai_value_mapping.py:19-68` | Passes if the AI's **quoted source text** is on the page even when the value is not (`:84-88`); list/dict values pass on any non-empty quote without a page check (`:57-66`). |
| Missing evidence handling | **Defect** | `services/target_result_store.py:52-58` | When evidence is `None`, the row is stored with `page_number: 1` and empty source text — a fabricated page reference. |
| Staging grounding modes | Implemented | `staging/profile.py:44-49`; `staging/validation.py:205-324` | `evidence` grounding requires the value to appear in its evidence text to be Verified. |
| Staging engine never rewrites stated values | Implemented | `staging/profiles/invoice_v1.py:959-960` | Arithmetic adds checks, never changes totals. |

## 7. Validation

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Cell states + OCR gate (<0.80 → Needs Review) | Implemented | `staging/validation.py:196-324`; `staging/structure_provenance.py:23-31` | |
| Declarative field rules | Partial | `staging/profile.py:52-62`; `validation.py:154-193` | Only `positive_amount`, `evidence_mentions`, `pattern`. No date-range, cross-field or reference-data rules. |
| Invoice line extension (qty × price) | Implemented | `invoice_v1.py:911-924` | |
| Invoice lines vs subtotal; total; amount due | Implemented | `invoice_v1.py:952-1030` | Tolerance scales with component count. |
| Invoice currency detection / conflict | Implemented | `invoice_v1.py:1244-1275` | "$" flagged ambiguous. |
| Supplier corroboration | Partial | `invoice_v1.py:635-643, 1195-1202` | Email domain / remit-to only; no supplier master. |
| Supplier/site master resolution | Missing | — | |
| PO format / PO match (2-way, 3-way) | Missing | `invoice_vocabulary.py:78` | PO number extracted as a code only. |
| Duplicate invoice (supplier + number + amount) | Missing | — | Only exact file checksum. |
| Business-unit derivation; utility/service rules | Missing | — | |
| Invoice date logic | Missing | `validation.py:133-145` | Parse check only. |
| Transcript course/term/credits/GPA extraction | Implemented | `academic_transcript.py:98-139`; `transcript_vocabulary.py:127-169` | Values as printed. |
| Transcript credit/GPA arithmetic | Missing | — | |
| MRZ, MICR, ABA routing, IBAN, Luhn | Missing | — | |
| Workspace-configurable rules | Partial | `api/validation_rules.py:70-201`; `services/validation_rules.py:33-81` | Contract-oriented (UEI, CAGE, PIID…); results are a separate report and do not affect cell state. |
| Negative invoice tests | Missing | `tests/test_invoice_profile.py` | No test drives an arithmetic failure. |

## 8. Review, viewer, corrections, audit

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Dual-pane review page | Implemented | `frontend/src/app/documents/[documentId]/review/page.tsx:920-1024` | `ResizableSplit` with page image + field list. |
| Page rendering | Implemented | `backend/app/api/page_extraction.py:419-500` | Server-side PNG (PyMuPDF); no pdf.js. Non-PDF/non-image → 422 → text fallback. |
| Bounding-box highlight / click-to-evidence | Implemented | `page_extraction.py:426-436, 504-516`; `frontend/components/pdf-page-viewer.tsx:45-60, 141-155` | One box per render. |
| Zoom, paging, search | Implemented | `frontend/components/pdf-toolbar.tsx:130-152` | |
| Deep links `?view=source&page=&hl=` | Implemented | `frontend/components/documents/document-workspace.tsx:124-133` | |
| Workspace split view | Partial | `document-workspace.tsx:136-138` | Off by default. |
| Field accept / edit / reject / unknown | Implemented | `api/contract_analysis.py:998-1161` | RBAC + review-mutation gate. |
| Server accept-all | Implemented (risky) | `api/contract_analysis.py:1218-1282` | Accepts every pending field regardless of confidence; used by the review queue (`frontend/src/app/review-queue/page.tsx:142`). |
| Document approve / promote | **Partial — weak controls** | `api/contract_analysis.py:874-948` | No RBAC permission, no gate, no audit row; `approved_by` is client-supplied text. Workspace isolation still applies via router dependency (`main.py:200-204`). |
| Reviewer identity | Partial | `contract_analysis.py:1039`; `review/page.tsx:82` | Free-text `changed_by` defaults to "Dataomatix"; `actor_id` also recorded. |
| Review assignment | Implemented | `api/assignments.py:87-138`; `frontend/components/review-queue/assign-popover.tsx` | |
| Optimistic concurrency | Missing | no ETag/version column | Last write wins. |
| Re-extraction protects reviewed values | Implemented | `services/target_result_store.py:70-110, 241-276` | Reviewed value kept; status reset to pending if machine value differs. |
| Review priority | Implemented (misleading name) | `services/review_routing.py:69-86`; `api/dashboard.py:387-391` | Validation-failed / ambiguous / low-band fields get `priority="low"`, clean fields `"high"` — but the queue sorts ascending, so problem fields are listed first. **Correction (DI-02):** the original audit called this inverted; queue order is correct, only the label is confusing. Documented in code; values unchanged to avoid re-ordering stored rows. |
| Staging "Verified" vs human review | **Ambiguous** | `staging/engine.py:112-143` | Staging "Verified" is machine evidence status, not human approval; exported as such. |
| Corrections stored | Implemented | `models/target_correction.py`; `api/target_corrections.py:43-147` | Original/corrected value, evidence snapshot, `changed_by`; no reason, no `actor_id` on the correction row. |
| Corrections reused | Missing | — | No alias learning, retrieval or training. |
| Field audit log | Implemented | `models/metadata_field_audit_log.py:17-102`; `frontend/src/app/audit-log/page.tsx` | Actor, role, request id, previous/new. |
| Classification / relationship audit | Partial | `models/classification_audit_log.py`; `relationship_audit_log.py` | No `actor_id`. |
| Audit retention on delete | **Defect** | audit FKs `ondelete="CASCADE"` | Deleting a document erases its audit trail. |
| Read/access audit | Missing | `core/observability.py:97-137` | Request logs without identity; nothing persisted. |

## 9. Security (summary — full detail in `di-01-security-assessment.md`)

| ID | Finding | Status | Evidence |
|---|---|---|---|
| S-1 | Hard-coded service API key seeded and re-activated on every start, in every environment | **Critical** | `services/actor_seed.py:11-12, 49-71`; `main.py:402-409`; permissions `core/rbac.py:101-111` (all-workspace `documents.view`, `export.authoritative`, `oracle.send`) |
| S-2 | Anonymous processing on by default, no rate limit | High | `core/config.py:102`; `core/auth.py:156-162` |
| S-3 | Raw text to Gemini (and fallbacks) by default; no per-document consent or redaction | High | `gemini_provider.py:36-66`; `ai_provider_factory.py:81-134` |
| S-4 | No isolation between authenticated users | High | `core/document_access.py:31-46` |
| S-5 | No classification, retention, or app-level encryption | High | — |
| S-6 | No malware scan / decompression limits | Medium | `security_validation.py:422-432` |
| S-7 | CORS trusts `*.vercel.app` with credentials; no HSTS; no frontend CSP | Medium | `main.py:147-165`; `core/security_headers.py:13-25` |

## 10. Oracle and export

| Capability | Status | Evidence | Notes |
|---|---|---|---|
| Reviewed-payload preview | Implemented | `api/reviewed_export.py:274-303` | Accepted/edited fields only. |
| Send with confirm + zero-pending check | Implemented (dry-run) | `api/reviewed_export.py:306-451` | `oracle.send` permission, `confirm=true`, audited. |
| Live Oracle REST client | Missing | `reviewed_export.py:375-404` (501 when not dry-run); `app/connectors/__init__.py` empty | Correct for current release scope. |
| FBDI generation | Missing | `far/oracle_map.py:1-23` | |
| Status reconciliation | Missing | — | |
| Integrations router | Stub, unregistered | `api/integrations.py` | |
| Reviewed export | Implemented | `api/reviewed_export.py:73-270` | `authoritative_only` defaults to **False**; rows carry `review_status` and `authoritative`. |
| Staging exports (XLSX/JSON/CSV) | Implemented | `api/staging_workbook.py:118-233` | Serialises persisted workbook; machine cell states. |

## 11. Baseline test status

See the appendix at the end of this file (recorded from an actual local run on 2026-10-26).

## 12. Existing evaluation assets

| Asset | Location | Notes |
|---|---|---|
| Invoice fixtures (6, fictional, generated) | `backend/tests/fixtures/invoices/` | Native, scanned/skewed, multi-page, PO-backed, EUR charges, HTML. Not real suppliers. |
| Invoice acceptance tests | `backend/tests/test_invoice_profile.py` | Positive-path only. |
| Truth-scored invoice report | `backend/scripts/invoice_validation_report.py` | Scores Correct/Incorrect × Verified/Needs Review; "Incorrect + Verified" = release blocker. Writes outside repo. Reusable as the benchmark harness core. |
| Contract regression PDFs | `reference/regression/` | Contracts + FAR; tracked in git. |
| Reference workbooks | `reference/schemas/` | Includes `Oracle_Fusion_Package_Index.xlsx`. User-managed; do not modify. |

No permissioned real-world invoice, passport, cheque, transcript or healthcare corpus exists in the repo. This is correct (real documents must not be committed) and is the first dependency of the benchmark plan.

---

## Appendix — Baseline automated test run (actual, 2026-10-26)

Command: `python -m pytest -q` in `backend/` (local `.venv`, Python 3.12, test DB = local SQLite `test_data_agent.db`; no Supabase variables set, so no remote storage was used).

| Result | Count |
|---|---|
| Passed | 877 |
| Failed | 11 |
| Skipped | 14 |
| Duration | 1030.5 s |

Failure triage (rerun of the failing files in isolation: 30 passed, 2 failed):

| Test(s) | Isolated result | Assessment |
|---|---|---|
| `test_clause_extraction.py` (3), `test_contract_analysis.py` (6) | Pass | **Order-dependent** — fail only in the full run; a test-isolation defect (shared state between tests), not a product regression. Needs investigation. |
| `test_ingestion_ocr_matrix.py::test_native_text_formats_do_not_need_ocr` | Fail | Persistent test DB holds an identical `memo.rtf` from 2026-09-24, so upload returns 200 `duplicate_pending` instead of 201. Test-DB hygiene issue (DB not reset between runs). |
| `test_stress_p0_ingestion.py::test_png_ocr_persists_final_text_and_discovers_invoice` | Fail | `final_text` empty after OCR; `tesseract` binary not resolvable on this machine's PATH. Environment issue — OCR tests are not meaningful on this workstation until Tesseract is fixed. |

Implication for DI-02: gate G0 requires a green suite, so test isolation, per-run test DB reset and a CI image with Tesseract are prerequisites (added to backlog as B-018).
