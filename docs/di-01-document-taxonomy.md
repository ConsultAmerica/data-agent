# DI-01 — Document Taxonomy and Profile Contract

**Status:** design proposal (not implemented) · **Date:** 2026-10-26
**Builds on:** `backend/app/staging/profile.py` (`StagingProfile`), `backend/app/staging/registry.py`, `backend/app/services/structure_detection.py` (`DOCUMENT_FAMILIES`).

## 1. Principle

Every document type is a **configurable profile**, not a new pipeline. Today a `StagingProfile` already declares datasets, fields (stable `canonical_field` ids), grounding, simple rules, recognisers, views and exports. DI-01 extends this contract with five policy blocks that are currently missing: **extraction strategy, validation set, evidence requirements, security classification and review policy**. Adding a document type must remain "a registration, not an engine change" (`profile.py:1-8`).

## 2. Extended profile contract

```text
DocumentTypeProfile  (new, wraps StagingProfile; versioned as <id>@<n>)
├─ identity            profile_id, version, display_name, document_families, parent_category
├─ schema              datasets → fields (existing DatasetDefinition / FieldDefinition)
├─ extraction_strategy ordered provider steps (see target architecture §4)
│                      e.g. [native_text, local_ocr, mrz_parser, layout_tables, llm_structured?]
│                      + per-step: required?, timeout_s, max_attempts, allowed_data_classes
├─ validation          validator ids + parameters (see validation-rules doc)
│                      split into: internal_validity[] and external_verification[] (never merged)
├─ evidence            per field: grounding (evidence|derived|system|none),
│                      geometry_required (bbox), min_ocr_confidence, cross_source (e.g. MRZ↔visual)
├─ security            data_class (see §4), redaction_fields[], log_mask_fields[],
│                      external_processing: forbidden | approval_required | allowed,
│                      retention_days, export_permission
└─ review_policy       straight_through: bool, auto_accept_min (per field class),
                       mandatory_review_fields[], dual_control (two-person) fields[],
                       sample_rate for STP QA, escalation roles
```

Rules:

- `canonical_field` ids are permanent integration keys; labels may change, ids may not.
- A profile version bump never changes stored values of documents pinned to the old version (existing behaviour, `document_staging_workbooks.profile_version`).
- `external_processing` defaults to **forbidden** for Restricted classes and **approval_required** for Confidential.
- Review policy is evaluated by the engine; profiles declare, they do not implement.

## 3. Taxonomy

Legend for **Current**: ✅ registered profile · ◐ keyword family only (falls back to generic) · ✗ none.

| # | Category | Document types (initial) | Current | Data class | Primary extraction strategy | Key validators | Default review policy |
|---|---|---|---|---|---|---|---|
| 1 | Invoices & utility bills | Supplier invoice, credit memo, utility bill, service/subscription invoice | ✅ `invoice@1` (invoice only) | Confidential (Financial) | native/OCR → layout tables → labelled-block + alias resolution → optional LLM gap-fill | arithmetic, currency, supplier resolution, PO format/match, duplicate, BU derivation, utility period/meter rules | STP allowed after qualification; totals, supplier, PO, bank details mandatory review until qualified |
| 2 | Purchase orders & requisitions | PO, change order, requisition | ◐ `purchase_order` family | Confidential | native/OCR → line tables | line arithmetic, PO number format, buyer/BU, ship-to | Review all until qualified |
| 3 | Receipts & expenses | Retail receipt, card slip, hotel folio, mileage claim | ✗ | Confidential (Financial) | OCR → receipt layout → optional prebuilt receipt model | total = items + tax + tip, date not future, merchant category, duplicate claim | Sample-based for low value; mandatory over policy threshold |
| 4 | Contracts & legal | Gov contract (SF1442/26/33), FAR/DFARS text, MSA, amendments | ✅ `contract_v3@1`, `far_part_52@1`, `far_regulatory_change@1` | Confidential | existing contract_structure + V3 | clause references, NAICS, ceilings, periods | Existing behaviour |
| 5 | Banking | Cheque, bank statement, deposit slip | ✗ (`statement` family ◐) | **Restricted (Banking)** | image OCR → **MICR E-13B parser** → amount boxes; statements: layout tables | ABA checksum, MICR fields, numeric↔written amount, running-balance arithmetic, duplicate cheque | Mandatory review; account numbers masked in UI by default |
| 6 | Identity | Passport, national ID, driver licence, residence permit | ✗ | **Restricted (Identity)** | image OCR → **MRZ parser (ICAO 9303)** → visual-zone fields | MRZ check digits, MRZ↔VIZ consistency, dates, ISO 3166 country codes | Mandatory review; never STP; dual control for exports |
| 7 | Academic | Transcript, degree certificate, diploma | ✅ `academic_transcript@1` (transcript) | Restricted (Education) | layout tables + transcript vocabulary | credit arithmetic, GPA recompute (known scale only), term ordering, award metadata | Mandatory review of GPA/award; certificates external-verify only |
| 8 | Insurance | Certificate of insurance (ACORD 25), policy declaration, claim form | ✗ | Confidential | OCR → form/checkbox layout | policy dates, coverage limits ≥ contract minimums, insured name match | Review all |
| 9 | Healthcare forms | Claim (CMS-1500/UB-04), intake, prescription, lab report | ✗ (`laboratory_report` family ◐) | **Restricted (Health/PHI)** | local-only OCR + forms; external processing forbidden by default | NPI Luhn, ICD-10/CPT code shape, dates, totals | Mandatory review; minimum-necessary display |
| 10 | HR | Offer letter, W-4/I-9 support, payslip, timesheet | ✗ | Restricted (PII) | OCR + forms | pay arithmetic (gross − deductions = net), date logic, SSN masking | Mandatory review |
| 11 | Tax | W-9, W-2, 1099 family, VAT invoice/return | ✗ | Restricted (Tax ID) | forms + box-number anchors | TIN format (masked), box arithmetic, VAT rate × base | Mandatory review |
| 12 | Logistics | Bill of lading, packing list, delivery note, customs declaration | ✗ | Internal/Confidential | layout tables | quantity reconciliation vs PO lines, weights, HS code shape | Review exceptions only after qualification |
| 13 | Custom | Tenant-defined | Partial (`extraction_model` field templates; generic profile) | Declared by tenant (default Confidential) | generic structure + declared fields | declared rules (regex, required, cross-field) | Review all |
| — | Generic fallback | Unrecognised | ✅ `generic_business_document@2` | Confidential (default) | existing | existing | Review all |

## 4. Data classification scheme

| Class | Examples | External AI/OCR | Logs | Default retention | UI display |
|---|---|---|---|---|---|
| Public | Published FAR text | Allowed | Values allowed | Tenant default | Full |
| Internal | Logistics docs | Allowed with workspace setting | Values allowed | Tenant default | Full |
| Confidential | Invoices, POs, contracts, insurance | **Approval required** (per workspace, per provider) | No values | Tenant default (e.g. 7 years for AP, tenant-set) | Full |
| Restricted | Passports, IDs, bank, health, HR, tax, education | **Forbidden** unless a signed per-tenant exception names provider, region and purpose | Never values; masked identifiers only | Shortest workable (tenant-set; e.g. 30–90 days post-decision) | Masked by default; reveal is audited |

Retention values above are placeholders for the tenant's records policy; Dataomatix must enforce whatever is configured, not choose it.

## 5. Field classes used by review policy

| Field class | Examples | Rule |
|---|---|---|
| Identifier-critical | Passport no., account no., invoice no., PO no., supplier id | Never STP before profile qualification; exact-match scoring |
| Monetary-critical | Totals, tax, cheque amount | Arithmetic must pass for STP |
| Reference | Dates, addresses, names | STP allowed when evidence-grounded and validated |
| Descriptive | Line descriptions, notes | STP allowed |
| Derived | BU, GL distribution, GPA recompute | Shown with derivation; never presented as extracted |

## 6. Classification approach

1. Keep the existing deterministic path (profile document-recognisers → keyword families → structural recognisers).
2. Add **specialised detectors** that are cheap and decisive: MRZ presence (two/three lines of 30/36/44 chars of `[A-Z0-9<]`), MICR line, ACORD form number, CMS-1500 title.
3. Optional external classifier (Azure custom classifier / Google custom classifier) only for Public/Internal/approved-Confidential documents, behind the provider policy.
4. Multi-document PDFs: add a **splitter** step (page-level classification + boundary detection) before profile resolution. Not present today.
5. Every classification records method, score, reasons and version (extend `document_staging_workbooks.resolution_reasons`).

## 7. Out of scope for DI-02

Healthcare, HR and tax profiles carry regulatory obligations (HIPAA, employment, tax-ID handling) that require a security baseline and legal review first. They are sequenced after the security gate in the backlog.
