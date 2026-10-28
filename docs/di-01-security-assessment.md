# DI-01 — Security Assessment for Sensitive Document Processing

**Status:** assessment (no changes made) · **Date:** 2026-10-26
**Scope:** readiness to process identity, banking, education, health and financial documents. Evidence is code-level; deployment-side controls (Supabase bucket privacy, DB encryption, backups, Gemini contract tier, repository visibility) were **not verifiable from the repo** and are listed as open items. No secret values are reproduced in this document.

## 1. Verdict

The platform is **not ready to accept Restricted-class documents** (passports, bank documents, health records, HR/tax identifiers, transcripts) in a shared or hosted environment. Confidential-class documents (invoices, contracts) are processed today under the current release scope; several findings below also apply to them and should be fixed first.

## 2. Findings (ranked)

| ID | Severity | Finding | Evidence | Recommendation |
|---|---|---|---|---|
| S-1 | **Critical** | A service-account API key is a string literal in source ("only for local/test" comment). Startup seeding runs unconditionally in every environment, upserts the service actor with that key's hash and sets `active=True` on every boot. The role grants `documents.view` across **all** workspaces (non-workspace roles are unscoped), `export.authoritative`, `oracle.preview` and `oracle.send`. | `backend/app/services/actor_seed.py:11-12, 49-71`; `backend/app/main.py:402-409`; `backend/app/core/rbac.py:101-111`; `backend/app/core/document_access.py:31-38` | Immediately (before DI-02 feature work, subject to approval): rotate/deactivate the service actor in production; guard seeding by `APP_ENV` (dev/test only); remove the literal; never reactivate on boot; review access logs for use of the key. Repository visibility unverified — if public, treat the key as compromised. |
| S-2 | High | Credential-less requests are served as the `workspace` role by default (including production); no rate limiting; workspace bearer token lives in `localStorage`; no frontend CSP. | `core/config.py:102`; `core/auth.py:156-162`; `frontend/lib/workspace.ts:7-25`; no limiter in app/nginx | Keep for Public/Internal demo flows only; disable anonymous processing for tenants handling Confidential/Restricted data; add rate limits and frontend CSP. |
| S-3 | High | Raw page text is sent to Gemini by default when deterministic extraction is judged insufficient, and schema enrichment sends early pages; a fallback chain may include OpenAI. No per-document or per-workspace consent, no redaction, provider data-use terms unverified. | `services/gemini_provider.py:36-66`; `services/ai_provider_factory.py:81-134`; `services/semantic_schema_enrichment.py:148-158`; `use_ai_fallback=True` defaults | Provider policy engine + `provider_approvals`; Restricted = forbidden by default; redact masked fields before any external call; record provider/model/region per call. |
| S-4 | High | No isolation between authenticated users: only the anonymous `workspace` role is scoped; viewer/analyst/reviewer/Entra-default-viewer/service see all documents. Postgres RLS is perimeter-only (blocks PostgREST, no per-tenant policies). | `core/document_access.py:31-46`; `app/database/rls.py` | Introduce `tenant_id` across documents and derived tables; scope every role; optional per-tenant RLS policies as defence in depth. |
| S-5 | High | No data classification, no retention/TTL, no application-level encryption; files in plaintext on local disk cache and Supabase bucket. | grep: none; `services/document_storage.py:39-60, 312-333` | Classification on document; envelope encryption for Restricted files and masked columns; retention jobs per class; purge local cache. |
| S-6 | High | Document approve/promote have no RBAC permission, no feature gate and no audit; approver is client-supplied text. | `api/contract_analysis.py:874-948` | Bring under gate + RBAC; actor from auth; audit event. |
| S-7 | Medium | Audit records cascade-delete with the document; no read/reveal audit; classification and relationship logs lack `actor_id`. | audit model FKs `ondelete="CASCADE"`; `core/observability.py:97-137` | Separate append-only audit store retaining tombstones; access audit for Restricted views/exports. |
| S-8 | Medium | Upload hardening gaps: no malware scan, no decompression/zip-bomb limits on OOXML, LibreOffice converts untrusted legacy Office files. | `services/security_validation.py:17-19, 422-432`; `services/libreoffice_convert.py` | AV scan (e.g. ClamAV sidecar); member count/size ratio limits; sandbox converter (no network, resource limits). |
| S-9 | Medium | CORS accepts any `*.vercel.app` origin with credentials; no HSTS on API. | `main.py:147-165`; `core/security_headers.py:13-25` | Exact origin allowlist; HSTS. |
| S-10 | Medium | Missing-evidence values stored as page 1; AI grounding passes on quote-only matches. (Integrity rather than confidentiality, but enables false acceptance.) | `services/target_result_store.py:52-58`; `services/source_validator.py:57-90` | Fix in DI-02 (see validation rules X-01/X-02). |
| S-11 | Low | Filenames logged on deletion; exception and remote-response text returned to clients; `/ready` exposes auth mode, binary paths, git SHA; OpenAPI docs exposed. | `services/document_deletion.py:124`; `api/documents.py:353,626,635`; `main.py:592-666, 133-141` | Mask filenames for Restricted; generic client errors; restrict `/ready` detail and docs in production. |
| S-12 | Low | API keys: unsalted SHA-256, no expiry/rotation/scope. | `core/auth.py:64-65, 132-141` | Prefix + salted hash, expiry, scopes, rotation. |

Positive controls observed: file-type allowlist with magic bytes; encrypted-PDF rejection; hardened XML parsing; structured logs strip page text/prompts (`core/observability.py:21-68`); Entra JWT validation (RS256, aud, iss, JWKS); RBAC forced in production; review mutations fail-closed in production; Oracle send dry-run with explicit confirm, zero-pending check and audit; `.env` files untracked, production secrets `sync: false` in `render.yaml`.

## 3. Required controls by data class

| Control | Confidential | Restricted (ID, bank, health, HR, tax, education) |
|---|---|---|
| Authenticated access (no anonymous) | Required | Required |
| Tenant isolation for all roles | Required | Required |
| Encryption at rest (provider) | Required | Required |
| Application envelope encryption (tenant key) | Recommended | **Required** |
| Field masking in UI/exports | Bank details | All identifiers (passport no., account no., SSN/TIN, MRN, student id) |
| Reveal with permission + access audit | Recommended | **Required** |
| External AI/OCR | Approval per provider/purpose/region | **Forbidden** unless documented tenant exception |
| Redaction before external call | Required for masked fields | n/a (forbidden) or required under exception |
| Logs | No values | No values; masked identifiers only; no filenames |
| Retention | Tenant policy | Shortest workable, enforced by job; deletion certificate |
| Export | Role `export.read`; authoritative separate | Dual control for bulk export; watermark + audit |
| Malware scan | Required | Required |
| Benchmark data handling | Permissioned, local | Synthetic/specimen preferred; real only with written consent, local-only |

## 4. Logging rules (to implement)

Never log: full passport/ID numbers, bank account or routing+account pairs, card numbers, SSN/TIN, medical record numbers, diagnosis/procedure codes tied to a person, page text, prompts, extracted values of Restricted fields. Mask format: keep last 3–4 characters (`•••••1234`). Add a central `mask()` utility used by logging filters, error handlers and exports; add a CI test that greps captured logs from the test suite for known fixture identifiers.

## 5. Third-party processing requirements (before any activation)

1. Data Processing Agreement covering purpose, region, retention (zero/limited), no training on customer data.
2. Written tenant approval recorded in `provider_approvals` (provider, purpose, region, approver, expiry).
3. Per-call record: provider, model version, region, pages, cost, document id, data class.
4. Kill switch per tenant and global.
5. Real sensitive documents are never sent to any external provider during evaluation; DI-01 sent none.

## 6. Open items (not verifiable from code)

- GitHub repository visibility (affects S-1 severity response).
- Supabase Storage bucket privacy and encryption; database encryption and backup policy.
- Gemini API tier and data-use terms in production.
- Whether rows without a `documents` FK (e.g. staged uploads) persist after deletion.
- Regulatory scope per tenant (HIPAA, GLBA, FERPA, GDPR/UK GDPR, state privacy laws) — requires legal input before healthcare/HR/tax profiles.
