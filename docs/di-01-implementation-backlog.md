# DI-01 — Implementation Backlog and Prioritised Build Plan

**Status:** proposal for approval · **Date:** 2026-10-26
**DI-01 stops here.** No code, migration, provider activation, Oracle call, commit, push or deployment was performed. DI-02 starts only on explicit approval.

## 1. Phase overview

| Phase | Theme | Outcome | Depends on | External activation? |
|---|---|---|---|---|
| **DI-02** | Safety fixes + recognition foundation | P0 defects closed; `RecognitionProvider` interface; per-value provenance; data classification field; local MRZ/ABA/IBAN libraries | Approval of DI-01; approval for dev migrations | No |
| **DI-03** | Invoice matching + exception inbox | Supplier master import, supplier/site resolution, duplicate fingerprints, BU derivation, PO format, exception-typed inbox, ZIP/multi-file intake | DI-02; tenant supplier master extract | No |
| **DI-04** | Benchmark baseline + PO match + first provider adapter (disabled) | Measured baseline on Phase A/B invoice sets; 2-way PO match; Azure DI or Google DocAI adapter behind flag | DI-03; permissioned invoice set; PO extract; provider DPA decision | Only on consented non-sensitive docs, after approval |
| **DI-05** | Interactive review upgrades | All-box overlays, reverse click, separate confidence indicators, evidence reselection, optimistic concurrency, reprocessing dialog/diff, gate-aware UI | DI-02 | No |
| **DI-06** | Learning layer 1 | Proposals → approval → versioned hints → rollback; replay evaluation | DI-04 baseline; DI-05 correction provenance | No |
| **DI-07** | Restricted-data security baseline + capture channels | Tenant isolation for all roles, envelope encryption, masking + reveal audit, retention jobs, append-only audit, AV scan, email/SFTP inbox | DI-02; infra decisions | No |
| **DI-08** | Identity, banking, transcript validation profiles + learning layer 2 | `passport@1`, `cheque@1`, `bank_statement@1`, transcript arithmetic; reviewed-example retrieval | DI-07 (mandatory for Restricted) | No (local-only) |
| **DI-09** | Authorised Oracle submission + reconciliation | Live REST/FBDI per customer templates, idempotency, status polling, ERP state machine | Customer Fusion interface templates; Oracle test pod credentials; explicit go-live approval | Yes — test pod first |
| **DI-10** | Taxonomy expansion + optional training | Receipts, PO, insurance, logistics profiles; healthcare/HR/tax after legal review; layer 3 training if justified | DI-07, DI-08, legal input | Per approval |

## 2. Backlog (prioritised)

Priority: **P0** safety/integrity defect · **P1** foundation for DI target · **P2** capability · **P3** later.

### DI-02 — Safety fixes and foundation

| ID | P | Item | Evidence / reason | Test criteria |
|---|---|---|---|---|
| B-001 | P0 | Remove hard-coded service key; seed default actors only when `APP_ENV` ∈ {development, test}; do not reactivate on boot; production runbook to deactivate/rotate existing actor | Security S-1 | Startup in `APP_ENV=production` creates no seeded actors; test asserts literal key absent from source; existing tests pass with test-only seeding |
| B-002 | P0 | Stop fabricating evidence: no default `page_number: 1`; values without evidence stored with `evidence=null` and can never be Verified/auto-accepted | `target_result_store.py:52-58` | Unit test: value without evidence → Needs Review, no page reference in API/exports |
| B-003 | P0 | Tighten grounding: normalised value must be located in page text (or evidence span); quote-only match → Needs Review; list/dict values validated element-wise | `source_validator.py:57-90` | Tests for each previously-passing weak case |
| B-004 | P0 | Approve/promote under RBAC permission (`review.approve`), review-mutation gate, actor identity, audit event; deprecate free-text `approved_by` | `contract_analysis.py:874-948` | 403 when gate closed / role lacks permission; audit row with actor id |
| B-005 | P0 | Fix review priority semantics (exceptions/low confidence = high urgency) or rename to `confidence_tier`; queue ordering by severity | `review_routing.py:69-86` | Ordering test |
| B-006 | P0 | Restrict server accept-all to explicit field ids satisfying review policy; admin-only bulk override with reason | `contract_analysis.py:1218-1282`; `review-queue/page.tsx:142` | Low-confidence field cannot be accepted by batch call |
| B-007 | P1 | Label machine state "Evidence-verified" in staging UI/exports; exports include human review state column | `staging/engine.py:112-143` | Snapshot tests of export headers |
| B-008 | P1 | Reviewed export `authoritative_only` default reviewed for Oracle-bound/authoritative exports; ordinary export keeps status columns | `reviewed_export.py` | Default behaviour test |
| B-009 | P1 | Audit retention: audit rows not cascade-deleted (tombstone document id); `actor_id` on classification/relationship logs and corrections; correction `reason` | audit models | Delete document → audit rows remain |
| B-010 | P1 | `RecognitionProvider` protocol, `RecognitionResult`, orchestrator wrapping existing native/OCR/source-structure/AIProvider steps — **behaviour-preserving** | target architecture §3 | Contract/V3 byte-identical regression (existing snapshot practice); invoice fixtures unchanged |
| B-011 | P1 | `recognition_runs` table; per-value `run_id`, provider, model version, pipeline version; fix fallback model mislabel | `ai_enrichment.py:243` | Every value links to a run; fallback test shows actual model |
| B-012 | P1 | `document_classification` (data class) set from profile; displayed; enforced by policy check (external steps skipped for Restricted) | taxonomy §4 | Policy unit tests |
| B-013 | P1 | `provider_approvals` table + policy check (no UI beyond admin API yet); default deny for external providers on Confidential/Restricted when tenant mode is "enterprise" | security S-3 | External step skipped with reason when no approval |
| B-014 | P1 | Local validator library: ICAO 9303 MRZ parse + check digits, ABA checksum, IBAN mod-97, Luhn/NPI, words↔number amounts | validation rules ID/BK | Reference vectors + property tests; no sensitive data needed |
| B-015 | P1 | Negative invoice tests (arithmetic, currency conflict, missing totals) | no failing-path tests today | Each check has ≥ 1 failing fixture |
| B-016 | P1 | Central `mask()` + logging filter; CI log-leak test | security §4 | Fixture identifiers never in captured logs |
| B-017 | P2 | Frontend reads review gate from `/ready`; read-only mode | interactive review §1 | Playwright: controls disabled when gate closed |
| B-018 | P0 | Make the baseline suite green and reproducible: fix order-dependent contract/clause tests, reset test DB per run, CI image with Tesseract | Baseline run 2026-10-26: 877 passed / 11 failed / 14 skipped (audit appendix) | Full suite green twice in a row, in random order, on a clean checkout |

### DI-03 — Invoice matching and inbox

| ID | P | Item | Test criteria |
|---|---|---|---|
| B-101 | P1 | Supplier master + sites import (CSV/ERP extract), tenant-scoped | Import validation tests |
| B-102 | P1 | Supplier/site resolution (tax id, remit-to, aliases, email domain, fuzzy name) with method + score | Resolution accuracy measured on Phase A |
| B-103 | P1 | Bank-details-differ Block (IN-17) | Never auto-updates master |
| B-104 | P1 | Invoice fingerprints + exact/near duplicate detection (IN-13) | Duplicate fixtures detected; no false Block on credit memos |
| B-105 | P1 | BU derivation rules (IN-14), shown as Derived | Rule-order tests |
| B-106 | P1 | PO format regex per tenant (IN-10); date logic (IN-07); tax plausibility (IN-06) | Unit tests |
| B-107 | P2 | Exception-typed inbox views + severity ordering | Playwright |
| B-108 | P2 | ZIP / multi-file intake endpoint with per-member validation, limits, and zip-bomb protection | Malformed archive tests |
| B-109 | P2 | Utility-bill rules (IN-15) + profile vocabulary | Utility fixtures |

### DI-04 — Benchmark, PO match, provider adapter

| ID | P | Item | Test criteria |
|---|---|---|---|
| B-201 | P1 | Generalised benchmark harness, metrics module, isolated DB, run manifest | Metrics unit tests; reproducible run |
| B-202 | P1 | Phase A baseline report (local stack) | Report with n, CIs, all Incorrect+Verified cases |
| B-203 | P1 | PO data import + 2-way match (IN-11) | PO-mismatch fixtures |
| B-204 | P2 | First external adapter (Azure DI or Google DocAI) behind disabled flag, re-grounding against local text, usage/cost capture | Runs only with approval record; consented docs only |
| B-205 | P2 | Phase B held-out qualification run | Gate G2 decision |

### DI-05 … DI-10

| ID | P | Item |
|---|---|---|
| B-301 | P2 | Page evidence endpoint (all boxes), thumbnails, reverse click, OCR-pixel→page conversion server-side |
| B-302 | P2 | Optimistic concurrency (`row_version`, `If-Match`, 409 UI) |
| B-303 | P2 | Reprocessing confirm dialog, diff view, blocked states |
| B-304 | P2 | Evidence reselection on edit; reason on Block override |
| B-401 | P2 | Learning proposals, approval, versioned hints, rollback, replay evaluation (DI-06) |
| B-501 | P1* | Tenant model + scope all roles; envelope encryption; masking + reveal audit; retention jobs; AV scan; CORS/HSTS/CSP; disable anonymous mode for enterprise tenants (DI-07) — *P1 before any Restricted data* |
| B-502 | P2 | Email/SFTP capture (DI-07) |
| B-601 | P2 | `passport@1`, `cheque@1`, `bank_statement@1`, transcript arithmetic (DI-08) |
| B-602 | P3 | Reviewed-example retrieval (layer 2) |
| B-701 | P2 | Oracle live submission per customer templates; idempotency; reconciliation (DI-09) |
| B-801 | P3 | Receipts, PO, insurance, logistics profiles; healthcare/HR/tax after legal review; layer 3 training (DI-10) |

## 3. Dependencies (external to engineering)

| Needed | For | Owner |
|---|---|---|
| Approval of DI-01 and permission for dev-only migrations | DI-02 | Product owner |
| Decision on production response to S-1 (rotate/deactivate) | Immediately | Product owner / ops |
| Permissioned invoice corpus (5 × 10–20 suppliers, then held-out) + truth labels | DI-04 | Business / AP |
| Supplier master and PO extracts (sanitised) | DI-03/04 | Business / Oracle admin |
| Cloud/provider preference, DPA, region, budget | DI-04 provider adapter | Business / legal |
| Fusion interface templates (Payables Invoice Import FBDI and/or REST), test pod | DI-09 | Oracle admin |
| Regulatory scope (HIPAA/GLBA/FERPA/GDPR) | DI-08/10 | Legal |

## 4. Release gates

| Gate | Before | Criteria (thresholds proposed; to be agreed with the business) |
|---|---|---|
| **G0 — Safety** | Any DI feature release | B-001…B-006 and B-018 done; full backend + frontend test suites green; contract/V3 outputs byte-identical to pre-change snapshot; no secrets in source (scan) |
| **G1 — Foundation** | DI-03 work merges to main | Every new value has run/provider/model/pipeline provenance; policy check skips forbidden external steps (tests); negative invoice tests present |
| **G2 — Invoice qualification** | Calling invoice processing "production-qualified" or enabling any STP | Held-out set measured; **zero** "Incorrect + Evidence-verified" on identifier- and money-critical fields, or an agreed FAR upper bound with CI; duplicate exact-match recall 100 % on the inserted set; STP reported only with FAR; report signed off |
| **G3 — External provider** | Sending any tenant document to an external provider | DPA + region approved; `provider_approvals` record; redaction/masking active; cost caps; kill switch tested; provider results re-grounded |
| **G4 — Restricted data** | Accepting passports, bank, health, HR, tax, education documents for a tenant | DI-07 complete; anonymous mode off for tenant; encryption + masking + reveal audit + retention verified; security review sign-off; log-leak test green |
| **G5 — Learning activation** | Enabling learned hints for a tenant | Replay shows no FAR increase and no per-supplier regression; rollback tested; approver workflow active |
| **G6 — Oracle live** | Any non-dry-run Oracle call | Customer templates implemented and validated in Oracle test pod; idempotency proven; reconciliation mapping verified against real responses; explicit written go-live approval; UI never shows Oracle approval/payment without read-back |

## 5. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| S-1 key already exposed (repo visibility unknown) | Unauthorised read/export of all documents | Rotate/deactivate now; access-log review |
| Over-reliance on STP metrics hides false acceptance | Wrong payments | FAR is primary metric; STP never reported alone |
| Real-document scarcity | Benchmarks unrepresentative | Start Phase A early; synthetic sets for Restricted classes |
| External provider data egress | Compliance breach | Policy engine + approvals before any adapter is callable |
| Vendor model drift | Silent accuracy change | Pin and record model versions; re-run benchmark on version change |
| Learning feedback loops | Errors become rules | Approval gate, minimum evidence counts, replay evaluation, rollback |
| Scope creep into Oracle Payables functions | Misrepresentation, duplicated controls | Boundary statement; ERP states only from read-back |
| Behaviour change in contract/V3 path during refactor | Regression for current users | Byte-identical snapshot diff (existing practice) in G0/G1 |
| In-process job runner under load | Lost/failed jobs | Durable queue in DI-03/04 if volumes grow; requeue on restart |
| Regulatory obligations for health/HR/tax | Legal exposure | Defer those profiles until legal scope is defined (DI-10) |

## 6. Approval request

DI-01 is complete. Requesting approval to begin **DI-02 (safety fixes and recognition foundation)** with:

- local development changes only, on a feature branch;
- development/test database migrations only (no production migration);
- no external provider activation, no Oracle live calls, no commit/push/deploy without separate instruction.

Separately, a decision is requested now on finding **S-1** (production service key), which is outside DI-01's no-change restriction and therefore has not been touched.
