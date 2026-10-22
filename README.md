# Consult America — Dataomatix

**Enterprise document intelligence that does not stop at extraction.**  
It retrieves evidence, extracts with explainable confidence, routes fields for human review, preserves corrections in an append-only audit trail, and exports only authoritative reviewed values — with Oracle send gated behind RBAC and explicit confirmation.

| | |
|---|---|
| **Live frontend** | https://data-agent-ca.vercel.app |
| **Live API** | https://data-agent-backend-qbmc.onrender.com |
| **Health / Ready** | [/health](https://data-agent-backend-qbmc.onrender.com/health) · [/ready](https://data-agent-backend-qbmc.onrender.com/ready) |
| **Architecture (in-app)** | [/architecture](https://data-agent-ca.vercel.app/architecture) |

---

## Why it is technically different

| Typical OCR/LLM demo | Dataomatix |
|---|---|
| Extract → dump JSON | Retrieve → extract → validate → confidence → **source ground** |
| Confidence as a vibe score | Explainable signals + review routing reasons |
| Re-run overwrites humans | `machine_value` vs reviewed `value`; re-extract cannot silently clobber |
| “Send to ERP” | Preview only accepted/edited; `POST /oracle-send` needs permission + confirm + snapshot audit |

**Value contract (every surface):**

```
extracted_value  = machine result
value            = effective reviewed / authoritative result
review_status    = pending | accepted | edited | rejected | …
```

---

## Core architecture

```
Upload → Understand → Discover Schema → Retrieve → Extract
  → AI escalate when needed → Validate → Explain confidence
  → Source ground → Route for review → Accept / Edit / Reject
  → Audit (actor + request_id) → Persist
  → Export authoritative value → Oracle preview / gated send
```

**Stack:** Next.js (Vercel) · FastAPI (Render Docker) · PostgreSQL · Supabase Storage · Gemini/OpenAI escalation · field-level RBAC (Entra-ready)

---

## Key features

- Schema discovery + targeted extraction with source verification workspace  
- Review Queue with Accept / Edit / Reject and append-only audit  
- Reopen Repository / Field Explorer **without** re-extracting  
- Reviewed-value-aware JSON/CSV export + Oracle payload preview  
- RBAC roles (Admin / Reviewer / Analyst / Viewer / Service Account)  
- Production forces RBAC; Entra JWT + service API keys  

---

## 5-minute demo (keep it tight)

| Time | Beat |
|---|---|
| 0:00–0:45 | Problem + **/architecture** |
| 0:45–1:30 | Upload a fresh document |
| 1:30–2:30 | Schema discovery + extraction |
| 2:30–3:30 | One field: retrieval · confidence · validation · source |
| 3:30–4:15 | Edit or accept → audit / review state |
| 4:15–5:00 | Repository / Explorer / export → finish on architecture |

---

## How to run locally

```bash
# Backend (port 8001)
cd backend
python -m venv .venv
# Windows: .venv\Scripts\activate
pip install -r ../requirements.txt
# from repo root:
set PYTHONPATH=backend
uvicorn app.main:app --reload --port 8001 --app-dir backend

# Frontend
cd frontend
npm install
# NEXT_PUBLIC_API_URL=http://127.0.0.1:8001
npm run dev
```

## How to run with Docker

```bash
cd infrastructure
docker compose up --build
# nginx :80 → frontend :3000 + API /api → backend :8000
```

---

## How AI providers work

1. **Page retrieval** ranks evidence pages for each target  
2. **Deterministic extract** first (labels, forms, patterns)  
3. **AI escalation** only when unresolved / ambiguous (`AI_FALLBACK_ENABLED`)  
4. Providers: Gemini (default), OpenAI, optional Ollama / Convera  
5. Production: set `AI_PROVIDER_MODE=production`; never log page text or prompts  

## How review / governance works

- Fresh fields stay **`pending`** unless `auto_accept_high_confidence=true` (default **false**)  
- Review reasons: low confidence, validation failed, not source-grounded, ambiguous, AI escalation  
- Human decisions write `MetadataFieldAuditLog` with `actor_id` / `actor_role` / `request_id`  
- Re-extract updates `machine_value`; edited/accepted values are preserved  
- Export JSON keeps both values; CSV uses effective `value`  
- Oracle: `GET …/oracle-payload` preview only; `POST …/oracle-send` requires `oracle.send` + clean authoritative set + `confirm:true`

---

## Release candidate

See [`documentation/RELEASE_CANDIDATE.md`](documentation/RELEASE_CANDIDATE.md) for the security / scale / deploy / demo checklist.  
**Do not tag `v1.0.0` until one clean production smoke pass succeeds.**

```bash
# Local RC security suite
cd backend && ..\.venv\Scripts\python.exe -m pytest tests/test_security_certification.py tests/test_rbac_oracle_certification.py tests/test_rc_security.py -q

# Production smoke (writes a test upload — ask before running)
python backend/scripts/production_rc_smoke.py
```
