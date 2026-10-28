# DI-01 — Correction-Based Learning Design

**Status:** design proposal · **Date:** 2026-10-26
**Current state (verified):** corrections are stored (`backend/app/models/target_correction.py`, `api/target_corrections.py`; field audit in `metadata_field_audit_log`) but **nothing reads them back** for extraction. Supplier aliases are hard-coded vocabulary (`staging/profiles/invoice_vocabulary.py`). There is no embedding, retrieval or training code; `pgvector` is in requirements but unused. **Dataomatix does not learn from corrections today, and no document may claim it does.**

## 1. Three layers

| Layer | What it learns | Mechanism | Scope | Risk | Phase |
|---|---|---|---|---|---|
| 1. Approved aliases & deterministic hints | Supplier name variants, label anchors (e.g. "Bill Ref." = invoice no. for supplier X), PO regex, default site/BU | Correction → **proposal** → human approval → versioned hint used by deterministic extractors and matchers | Tenant (optionally per supplier) | Low; explainable; reversible | DI-06 |
| 2. Retrieval of reviewed examples | "How was this field found on this supplier's last 5 reviewed invoices?" | Tenant-scoped store of reviewed (value, evidence, layout signature); retrieved as hints for anchoring and as few-shot context for an *approved* LLM step | Tenant | Medium (data reuse, leakage across suppliers) | DI-08 |
| 3. Optional model training | Custom extraction/classification models (e.g. Azure DI custom neural, Google custom extractor, or local model) | Offline training on approved, labelled sets; promoted only after held-out evaluation beats baseline | Tenant | High (cost, drift, data egress) | DI-10, only if layers 1–2 insufficient |

## 2. Correction provenance (prerequisite, DI-02)

Each correction record must carry:

- `actor_id` (authenticated) and role — currently only free-text `changed_by` on the correction row;
- `reason` (free text + code: wrong value / wrong field / missing / OCR error / split-merge);
- before/after value **and** before/after evidence (page, geometry, text) — evidence snapshot exists but is client-supplied; server must validate that the referenced evidence exists on the page;
- extraction context: profile@version, provider/model, pipeline version, run id, supplier id (if resolved), layout signature;
- review policy outcome (was the field mandatory-review? was a Block overridden?).

## 3. Layer 1 lifecycle

```text
correction(s) ─► proposal generator ─► proposal (pending)
                                       │ approve (role: ap_lead / admin)
                                       ▼
                                   hint vN (active) ─► used by extractors/matchers
                                       │ rollback / retire
                                       ▼
                                   hint vN (retired), vN-1 restored
```

Proposal rules (deterministic, conservative):

- **Alias**: raw supplier text corrected to the same supplier id **≥ 2 times** from **≥ 2 documents** → alias proposal.
- **Label anchor**: the same printed label preceded the corrected value on **≥ 2** documents of the same supplier → anchor proposal (label text, relative position, value type).
- Never auto-propose from a single document; never propose bank details as an alias or hint.
- Proposals show the evidence snippets that motivated them.

Approval and controls:

- Approver ≠ the person whose corrections generated it (four-eyes) where team size allows; configurable.
- Each hint is versioned, scoped (tenant, supplier, profile version) and records approver and time.
- **Rollback**: one action retires a hint and re-validates (not re-extracts) open documents affected.
- **Kill switch** per tenant to disable all learned hints (falls back to base vocabulary).

## 4. Evaluation (required before and after activation)

| Check | Method | Pass condition (proposed; to be agreed) |
|---|---|---|
| Offline replay | Run the frozen held-out set with and without the hint set | No increase in false acceptance; field exact-match not lower on any supplier |
| Targeted gain | Supplier(s) motivating the hint | Improvement reported as measured delta, with n |
| Leakage | Hints for supplier A never fire on supplier B documents in held-out set | Zero cross-supplier firings |
| Drift monitor | Weekly: correction rate per supplier per field before/after hint | Alert if correction rate rises |

All reported improvements must be actual measurements on documented sets; no "accuracy improved by learning" claim without the replay report.

## 5. Layer 2 design notes

- Store: `reviewed_examples(tenant_id, supplier_id, profile_key, field, value_normalised, evidence_text, label_text, relative_geometry, layout_signature, embedding?)`.
- Only Accepted/Edited values, never pending or rejected.
- Retrieval keyed first by supplier + layout signature (deterministic), embeddings optional (pgvector) and tenant-partitioned.
- Restricted data classes are excluded unless the tenant enables it and the store is encrypted with the tenant key.
- Retention follows the source document's retention; deleting a document deletes its examples.
- LLM few-shot use only where the provider policy permits external processing for that data class.

## 6. Layer 3 gate

Training is considered only when: layer 1+2 replay shows a plateau on ≥ 1 profile; a labelled, permissioned training set exists with a separate held-out set; provider approval and DPA cover training use; cost estimate approved; promotion requires beating the current pipeline on false acceptance **and** exact-match on held-out data, with rollback to the previous model version.

## 7. Data model (proposed, DI-02/DI-06 migrations require approval)

- `target_corrections`: + `actor_id`, `reason_code`, `reason_text`, `context_json`.
- `learning_proposals(id, tenant_id, kind, scope, payload, source_correction_ids, status, created_at, decided_by, decided_at)`.
- `learning_hints(id, tenant_id, kind, scope, payload, version, status, approved_by, approved_at, retired_by, retired_at)`.
- `learning_evaluations(id, hint_set_version, dataset_id, metrics_json, run_at, run_by)`.
