"""Public-schema lockdown against Supabase's PostgREST roles.

The SQLite case runs everywhere. The Postgres cases need a disposable
server: set TEST_POSTGRES_URL to a superuser URL, e.g.
postgresql+psycopg://postgres:postgres@localhost:55432/postgres
"""

from __future__ import annotations

import os
import uuid

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.exc import ProgrammingError

from app.database.rls import RlsLockdownError, lock_down_public_schema

POSTGRES_URL = os.environ.get("TEST_POSTGRES_URL")
needs_postgres = pytest.mark.skipif(
    not POSTGRES_URL, reason="TEST_POSTGRES_URL not set"
)


def test_sqlite_is_a_no_op(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'db.sqlite'}")
    with engine.begin() as conn:
        conn.execute(text("CREATE TABLE documents (id INTEGER PRIMARY KEY)"))
    assert lock_down_public_schema(engine) == []


@pytest.fixture
def supabase_like():
    """A fresh database shaped like Supabase: an owner role that the app
    connects as, plus anon/authenticated holding default grants."""

    admin = create_engine(POSTGRES_URL, isolation_level="AUTOCOMMIT")
    suffix = uuid.uuid4().hex[:8]
    db, owner = f"rls_{suffix}", f"app_{suffix}"
    with admin.connect() as conn:
        for role in ("anon", "authenticated"):
            exists = conn.execute(
                text("SELECT 1 FROM pg_roles WHERE rolname = :r"), {"r": role}
            ).scalar()
            if not exists:
                conn.execute(text(f"CREATE ROLE {role} NOLOGIN"))
        conn.execute(text(f"CREATE ROLE {owner} LOGIN PASSWORD 'pw'"))
        conn.execute(text(f"CREATE DATABASE {db} OWNER {owner}"))

    base = admin.url.set(database=db)
    as_admin = create_engine(base, isolation_level="AUTOCOMMIT")
    with as_admin.connect() as conn:
        conn.execute(text(f"GRANT anon, authenticated TO {owner}"))
        conn.execute(text(f"ALTER SCHEMA public OWNER TO {owner}"))
    as_owner = create_engine(base.set(username=owner, password="pw"))
    with as_owner.begin() as conn:
        conn.execute(
            text(
                "ALTER DEFAULT PRIVILEGES IN SCHEMA public "
                "GRANT ALL ON TABLES TO anon, authenticated"
            )
        )
        conn.execute(text("CREATE TABLE documents (id serial PRIMARY KEY, name text)"))
        conn.execute(text("INSERT INTO documents (name) VALUES ('contract')"))

    yield as_admin, as_owner

    as_owner.dispose()
    as_admin.dispose()
    with admin.connect() as conn:
        conn.execute(text(f"DROP DATABASE {db} WITH (FORCE)"))
        conn.execute(text(f"DROP ROLE {owner}"))
    admin.dispose()


def _select_as(engine, role):
    with engine.begin() as conn:
        conn.execute(text(f"SET LOCAL ROLE {role}"))
        return conn.execute(text("SELECT count(*) FROM documents")).scalar()


@needs_postgres
def test_api_roles_lose_access_and_owner_keeps_it(supabase_like):
    _, owner = supabase_like
    assert _select_as(owner, "anon") == 1  # exposed before the lockdown

    assert lock_down_public_schema(owner) == ["documents"]

    with pytest.raises(ProgrammingError, match="permission denied"):
        _select_as(owner, "anon")
    with owner.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM documents")).scalar() == 1


@needs_postgres
def test_idempotent_and_covers_tables_added_later(supabase_like):
    _, owner = supabase_like
    lock_down_public_schema(owner)
    assert lock_down_public_schema(owner) == []

    with owner.begin() as conn:
        conn.execute(text("CREATE TABLE document_pages (id serial PRIMARY KEY)"))
    # Default grants were revoked, so a new table is closed even before
    # the next startup enables RLS on it.
    with pytest.raises(ProgrammingError, match="permission denied"):
        with owner.begin() as conn:
            conn.execute(text("SET LOCAL ROLE anon"))
            conn.execute(text("SELECT * FROM document_pages"))
    assert lock_down_public_schema(owner) == ["document_pages"]


@needs_postgres
def test_refuses_when_backend_role_does_not_own_tables(supabase_like):
    admin, owner = supabase_like
    with admin.connect() as conn:
        conn.execute(text("CREATE TABLE admin_owned (id int)"))

    with pytest.raises(RlsLockdownError, match="admin_owned"):
        lock_down_public_schema(owner)
    with owner.connect() as conn:
        rls = conn.execute(
            text("SELECT relrowsecurity FROM pg_class WHERE relname = 'documents'")
        ).scalar()
    assert rls is False  # nothing changed
