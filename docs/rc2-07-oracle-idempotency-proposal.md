# RC2-07 — Oracle send idempotency proposal (design only)

**Status:** Proposal — **not implemented**  
**Related risk:** R1  
**Approval required** before any live-send semantics change

## Current behavior (evidence)

- `POST …/oracle-send` accepts `{confirm: true}` with no client request key.
- Dry-run writes `IntegrationAuditLog` rows; live Fusion client returns HTTP 501 when unconfigured.
- UI does not auto-retry; unknown/timeout outcomes are labeled unknown, not failed.

## Proposed design (for separate approval)

1. **Client request key** — Optional header or body field `Idempotency-Key` / `request_key` (UUID), scoped to `(workspace_id, document_id, actor_id, operation)`.
2. **Server reconciliation** — Before calling Fusion, look up an existing `IntegrationAuditLog` (or dedicated idempotency table) with the same key in a TTL window (e.g. 24h).
3. **Outcomes**
   - Prior **succeeded** → return stored audit id + outcome (HTTP 200), no second send.
   - Prior **failed** with terminal error → allow explicit new key only (no silent retry of same key).
   - Prior **in_flight / unknown** → return 409 Conflict with correlation id; client must poll history.
4. **Persistence** — Prefer append-only audit + unique constraint on request key; avoid parallel operational stores.
5. **Non-goals for this proposal** — Automatic retries, changing dry-run semantics, weakening RBAC.

## Stop condition

Implementing this requires separate approval and likely a migration — outside RC2-07 scope.
