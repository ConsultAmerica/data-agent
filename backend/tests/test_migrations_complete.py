"""A database built by Alembic alone (a new Neon branch, no start-up
create_all or column patches) has every model table and column."""

from __future__ import annotations

import importlib
import os
import pkgutil
import subprocess
import sys
import textwrap
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]


def test_alembic_alone_builds_the_full_schema(tmp_path: Path) -> None:
    # A separate process: the app's engine is bound to its database at import.
    script = textwrap.dedent(
        """
        import importlib, pkgutil
        from sqlalchemy import inspect
        from app.database.migrate import run_alembic_upgrade
        run_alembic_upgrade()
        import app.models
        for module in pkgutil.iter_modules(app.models.__path__):
            importlib.import_module(f"app.models.{module.name}")
        from app.database.base import Base
        from app.database.session import engine
        inspector = inspect(engine)
        tables = set(inspector.get_table_names())
        missing = sorted(set(Base.metadata.tables) - tables)
        columns = {
            name: sorted({c.name for c in table.columns} - {c["name"] for c in inspector.get_columns(name)})
            for name, table in Base.metadata.tables.items() if name in tables
        }
        columns = {name: gap for name, gap in columns.items() if gap}
        print("MISSING", missing, columns)
        run_alembic_upgrade()  # idempotent
        print("RERUN OK")
        """
    )
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{(tmp_path / 'fresh.db').as_posix()}", "APP_ENV": "development"}
    result = subprocess.run([sys.executable, "-c", script], cwd=BACKEND, env=env, capture_output=True, text=True, timeout=300)
    assert result.returncode == 0, result.stderr[-2000:]
    assert "MISSING [] {}" in result.stdout, result.stdout[-2000:]
    assert "RERUN OK" in result.stdout
