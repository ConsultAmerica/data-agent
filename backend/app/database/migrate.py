import logging
from pathlib import Path
import time

from alembic import command
from alembic.config import Config
from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.exc import OperationalError

logger = logging.getLogger(__name__)

_MIGRATION_ATTEMPTS = 8
_MIGRATION_RETRY_SECONDS = 5

_BACKEND_ROOT = Path(__file__).resolve().parents[2]


def run_alembic_upgrade() -> None:
    """Apply all pending Alembic migrations (production schema path).

    Local development keeps using create_all + ensure_*_columns below
    for convenience; production must go through real migrations so
    schema changes on Postgres are never silently skipped.
    """

    alembic_cfg = Config(str(_BACKEND_ROOT / "alembic.ini"))
    alembic_cfg.set_main_option(
        "script_location", str(_BACKEND_ROOT / "migrations")
    )
    # Migrations run in one transaction with a short lock_timeout (see
    # migrations/env.py), so a lock timeout rolls back cleanly and is
    # safe to retry once the previous instance's transactions finish.
    for attempt in range(1, _MIGRATION_ATTEMPTS + 1):
        try:
            command.upgrade(alembic_cfg, "head")
            return
        except OperationalError as exc:
            if "lock timeout" not in str(exc).lower() or attempt == _MIGRATION_ATTEMPTS:
                raise
            logger.warning(
                "Migration lock timeout (attempt %d/%d); retrying in %ds",
                attempt,
                _MIGRATION_ATTEMPTS,
                _MIGRATION_RETRY_SECONDS,
            )
            time.sleep(_MIGRATION_RETRY_SECONDS)


# Column type strings, keyed by dialect name. "sqlite" doubles as the
# default for any dialect not listed (sqlite's loose typing — e.g.
# "DATETIME", "BOOLEAN ... DEFAULT 0" — happens to also be valid SQL
# there, so most columns don't need a postgres-specific override).
_DEFAULT_DIALECT = "sqlite"


def _column_ddl(column_type: str | dict[str, str], dialect_name: str) -> str:
    if isinstance(column_type, str):
        return column_type
    return column_type.get(dialect_name, column_type[_DEFAULT_DIALECT])


DOCUMENT_PAGE_COLUMNS: dict[str, str | dict[str, str]] = {
    "form_fields_json": "JSON",
    "tables_json": "JSON",
    "ocr_layout_json": "JSON",
    "has_tables": {"sqlite": "BOOLEAN NOT NULL DEFAULT 0", "postgresql": "BOOLEAN NOT NULL DEFAULT false"},
    "has_form_fields": {"sqlite": "BOOLEAN NOT NULL DEFAULT 0", "postgresql": "BOOLEAN NOT NULL DEFAULT false"},
    "is_scanned": {"sqlite": "BOOLEAN NOT NULL DEFAULT 0", "postgresql": "BOOLEAN NOT NULL DEFAULT false"},
    "text_length": "INTEGER NOT NULL DEFAULT 0",
}


DOCUMENT_METADATA_FIELD_COLUMNS: dict[str, str | dict[str, str]] = {
    "human_approved": {"sqlite": "BOOLEAN NOT NULL DEFAULT 0", "postgresql": "BOOLEAN NOT NULL DEFAULT false"},
    "review_status": "VARCHAR(20) NOT NULL DEFAULT 'pending'",
    "original_value": "TEXT NOT NULL DEFAULT ''",
    "confidence_band": "VARCHAR(10)",
    "value_type": "VARCHAR(30)",
    "display_method": "VARCHAR(80)",
    "extraction_source": "VARCHAR(20) NOT NULL DEFAULT 'contract'",
    "extraction_job_id": "INTEGER",
}


EXTRACTION_MODEL_COLUMNS: dict[str, str | dict[str, str]] = {
    "document_types": {"sqlite": "JSON", "postgresql": "JSON DEFAULT '[\"*\"]'::json"},
}


TARGET_CORRECTION_COLUMNS: dict[str, str | dict[str, str]] = {
    "action": "VARCHAR(20) NOT NULL DEFAULT 'edit'",
    "actor_id": "VARCHAR(64)",
    "reason_code": "VARCHAR(40)",
    "reason_text": "TEXT",
}


# classification_audit_log and relationship_audit_log share this shape.
ACTOR_AUDIT_LOG_COLUMNS: dict[str, str | dict[str, str]] = {
    "actor_id": "VARCHAR(64)",
}


EXTRACTION_JOB_COLUMNS: dict[str, str | dict[str, str]] = {
    "heartbeat_at": {"sqlite": "DATETIME", "postgresql": "TIMESTAMP WITH TIME ZONE"},
}


RECOGNITION_RUN_COLUMNS: dict[str, str | dict[str, str]] = {
    "model_version": "VARCHAR(40)",
    "pages": "INTEGER",
    "input_tokens": "INTEGER",
    "output_tokens": "INTEGER",
    "estimated_cost_usd": "FLOAT",
}


METADATA_FIELD_AUDIT_LOG_COLUMNS: dict[str, str | dict[str, str]] = {
    "previous_status": "VARCHAR(20)",
    "new_status": "VARCHAR(20)",
    "reason": "TEXT",
    "request_id": "VARCHAR(64)",
    "actor_id": "VARCHAR(64)",
    "actor_type": "VARCHAR(20)",
    "actor_role": "VARCHAR(32)",
    "metadata_field_id": "INTEGER",
}


DETECTED_TARGET_COLUMNS: dict[str, str | dict[str, str]] = {
    "discovery_meta_json": {
        "sqlite": "JSON NOT NULL DEFAULT '{}'",
        "postgresql": "JSON NOT NULL DEFAULT '{}'::json",
    },
}


DOCUMENT_COLUMNS: dict[str, str | dict[str, str]] = {
    "document_type": "VARCHAR(60)",
    "industry": "VARCHAR(60)",
    "contract_side": "VARCHAR(20)",
    "document_language": "VARCHAR(40)",
    "classification_confidence": "FLOAT",
    "parent_document_id": "VARCHAR(36)",
    "parent_relationship_type": "VARCHAR(30)",
    "parent_relationship_confidence": "FLOAT",
    "parent_relationship_matched_on": "VARCHAR(20)",
    "parent_relationship_status": "VARCHAR(20)",
    "processing_duration_seconds": "FLOAT",
    "approved_by": "VARCHAR(120)",
    "owner_workspace": "VARCHAR(64)",
    "data_class": "VARCHAR(20)",
    "data_class_source": "VARCHAR(20)",
    "approved_at": {"sqlite": "DATETIME", "postgresql": "TIMESTAMP WITH TIME ZONE"},
    "document_status": "VARCHAR(30)",
    "parent_relationship_reasons": "JSON",
    "parent_relationship_detection_method": "VARCHAR(20)",
    "promoted_by": "VARCHAR(120)",
    "promoted_at": {"sqlite": "DATETIME", "postgresql": "TIMESTAMP WITH TIME ZONE"},
    "organization_id": "VARCHAR(36)",
    "owner_id": "VARCHAR(36)",
    "ingestion_provenance": "JSON",
}


def _ensure_columns(
    engine: Engine,
    table_name: str,
    columns: dict[str, str | dict[str, str]],
) -> None:
    """Add any missing columns to an existing table, on any dialect.

    Uses SQLAlchemy's dialect-agnostic inspector (not sqlite's PRAGMA)
    so this also patches columns added to a model after a table was
    first created on Postgres — the same gap this already covered for
    SQLite, just no longer skipped there.
    """

    inspector = inspect(engine)

    if not inspector.has_table(table_name):
        return

    existing = {column["name"] for column in inspector.get_columns(table_name)}

    with engine.begin() as connection:
        for column_name, column_type in columns.items():
            if column_name in existing:
                continue

            ddl = _column_ddl(column_type, engine.dialect.name)
            connection.execute(
                text(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {ddl}")
            )


def ensure_document_page_columns(engine: Engine) -> None:
    """Add missing document_pages columns for an existing database."""
    _ensure_columns(engine, "document_pages", DOCUMENT_PAGE_COLUMNS)


def ensure_documents_columns(engine: Engine) -> None:
    """Add missing documents columns for an existing database."""
    _ensure_columns(engine, "documents", DOCUMENT_COLUMNS)


def ensure_document_metadata_field_columns(engine: Engine) -> None:
    """Add missing document_metadata_fields columns for an existing database."""
    _ensure_columns(
        engine, "document_metadata_fields", DOCUMENT_METADATA_FIELD_COLUMNS
    )


def ensure_extraction_model_columns(engine: Engine) -> None:
    """Add missing extraction_models columns for an existing database."""
    _ensure_columns(engine, "extraction_models", EXTRACTION_MODEL_COLUMNS)


def ensure_target_correction_columns(engine: Engine) -> None:
    """Add missing target_corrections columns for an existing database."""
    _ensure_columns(engine, "target_corrections", TARGET_CORRECTION_COLUMNS)


def ensure_metadata_field_audit_log_columns(engine: Engine) -> None:
    """Add missing metadata_field_audit_log columns for an existing database."""
    _ensure_columns(
        engine, "metadata_field_audit_log", METADATA_FIELD_AUDIT_LOG_COLUMNS
    )


def ensure_actor_audit_log_columns(engine: Engine) -> None:
    """Add actor_id to the classification and relationship audit logs."""
    _ensure_columns(engine, "classification_audit_log", ACTOR_AUDIT_LOG_COLUMNS)
    _ensure_columns(engine, "relationship_audit_log", ACTOR_AUDIT_LOG_COLUMNS)


def ensure_extraction_job_columns(engine: Engine) -> None:
    """Add the runner heartbeat to extraction_jobs created before it existed."""
    _ensure_columns(engine, "extraction_jobs", EXTRACTION_JOB_COLUMNS)


def ensure_recognition_run_columns(engine: Engine) -> None:
    """Add usage columns to recognition_runs created before they existed."""
    _ensure_columns(engine, "recognition_runs", RECOGNITION_RUN_COLUMNS)


def ensure_detected_target_columns(engine: Engine) -> None:
    """Add missing document_detected_targets columns for an existing database."""
    _ensure_columns(
        engine, "document_detected_targets", DETECTED_TARGET_COLUMNS
    )
