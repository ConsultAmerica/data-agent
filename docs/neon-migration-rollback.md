# Neon Migration Rollback

**Status:** Prepared — **not executed**  
**Goal:** Return authoritative Postgres to the pre-cutover Supabase database without data loss or Storage disruption

---

## 1. When to roll back

- Neon restore counts mismatch or FK orphans  
- `/ready` fails (DB unreachable) after `DATABASE_URL` swap  
- Critical repository/search/workspace isolation regressions  
- Document open fails due to DB (not Storage) errors  

Do **not** roll back solely for Storage issues — Storage remains on Supabase in both directions.

---

## 2. Preconditions for a safe rollback

| Requirement | Why |
|---|---|
| Supabase Postgres **not deleted** and still accepts connections | Rollback target |
| Pre-cutover `DATABASE_URL` retained in password manager / Render previous value | Exact restore of config |
| Cutover dump retained | Forensic / re-attempt |
| Write freeze still preferred during rollback window | Avoid split-brain writes |

---

## 3. Rollback procedure (production — approval required)

1. **Announce** rollback maintenance.  
2. **Stop writers** — scale Render web to 0 or enable maintenance page.  
3. **Revert Render `DATABASE_URL`** to the saved Supabase Postgres URL (SSL as before).  
4. **Do not change** `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` / bucket.  
5. **Restart** backend; confirm:  
   - `GET /health` → ok  
   - `GET /ready` → ready, database check ok  
   - `oracle_dry_run` true; review mutations fail-closed  
6. **Smoke:** document search → open → staging tab → export; governance portfolio.  
7. **Confirm** no dual-write: Neon left idle (do not delete until postmortem).  
8. **Communicate** completion.

---

## 4. Data written only to Neon during failed cutover

If any writes landed on Neon after swap:

| Option | Use when |
|---|---|
| Discard Neon-only writes | Short window; no critical accepts/uploads |
| Forward-port specific rows | Rare; manual SQL with approval |
| Re-cutover later from fresh Supabase dump | Preferred after fix |

Document any discarded Neon-only IDs in the incident note.

---

## 5. Staging rollback

Staging has no production impact:

- Delete or reset Neon staging branch  
- Repoint local/staging API `DATABASE_URL` back to prior value  
- No Supabase production changes  

---

## 6. What never to do in rollback

- Delete Supabase Postgres or Storage buckets  
- Point `DATABASE_URL` at Neon while also writing to Supabase without a sync plan  
- Commit connection strings  
- Enable live Oracle or review mutations to “test” recovery  

---

## 7. Post-rollback

- [ ] Root-cause note (dump error, pooling, missing column, network)  
- [ ] Keep Neon branch for analysis if useful  
- [ ] Schedule revised staging attempt  
- [ ] Retain backups per retention policy  
