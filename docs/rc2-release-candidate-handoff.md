# Dataomatix RC2 — Release Candidate Handoff

**Date:** 2026-10-09  
**Decision accepted:** RC2-08 **CONDITIONAL GO**  
**This document:** Freeze & gate verification only — **no commit, push, deploy, migration, or live Oracle send**

---

## 1. Certified scope

| Included | Notes |
|---|---|
| Core document intelligence | Upload → classify → extract → staging workbook → repository (`uploaded_at` sort) |
| Staging workbooks and exports | Export All / Selected / reviewed metadata JSON·CSV·XLSX; server-resolved values |
| Governance and operational visibility | Ops dashboard, audit explorer filters, `/health`+`/ready` probes, role **hints** |
| Metadata review — **single-writer only** | Accept/Edit/Reject, by-id for duplicates, human preservation on reprocess — **see gap §5** |

## 2. Explicit exclusions

| Excluded | Enforcement today |
|---|---|
| Concurrent multi-reviewer metadata editing | **Not implemented as a hard gate** — see §5 |
| Live Oracle sending | Backend refuses live Fusion call (dry-run simulate **or** HTTP **501**) |

Also excluded from claims: full FAR Parts 1–53 fixture coverage; global `updated_at` repository sort accuracy; inventing export/Oracle portfolio counts.

---

## 3. Source revision and working-tree state

| Item | Value |
|---|---|
| Branch | `main` (`main...origin/main`) |
| **Last committed SHA (git HEAD)** | `16b10393d162c6140b2d6fc320540a356a1a1a87` |
| Tip commit subject | `feat: read two-column pages column by column; size-aware section headings` |
| **Release candidate code freeze** | **Not a clean git tag/commit** — RC2 work lives in a **dirty working tree** on top of HEAD |
| Tracked diff vs HEAD | **51 files**, ~**+4143 / −1462** lines (plus untracked tests, docs, components, fixtures) |
| Commit created by this handoff | **None** (forbidden) |

### Working-tree contents (summary)

- **Backend (modified):** `contract_analysis.py`, `documents.py` (audit filters), `migrate.py` (`metadata_field_id` ensure-column), models/schemas, metadata extractor / all_fields_builder, audit filter tests  
- **Backend (untracked tests):** `test_human_review_preservation.py`, `test_metadata_review_by_id.py`, `test_metadata_field_duplicate_key.py`  
- **Frontend (modified/untracked):** RC2 workspace shell, documents home (Updated sort disabled), governance dashboard, audit explorer, Oracle panel, review UI, Vitest coverage, `rc2-08-browser-certify.mjs`  
- **Docs (untracked):** `docs/rc2-01` … `rc2-08-*`, browser evidence PNGs, this handoff  

**Implication:** Production deploy cannot truthfully claim “SHA 16b1039 alone.” A future approved commit (or explicit artifact bundle) must capture the dirty tree before any promote. This handoff only **records** that baseline; it does not create it.

---

## 4. Release artifact verification approach

| Artifact | Correspondence check | Result |
|---|---|---|
| `docs/rc2-08-certification-report.md` | Describes HEAD `16b1039` + dirty RC2 tree; matches current status | **Aligned** |
| `docs/rc2-08-test-matrix.md` / risk / decision / runbook | Same baseline; R1–R6 preserved | **Aligned** |
| `docs/rc2-08-browser-evidence/*.png` | Captured 2026-10-09 ~12:04–12:05 local against running FE/API; fixture `FAR_Part_52_…xml` | **Aligned to cert session** |
| Sort honesty in source | `documents-home.tsx` forces `uploaded_at`; Updated column non-sortable | **Present in current tree** |
| Governance / audit / Oracle panel | Present under `frontend/components/governance/`, `audit-log/page.tsx`, `oracle-integration-panel.tsx` | **Present** |
| Cert screenshots vs *future* commit | Screenshots predate any freeze commit | Re-smoke after first RC commit |

**Approach for operators:** Treat certification docs + PNG set as evidence for the **working tree as of 2026-10-09**, not for `origin/main` alone. After an approved freeze commit, re-run `node frontend/scripts/rc2-08-browser-certify.mjs` and attach new SHAs.

---

## 5. Feature-control evidence

### 5.1 Live Oracle — disabled at authorization/configuration boundary

| Gate | Location | Behavior |
|---|---|---|
| Permission | `POST …/oracle-send` → `require_permission("oracle.send")` | Unauthorized → 403 |
| Explicit confirm | Body `confirm: true` required | Else 400 |
| Dry-run config | `Settings.oracle_dry_run` (env `ORACLE_DRY_RUN`, **default `true`**) | Audited **simulated** response; **no external Fusion HTTP** |
| Live path | `oracle_dry_run=false` | **No Fusion client wired** → audit `rejected` + HTTP **501** |

**Verdict:** Live Oracle sending is **disabled** at the backend boundary for both default and misconfigured “live” modes. Preview remains `GET …/oracle-payload` (`oracle.preview`). Exclusion is technically enforced.

### 5.2 Single-writer metadata review — **enforcement gap**

| Control sought | Present? | Evidence |
|---|---|---|
| Document/field lease or lock | **No** | No lock table / lease API |
| Optimistic concurrency (`version` / `If-Match` / `expected_status`) | **No** | `_apply_metadata_field_review` overwrites `review_status` / value then appends audit |
| Backend rejection of second concurrent writer | **No** | Last write wins |
| UI “another reviewer” warning | **No** | Not found in review components |
| Operational SOP only | Possible | Not enforceable by the product |

**Update (freeze readiness follow-on):** A fail-closed **release gate** now blocks all metadata review mutation routes when `APP_ENV=production` and `METADATA_REVIEW_MUTATIONS_ENABLED` is unset/false (`app.core.feature_gates`). That satisfies restricted core-platform isolation (mutations off). It is **not** optimistic concurrency — R2 remains open if mutations are later re-enabled via waiver.

Human-locked preservation on **reprocess** remains implemented; that is **not** a concurrent-writer control.

### 5.3 Configuration matrix (enable / disable)

| Feature | Dev (cert) | Required prod RC setting | Release posture |
|---|---|---|---|
| Core upload / extract / staging | Enabled | Enabled | **In scope** |
| Repository search + `uploaded_at` sort | Enabled | Enabled | **In scope** |
| Repository `updated_at` sort (UI) | **Disabled** | Keep disabled | Honesty gate (R6) |
| Staging / metadata exports | Enabled | Enabled + RBAC | **In scope** |
| Governance dashboard / audit explorer | Enabled | Enabled | **In scope** |
| Metadata review mutations | Enabled in code | **Blocked for RC promote** until §5.2 resolved | Gap |
| Oracle preview | Enabled (`oracle.preview`) | Enabled | **In scope** (read-only) |
| Oracle dry-run send | Allowed if `oracle.send` + confirm | `ORACLE_DRY_RUN=true` | Optional simulated only |
| Live Oracle send | Impossible (501 / no client) | Keep dry-run; never wire Fusion without R1/R5 | **Excluded** |
| RBAC | Often relaxed (`rbac_enforced:false`) | `APP_ENV=production` (forces RBAC) | Prerequisite |
| Entra JWT | Optional / unset in cert | Configure if enterprise IdP required | Prerequisite if mandated |
| AI providers | Gemini/dev mode in cert | Production keys + `AI_PROVIDER_MODE=production` | Ops config |
| Ensure-column startup ALTER | Runs on boot | Prefer pre-applied column (R3); role needs ALTER or migrate offline | See §6 |

---

## 6. Audit ensure-column — production safety (no migration executed)

| Question | Assessment |
|---|---|
| Mechanism | Startup `ensure_metadata_field_audit_log_columns` → `_ensure_columns` additive `metadata_field_id INTEGER` |
| Idempotent? | **Yes** — skips columns already present |
| Old rows? | Remain readable; `metadata_field_id` NULL for legacy |
| Concurrent multi-instance? | Racing identical `ADD COLUMN` may error on one replica; usually converges |
| Restricted DB roles? | Fails if role cannot `ALTER TABLE` |
| Rollback | Leave column; do not drop without approval |
| Recommendation | Controlled offline migration **before** multi-instance prod if ALTER is undesirable at runtime — **not run by this handoff** |

---

## 7. Open risks and mitigations (R1–R6 preserved)

Carried forward from `docs/rc2-08-risk-register.md` — **none silently closed**:

| ID | Severity | Release-blocking? | Mitigation for this RC |
|---|---|---|---|
| **R1** Oracle send lacks idempotency | High | Yes — live Oracle | Live send excluded; dry-run/501 only |
| **R2** Metadata review last-write-wins | High | Yes — concurrent review | **Review mutations blocked for release** until enforceable single-writer or separate SOP acceptance |
| **R3** ensure-column schema management | Medium | Prefer before scale | Assess offline migration; idempotent additive path |
| **R4** FE suite flake/timeouts | Medium | Yes for “always-green CI” claim | Do not raise timeouts; record intermittent green |
| **R5** Live Oracle not certified | High | Yes — live Oracle | Excluded |
| **R6** `updated_at` capped sort | Medium | UI mitigated | UI disabled; API still approximate if called |

Additional: **R7** prod must force RBAC; **R9** incomplete FAR Parts 1–53 fixtures.

---

## 8. Production prerequisites

1. Create an **approved freeze commit** (or signed artifact) that includes the dirty RC2 working tree — out of scope for this handoff to create.  
2. `APP_ENV=production` (RBAC on); confirm `/ready` shows `rbac_enforced:true`.  
3. `ORACLE_DRY_RUN=true` (or accept permanent 501). **No Fusion client.**  
4. Resolve §5.2: either ship approved single-writer enforcement **or** formally accept operational-only single-writer and un-block review.  
5. Prefer pre-applied `metadata_field_id` column (R3) if runtime ALTER is disallowed.  
6. `NEXT_PUBLIC_API_URL` → production API; secrets only in platform stores.  
7. Postgres backup before first RC deploy.  
8. Do not claim full FAR 1–53 or global Updated sort.

---

## 9. Deployment and rollback checklist

### Deploy (when separately authorized)
- [ ] Freeze commit SHA recorded and built (`npm run build` / backend image)
- [ ] Env matrix applied (§5.3)
- [ ] DB backup taken
- [ ] Backend deploy → `/health` + `/ready` green; `oracle_dry_run:true`; RBAC enforced
- [ ] Frontend deploy → marketing `/`, `/documents`, `/governance`, `/audit-log`
- [ ] Post-deploy smoke (below)

### Post-deployment smoke
- [ ] Search documents (`uploaded_at`); open workspace; staging grid visible for a known fixture
- [ ] Staging export (All or Selected) downloads without client-invented values
- [ ] Governance portfolio totals match API; audit explorer filters apply
- [ ] Oracle **preview** only; confirm send remains dry-run or 501 — **never** production Fusion
- [ ] Cross-workspace document isolation spot-check
- [ ] If review unblocked by separate decision: single Accept → audit row; else confirm review UI/API still gated per policy

### Rollback
- [ ] Redeploy previous FE + BE revisions
- [ ] Restore DB **only** if corruption confirmed
- [ ] Re-verify `/health` `/ready` and one document open
- [ ] Communicate Oracle remains non-live

Full narrative: `docs/rc2-08-deployment-runbook.md`.

---

## 10. Gaps that prevent release without unapproved architecture

| Gap | Blocks | Needs |
|---|---|---|
| **No enforceable single-writer** for metadata review | Review mutations in CONDITIONAL GO scope | Approved lock/optimistic concurrency **or** explicit SOP-only waiver |
| **No freeze commit** of dirty RC2 tree | Any production SHA claim | Approved commit/tag (not created here) |
| Live Oracle (R1/R5) | Live ERP | Idempotency + Fusion certification (excluded) |
| Runtime ALTER dependence (R3) | Hardened prod DB roles | Controlled migration (not executed here) |

---

## 11. Final readiness recommendation

| Surface | Ready to promote under CONDITIONAL GO? |
|---|---|
| Core document intelligence | **Yes**, after freeze commit + prod RBAC |
| Staging workbooks and exports | **Yes**, after freeze commit + prod RBAC |
| Governance / ops visibility | **Yes**, after freeze commit |
| Metadata review mutations | **No — blocked** until §5.2 enforceable single-writer or separate waiver |
| Live Oracle sending | **No — excluded** (controls already refuse live delivery) |

**Overall:** Release-candidate **freeze documentation is complete**. Product surfaces other than metadata review mutations and live Oracle are ready for a future authorized promote **once the dirty tree is committed under change control**. Metadata review remains **release-blocked** for concurrent-safety reasons despite CONDITIONAL GO acceptance, because the required **enforceable** single-writer control is not present in source.

**Stop.** No commit, push, deployment, migration, or live Oracle send performed.
