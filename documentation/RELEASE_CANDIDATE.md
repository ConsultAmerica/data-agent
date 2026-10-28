# Release Candidate Checklist

Tag `v1.0.0` only after **one clean production smoke pass**.

```bash
git tag -a v1.0.0 -m "Dataomatix enterprise document intelligence release"
git push origin v1.0.0
```

## Security

| Item | How to verify | Status |
|---|---|---|
| RBAC permissions on real routes | `tests/test_rbac_oracle_certification.py`, `tests/test_rc_security.py` | automated |
| No secrets in frontend bundle | Only `NEXT_PUBLIC_*` in client; no API keys in `frontend/` | manual + code review |
| CORS locked to expected origins | Production `DEBUG=false` → no LAN origins; Vercel hosts allowlisted | automated (unit) |
| Upload MIME / type / size | `security_validation` + upload API rejects `.exe` / wrong type | automated |
| Path traversal / filename sanitization | `sanitize_display_filename` strips `../` and stores UUID name | automated |
| Audit logs include actor + request | corrections / review write `actor_*` + `request_id` | automated |
| No document text in logs | `observability._sanitize` drops `source_text` / `final_text` / `prompt` | automated |

## Scale

| Item | How to verify | Status |
|---|---|---|
| Concurrent upload | Manual / load tool against `/api/documents/upload` | manual |
| Concurrent extraction | Manual job starts under load | manual |
| Pool exhaustion behavior | Lower `DB_POOL_SIZE` and observe timeouts (not crash loops) | manual |
| Search under larger repo | Automated caps + SQL pagination; soak with fixture docs | partial auto |
| Large PDF near upload limit | Upload ~`MAX_UPLOAD_MB` PDF | manual |
| Timeout / failure recovery | Kill mid-job → status `failed` on restart | existing recover path |

## Deploy

| Item | How to verify | Status |
|---|---|---|
| Fresh Docker build | `docker build -f backend/Dockerfile backend` | manual |
| Fresh compose start | `cd infrastructure && docker compose up --build` | manual |
| Render from clean env | Redeploy service; `/ready` ok | manual |
| Vercel from clean env | Redeploy frontend; hit `/architecture` | manual |
| Cold-start smoke | `production_rc_smoke.py` after idle | script |
| Restart / reopen persistence | Smoke reopen extract-results without re-extract | script |

## Demo

| Item | Notes |
|---|---|
| One clean contract workflow | Prefer award / MSA with clear labels |
| One non-contract workflow | Invoice / rate card if available |
| One AI-escalated field | Ambiguous / sparse label |
| One human edit / accept / reject | Show audit |
| One Repository / Explorer reopen | No re-extract |
| One export preview | `extracted_value` vs `value` |
| Architecture page walkthrough | Close on `/architecture` |

## 5-minute script

0:00–0:45 Problem + architecture  
0:45–1:30 Upload  
1:30–2:30 Discover + extract  
2:30–3:30 Field intelligence + source  
3:30–4:15 Edit/accept + audit  
4:15–5:00 Repository / export → architecture  

## Gate for v1.0.0

- [x] RC security pytest green locally  
- [ ] `production_rc_smoke.py` green against Render  
- [ ] Demo dry-run once without improvisation  
- [ ] Then create annotated tag (above)

### Production smoke log

| Date | Result | Notes |
|---|---|---|
| 2026-09-10 | **FAIL — RC undeployed** | Live `/ready` lacks `rbac_enforced`; `GET /export` → 404. HEAD on `main` is still `d5e0697`; RC work is local/uncommitted. **Blocker:** commit + deploy RC SHA to Render/Vercel, then re-run smoke. Do not tag until re-smoke PASS. |
