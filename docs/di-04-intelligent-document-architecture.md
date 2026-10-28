# DI-04 — Intelligent Document Recognition: Architecture

**Status:** architecture + first implementation (local branch `feature/di-02-safety-foundation`, uncommitted)
**Date:** 2026-10-26
**Scope:** make Dataomatix extract values that are *correct*, not merely present — invoices (Oracle IDR-style lifecycle), passports and travel documents, bank cheques, academic transcripts — and automatically detect the expiry of any document.

Legend: ✅ built and tested in this phase · ◐ partly built · ⏭ designed, next phase.

---

## 1. Principles

1. **Correct, not just extracted.** Every value is checked against something independent: a second reading of the same document (passport MRZ vs printed zone), arithmetic (invoice totals, transcript GPA), or reference data (supplier master, purchase orders).
2. **Never invent.** A value without evidence (page + source text) is never accepted; validators flag, they never rewrite. An expiry date the document doesn't state is never inferred.
3. **Explain every decision.** Each check says what was compared, with what, and why it passed or needs review; every value links to the page and text it came from.
4. **Internal validity ≠ authenticity.** A passport whose MRZ check digits pass is *consistent*, not *genuine*. External verification (issuing authority, bank, registrar) is a separate, consented integration.
5. **Learn deterministically first.** Corrections become approved, auditable, reversible rules (aliases, hints) before any model training.
6. **Status mirrors reality.** Dataomatix's "Not Validated" is IDR's meaning — every expected field recognized and matched, *ready for* ERP validation. It is never shown as an ERP approval or payment.

## 2. The lifecycle (Oracle IDR equivalent)

```text
 Capture ─► Classify ─► Recognize ─► Validate & Match ─► Status ─► Review ─► Learn ─► Stage ─► Authorized ERP submit ─► Reconcile
  upload     profile     text/OCR/     arithmetic,       Incomplete  viewer,   alias     staging   (Oracle dry-run       ERP status
  batch      resolver    MRZ/tables/   MRZ, supplier,    / Not       highlight hints     workbook  today; live after     read back
  email⏭     (MRZ,       providers     PO, GPA, dates    Validated   correct   (rules)   + ERP     templates)⏭
             keywords,   (DI-03)                                                       staging
             structure)
```

| Stage | IDR behaviour | Dataomatix | Status |
|---|---|---|---|
| Capture | Invoices e-mailed to the IDR inbox | Upload (single, browser batch); e-mail/SFTP inbox | ◐ (inbox ⏭) |
| Recognition | Header + lines extracted | Deterministic layout extraction; pluggable OCR/field engines (Tesseract, Azure DI, Google Document AI, LLM) behind policy | ✅ (DI-03) |
| Supplier / site / BU | From supplier master, PO, configuration | Tax id → learned alias → exact name → similar name; site by address; BU from PO, else site | ✅ |
| PO match | Format + PO data | Configured formats; exists; same supplier; open | ✅ (lines 2-/3-way ⏭) |
| Scanned Information tile | *Incomplete* (needs attention) / *Not Validated* (all expected fields recognized) | **Recognition status** on every invoice with reasons, ERP Staging record | ✅ |
| Interactive Viewer | Highlight correct info on the invoice | Dual-pane review with evidence highlight; per-field correct; supplier match control | ◐ (draw-to-select ⏭) |
| Learning | Learns from corrections per supplier | Reviewer's supplier match → approved alias used by every later invoice; retire = rollback | ✅ layer 1 (label anchors, retrieval ⏭) |
| Invoice entry → approval → payment | Oracle Payables | Out of scope by design; ERP status read back only | ⏭ (reconciliation) |

## 3. Document intelligence by type

### 3.1 Supplier invoices ✅
- **Extraction:** invoice header, supplier letterhead (incl. name + "INVOICE" on one line), customer, references, lines (multi-page merge), charges, totals.
- **Validation:** line extension, lines vs subtotal, subtotal + tax + freight − discount = total, total − paid = due, currency conflicts.
- **Matching:** supplier master + sites + POs (§2); excluded suppliers (e.g. internal) never auto-recognized; PO Box vs street address mismatch explained (IDR's own setup guidance).
- **Outputs:** *Supplier & PO Validation* (checks), *ERP Staging* (supplier number, site, BU, invoice number/date/amount/currency, PO, recognition status). The Oracle import layout comes from the customer's FBDI/REST template — never guessed.
- **Next ⏭:** duplicate invoice fingerprints (supplier + normalized number + amount + date window), bank-details-changed block, 2/3-way line match, utility/service supplier rules (meter reads, service periods), date logic.

### 3.2 Passports, visas, ID cards ✅ (passport@1)
- **Two independent readings:** printed visual zone (labels such as *Surname / Nom*, value on the line below, in columns) and the ICAO 9303 machine-readable zone (TD1/TD2/TD3; visas use the same shapes).
- **Validation:** all MRZ check digits incl. composite; date sanity (birth < issue < expiry); validity on the processing date (Valid / Expiring soon / Expired).
- **Discrepancy detection:** field-by-field VIZ ↔ MRZ (number, names with truncation/transliteration, nationality, dates, sex, issuing state); any mismatch → *Needs Review* on both values with the exact difference.
- **Data class:** restricted — never sent to an external provider without an explicit approval.
- **Next ⏭:** visa/ID-card profiles over the same engine, ISO 3166 country list, photo/MRZ image quality checks, masking of document numbers in the UI.

### 3.3 Bank cheques ◐ (validators built; profile ⏭)
- Built: ABA routing checksum and prefix ranges, IBAN, written-amount parser (*"One thousand … and 56/100"*) with numeric/written agreement.
- Next: `cheque@1` — MICR E-13B line parsing (needs a MICR-capable OCR model or Azure *bank check*), numeric vs written amount, date staleness, duplicate cheque (routing + account + serial), account-number masking. Restricted class.

### 3.4 Academic transcripts ✅
- **Extraction:** student & program, course rows under the document's own column names, terms, summaries.
- **Validation:** total credits recalculated (earned or attempted); cumulative GPA recalculated on the **printed grading scale**, else the US 4.0 letter scale when every grade is a letter (stated as an assumption); P/S/W/I handled; unknown scale → GPA *not checked* (never guessed).
- **Output:** *Credit & GPA Checks* shown beside the Academic Summary; a stated GPA or credit total that doesn't match makes that value *Needs Review*.
- **Next ⏭:** per-term totals, repeated-course rules, institution profiles (scale per institution), degree conferral date checks.

## 4. Expiry and key-date detection (any document) ✅

### 4.1 What it finds
Every dated event a document states about itself: **expiry, valid until, renewal, termination, period end** (these can *expire*), plus due, issue and effective dates.

### 4.2 Architecture

```text
   document staged (staging/preparation.py)  ──►  app/key_dates/detector.py
                                                    │
        ┌───────────────────────────────────────────┼─────────────────────────────────────┐
        ▼                                           ▼                                     ▼
  1. MRZ (passport, visa, ID)          2. Contract schedule                3. Labelled dates in text
     ICAO expiry, confidence from         period-of-performance ends          "Date of expiry", "Valid until",
     check digits (0.99 / 0.6)            (CLINs, options, award +            "Expires on", "Renewal date",
                                          base period)                        "Termination date", "Period …
                                                                              through …", same or next line
        └───────────────────────────────────────────┼─────────────────────────────────────┘
                                                    ▼
                         dedupe per (kind, date): MRZ > schedule > text
                                                    ▼
                         document_key_dates (kind, date, label, source, page, evidence, confidence, version)
                                                    ▼
             status computed on read vs today: expired · expiring (≤ KEY_DATE_EXPIRING_DAYS, default 90) · upcoming · past
                                                    ▼
     API: GET /api/documents/{id}/key-dates · POST …/key-dates/refresh · GET /api/key-dates?status=expiring&within_days=90
                                                    ▼
     UI: expiry tag on every document header · Expirations page (needs attention / expired / expiring / later), evidence links
```

### 4.3 Accuracy rules
- A date is taken only next to an expiry-type label (or from an MRZ / contract schedule) — a stray date is never an expiry.
- Ranges ("01/01/2026 through 12/31/2026") yield the end; month-year forms ("VALID THRU 08/27") resolve to the end of that month for end-type dates.
- Ambiguous numeric dates read month-first (US) unless the first number can only be a day; dotted dates are day-first.
- Detection is versioned (`key-dates-v1`); rows from an older extractor are recomputed on read.

### 4.4 Next ⏭
Notifications (daily digest e-mail / webhook / Teams) at configurable horizons (90/60/30/7 days); per-tenant horizon by document type; owner assignment; renewal workflow (link the renewed document, close the alert); calendar export (ICS).

## 5. Learning from corrections

| Layer | What | Status |
|---|---|---|
| 1. Approved aliases & hints | A reviewer matches an invoice to a master supplier → the printed name becomes an approved alias (actor, document, time); every later invoice printing it matches automatically; *retire* rolls it back | ✅ (aliases); label anchors per supplier ⏭ |
| 2. Retrieval of reviewed examples | How a field was found on this supplier's last reviewed invoices, tenant-scoped | ⏭ |
| 3. Model training | Custom extraction models (Azure / Google) only after replay evaluation beats the baseline | ⏭ |

Every learned rule is auditable (who, from which document), reversible, and never learned from bank details.

## 6. Readiness checklist (adapted from Oracle IDR guidance)

| IDR guidance | Dataomatix setting / action |
|---|---|
| ≥ 5 invoices from each of your top 10–20 suppliers to test | Benchmark plan Phase A (`docs/di-01-benchmark-plan.md`); `scripts/invoice_validation_report.py --truth` |
| Supplier names and **site addresses** match what invoices print (PO Box vs street) | Load the supplier master: `POST /api/reference/suppliers` (sites with exact remit addresses); mismatches are reported per invoice |
| PO format on invoices matches Procurement | `INVOICE_PO_FORMATS` (regex list); load open POs: `POST /api/reference/purchase-orders` |
| Exclude suppliers that shouldn't be recognized (internal) | `excluded_from_recognition: true` on the supplier |
| Variety of invoices in the test group | Use the demo set + your own (`backend/demo/`) |
| Scanners: TIFF/PDF, CCITT G4, 300 dpi, adaptive thresholding, Letter/A4, correct orientation | Same guidance; Dataomatix OCR runs at 300 dpi (`OCR_DPI`), deskews degraded pages, accepts TIFF/PDF/PNG/JPG |
| How the business unit is derived | From the PO, else the supplier site's BU |
| How lines are recognized | Line tables merged across pages; 1 row = 1 line |
| Tax and freight | Shown as charges with arithmetic checks |
| Service and utility suppliers | ⏭ utility rules (service period, meter reads) |

## 7. Demo environment

`docs/demo-walkthrough.md` — three documents (invoice, passport, transcript) plus expiry, all fictional, seeded with `backend/scripts/demo_seed.py` against any backend.

## 8. What is not claimed
No authenticity verification; no automatic model retraining; no Oracle approval or payment status; no accuracy figures — those come from the benchmark on a permissioned document set.
