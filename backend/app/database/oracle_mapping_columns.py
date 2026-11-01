"""Local-dev column patch for the Oracle mapping tables (create_all does not
add columns to an existing table). Production goes through migration
a7c9e1f3b5d7."""

from sqlalchemy.engine import Engine

from app.database.migrate import _ensure_columns

ORACLE_TEMPLATE_COLUMNS: dict[str, str | dict[str, str]] = {
    "catalog": "JSON",
}

ORACLE_MAPPING_PROFILE_COLUMNS: dict[str, str | dict[str, str]] = {
    "status": "VARCHAR(20) NOT NULL DEFAULT 'draft'",
    "created_by": "VARCHAR(120)",
    "approved_by": "VARCHAR(120)",
    "approved_at": {"sqlite": "DATETIME", "postgresql": "TIMESTAMP WITH TIME ZONE"},
    "source_document_type": "VARCHAR(120)",
}


def ensure_oracle_mapping_columns(engine: Engine) -> None:
    """Add the catalog and profile-approval columns to existing tables."""
    _ensure_columns(engine, "oracle_templates", ORACLE_TEMPLATE_COLUMNS)
    _ensure_columns(engine, "oracle_mapping_profiles", ORACLE_MAPPING_PROFILE_COLUMNS)
