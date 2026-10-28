# DI-01 — Extraction Provider Evaluation

**Status:** desk evaluation only · **Date:** 2026-10-26
**No provider was activated, called or sent any document during DI-01.** All cost, accuracy and latency figures for external providers are to be measured in the benchmark (see `di-01-benchmark-plan.md`). Vendor capability statements below reflect public product documentation as known to the assessor and must be re-confirmed against the vendor's current documentation, price list and data-processing terms before any procurement decision.

## 1. Current providers (measured from code, not from claims)

| Provider | Kind | Locality | Status in code | Strengths | Limits |
|---|---|---|---|---|---|
| PyMuPDF native text | Text layer | Local | Implemented | Exact text, fast, free | No text for scans |
| Tesseract (MuPDF / pytesseract) | OCR | Local | Implemented, `eng` only | No data egress; word boxes + confidence | Weaker on low-quality scans, handwriting, MICR font, dense tables; one language configured |
| pdfplumber / OpenCV raster grids | Tables | Local | Implemented | Deterministic, explainable | Borderless/complex tables |
| `source_structure` | Layout regions, KV, tables | Local | Implemented | Schema-neutral, provenance-rich | Rule-based; per-layout tuning |
| Gemini (`gemini-3.6-flash` default) | LLM | External | Implemented, default AI | Flexible gap-fill | Data egress; per-run model tracking only; no cost tracking; grounding check weak (see audit §6) |
| OpenAI / Ollama / Convera | LLM | External / local (Ollama) | Implemented | Fallback options; Ollama keeps data local | Same grounding/tracking gaps |

## 2. Candidate providers

### 2.1 Azure AI Document Intelligence

| Aspect | Assessment |
|---|---|
| Relevant models | Read/Layout (OCR, tables, selection marks), prebuilt invoice, receipt, ID document (incl. passport MRZ), US bank check, US bank statement, tax forms, health insurance card, contract; custom extraction (template/neural); custom classifier |
| Output fit | Word/line polygons, tables, typed fields with per-field confidence → maps directly to `RecognitionResult` |
| Learning | Custom models trained on labelled tenant samples — supports Learning layer 3 |
| Data handling | Regional deployment; containers available for some models (verify current list) → potential local processing for Restricted classes |
| Risks | Prebuilt model coverage varies by locale/country; versions change (`model_version` must be pinned and recorded); cost per page |
| Fit | **Strong** for invoices/receipts/IDs/cheques where policy allows; best candidate for first external provider |

### 2.2 Google Cloud Document AI

| Aspect | Assessment |
|---|---|
| Relevant processors | OCR, Form Parser, Layout Parser, Invoice parser, Expense parser, identity document processors (availability by country/allow-list), custom extractor (incl. generative), custom classifier, splitter |
| Output fit | `Document` object with pages, tokens, entities, bounding polys, confidence → maps to `RecognitionResult` |
| Learning | Custom extractor / uptraining |
| Data handling | Regional (US/EU) endpoints; verify data-use terms |
| Risks | Some processors are limited-access; processor versions must be pinned |
| Fit | **Strong** alternative; useful as second opinion in consensus and for splitter/classifier |

### 2.3 Oracle Fusion Cloud IDR (benchmark, not a provider)

IDR is Oracle Payables' embedded invoice recognition service. It is the **workflow benchmark** for invoices (see parity matrix), not a pluggable extraction engine for Dataomatix: its output lands in Oracle Payables, not in an API Dataomatix would call. Treat it as the comparison baseline, and as the system Dataomatix must not misrepresent (no claim that Dataomatix staging equals IDR recognition or Payables approval).

### 2.3a OCI Document Understanding (provider — added after DI-03)

Oracle Cloud Infrastructure's document service is a callable API, unlike IDR: `analyzeDocument` (API `20221109`) returns words, lines, tables and — for prebuilt types such as `INVOICE` and `PASSPORT` — key values with normalised-vertex geometry. Adapter: `backend/app/recognition/providers/oci_document.py` (provider id `oci_document`), signed with an OCI API key, disabled until configured, subject to the same policy and budget as Azure/Google. Relevant for tenants whose cloud estate is OCI or whose data-residency terms already cover an OCI region. Its output is **not** IDR recognition and implies nothing about Payables status.

### 2.4 Specialist / local engines

| Engine | Purpose | Locality | Notes |
|---|---|---|---|
| **MRZ parser** (ICAO Doc 9303 TD1/TD2/TD3, MRV-A/B) | Passport/ID machine-readable zone | Local, deterministic | Small, fully testable; implement in-house or adopt a permissively licensed library after licence review. MRZ OCR quality is the risk: use a constrained character set `[A-Z0-9<]` and OCR-B tuned settings. |
| **MICR E-13B parser** | Cheque routing/account/serial | Local | Tesseract has no reliable E-13B model by default; needs a dedicated trained model or an external cheque model (Azure bank check). Evaluate. |
| **ABA routing checksum** | Validation | Local | Deterministic (see validation rules). |
| **Number-to-words / words-to-number** | Cheque amount consistency | Local | Deterministic; locale-aware. |
| **Layout/table models (local)** | Complex tables | Local | Candidate open models (e.g. table-structure recognisers) — evaluate licence, CPU cost, and accuracy vs pdfplumber on the benchmark. |
| **Ollama local LLM** | Gap-fill without egress | Local | Already integrated; candidate for Restricted classes if quality is sufficient. |

### 2.5 Others considered

AWS Textract (forms/tables/expense/ID/lending) is functionally comparable. `boto3` is already in requirements but unused. It is a reasonable third option if the tenant's cloud estate is AWS. No integration is proposed until a tenant needs it.

## 3. Evaluation criteria and scoring template

Scores to be filled **only from benchmark measurements**. Placeholders are deliberately empty.

| Criterion | Weight | Local stack | Azure DI | Google DocAI | OCI Document | LLM gap-fill |
|---|---|---|---|---|---|---|
| Field exact-match (invoice header) | 20 | — | — | — | — | — |
| Line-item accuracy | 15 | — | — | — | — | — |
| False acceptance rate (lower better) | 20 | — | — | — | — | — |
| Evidence geometry quality | 10 | — | — | — | — | — |
| Latency p50/p95 | 5 | — | — | — | — | — |
| Cost per document | 10 | — | — | — | — | — |
| Data-residency / policy fit | 15 | — | — | — | — | — |
| Version stability / pinning | 5 | — | — | — | — |

## 4. Recommendation (for approval, not activation)

1. **DI-02 builds the interface, not the vendors**: `RecognitionProvider`, `recognition_runs`, policy check, MRZ parser, ABA checksum — all local, no external activation.
2. **First external adapter** (Azure DI or Google DocAI) is built behind a disabled-by-default flag and exercised only on **synthetic or explicitly permissioned non-sensitive** documents, after: (a) provider approval workflow exists, (b) DPA/region review is signed off, (c) budget caps exist.
3. Restricted classes (identity, banking, health) stay **local-only** unless a tenant signs a documented exception.
4. Fix grounding before adding providers: a value is accepted only if it (or its normalised form) is located in the evidence span; quote-only matches become Needs Review.

## 5. Information needed from the business

- Cloud estate and preferred region(s) (Azure / GCP / AWS / OCI).
- Whether any tenant data may leave the platform at all, by data class.
- Expected monthly volumes per document type (drives cost model).
- Procurement constraints (existing enterprise agreements).
