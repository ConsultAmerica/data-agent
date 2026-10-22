"""Close Supabase's auto-generated REST API (PostgREST) over our tables.

Supabase exposes every table in the ``public`` schema through PostgREST to
its ``anon`` and ``authenticated`` roles. The app never uses that API: the
backend connects directly as the table owner. So every public table gets
row level security enabled with no policies (deny-all for API roles; the
owner is exempt from RLS unless FORCE is set), and the API roles lose
their grants, including default grants on tables created later.

Runs after migrations on every production startup and is idempotent, so a
table added by a future migration is locked down on its first deploy.
"""

from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.engine import Engine

logger = logging.getLogger(__name__)

API_ROLES = ("anon", "authenticated")


class RlsLockdownError(RuntimeError):
    pass


def lock_down_public_schema(engine: Engine) -> list[str]:
    """Enable RLS on every public table; return the tables changed."""

    if engine.dialect.name != "postgresql":
        return []

    with engine.begin() as conn:
        tables = conn.execute(
            text(
                """
                SELECT c.relname,
                       c.relrowsecurity,
                       pg_get_userbyid(c.relowner) AS owner
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relkind IN ('r', 'p')
                ORDER BY c.relname
                """
            )
        ).all()
        current_user, bypass_rls = conn.execute(
            text(
                "SELECT current_user, rolbypassrls FROM pg_roles "
                "WHERE rolname = current_user"
            )
        ).one()

        # Without ownership (or BYPASSRLS) a no-policy RLS table would be
        # invisible to the backend itself. Refuse rather than lock it out.
        foreign = [name for name, _, owner in tables if owner != current_user]
        if foreign and not bypass_rls:
            raise RlsLockdownError(
                f"Role {current_user!r} does not own {', '.join(foreign)}; "
                "enabling RLS would hide those tables from the backend. "
                "Transfer ownership or grant BYPASSRLS first."
            )

        changed = []
        for name, has_rls, _ in tables:
            if not has_rls:
                conn.execute(
                    text(f'ALTER TABLE public."{name}" ENABLE ROW LEVEL SECURITY')
                )
                changed.append(name)

        present = [
            role
            for (role,) in conn.execute(
                text("SELECT rolname FROM pg_roles WHERE rolname = ANY(:roles)"),
                {"roles": list(API_ROLES)},
            )
        ]
        if present:
            roles = ", ".join(present)
            conn.execute(
                text(f"REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {roles}")
            )
            conn.execute(
                text(f"REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM {roles}")
            )
            conn.execute(
                text(
                    "ALTER DEFAULT PRIVILEGES IN SCHEMA public "
                    f"REVOKE ALL ON TABLES FROM {roles}"
                )
            )
            conn.execute(
                text(
                    "ALTER DEFAULT PRIVILEGES IN SCHEMA public "
                    f"REVOKE ALL ON SEQUENCES FROM {roles}"
                )
            )

    if changed:
        logger.warning(
            "Enabled row level security on %d public table(s): %s",
            len(changed),
            ", ".join(changed),
        )
    return changed
