# DI-05 — Proposed Features: Multi-Cloud Recognition and Post-Recognition Automation

**Status:** proposal · **Date:** 2026-10-27
**Scope:** Azure and Oracle document recognition alongside Google Document AI. Supplier invoices, passports and academic transcripts as the three lead use cases, plus a hand-off to RPA after recognition.
**References:**
- [Google Cloud Document AI — Try Document AI](https://docs.cloud.google.com/document-ai/docs/try-docai): processor catalogue and console try-out (benchmark for processor coverage).
- [KEYENCE RPA](https://www.keyence.com/products/software/rpa/rk/lp/207447003.jsp): reference for automating repetitive business steps *after* recognition (keying into ERP screens, filing, notifications).

Vendor capabilities below are summarised from public product documentation. Check each one against the tenant's region and the current API version before quoting it commercially. No accuracy figures appear here. Those come only from the DI-01 benchmark.

## 1. Recognition providers

| Provider | Id | Status | Prebuilt fields mapped | Notes |
|---|---|---|---|---|
| Local (native text, Tesseract, MRZ) | `native_text`, `tesseract`, `mrz` | ✅ DI-03 | MRZ (passport) | Always allowed; first in every strategy |
| Azure AI Document Intelligence | `azure_di` | ✅ DI-03 | `prebuilt-invoice`, `prebuilt-idDocument` | REST `2024-11-30`, async submit → poll |
| Google Cloud Document AI | `google_docai` | ✅ DI-03 | Invoice parser | REST v1, one processor per config |
| **OCI Document Understanding** | `oci_document` | ✅ **added** | `INVOICE`, `PASSPORT` key values | REST `20221109`, synchronous; OCI API-key signing, no SDK |
| LLM gap-fill | `llm` | ✅ DI-03 | Wanted fields only | Re-grounded by the engine |

All external providers stay **off until configured**. They are subject to `EXTERNAL_AI_POLICY` and provider approvals per data class (`app/recognition/policy.py`) and to `RECOGNITION_BUDGET_USD_PER_DOCUMENT`. Every value they return is re-grounded against the platform's own text layer before acceptance.

The invoice strategy is now: native → Tesseract (no text) → Azure → Google → **OCI** → LLM. Each external step runs only while wanted fields are still missing. Any one of them can also serve as `OCR_ENGINE` for scanned pages.

### OCI configuration

`OCI_DOCUMENT_REGION`, `OCI_DOCUMENT_COMPARTMENT_ID`, `OCI_DOCUMENT_TYPE` (unset = layout only; `INVOICE` | `PASSPORT`), `OCI_DOCUMENT_LANGUAGE`, `OCI_TENANCY_OCID`, `OCI_USER_OCID`, `OCI_KEY_FINGERPRINT`, `OCI_PRIVATE_KEY_FILE`, `OCI_PRIVATE_KEY_PASSPHRASE`, `OCI_DOCUMENT_PRICE_PER_PAGE_USD`.

### Oracle boundary (unchanged)

OCI Document Understanding is an extraction API. **Oracle Fusion IDR** remains the workflow benchmark and is not a provider (see `di-01-oracle-idr-parity-matrix.md`). An `oci_document` result never means that Oracle Payables has validated, approved or paid an invoice.

## 2. Proposed features by use case

### 2.1 Supplier invoice: extraction, supplier/PO validation, evidence highlighting, ERP staging

| Feature | Provider role | Phase |
|---|---|---|
| Header + line extraction with per-field evidence boxes | Any provider; geometry kept in `pdf_points`/`ocr_pixels` | ✅ DI-03 |
| Cross-provider agreement badge (agreed / single / conflict) | Engine merge already computes it; surface in viewer | DI-05 |
| Line items from Azure `Items` / Google `line_item` / OCI `LINE_ITEM_GROUP` | Map to `invoice.line.*` with row evidence | DI-05 |
| Supplier match (aliases, tax id, remit-to) and PO validation | Local; provider supplies raw values only | DI-06 / DI-07 |
| ERP staging → Oracle REST/FBDI dry-run → authorised send | Local; Oracle layout from customer template | DI-07 |

### 2.2 Passport: field extraction, MRZ validation, discrepancy detection

| Feature | Provider role | Phase |
|---|---|---|
| Visual-zone fields from Azure `prebuilt-idDocument` / OCI `PASSPORT` | Mapped to `identity.*`; restricted class, so approval required | ✅ adapters |
| MRZ parse + ICAO check digits | Local `mrz` only; never sent out for validation | ✅ DI-03 |
| Printed vs MRZ vs provider discrepancy table | Compare all three sources per field; disagreement = Review | DI-05 |
| No authenticity claim | UI wording: "internally consistent", never "verified genuine" | DI-04 rule |

### 2.3 Academic transcript: course extraction, credit calculations, GPA validation

| Feature | Provider role | Phase |
|---|---|---|
| Course tables (code, title, credits, grade, term) | Table output from Azure layout / Google / OCI `TABLE_EXTRACTION` as an alternative to local table detection on scans | DI-05 |
| Credit totals and GPA recomputation | Local deterministic (`transcript_checks.py`); provider values never trusted for totals | ✅ / DI-05 |
| Grade-scale profiles per institution | Learned from approved corrections | DI-06 |

## 3. Features borrowed from Google Document AI's processor catalogue

These are worth matching where a provider (or a local engine) offers an equivalent. Each one is listed with the provider that would supply it.

| Capability | Google | Azure | OCI | Dataomatix proposal |
|---|---|---|---|---|
| Document classifier | Custom classifier | Custom classification model | `DOCUMENT_CLASSIFICATION` feature | Second opinion for profile resolution when local confidence is low (DI-02 routing) |
| Splitter (multi-doc PDFs) | Custom splitter | Classifier with page splitting | — | Batch upload splitting before profile resolution |
| Layout / form parser | Layout parser, Form parser | `prebuilt-layout`, key-value pairs | Text + table + generic key-value | Already the OCR/layout step; add generic key-value as review hints only |
| Custom extractor | Custom extractor (Workbench) | Custom neural/template models | Custom key-value models | Learning layer 3: train only after replay beats baseline (DI-06) |
| Human review | Human-in-the-loop (legacy) | — | — | Ours: interactive review + correction history (DI-05) |
| "Try it" upload | Console demo | Studio | Console | Provider comparison panel: run one sample through each configured provider and show the fields side by side (admin only, permissioned samples) |

## 4. Post-recognition automation (RPA hand-off)

KEYENCE RPA and similar tools automate screen-level steps once data exists. Dataomatix should **feed** RPA, not replace it:

1. **Reviewed-data outbox**: emit an event (webhook / queue) when a document reaches *Reviewed* or *Ready to submit*. The payload holds reviewed values only, with the document id and checksum.
2. **Stable export API**: an RPA bot pulls the staging workbook (JSON/CSV/XLSX) by document id or saved view, and never scrapes the UI.
3. **Write-back endpoint**: the bot posts the outcome (ERP document number, rejection message), which becomes a reconciliation event with actor `rpa:<bot id>`.
4. **Guardrails**: RPA uses a scoped service account with no review or approval permission. It can't send anything that hasn't been reviewed, and idempotency keys prevent double entry.

Phase: DI-07 (inbox and routing), with the service-account scope in DI-08 (security).

## 5. Acceptance gates for this proposal

| Gate | Evidence |
|---|---|
| OCI adapter correct without network | `tests/test_recognition_engine.py::test_oci_*` (MockTransport; signature verified against the public key) — **passing** |
| No external call without config + policy + budget | Existing engine/policy tests cover `oci_document` via the registry |
| Provider choice is measured | Benchmark scores filled for Azure / Google / OCI on the permissioned set before any default is changed |
| No unsupported claims | No "verified passport", "Oracle approved" or accuracy number appears in the UI without evidence |
