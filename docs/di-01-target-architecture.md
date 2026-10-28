# DI-01 — Target Architecture

**Status:** design proposal (not implemented) · **Date:** 2026-10-26
**Constraint:** preserve the existing Next.js + FastAPI + PostgreSQL/Supabase architecture, the staging engine, the review feature gates, the `public_workspace_access` core flow and the dry-run Oracle default. No production migrations are part of DI-01.

## 1. Design principles

1. **Deterministic first, external last.** Native text, local OCR and specialist parsers (MRZ, MICR) run before any external or generative provider. This matches the current rule that AI is optional enrichment (`services/ai_enrichment.py`).
2. **Provenance is mandatory.** Every value carries page, geometry, source text, provider, model version, pipeline version and run id. No value without evidence may be Verified, and no evidence may be fabricated (fixes the `page_number: 1` default in `target_result_store.py:52-58`).
3. **Machine status ≠ human status ≠ ERP status.** Three separate state machines, never collapsed into one label.
4. **Internal validity ≠ external authenticity.** A passport whose MRZ check digits pass is *internally consistent*, not *genuine*.
5. **Policy, not code, decides data movement.** A document's data class and the workspace's provider approvals decide whether any byte leaves the platform.
6. **Profiles declare; the engine enforces.** (Existing staging principle.)

## 2. Logical view

```text
             ┌──────────── Capture ─────────────┐
 Upload UI ─►│ intake API · batch/ZIP · inbox*  │  *email/SFTP later
             └───────────────┬──────────────────┘
                             ▼
                 Document + file storage (encrypted, classified)
                             ▼
        ┌──────────── Recognition orchestrator (new) ─────────────┐
        │ classify/split → resolve profile → policy check →       │
        │ run extraction_strategy steps via ProviderRegistry      │
        │   ├ native_text / local_ocr (existing)                  │
        │   ├ source_structure (existing)                         │
        │   ├ mrz_parser, micr_parser (new, local)                │
        │   ├ azure_di, google_docai (new, opt-in, gated)         │
        │   └ llm_structured (existing AIProvider, gated)         │
        │ → RecognitionResult (normalised, provenance-complete)   │
        └───────────────┬──────────────────────────────────────────┘
                        ▼
   Matching (new): supplier/site · PO · duplicate · reference data
                        ▼
   Validation (extended): profile validators → ValidationCheck per cell
                        ▼
   Staging engine (existing) → workbook with machine cell states
                        ▼
   Review (existing + extended): inbox, viewer, corrections, approval
                        ▼
   Learning (new): approved aliases/hints · reviewed-example retrieval
                        ▼
   Authorised submission (existing dry-run → later live) → reconciliation (new)
```

## 3. Recognition provider interface

The existing `AIProvider` (`services/ai_provider.py`) is LLM-shaped (prompts in, JSON out). Recognition engines return pages, words, polygons, tables and typed fields. A separate, lower-level interface is introduced; `AIProvider` is wrapped as one implementation of it.

```python
class RecognitionProvider(Protocol):
    provider_id: str            # "local_ocr", "mrz", "azure_di", "google_docai", "llm:gemini"
    capabilities: frozenset[str]  # {"ocr","layout","tables","kv","fields:invoice","mrz","micr","classify"}
    locality: Literal["local", "external"]

    def model_info(self) -> ModelInfo: ...        # name, version, region, price_ref
    async def recognize(self, request: RecognitionRequest) -> RecognitionResult: ...

@dataclass
class RecognitionRequest:
    document_id: str; run_id: str; pages: list[int] | None
    profile_key: str; data_class: str
    hints: RecognitionHints | None      # approved aliases/anchors (learning layer 1)
    deadline_s: float

@dataclass
class RecognitionResult:
    provider_id: str; model: ModelInfo; status: Literal["ok","partial","failed","skipped"]
    pages: list[PageLayout]             # words/lines with polygons + confidence, coord space
    tables: list[TableResult]
    fields: list[FieldCandidate]        # canonical_field?, raw_label, value, normalised_value,
                                        # confidence, evidence spans (page, polygon, text)
    usage: UsageRecord                  # pages billed, tokens, est_cost, latency_ms
    warnings: list[str]
```

Rules enforced by the orchestrator, not by providers:

- A `FieldCandidate` without at least one evidence span is **rejected** (not defaulted).
- External providers' values are re-grounded against the platform's own text layer where one exists; disagreement → Needs Review with both values shown.
- LLM providers may only *select and normalise* spans that exist in the text layer; free-text generation of values is not accepted as extraction (strengthens `source_validator.py`, which currently accepts a value if only the *quote* is on the page).

## 4. Routing, fallback and limits

Each profile's `extraction_strategy` is an ordered list of steps:

```yaml
invoice@2:
  steps:
    - {provider: native_text,  required: true}
    - {provider: local_ocr,    when: page_needs_ocr, timeout_s: 45, max_attempts: 1}
    - {provider: source_structure, required: true}
    - {provider: azure_di.invoice, when: "deterministic_insufficient and policy_allows",
       timeout_s: 60, max_attempts: 2, budget_usd_per_doc: <tenant-set>}
    - {provider: llm_structured, when: "still_insufficient and policy_allows", timeout_s: 45, max_attempts: 1}
passport@1:
  steps:
    - {provider: local_ocr, required: true}
    - {provider: mrz_parser, required: true}
    - {provider: azure_di.id_document, when: policy_allows}   # default: forbidden (Restricted)
```

| Concern | Design |
|---|---|
| Policy check | Before any `external` step: data class allows it **and** workspace has an active `ProviderApproval(provider, purpose, region, approved_by, expires_at)`. Otherwise step is `skipped` with reason, visible in Processing Details. |
| Timeouts | Per step (`timeout_s`) + per run deadline. Existing per-page OCR (45 s) and per-AI-attempt (45 s) limits retained. |
| Retries | `max_attempts` per step; retry only on transient classes (timeout, 429, 5xx); never on 4xx/validation. Existing circuit breaker extended per provider. |
| Fallback | Next step in list; a fallback never overwrites a value from an earlier step silently — conflicts become candidates for consensus (`services/candidate_consensus.py`). |
| Cost | `UsageRecord` per call persisted to `recognition_runs`; per-tenant monthly budget and per-document cap; step skipped when exceeded. |
| Versioning | `ModelInfo` (provider, model, api version, region) + `pipeline_version` stored per run and referenced from each value. |
| Jobs | Move from in-process `BackgroundTasks` to a durable queue (Celery/Redis is already in requirements but unused; or Postgres-backed queue) with retry counters actually incremented and requeue on restart. |

## 5. Data model additions (proposed — migrations are DI-02+ and require approval)

| Table | Purpose | Key columns |
|---|---|---|
| `recognition_runs` | One row per provider step per document run | run_id, document_id, provider_id, model_name, model_version, region, status, started/finished, pages, tokens, est_cost, error_class |
| `field_evidence` (or extend `evidence_json` schema) | Normalised evidence spans | value_id, page, coord_space, polygon, source_text, run_id |
| `document_classification` | Data class + who set it | document_id, data_class, source (profile/auto/user), set_by, set_at |
| `provider_approvals` | External processing consent | workspace, provider_id, purpose, region, approved_by, approved_at, expires_at, revoked_at |
| `supplier_master`, `supplier_sites`, `supplier_aliases` | Matching + learning layer 1 | tenant-scoped; alias status pending/approved/retired |
| `purchase_orders`, `po_lines` (reference import) | PO matching | tenant-scoped, read-only import from ERP extract |
| `invoice_fingerprints` | Duplicate detection | supplier_key, normalised_invoice_no, amount, date, document_id |
| `review_events` | Unified document-level review actions (approve, reject, return) with actor id | replaces free-text `approved_by` |
| `erp_submissions` | Submission + reconciliation state | document_id, target, payload_hash, idempotency_key, status, erp_reference, last_polled_at |

Existing tables reused: `document_metadata_fields`, `target_corrections`, `metadata_field_audit_log`, `document_staging_workbooks`, `review_assignments`.

## 6. State machines (separated)

**Processing (machine):** `captured → recognising → recognised → matched → validated → staged` (+ `failed`, `skipped_by_policy`).

**Review (human):** per field `pending → accepted | edited | rejected | unknown` (existing); per document `not_started → in_review → reviewed → approved | returned`.

**ERP (external):** `not_submitted → authorised → submitted → erp_received → erp_validated | erp_rejected → (erp_approved → erp_paid)`, where every state after `submitted` is set **only** from an ERP response or reconciliation poll — never inferred locally.

UI copy rule: "Extracted", "Verified (evidence)", "Reviewed", "Approved for submission" and "Accepted by Oracle" are distinct labels. Dataomatix never displays "Approved" or "Paid" for an ERP state it has not read back from Oracle.

## 7. Security architecture (summary — see security assessment)

- Tenant model: introduce `tenant_id` on documents and every derived table; scope **all** roles (today only the anonymous `workspace` role is scoped).
- Encryption: application-level envelope encryption for Restricted-class files and masked-field columns; keys per tenant.
- Redaction: field-level masks for UI, logs and exports driven by `security.log_mask_fields`/`redaction_fields`.
- External processing: policy engine (§4) + approvals table; Restricted defaults to forbidden.
- Audit: append-only audit store not cascaded on document delete; read/reveal events audited.

## 8. Integration with what exists

| Existing component | Role in target |
|---|---|
| `staging/engine.py`, profiles | Unchanged core; receives validator checks and review policy |
| `source_structure/` | Remains the canonical local layout layer and the re-grounding text layer for external results |
| `ai_enrichment.py` session | Becomes the per-provider limiter inside the orchestrator |
| `candidate_consensus.py`, `confidence_engine.py` | Consensus across providers |
| `target_result_store.py` lock semantics | Preserved: reviewed values never overwritten by reprocessing |
| `api/reviewed_export.py` Oracle dry-run | Becomes the "authorised submission" step; live mode only after the Oracle gate |
| `core/feature_gates.py` | Extended with gates for approve/promote and external providers; UI reads gates from `/ready` |
