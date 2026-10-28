# DI-01 — Oracle IDR-Style Workflow and Parity Matrix

**Status:** assessment + design · **Date:** 2026-10-26
**Caveat:** Oracle Fusion Cloud IDR behaviour is summarised from Oracle's public product documentation at a capability level. Exact screens, statuses and learning behaviour vary by Fusion release and tenant configuration; confirm each Oracle-column statement against the customer's release before using this matrix commercially. Nothing was sent to Oracle during DI-01 (`oracle_dry_run=True`, `backend/app/core/config.py:34`).

## 1. Boundary statement

Dataomatix prepares **reviewed, source-grounded staging data** and (later) **submits it with authorisation**. Oracle Payables owns invoice validation, holds, approval workflow, accounting and payment. Therefore:

- "Extraction complete", "Verified (evidence)" and "Reviewed" in Dataomatix **are not** Oracle invoice approval, validation or payment.
- Dataomatix shows an Oracle status only when it has read it back from Oracle (reconciliation), with the time it was read.
- Today the only Oracle send is a dry run (`backend/app/api/reviewed_export.py:375-404` returns 501 for live mode). UI correctly labels it "Dry-run — simulated" (`frontend/components/oracle-send-confirm-modal.tsx`).

## 2. Target workflow

```text
Capture → Recognition → Matching → Validation → Review → Learning → Staging
       → Authorised ERP Submission → Status Reconciliation
```

| Stage | Dataomatix responsibility | Exit criteria | Audit record |
|---|---|---|---|
| Capture | Inbox: upload, batch, ZIP, (later) email/SFTP; per-tenant routing to BU/profile | File stored, classified, checksum recorded | capture event (source, actor/mailbox, checksum) |
| Recognition | Classify/split; run profile strategy | `RecognitionResult` per step, provenance complete | `recognition_runs` |
| Matching | Supplier + site, PO, duplicate, BU derivation | Match result with method + score, or exception | match decisions |
| Validation | Internal-validity rules | All checks recorded | checks per cell |
| Review | Inbox queue, viewer, corrections, document approval | All mandatory fields reviewed; no Block unresolved | field + document review events (actor id) |
| Learning | Propose aliases/hints from corrections; approval gate | Approved hints versioned | hint approvals/rollbacks |
| Staging | Persisted workbook = single source for export/submission | Workbook persisted with review states | workbook version |
| Authorised submission | Build payload from reviewed values only; idempotency key; explicit confirm by permitted role | ERP request accepted or rejected | `erp_submissions` + integration audit |
| Reconciliation | Poll/receive ERP status; map to ERP state machine | Status mirrored with timestamp | reconciliation events |

## 3. Invoice inbox (design)

Columns: received, source, supplier (resolved / raw), invoice no., amount + currency, PO, BU (derived), processing state, exceptions (count + top type), review state, assignee, ERP state, age.

Saved views: *Needs my review*, *Exceptions: supplier*, *Exceptions: PO*, *Possible duplicates*, *Ready to submit*, *Submitted – awaiting Oracle*, *Rejected by Oracle*.

Builds on existing: review queue (`frontend/src/app/review-queue/`), saved filters, assignments (`backend/app/api/assignments.py`). Ordering must use exception severity (fix the inverted priority in `services/review_routing.py:69-86`).

## 4. Supplier recognition profiles (configurable)

Per supplier (tenant-scoped), approved by an AP lead:

- aliases (names, legal names, trading names, email domains, remit-to variants);
- identifiers (tax id, DUNS/UEI, bank last-4 for corroboration only);
- default site, BU, currency, payment terms;
- layout hints: label anchors for invoice no./PO/total when the generic vocabulary fails (e.g. "Bill Ref." → `invoice.invoice_number`);
- utility/service flags (meter, service period, account number pattern);
- PO policy (PO required / non-PO allowed / PO regex).

Today: supplier aliases are hard-coded vocabulary (`staging/profiles/invoice_vocabulary.py`, `services/discovery_enrichment.py:13`); no supplier master exists.

## 5. Exceptions taxonomy

| Code | Exception | Default severity |
|---|---|---|
| EX-SUP-NOMATCH | Supplier not found | Review |
| EX-SUP-AMBIG | Multiple supplier candidates | Review |
| EX-SUP-BANK | Bank details differ from master | Block |
| EX-SITE | Site undetermined | Review |
| EX-PO-FORMAT | PO token fails tenant format | Review |
| EX-PO-NOTFOUND / CLOSED / SUPPLIER | PO not found / closed / other supplier | Review |
| EX-PO-PRICE / QTY | Line price/qty outside tolerance | Review |
| EX-DUP-EXACT / NEAR | Duplicate invoice | Block / Review |
| EX-ARITH | Arithmetic failure | Review |
| EX-CUR | Currency ambiguous/conflicting | Review |
| EX-DATE | Date logic | Review |
| EX-BU | BU not derivable | Review |
| EX-OCR | Low OCR quality | Review |
| EX-ERP-REJECT | Rejected by Oracle (with Oracle message) | Review |

## 6. Parity matrix

Legend: ✅ implemented · ◐ partial · ✗ missing · — not applicable. Oracle column summarises vendor-documented capability (verify per release).

| # | Capability | Oracle IDR / Payables (documented capability) | Dataomatix today | Evidence | Target (phase) |
|---|---|---|---|---|---|
| 1 | Email-based invoice capture | Dedicated mailbox(es); attachments imported | ✗ | — | Inbox email/SFTP (DI-07) |
| 2 | Upload / batch capture | Via Payables/Imaging UIs | ◐ single upload + browser queue | `batch-queue.ts` | ZIP + multi-file endpoint (DI-03) |
| 3 | Header recognition | Invoice no., date, supplier, site, amount, currency, PO, etc. | ✅ deterministic invoice@1 | `invoice_v1.py` | keep; add provider steps (DI-02/04) |
| 4 | Line recognition | Lines recognised; PO-matched lines | ✅ line tables, merged across pages | `invoice_v1.py:735-950` | keep |
| 5 | Supplier + site identification | From supplier master data | ✗ (email/remit corroboration only) | `invoice_v1.py:635-643` | supplier master + resolution (DI-03) |
| 6 | BU derivation | From PO / configuration | ✗ | — | IN-14 rules (DI-03) |
| 7 | PO matching | PO-based derivation and matching in Payables | ✗ | — | 2-way match on imported PO data (DI-04) |
| 8 | Duplicate detection | Payables duplicate checks | ◐ file checksum only | `api/documents.py:126-133` | IN-13 fingerprints (DI-03) |
| 9 | Arithmetic checks | Payables validation | ✅ richer pre-submission QA | `invoice_v1.py:952-1030` | keep + negative tests |
| 10 | Exceptions queue | "Invoices requiring attention" style queues | ◐ review queue (field-level) | `review-queue/page.tsx` | exception-typed inbox (DI-03) |
| 11 | Correction UI with document image | Invoice workbench with image | ✅ dual-pane review | `review/page.tsx:920-1024` | extend (DI-05) |
| 12 | Source-linked corrections | — (implicit) | ✅ evidence snapshot stored | `models/target_correction.py` | add actor id + reason (DI-02) |
| 13 | Learning from corrections | Oracle documents supplier-level learning from user corrections | ✗ | — | layer 1 hints (DI-06), layer 2 retrieval (DI-08) |
| 14 | Audit of changes | Fusion audit | ✅ field audit; ◐ document-level | `metadata_field_audit_log.py`; approve unaudited | unified review events (DI-02) |
| 15 | Approval workflow | Payables approval rules (BPM) | — out of scope (Oracle owns) | — | never replicate; show ERP state only |
| 16 | Submission to Payables | Native | ◐ dry-run with confirm + zero-pending | `reviewed_export.py:306-451` | live REST/FBDI behind gate (DI-09) |
| 17 | Status reconciliation | Native | ✗ | — | polling + mapping (DI-09) |
| 18 | Non-invoice documents | — (IDR is AP-focused) | ✅ contracts, FAR, transcripts, XML | registry | broad taxonomy (differentiator) |
| 19 | Evidence-grounded cell states | — | ✅ Verified/Needs Review/Missing | `staging/validation.py` | differentiator |
| 20 | Explainable deterministic extraction, no egress | — (cloud service) | ✅ local OCR + rules | — | differentiator for Restricted data |

## 7. Status-mapping contract (for DI-09; to be confirmed against the tenant's Oracle REST / FBDI interface)

| Dataomatix ERP state | Set when | Source |
|---|---|---|
| authorised | Permitted role confirms submission | Dataomatix |
| submitted | Request sent; idempotency key recorded | Dataomatix |
| erp_received | Oracle returns invoice id / import request id | Oracle response |
| erp_rejected | Import rejection / validation error read back | Oracle response/poll |
| erp_validated, erp_approved, erp_paid | Read from Oracle invoice status fields | Oracle poll only |

The exact Oracle field names and the choice of REST vs FBDI (Payables Invoice Import) must come from the customer's Fusion interface templates — consistent with the standing rule that Oracle shapes are never guessed.
