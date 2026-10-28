# RC2 Release Freeze Readiness

**Date:** 2026-10-09  
**Purpose:** Prepare a reproducible, restricted **core-platform** release (no features).  
**Authority:** RC2 handoff accepted · CONDITIONAL GO exclusions apply  
**Actions taken:** Inspection and report only — **no commit, push, deploy, migrate, or implementation**

---

## A. Git baseline

| Item | Value |
|---|---|
| Branch | `main` (`main...origin/main`) |
| HEAD | `16b10393d162c6140b2d6fc320540a356a1a1a87` |
| Tip message | `feat: read two-column pages column by column; size-aware section headings` |
| Working tree | **Dirty** — RC2 certified work uncommitted |
| Freeze commit / tag | **Not created** |

---

## B. Complete change inventory

### B.1 Modified tracked files (51)

**Backend**
| Path | RC2 relevance |
|---|---|
| `backend/app/api/contract_analysis.py` | By-id review, duplicate-key 409, human review apply |
| `backend/app/api/documents.py` | Audit-log filters; search/`updated_at` scan path |
| `backend/app/database/migrate.py` | `metadata_field_id` ensure-column |
| `backend/app/models/metadata_field_audit_log.py` | `metadata_field_id` column |
| `backend/app/schemas/contract_analysis.py` | Global audit / field id schema |
| `backend/app/services/all_fields_builder.py` | Human-locked preservation |
| `backend/app/services/contract_metadata_extractor.py` | By-id lookup, preservation |
| `backend/tests/test_repository_search_audit.py` | Audit filter tests |

**Frontend (application)**
| Path | RC2 relevance |
|---|---|
| Documents home / workspace / overview / analysis-request | Repository + workspace UX |
| Extraction + staging grid/selection/export UI | Staging exports |
| `review-field-list.tsx`, review page | Metadata review UI |
| AppShell, nav, globals, marketing layout | RC2 shell |
| `audit-log/page.tsx`, `governance/page.tsx`, `integrations/page.tsx` | Governance / Oracle UX |
| `lib/documents.ts`, `reviewed-export.ts`, `types/document.ts` | API clients |
| `vitest.setup.ts` | `matchMedia` stub |
| `public/consult-america-logo.jpg` | **Deleted** (replaced by SVG logo) |

**Frontend tests (modified)**  
`document-workspace.test.tsx`, `documents-home.test.tsx`, `data-grid.test.tsx`, `table-selection.test.tsx`

### B.2 Untracked source (certified RC2)

| Path | Role |
|---|---|
| `frontend/components/governance/governance-ops-dashboard.tsx` | Ops dashboard |
| `frontend/components/oracle-integration-panel.tsx` | Oracle preview/send UI |
| `frontend/components/layout/*` (Breadcrumbs, PageHeader, Sidebar, WorkspaceTopBar, document-chrome) | Shell |
| `frontend/components/navigation/dataomatix-logo.tsx` | Brand |
| `frontend/components/staging/sortable-header.tsx` | Grid sort UI |
| `frontend/lib/{ops-health,workspace-nav,table-sort,text-display,extraction-workflow}.ts` | Support libs |
| `frontend/public/dataomatix-logo.svg` | Brand asset |
| `frontend/scripts/rc2-04-browser-verify.mjs`, `rc2-08-browser-certify.mjs` | Browser evidence |

### B.3 Untracked tests (required for RC)

| Path |
|---|
| `backend/tests/test_human_review_preservation.py` |
| `backend/tests/test_metadata_review_by_id.py` |
| `backend/tests/test_metadata_field_duplicate_key.py` |
| `frontend/components/__tests__/*` (analysis-request-rc2, document-overview, governance-ops, oracle-panel, review-field-list, status-badge-metadata, workflow-breadcrumb) |
| `frontend/components/layout/__tests__/*` |
| `frontend/lib/__tests__/{ops-health,workspace-nav,table-sort,text-display,extraction-workflow}.ts` |
| `frontend/src/app/audit-log/__tests__/audit-log-page.test.tsx` |

### B.4 RC2 documentation (include in freeze)

All `docs/rc2-*.md`, `docs/rc2-08-browser-evidence/*.png`, `docs/enterprise-workspace-phase1-audit.md`, `docs/rc2-release-candidate-handoff.md`, **this file**.

### B.5 Configuration changes

No committed `.env` changes in the working tree. Runtime defaults remain in `backend/app/core/config.py` (`oracle_dry_run=True`, `rbac_enforced=False` until `APP_ENV=production`).

### B.6 Generated artifacts / local data (exclude)

| Pattern | Reason |
|---|---|
| `*.db`, `backend/uploads/`, `.env*` | Already gitignored — secrets / local data |
| `__pycache__/`, `.pytest_cache/`, `node_modules/`, `.next/` | Build caches |
| Untracked `reference/regression/*`, `reference/schemas/*` | Large fixtures; optional for runtime; **exclude from freeze commit** unless product policy requires bundling |

### B.7 Secrets / sensitive — must not enter VCS

Confirm **not** staged: `.env`, `.env.local`, API keys, service-role keys, production DB URLs, `*.db`, upload binaries under `backend/uploads/`.  
Working-tree scan: no untracked `.env` in the inventory above; secrets remain gitignored.

---

## C. Proposed commit manifest

### Include — certified application code
- All modified tracked backend/frontend application paths in §B.1 (except optional logo deletion if brand policy prefers keep — currently deletion + new SVG is RC2 brand)
- All untracked source in §B.2

### Include — required tests
- All §B.3 tests + modified frontend/backend tests in §B.1

### Include — required documentation
- All RC2 docs in §B.4 including freeze readiness + handoff + RC2-08 cert pack

### Include — deployment configuration
- No new infra files in the dirty tree; use existing Render/Vercel configs + env matrix in §G  
- Document only (this file + `docs/rc2-08-deployment-runbook.md`)

### Exclude from release commit
- `reference/regression/**`, `reference/schemas/**` (fixtures; keep local)
- Any `.env*`, databases, uploads, caches
- Unrelated WIP not in inventory (none identified beyond above)

### Proposed tag / rollback (not created)
| Item | Proposal |
|---|---|
| Freeze commit message | `release: RC2 core-platform candidate (metadata review gated)` |
| Tag | `rc2-core-platform-2026-10-09` (after approved commit) |
| Rollback reference | Parent of freeze commit = current HEAD `16b1039` **or** prior production deploy SHA on Render/Vercel |

---

## D. Backend feature-isolation findings

### D.1 Live Oracle send — **isolation demonstrated**

| Route | Gate |
|---|---|
| `POST /api/documents/{id}/oracle-send` | `oracle.send` RBAC · `confirm:true` · if `oracle_dry_run` → simulated only · else **501** (no Fusion client) |
| `GET /api/documents/{id}/oracle-payload` | Preview only; `send_allowed` forced false |
| Integration audit list | Read path under `oracle.preview` |

**Verdict:** Live Oracle cannot succeed through exposed routes with current code + default/safe prod config (`ORACLE_DRY_RUN=true`).

### D.2 Metadata review mutations — **isolation now demonstrable (gate implemented)**

Fail-closed gate shipped in working tree (pending freeze commit):

| Piece | Location |
|---|---|
| Settings | `metadata_review_mutations_enabled: bool \| None` + `effective_metadata_review_mutations_enabled` |
| Guard | `app.core.feature_gates.require_metadata_review_mutations_enabled` |
| Wired routes | field_key review · by-id review · accept-all · target corrections |
| Readiness | `/ready` → `metadata_review_mutations_enabled` |
| Tests | `tests/test_metadata_review_feature_gate.py` (403 when disabled; production unset = closed) |

| Method | Route | When gated off |
|---|---|---|
| POST | `/api/documents/{id}/metadata-fields/{field_key}/review` | **403** |
| POST | `/api/documents/{id}/metadata-fields/by-id/{metadata_field_id}/review` | **403** |
| POST | `/api/documents/{id}/metadata-fields/accept-all` | **403** |
| POST | `/api/documents/{id}/targets/{normalized_key}/corrections` | **403** |

**Semantics:** unset + `APP_ENV=production` → **disabled** (fail-closed). Unset + non-production → enabled (local/tests). Explicit `METADATA_REVIEW_MUTATIONS_ENABLED=true|false` overrides.

**Single-writer concurrency (R2):** still absent — gate disables mutations for restricted RC rather than allowing concurrent review.

**Read paths stay open:** audit logs, review queue GET, field GET, Oracle preview, exports.

### D.3 Stop condition (updated)

Live Oracle isolation: **demonstrated**.  
Metadata review mutation isolation: **demonstrated when production defaults apply** (or env set false).  
→ Restricted core-platform freeze may proceed **after** an approved freeze commit that includes this gate; deploy must keep production fail-closed (do not set the waiver env without approval).

---

## E. Production RBAC matrix

Roles from `backend/app/core/rbac.py`. Production must set `APP_ENV=production` (forces RBAC).

| Capability | admin | reviewer | analyst | viewer | service_account | workspace |
|---|---|---|---|---|---|---|
| Document access (`documents.view`) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Upload | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| Extraction | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| Staging (via extract/view) | ✓ | ✓ | ✓ | view only | ✓ | ✓ |
| Export ordinary (`export.read`) | ✓ | ✓ | ✓ | — | ✓ | ✓ |
| Export authoritative | ✓ | ✓ | — | — | ✓ | — |
| Governance UI / portfolio (view APIs) | ✓* | ✓* | ✓* | ✓* | ✓* | ✓* |
| Audit log read (scoped) | ✓* | ✓* | ✓* | ✓* | ✓* | ✓* |
| Metadata review mutate | ✓ | ✓ | — | — | — | ✓ |
| Live Oracle send | ✓† | — | — | — | ✓† | — |
| Oracle preview | ✓ | ✓ | ✓ | — | ✓ | — |
| Cross-workspace isolation | Enforced by `scope_documents` / ownership — not role-permissive | | | | | |

\* No separate `governance.*` permission; access follows document scope + auth.  
† Send still cannot reach Fusion (501 / dry-run); deny at permission for reviewer/analyst/viewer/workspace.

### E.1 Production-role test cases to run before promote

| # | Case | Expect |
|---|---|---|
| 1 | Viewer: list/search documents | 200, only scoped docs |
| 2 | Viewer: upload | 403 |
| 3 | Analyst: upload + extract | 200 |
| 4 | Analyst: metadata Accept | 403 |
| 5 | Reviewer: metadata Accept (if mutations enabled) | 200; **if gate false → 403** |
| 6 | Reviewer: Oracle send | 403 permission |
| 7 | Admin: Oracle send with `confirm` + dry-run | 200 simulated; no external call |
| 8 | Admin: Oracle send with dry-run false | 501 |
| 9 | Workspace A cannot read Workspace B document | 404/empty |
| 10 | Accept-all / by-id / field_key / target corrections all denied when gate false | 403 |
| 11 | Export selected staging as analyst | 200 if `export.read` |
| 12 | Audit log does not leak other workspace ids | scoped only |

---

## F. Database readiness

| Topic | Status |
|---|---|
| Compatibility | SQLite (local) / Postgres (prod) supported by ensure-column path |
| Audit `metadata_field_id` | Additive nullable INTEGER via startup `_ensure_columns` (R3) |
| Idempotent ensure | Yes — skip if column exists |
| Prod recommendation | Prefer offline ADD COLUMN before multi-instance boot if ALTER restricted |
| Migrations executed by this work | **None** |
| Rollback | Leave additive column; redeploy prior app revision |

---

## G. Deployment prerequisites

| Area | Requirement |
|---|---|
| Env | `APP_ENV=production`, `DATABASE_URL`, `FRONTEND_URL`, `NEXT_PUBLIC_API_URL` |
| Safe defaults | `ORACLE_DRY_RUN=true`; leave `METADATA_REVIEW_MUTATIONS_ENABLED` **unset** (fail-closed) or set `false` |
| Secrets | Platform stores only — never commit |
| Vercel | `npm ci && npm run build` proven locally (RC2-08) |
| Render | Existing Docker/service; confirm `/ready` after deploy |
| Health | `GET /health`, `GET /ready` — do not infer from HTML |
| Rollback | Prior Render + Vercel revisions; DB restore only if corrupt |
| Post-deploy smoke | Documents search → open workspace → staging export; governance; audit filters; Oracle preview only; confirm review mutations 403 if gate shipped |

See `docs/rc2-08-deployment-runbook.md`.

---

## H. Remaining blockers

| # | Blocker | Severity |
|---|---|---|
| 1 | ~~No backend fail-closed gate~~ **Resolved in working tree** — needs freeze commit | Cleared for isolation claim once committed |
| 2 | No freeze commit of dirty tree | Cannot deploy a reproducible SHA |
| 3 | R2 concurrent LWW if review re-enabled without concurrency control | High — keep gate closed |
| 4 | R3 runtime ALTER vs locked-down DB roles | Medium |
| 5 | R4 intermittent FE suite flakes | Medium (CI claim) |
| 6 | R1/R5 live Oracle | Excluded (controls OK) |

---

## I. Exact commands proposed for a future approved freeze

> Run only after explicit approval. Do **not** run now.

```bash
# 0) Confirm clean intent and no secrets
git status
git rev-parse HEAD   # expect 16b10393d162c6140b2d6fc320540a356a1a1a87 before freeze commit

# 1) After approved METADATA_REVIEW_MUTATIONS_ENABLED gate is implemented & tested:
#    (implementation PR separately approved)

# 2) Stage certified paths only (illustrative — adjust to final gate files)
git add backend/app backend/tests
git add frontend/components frontend/lib frontend/src frontend/public/dataomatix-logo.svg
git add frontend/scripts/rc2-0*.mjs frontend/vitest.setup.ts frontend/types
git add docs/rc2-*.md docs/rc2-08-browser-evidence docs/enterprise-workspace-phase1-audit.md
git add docs/rc2-release-candidate-handoff.md docs/rc2-release-freeze-readiness.md

# Explicitly do NOT add:
#   reference/regression reference/schemas .env* *.db backend/uploads

git status   # review carefully

# 3) Commit (message via HEREDOC per project policy)
git commit -m "$(cat <<'EOF'
release: RC2 core-platform candidate with review mutations gated

EOF
)"

# 4) Tag (optional, after commit)
git tag -a rc2-core-platform-2026-10-09 -m "RC2 restricted core-platform release candidate"

# 5) Push only with separate approval
# git push origin HEAD
# git push origin rc2-core-platform-2026-10-09
```

---

## J. Final readiness recommendation

| Question | Answer |
|---|---|
| Core platform code + tests + docs inventory complete? | **Yes** |
| Live Oracle isolation demonstrable? | **Yes** |
| Metadata review mutation isolation demonstrable? | **Yes** (gate in working tree; 19 related tests passed) |
| Ready to create freeze commit / tag? | **Awaiting explicit approval to commit** |
| Ready to deploy? | **No** until freeze commit + separate deploy auth |

**Recommendation: READY FOR APPROVED FREEZE COMMIT** (not deploy) of the §C manifest including the review mutation gate. Production must keep mutations fail-closed (`APP_ENV=production` with flag unset/false). Do not set `METADATA_REVIEW_MUTATIONS_ENABLED=true` without a waiver.

**Stopped.** Gate implemented locally; **no commit, push, deploy, or migration** performed.
