from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import get_settings

settings = get_settings()

connect_args = {}
engine_kwargs: dict = {}

if settings.resolved_database_url.startswith("sqlite"):
    connect_args = {
        "check_same_thread": False,
    }
else:
    # Managed Postgres (e.g. Render) closes idle connections server-side;
    # pre-ping avoids handing the app a dead connection from the pool.
    # Keep the pool small on free/starter plans — one web dyno should not
    # exhaust the database connection allotment.
    engine_kwargs["pool_pre_ping"] = True
    engine_kwargs["pool_size"] = settings.db_pool_size
    engine_kwargs["max_overflow"] = settings.db_max_overflow
    engine_kwargs["pool_recycle"] = settings.db_pool_recycle_seconds
    engine_kwargs["pool_timeout"] = settings.db_pool_timeout_seconds

engine = create_engine(
    settings.resolved_database_url,
    connect_args=connect_args,
    **engine_kwargs,
)

if settings.resolved_database_url.startswith("sqlite"):
    from sqlalchemy import event

    @event.listens_for(engine, "connect")
    def _sqlite_concurrency(dbapi_connection, _record) -> None:
        """WAL lets job-status reads, page writes and background enrichment
        run side by side instead of queueing on one file lock (in the default
        journal mode a reader blocks a writer: uploads stalled for a minute).
        NORMAL sync is safe in WAL (no corruption; an OS crash can drop only
        the last commits) and avoids a disk flush per page commit. A busy
        timeout turns the remaining short contention into a wait, not an
        error."""

        cursor = dbapi_connection.cursor()
        try:
            cursor.execute("PRAGMA journal_mode=WAL")
            cursor.execute("PRAGMA synchronous=NORMAL")
            cursor.execute("PRAGMA busy_timeout=30000")
        finally:
            cursor.close()

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
)
