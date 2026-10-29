# VNEXT-01 — Implementation Gap Report

**Scope:** "Dataomatix VNext — Universal AI Document Intelligence" brief (20 sections), Phase 1 (application audit).
**Date:** 2026-10-28 · **Code audited:** `main` @ `bbd7210`
**Method:** builds on the DI-01 current-state audit (`docs/di-01-current-state-audit.md`, at `821a2a3`) and the DI-02 to DI-05 reports, then re-checks in code every brief item those documents don't cover. A status here means "found and wired in code", not "described in docs or UI".

Status key: **Done** — implemented and covered by tests · **Partial** — present but narrower than the brief · **Missing** — not in code.

---

## 1. Summary

Dataomatix already has the backbone the brief asks for:

- a deterministic-first extraction pipeline with per-value provenance;
- a profile-driven staging engine (contract, FAR, invoice, transcript, passport, driving licence, XML, generic);
- a pluggable recognition layer (Tesseract, Azure DI, Google Document AI, OCI, LLM), with policy, budget and grounding;
- field-level review with an audit trail;
- automatic document categories;
- dry-run-only Oracle output.

The brief should be delivered as **increments on that backbone, not a rebuild**.

The gaps that matter most, in order:

1. **Oracle Template Manager.** There is no way to upload an Oracle Import Management template, so no export uses exact technical headers. Today's Oracle output stops at "output concepts" by design (`far/oracle_map.py`).
2. **Classification is not reviewable.** A document gets a type and a category, but there's no stored confidence, no alternative types, no manual override, and no "please confirm" step when confidence is low.
3. **Schema and label designer.** Extraction models (custom field lists) exist, but there's no schema versioning, no inheritance, no repeating groups, no per-field validation rules, and no export mapping per schema. External mapping labels aren't modelled separately from display labels.
4. **File formats.** JSON, XLSM, ODS, TSV, ZIP, EML and MSG are rejected at upload. Spreadsheets are read as text and tables only: no formula/value split and no cell-level evidence in the review UI.
5. **Review workspace.** Dual-pane review with page highlights works for PDFs and images. There's no third (intelligence and mapping) panel, and no native viewers for Excel, Word or XML sources.
6. **Platform.** There's no tenant isolation beyond the workspace scope, no malware scanning, no encryption at the application layer, no retention policies, no dark theme, and no automation rules engine.

---

## 2. Status by brief section

### §2 Universal upload and processing

| Item | Status | Evidence / note |
|---|---|---|
| PDF (native and scanned), images (JPG/PNG/TIFF/BMP/WEBP) | Done | `services/security_validation.py`; Tesseract OCR with word geometry |
| DOCX, XLSX, CSV, TXT, RTF, HTML, XML | Done | `services/file_processors/`, `parsers/office_text_parsers.py` (openpyxl), `xml_records/parse.py` |
| DOC / XLS / PPT | Partial | Needs LibreOffice (`services/libreoffice_convert.py`); `/ready` reports it unavailable when `soffice` is missing |
| JSON, XLSM, ODS, TSV | Missing | Not in the upload allowlist |
| ZIP archives | Missing | Not in allowlist; no unpack, size or zip-bomb limits |
| EML / MSG email | Missing | — |
| PDF portfolio (embedded files) | Done | User picks the embedded file |
| Drag-and-drop, multi-file batch, progress, retry, duplicate detection | Done | `components/intake/` (2 files at a time) |
| Folder upload, file previews before upload, cancel an in-flight file | Missing | — |
| Per-stage processing status | Done | Job stage history (`extraction_job_runner.py`) shown in the queue |
| Malware scanning | Missing | Allowlist explicitly "not antivirus" |
| Macros and active content not executed | Done | Parsers read data only; legacy conversion runs headless |

### §3 Automatic classification

| Item | Status | Evidence / note |
|---|---|---|
| Content-based (not filename) classification | Done | `staging/resolver.py`: structural recognizers, then keyword families |
| Broad category + detailed type | Done | `staging/document_categories.py` (8 groups); `type_label` (e.g. "SF 1442 Contract Award") |
| Brief's category list | Partial | ~35 families recognized; missing among others NDA, lease, SF 33 as its own type, credit memo vs credit note, sales order, expense report, payment advice, offer letter, timesheet, visa, EAD, diploma, claims, prescription, packing list, bill of lading, delivery note |
| Confidence score stored and shown | Partial | Keyword classifier computes one; the persisted resolution stores reasons, not the score |
| Classification evidence | Partial | `resolution_reasons` stored; not shown in the UI |
| Alternative classifications | Missing | Runner-up scores are computed and discarded |
| Manual override | Missing | Only the legacy AI `document_type` can be patched; the staging profile can't be overridden |
| Low-confidence confirmation | Missing | Uncertain documents fall back to the Generic profile silently |

### §4 Field labels and unknown documents

| Item | Status | Evidence / note |
|---|---|---|
| Document-specific labels | Done | Each profile declares its columns and labels (invoice, contract, transcript, passport, …) |
| Unknown-document field discovery | Done | Schema discovery + generic key-value scanner + table detection |
| Propose → approve → save schema for future documents | Partial | Custom targets per document and saved extraction models exist; there's no "approve this as the schema for this kind of document" flow |
| Canonical / display / external labels kept separate | Partial | Canonical and display are separate (`canonical_field`, `display_label`); external (Oracle display + technical) labels are not modelled |

### §5 Adaptive review interface

| Item | Status | Evidence / note |
|---|---|---|
| Document viewer + extracted data side by side | Done | Split view; server-rendered pages; click-to-highlight |
| Third panel (classification, validation, mapping) | Missing | That information is spread across tabs |
| Collapsible / resizable panels | Partial | Grid columns resize; panels don't |
| Native viewers for Word, Excel, CSV, XML | Partial | HTML and XML DOM evidence exists; no sheet or cell viewer, no Word layout view |
| Evidence never fabricated | Done | DI-02 B-002: no-evidence values have page 0 and route to review |

### §6 UI/UX and navigation

| Item | Status | Evidence / note |
|---|---|---|
| Consistent enterprise design system, tokens | Done | `globals.css` tokens, ConsoleHeader, shared grid |
| Dark theme | Missing | No dark tokens or theme switch |
| Brief's navigation (Dashboard, Upload Center, Schemas & Labels, Mapping Studio, Export Center, Automation, …) | Partial | Current: Overview, Documents, Extraction, Review queue, DataoAI, Search, FAR/DFARS, Field Explorer, Compare, Agent actions, Analytics, Obligations, Expirations, Clause playbook, Exports & Oracle, Governance, Settings. No Schemas & Labels, Mapping Studio or Automation areas |

### §7 Extraction engine and providers

| Item | Status | Evidence / note |
|---|---|---|
| Hybrid deterministic-first + AI | Done | DI-01/DI-03 |
| Provider abstraction (Azure DI, Google DocAI, OCI, LLM) | Done (not live) | `app/recognition/`; all off until configured; never called a real provider in tests |
| Recognition results written into review data | Missing | DI-03 §E: engine results stay in run records |
| Per-value original, normalized, evidence, confidence, method, review status, approved value | Done | `machine_value` vs `value`, provenance, review status, audit |

### §8 Tables

| Item | Status | Evidence / note |
|---|---|---|
| Multi-page tables, CLINs, invoice lines, courses | Done | Profile table extraction; invoice lines merged across pages |
| Excel: formula vs calculated value, leading zeros, multiple tables per sheet, cell refs in UI | Partial | Sheets read with openpyxl; cell refs and formula/value split not surfaced |
| CSV: delimiter, encoding, quoting | Partial | Comma CSV; no delimiter or encoding detection, no TSV |
| XML: namespaces, repeating nodes, paths | Done | `xml_records/`, XML source structure |
| Bank transactions | Missing | No bank statement profile |

### §9 Document-specific workspaces

| Workspace | Status |
|---|---|
| Contract (summary, data, clauses, source, Oracle) | Done (tabs differ from the brief's list) |
| Invoice (summary, lines, PO matching, validation) | Done |
| Transcript, passport, driving licence | Done |
| General document (fields, tables, structure) | Done |
| Resume, bank statement | Missing |

### §10 Oracle Fusion Import Management

| Item | Status | Evidence / note |
|---|---|---|
| Template upload and storage (object, technical names, display labels, user keys, required, column order, version) | Missing | — |
| Mapping UI (select object, match fields, transforms, lookups, profiles) | Missing | Fixed concept maps only (`far/oracle_map.py`) |
| CSV export with exact technical headers and column order | Missing | Blocked on the template manager; nothing invents Oracle names today (correct) |
| Non-importable data (clauses, deliveries, attachments) kept as review datasets | Done | Contract Data datasets |
| Oracle payload preview; gated send | Done | `oracle-payload` preview; send is dry-run, permission + confirm |

### §11 Validation

| Item | Status |
|---|---|
| Invoice arithmetic, duplicate invoice, PO match, supplier match | Done (DI-03/04) |
| Passport MRZ + dates | Done |
| Transcript credits and GPA (institution scale aware) | Done |
| Contract: CLIN uniqueness, amount reconciliation, date order, amendment conflicts | Partial (some checks in the contract profile; no amendment conflict check) |
| Configurable rules | Partial (`api/validation_rules.py`, playbook) |

### §12–13 AI review assistant, schema designer

| Item | Status |
|---|---|
| AI explanation of classification, uncertain/missing fields | Partial (DataoAI chat and AI summaries exist; no per-document review assistant panel) |
| Schema designer with versions, inheritance, repeating groups, rules, export mappings | Missing (extraction models are flat field lists) |

### §14 Data model

| Item | Status |
|---|---|
| Documents, jobs, classification, fields, tables, evidence, review decisions, validation, audit | Done |
| Schema versions, mapping profiles, export batches | Missing |
| Several documents → one business record (contract + mods + SOW) | Partial (parent/child relationships and hierarchy; no consolidated record view) |

### §15–17 Automation, reliability, security

| Item | Status |
|---|---|
| Background jobs, progress, retries for transient provider errors, budget | Done |
| Idempotent jobs, cancellation, durable queue across restarts | Partial (in-process background tasks) |
| Automation rules (routing, notifications, export packages) | Missing (review routing is fixed logic) |
| RBAC, review gate, audit log, log masking, provider policy | Done |
| Tenant isolation | Partial (workspace scope) |
| Malware scanning, app-level encryption, retention, secure deletion workflow | Missing (deletion keeps an audit tombstone) |
| Prompt-injection defence | Partial (AI values re-grounded against page text; document text not treated as instructions in extraction prompts — not audited for chat) |

---

## 3. Regression risks to respect

- **Staging workbooks are the single export source.** Anything new (provider results, schema designer) must write through the staging engine, or the reviewed values and exports diverge.
- **Snapshot parity.** DI-02 established a 14-document snapshot harness; every extraction change should re-run it against `main`.
- **Production migrations run on startup** (`alembic upgrade head`). New tables are safe; the Postgres-only branches of DI-02 migrations are still unverified on Postgres.
- **Oracle names.** No code may invent Oracle technical attribute names; they must come from an uploaded template.

---

## 4. Recommended increments

Each increment is shippable on its own and ends with tests and the snapshot check.

| # | Increment | Brief § | Size | Why first |
|---|---|---|---|---|
| 1 | **Oracle Template Manager + exact-header CSV export.** Upload an Import Management template (CSV/XLSX), parse object, technical and display headers and column order; store versioned; map canonical fields → template columns (auto-suggest by label, user confirms); export reviewed values with exact headers; show Oracle labels when Oracle mapping is selected | 10, 4 | L | Highest business value; unblocks acceptance criteria 14–17 |
| 2 | **Reviewable classification.** Persist confidence + alternatives; show type, category, evidence and alternatives in the workspace; manual override (re-stages with the chosen profile, audited); "confirm type" state for low confidence | 3 | M | Makes every later schema decision trustworthy |
| 3 | **Format coverage.** JSON, TSV/CSV delimiter + encoding detection, XLSM (no macros), ODS; ZIP with size/count/zip-bomb limits fanning out into the batch queue; EML (attachments + body) | 2, 8 | M | Low risk, directly testable |
| 4 | **Schema & Labels area.** Versioned schemas with inheritance, repeating groups, required flags and rules; "save discovered fields as a schema"; external label sets per mapping | 4, 13 | L | Builds on 1 and 2 |
| 5 | **Three-panel review.** Add a collapsible intelligence panel (classification, validation, missing fields, mapping status); sheet/cell viewer for Excel and CSV evidence | 5 | M | UX; reuses existing panels |
| 6 | **Security hardening for broader formats.** Malware scanning hook (ClamAV or provider), retention policies, tenant isolation review | 17 | M | Required before accepting ZIP/email from customers |
| 7 | Remaining categories and workspaces (resume, bank statement, NDA, lease, logistics), automation rules, dark theme, analytics additions | 3, 9, 15, 6 | L | After the platform pieces exist |

## 5. Needs a decision or authorization

- Production deploys, migrations and pushes (the brief requires explicit authorization for each).
- Real provider evaluation (Azure / Google / OCI) needs credentials, DPA/region approval and a permissioned document set (`docs/di-01-benchmark-plan.md`).
- A sample Oracle Import Management template per object (Contract, Contract Line, Contract Party, Contract Party Contact, Pricing Terms) is needed to build and test increment 1. The repository has mapping drafts, not downloaded templates: `reference/schemas/Oracle_Fusion_Package_Index.xlsx` lists the target objects and required setup, and `FAR_Part_52_Oracle_Transformation_Ready_v4.xlsx` has a clause mapping sheet. The contract mapping workbooks it refers to (`FA30_Oracle_Contract_Mapping.xlsx`, `47QRC_Oracle_Contract_Mapping.xlsx`) are not in the repository.
- DI-02 B-007 (the "Verified" label) is still open.
