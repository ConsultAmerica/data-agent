"""Report on, or apply, the public-schema RLS lockdown against a database.

Same code the backend runs on startup (app.database.rls), for applying the
fix without waiting for a deploy. Reads the target from RLS_DATABASE_URL so
the production URL never has to go into .env or the shell history of a
command line.

Usage:
  python backend/scripts/lock_down_rls.py           # report only
  python backend/scripts/lock_down_rls.py --apply   # enable RLS + revoke
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy import create_engine, text  # noqa: E402

from app.database.rls import API_ROLES, lock_down_public_schema  # noqa: E402

REPORT_SQL = text(
    """
    SELECT c.relname,
           c.relrowsecurity,
           pg_get_userbyid(c.relowner) AS owner,
           EXISTS (
             SELECT 1 FROM information_schema.role_table_grants g
             WHERE g.table_schema = 'public' AND g.table_name = c.relname
               AND g.grantee = ANY(:roles)
           ) AS api_grants
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
    ORDER BY c.relname
    """
)


def report(engine) -> None:
    with engine.connect() as conn:
        user, bypass = conn.execute(
            text("SELECT current_user, rolbypassrls FROM pg_roles WHERE rolname = current_user")
        ).one()
        rows = conn.execute(REPORT_SQL, {"roles": list(API_ROLES)}).all()
    exposed = [r for r in rows if not r.relrowsecurity or r.api_grants]
    foreign = sorted({r.owner for r in rows if r.owner != user})
    print(f"Connected as {user!r} (bypassrls={bypass}); {len(rows)} public tables")
    print(f"  RLS off: {sum(not r.relrowsecurity for r in rows)}")
    print(f"  API roles still granted: {sum(r.api_grants for r in rows)}")
    if foreign and not bypass:
        print(f"  WARNING: tables owned by {foreign}; --apply will refuse")
    for r in exposed:
        print(f"    {r.relname}  rls={'on' if r.relrowsecurity else 'OFF'}  "
              f"api_grants={'YES' if r.api_grants else 'no'}  owner={r.owner}")


def main() -> int:
    url = os.environ.get("RLS_DATABASE_URL")
    if not url:
        print("Set RLS_DATABASE_URL to the Postgres connection string.", file=sys.stderr)
        return 2
    if url.startswith("postgres://"):
        url = "postgresql://" + url[len("postgres://"):]
    if url.startswith("postgresql://"):
        url = "postgresql+psycopg://" + url[len("postgresql://"):]

    engine = create_engine(url)
    try:
        report(engine)
        if "--apply" in sys.argv:
            changed = lock_down_public_schema(engine)
            print(f"\nApplied. RLS enabled on {len(changed)} table(s); API grants revoked.\n")
            report(engine)
        else:
            print("\nReport only. Re-run with --apply to fix.")
    finally:
        engine.dispose()
    return 0


if __name__ == "__main__":
    sys.exit(main())
