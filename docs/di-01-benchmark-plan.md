# DI-01 — Benchmark and Qualification Plan

**Status:** plan · **Date:** 2026-10-26
**Measurements taken in DI-01:** none for extraction accuracy. The only measurement recorded is the existing automated test suite result (see current-state audit appendix). Every metric table in this plan is intentionally empty until measured. No figures may be quoted externally from this plan.

## 1. Existing assets to reuse

| Asset | Use |
|---|---|
| `backend/scripts/invoice_validation_report.py` | Core harness: runs the real local pipeline per file; with `--truth`, scores each value Correct/Incorrect × Verified/Needs Review/Missing; "Incorrect + Verified" is already defined as the release blocker; writes reports outside the repo. |
| `backend/tests/fixtures/invoices/` (6 fictional) | Smoke set and harness self-test only — not representative. |
| `reference/regression/` contracts | Contract profile regression (separate from DI benchmark). |

## 2. Dataset governance

- **Permissioned only.** Each document has a recorded source, owner consent and allowed use ("benchmark, local processing only" / "may be sent to provider X").
- **Never committed to git.** Stored in an access-controlled location outside the repo; manifests (hashes, labels, metadata) may be versioned privately.
- **Restricted classes** (ID, bank, health): use specimen/synthetic documents first (e.g. ICAO specimen MRZs, bank-issued test cheques, generated statements). Real samples only with written consent, local-only processing, and deletion after use.
- **Splits are frozen.** `dev` (tuning allowed), `held-out qualification` (no tuning, no viewing of errors by the people tuning rules), and `post-correction` (for learning evaluation).
- Ground truth double-keyed by two annotators; disagreements adjudicated; label guide versioned.

## 3. Invoice set

### Phase A — development set
**5 invoices × 10–20 suppliers (50–100 documents)**, chosen for variety:

| Dimension | Coverage target |
|---|---|
| Source | native PDF, scanned PDF, phone photo, HTML/email body |
| Type | PO-backed goods, services (non-PO), utility, subscription, credit memo |
| Layout | single page, multi-page with line continuation, borderless tables |
| Currency/tax | USD + ≥ 1 non-USD; VAT and US sales tax; freight/discount lines |
| Quality | ≥ 10 % low-quality scans (skew, stamps, handwriting annotations) |

### Phase B — held-out qualification set
Proposed minimum **300 invoices from ≥ 40 suppliers**, of which **≥ 15 suppliers not present in Phase A**, sampled from real AP intake proportions; **≥ 30 known duplicates or near-duplicates** and **≥ 30 PO-mismatch cases** inserted to measure exception detection. Size to be confirmed with the business against target confidence intervals (e.g. for a false-acceptance rate near 0.5 %, several hundred fields per critical field class are needed for a meaningful upper bound).

### Truth schema (per document)
Header fields (canonical ids), lines (description, qty, unit price, amount, PO line), taxes/charges, totals, supplier id + site id (from tenant master), PO number(s), BU (expected derivation), duplicate-of (doc id or none), expected exceptions.

## 4. Other document types (initial sets)

| Profile | Initial set | Notes |
|---|---|---|
| Passport/ID | 50 specimen/synthetic MRZ + VIZ images (incl. 10 deliberately corrupted check digits) | Real passports excluded until security baseline (DI-07) |
| Cheque | 50 test cheques (incl. invalid routing, amount mismatch, duplicates) | Synthetic/bank test items |
| Bank statement | 20 statements from ≥ 5 banks | Synthetic or consented, masked |
| Transcript | 30 transcripts from ≥ 10 institutions, incl. ≥ 5 with printed grading key | GPA recompute only where scale is known |
| Receipts, PO, insurance, logistics | 30 each | When profiles exist |

## 5. Metrics

| Metric | Definition |
|---|---|
| Classification accuracy | correct profile / documents; plus confusion matrix |
| Field precision | correct extracted values / extracted values (non-missing) |
| Field recall | correct extracted values / truth values present |
| Normalised exact match (NEM) | value equals truth after field-type normalisation (dates ISO, money to 2 dp + currency, ids uppercase without spaces/punctuation where the profile says so) |
| Line-item accuracy | line-level F1 using matching on (description similarity, amount); plus % documents with all lines exactly correct |
| Supplier match accuracy | correct supplier id (and site id) / documents |
| PO match accuracy | correct PO (and PO line) / PO-backed documents |
| Exception detection | recall and precision for duplicates, PO mismatches, arithmetic errors |
| **False acceptance rate (FAR)** | incorrect values marked Evidence-verified (or auto-accepted) / all values marked Evidence-verified — **primary safety metric** |
| Human review rate | fields (and documents) routed to Needs Review / total |
| Straight-through processing (STP) rate | documents with zero required human touches under the profile review policy / documents — reported **only together with FAR** |
| Latency | p50/p95 end-to-end and per stage (from `recognition_runs`) |
| Cost per document | provider charges (from usage records) + compute estimate; local-only reported as compute only |
| Improvement after corrections | Δ of NEM, FAR and review rate on the post-correction split between hint set vN and vN+1 |

Report every metric with **n**, per profile, per supplier (invoices), per source quality band, and with 95 % confidence intervals (Wilson for proportions).

## 6. Procedure

1. Freeze pipeline version, profile versions, hint set version, provider/model versions; record in the run manifest.
2. Run harness on `dev`; iterate.
3. Run once on `held-out`; no changes between run and report.
4. For providers under evaluation: run only on documents whose consent allows that provider; same truth, same scorer.
5. For learning: apply corrections from `dev` only; evaluate on `post-correction` split.
6. Publish the report (internal) with manifest, metrics tables, error taxonomy, and every "Incorrect + Verified" case listed.

## 7. Harness extensions needed (DI-04)

- Generalise `invoice_validation_report.py` to any profile; JSON truth schema per profile.
- Isolated run database (never the developer's working DB or production).
- Metrics module (precision/recall/NEM/line F1/FAR/STP/CIs) with unit tests.
- Latency/cost capture from `recognition_runs`.
- Diff report between two runs (regression gate in CI on the synthetic set).

## 8. Results tables (to be filled only from runs)

| Run | Date | Set | n docs | Classification | Field NEM | Line F1 | Supplier | PO | FAR | Review rate | STP | p95 latency | Cost/doc |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| — | — | — | — | — | — | — | — | — | — | — | — | — | — |
