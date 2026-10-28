# DI-01 — Validation Rules Catalogue

**Status:** design proposal (not implemented, except where marked "exists") · **Date:** 2026-10-26
**Engine hook:** validators emit `ValidationCheck(check, passed, message)` into `RawRecord.cell_checks` (`backend/app/staging/profile.py`), which the existing engine already turns into Needs Review (`staging/validation.py:317-323`). Validators **never rewrite** an extracted value; derived values are stored as separate, labelled fields.

## 0. Two kinds of validation — never merged

| Kind | Question answered | Example | Output label |
|---|---|---|---|
| **Internal validity** | Is the document self-consistent and well-formed? | MRZ check digits pass; line totals add up; ABA checksum passes | "Consistent" / "Inconsistent" |
| **External verification** | Does an authoritative outside source confirm it? | Passport validated against issuing state service; account verified with bank; degree confirmed with registrar | "Externally verified by <source> at <time>" or "Not externally verified" |

Dataomatix DI-02..DI-05 implements **internal validity only**. No screen, export or API may describe an internally consistent document as "authentic", "genuine", "verified identity" or "verified account". External verification is a separate future integration with its own consent and audit.

Severity: **Block** (cannot be approved without override + reason) · **Review** (Needs Review) · **Info**.

---

## 1. Passport / identity (`passport@1`, `id_card@1`)

| ID | Rule | Algorithm | Severity |
|---|---|---|---|
| ID-01 | MRZ format detected | TD3 passport: 2 lines × 44 chars; TD1: 3 × 30; TD2: 2 × 36; charset `[A-Z0-9<]` | Review if absent on a passport |
| ID-02 | MRZ check digits | ICAO 9303: map `0-9`→0-9, `A-Z`→10-35, `<`→0; weights 7,3,1 repeating; sum mod 10. Apply to document number, birth date, expiry date, optional/personal number (TD3), and the composite digit (TD3 line 2: positions 1–10, 14–20, 22–43) | Block on any failure |
| ID-03 | Date validity | birth/expiry are real calendar dates; birth < issue < expiry; century inferred against today; expiry ≥ processing date → else flag "Expired" (Info, not invalid) | Review |
| ID-04 | Country codes | issuing state and nationality are ICAO/ISO 3166-1 alpha-3 codes incl. ICAO specials (e.g. `D<<`, `GBD`, `UNO`, `XXA`) | Review |
| ID-05 | MRZ ↔ visual zone consistency | surname, given names (MRZ transliteration rules, `<` as separator, truncation allowed), document no., DOB, expiry, sex, nationality compared after normalisation | Review per mismatched field, both values shown |
| ID-06 | Document-type code | `P` (+ subtype) for passports, `I/A/C` for TD1/TD2 | Info |
| ID-07 | Image quality | MRZ OCR confidence ≥ profile threshold; glare/crop warnings | Review |
| ID-X | External authenticity | Out of scope; label "Not externally verified" | — |

Masking: document number and personal number shown as last 3–4 characters by default; never logged.

## 2. Cheques, deposit slips, statements

| ID | Rule | Algorithm | Severity |
|---|---|---|---|
| BK-01 | MICR parsed | E-13B symbols ⑆ transit, ⑈ on-us, ⑇ amount, ⑉ dash; fields routing (9), account, serial | Review if unparsed |
| BK-02 | ABA routing checksum | `3(d1+d4+d7) + 7(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10)` | Block |
| BK-03 | Routing prefix range | first two digits in 00–12, 21–32, 61–72, 80 (US). Non-US cheques use the country's own scheme or are not validated | Review |
| BK-04 | Numeric ↔ written amount | parse courtesy (numeric) and legal (words) amounts; words→number with locale, "and xx/100" cents; must be equal | Block |
| BK-05 | Date | parseable; not more than tenant-set staleness (e.g. 180 days) or future-dated beyond tolerance → flag | Review |
| BK-06 | Payee / signature presence | presence only (no signature verification) | Review if absent |
| BK-07 | Duplicate indicators | same routing + account + serial, or same account + amount + date within window, across tenant history | Block (possible duplicate deposit) |
| BK-08 | Statement running balance | opening + Σcredits − Σdebits = closing; per-row running balance where printed | Review |
| BK-09 | Statement period | transaction dates within statement period | Review |
| BK-10 | IBAN (non-US) | ISO 13616 mod-97 = 1; country length table | Block |
| BK-X | Account existence / ownership | External only (bank verification service); out of scope | — |

Masking: account number last 4 only in UI/exports unless the role has `banking.reveal` (audited).

## 3. Academic transcripts and certificates

Existing `academic_transcript@1` extracts courses, terms, credits, grades and summary GPA values **as printed**; no arithmetic exists today.

| ID | Rule | Algorithm | Severity |
|---|---|---|---|
| ED-01 | Course rows complete | code or title, credits, grade present per row | Review |
| ED-02 | Term ordering | terms parse to (year, season) and are monotonic | Info |
| ED-03 | Term credit totals | Σ course credits in term = printed term attempted/earned credits (respect "earned" = passing grades only) | Review |
| ED-04 | Cumulative credit totals | Σ term totals (+ transfer credits if printed) = printed cumulative | Review |
| ED-05 | GPA recalculation (**only when grading scale is known**) | `GPA = Σ(grade_points(grade) × gpa_credits) / Σ gpa_credits`, excluding P/F, W, I, AU, transfer and repeated-excluded rows per the institution's key; scale source must be the transcript's printed key or a tenant-approved institution profile | Review on mismatch > 0.01; **Info "not recomputed"** when scale unknown |
| ED-06 | Printed quality points | grade_points × credits = printed quality points per row | Review |
| ED-07 | Award metadata | institution name, degree, major, conferral date present; conferral date ≥ last term | Review |
| ED-08 | Institution identifier | optional match to tenant institution list (e.g. IPEDS/OPEID/CEEB codes) | Info |
| ED-X | Credential authenticity | External only (registrar/clearinghouse); out of scope | — |

## 4. Invoices (`invoice@1` exists → `invoice@2`)

| ID | Rule | Status | Algorithm / data needed | Severity |
|---|---|---|---|---|
| IN-01 | Line extension qty × unit price = amount | exists (`invoice_v1.py:911-924`) | — | Review |
| IN-02 | Σ lines = subtotal | exists (`:973-981`) | — | Review |
| IN-03 | Subtotal + tax + freight + charges − discounts = total | exists (`:985-1020`) | Make freight an explicit component in the QA message | Review |
| IN-04 | Total − paid = amount due | exists (`:1021-1026`) | — | Review |
| IN-05 | Currency determination / conflict | exists (`:1244-1275`) | — | Review |
| IN-06 | Tax rate plausibility | new | tax / taxable base within tenant tax-rate table for ship-to jurisdiction | Review |
| IN-07 | Date logic | new | invoice date ≤ processing date + tolerance; due date ≥ invoice date; payment-terms days consistent with due date | Review |
| IN-08 | Supplier resolution | new | match against tenant `supplier_master` by tax id, remit-to, bank last-4, approved aliases, email domain, name similarity; result = supplier id + site id + method + score; unmatched/ambiguous → Review | Review / Block if bank details differ from master |
| IN-09 | Supplier site resolution | new | remit-to / ship-from address → site; multiple sites → choose by PO or Review | Review |
| IN-10 | PO number format | new | per-tenant regex(es) (e.g. BU prefix + digits); extraction of PO tokens from header and lines | Review |
| IN-11 | PO match (2-way) | new | PO exists, open, same supplier; invoice lines ↔ PO lines by item/description/price; price tolerance tenant-set | Review |
| IN-12 | 3-way match | later | requires receipts data; out of DI-02 | — |
| IN-13 | Duplicate invoice | new | fingerprint = (supplier id or normalised name, normalised invoice no. [strip spaces, punctuation, leading zeros, case], amount, date); exact → Block; near (same supplier + amount ± tolerance + date ± N days, or invoice no. edit distance ≤ 1) → Review; also file checksum (exists) | Block / Review |
| IN-14 | Business-unit derivation | new | rules in order: PO's BU → bill-to address/entity map → supplier-site default → none (Review). Shown as **Derived**, with rule used | Review if none |
| IN-15 | Utility rules | new | service period start < end; meter readings: current − previous = usage; usage × rate (+ fixed charges) ≈ line amount; account number matches supplier account master | Review |
| IN-16 | Service / non-PO rules | new | non-PO invoice requires requester/cost-centre per tenant policy; recurring-amount variance vs prior periods > threshold → Review | Review |
| IN-17 | Bank details change | new | remit bank details on invoice differ from supplier master → **Block** (fraud indicator), never auto-update master | Block |
| IN-18 | Credit memo sign | new | document type credit memo ⇒ totals negative or flagged as credit | Review |

## 5. Other profiles (initial rules)

| Profile | Rules |
|---|---|
| Receipt | items + tax + tip = total; date not future; duplicate (merchant + amount + date + card last-4) |
| Purchase order | line arithmetic; PO number format; BU and ship-to present |
| Insurance certificate | policy effective < expiry; coverage limits ≥ tenant-required minimums; insured name ↔ supplier master |
| Healthcare claim | NPI Luhn (prefix `80840`); ICD-10 / CPT/HCPCS code shape; charges sum = total |
| Payslip | gross − Σ deductions = net; YTD ≥ current; pay period dates |
| Tax forms | TIN format (masked); box arithmetic; VAT = rate × base |
| Logistics | quantities vs PO lines; gross ≥ net weight; HS code shape |

## 6. Cross-cutting rules

| ID | Rule | Notes |
|---|---|---|
| X-01 | Evidence required | No evidence span ⇒ value cannot be Verified; never default page 1 |
| X-02 | Value-in-evidence | For AI- and externally-produced values: the normalised value must be located in its evidence span; quote-only match ⇒ rejected. **DI-02 finding:** deterministic extractors legitimately ground by their own quote (synthesised `label: value` snippets, normalised forms such as `FAR 52.232-8`), so the strict rule applies to AI/external values only (`validate_source_value(strict=True)`). |
| X-03 | OCR gate | existing (<0.80 ⇒ Review) |
| X-04 | Multi-provider disagreement | Review with both candidates |
| X-05 | Derived values | stored separately with rule id; never displayed as extracted |
| X-06 | Rule versioning | every check records validator id + version; rule change ⇒ re-validation without re-extraction |

## 7. Test requirements

Every validator ships with: positive cases, **negative cases** (today no invoice test drives an arithmetic failure), boundary/tolerance cases, malformed-input cases, and for check-digit algorithms published reference vectors (e.g. ICAO 9303 specimen MRZ) plus property-based tests.
