# DI-02 Completion Report — Safety Fixes and Recognition Foundation

**Status:** Implemented locally on branch `feature/di-02-safety-foundation` — awaiting review
**Date:** 2026-10-26
**Baseline:** DI-01 assessment (`docs/di-01-*.md`) · `main` @ `821a2a3`
**Commit / push / deploy:** Not performed. No production migration run. No paid provider activated. No external call made by any test.

---

## A. Backlog outcome

| ID | Item | Outcome |
|---|---|---|
| B-001 | Hard-coded service key | **Fixed.** No key literal in source; the seeded service key comes from `SEED_SERVICE_API_KEY` (test suite sets its own). Default actors are seeded only outside production; in production, startup **retires** previously seeded defaults (deactivates them, clears key hashes). `core/config.py` `effective_seed_default_actors`; `services/actor_seed.py`. |
| B-002 | Fabricated page 1 for missing evidence | **Fixed.** No-evidence values store page `0` (the existing "no source page" convention) and always route to review with `no_source_evidence`; UI shows "No source page" (`frontend/lib/source-page.ts`). |
| B-003 | Weak AI grounding | **Fixed for AI values.** `validate_source_value(strict=True)`: quote must be on the page and the value must be readable in the quote or page (normalised ids, numbers, dates); lists/dicts checked element-wise. Applied to every AI-sourced path. **Default mode unchanged** — see §C. |
| B-004 | Approve/promote without controls | **Fixed.** Review-mutation gate + `review.accept` permission; approver = authenticated actor; audit event per action. |
| B-005 | "Inverted" review priority | **No defect.** Queue sorts ascending, so problem fields are listed first; DI-01 finding corrected; semantics documented in `review_routing.py`. Stored values unchanged. |
| B-006 | Unconditional server accept-all | **Fixed.** Accepts only low-risk pending values (≥0.85, no routing reasons, real evidence, validation not failed); flagged values need `include_flagged` + reason, admin only. Queue keeps a document listed while flagged values remain. |
| B-007 | Rename "Verified" → "Evidence-verified" | **Not done — decision needed.** "Verified / Needs Review / Missing" is the product owner's vocabulary; the UI already states "Metadata Accepted is not the same as Staging Verified". |
| B-008 | Export defaults | **No change needed.** Rows carry `review_status` + `authoritative`; authoritative filter is permission-gated; Oracle payload already excludes pending/rejected (covered by `test_export_api_integrity.py`). |
| B-009 | Audit retention / actor ids | **Fixed.** Audit logs no longer FK-cascade from documents; deletion keeps history and adds a `delete` tombstone (no filename); `actor_id` on classification/relationship audits and corrections; correction `reason_code`/`reason_text`; global audit shows deleted documents' history to non-workspace roles only. |
| B-010 | Recognition provider contract | **Done (contract).** `app/recognition/types.py`. Wrapping of local steps delivered in DI-03. |
| B-011 | Run records / model provenance | **Done.** `recognition_runs` row per AI call or policy refusal (provider that actually answered, model, data class, pipeline version, job id). Fixed: fallback chains were labelled with `GEMINI_MODEL`. Per-value linkage is via `extraction_job_id`; a direct per-value `run_id` is deferred. |
| B-012 | Data classification | **Done.** `documents.data_class` (+ source) stamped from the resolved profile unless set by a person; profiles declare class (FAR = public, transcripts = restricted, others confidential); exposed on `GET /api/documents/{id}`. |
| B-013 | Provider policy + approvals | **Done.** `app/recognition/policy.py`; `provider_approvals` table; admin API `/api/admin/provider-approvals` (create, list, revoke — never delete). Every AI session is policy-checked. |
| B-014 | Local validator library | **Done.** `app/validators/`: ICAO 9303 MRZ (TD1/TD2/TD3), ABA checksum + prefix, IBAN, Luhn, NPI, written amounts. Tested against ICAO specimens and published examples. Note: MRZ check digits cannot detect every substitution (e.g. `3`→`X` at weight 1) — a property of the standard. |
| B-015 | Negative invoice tests | **Done.** `tests/test_invoice_arithmetic.py` (7 tests, every arithmetic check driven to failure). |
| B-016 | Log masking | **Done.** `app/core/masking.py` redacts SSN, long digit runs, IBAN and MRZ shapes in every log record; end-to-end leak test. Tracebacks are not rewritten. |
| B-017 | UI reads the review gate | **Done.** `useReviewMutationsEnabled` + read-only notice; review, queue, drawer, batch and correction controls disabled when the backend gate is closed. |
| B-018 | Green, reproducible suite | **Done.** Fresh test DB per session; all real AI credentials blanked in tests; pytest limited to `tests/` (a stray `backend/test_gemini.py` script made a live Gemini call on every run); OCR test skips without Tesseract. |

## B. Policy behaviour (B-013) — what changes for users

| Data class | `EXTERNAL_AI_POLICY=legacy` (default) | `enterprise` |
|---|---|---|
| public / internal | allowed | allowed |
| confidential | allowed (as before) | approval required |
| unclassified | allowed (as before) | approval required |
| restricted (transcripts) | **approval required (new)** | approval required |

Known gap (legacy only): transcripts are recognised structurally at staging, after AI schema-name enrichment has run during discovery; until then a new transcript is "unclassified". Enterprise mode closes this. Convera document mode (off by default and in production) sends files at upload and is **not** policy-gated — gate it before enabling.

## C. Regression evidence (release gate G0)

Snapshot harness (`main` worktree vs branch, isolated DB, AI disabled) over 14 documents: 4 regression contracts, FAR Part 51/52, FAR final rule, `sample3.pdf`, 6 invoice fixtures.

- **First run found a real regression in B-003:** the strict rule rejected deterministic values whose quote is a synthesised `label: value` snippet or whose value is normalised (`FAR 52.232-8`), dropping e.g. `MSA-2024-117`, `NSS-7731`, `FA300224C0008` and 5–19 FAR/DFARS references per contract.
- **Fix:** strict grounding only for AI-sourced values; default mode is byte-for-byte the original algorithm.
- **Final run:** staging workbooks, V3 datasets and all extracted target values **identical to `main`** for all 14 documents. Remaining differences: the AI summary's new fields (`data_class`, `policy`) and `model: null` instead of the previously mislabelled `gemini-3.6-flash` when AI is disabled (intended), and one "Processing Time (ms)" row (timing).

## D. Migrations (not run in production)

| Revision | Content |
|---|---|
| `a9c1e3f5b7d9` | Drop audit → documents FKs (Postgres only, discovered by inspector); `actor_id` on classification/relationship audits; `actor_id`, `reason_code`, `reason_text` on `target_corrections` |
| `b2d4f6a8c0e1` | `documents.data_class`/`data_class_source`; `provider_approvals`; `recognition_runs` |

Up/down/up verified on SQLite. **The Postgres FK-drop branch is untested locally** (no Postgres available) and must be verified on a staging copy before deploy. Startup runs `alembic upgrade head` automatically in production, so the next deploy applies these.

## E. Tests

See DI-03 report §F for the final combined run.

## F. Production actions still needed (outside this branch)

1. The leaked service key stays usable in production until this code is deployed (startup retires it) **or** the actor `actor-service-default` is deactivated manually. Every restart of the current production build re-activates it.
2. Decide B-007 (staging "Verified" label).
