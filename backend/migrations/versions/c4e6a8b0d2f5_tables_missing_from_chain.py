"""Create the tables and columns no earlier migration creates

``actors``, ``document_extracted_tables`` and ``integration_audit_log`` were
only ever created by ``create_all`` at start-up, so a database built from
migrations alone (a new Neon branch) lacked them — and without ``actors``
service-key authentication fails. Likewise 15 columns existed only through
the start-up column checks (``database/migrate.py``). Both are added only
when missing, with the start-up checks' own DDL: a no-op on databases that
already have them.

Revision ID: c4e6a8b0d2f5
Revises: b8d2f4a6c1e3
Create Date: 2026-10-29 21:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "c4e6a8b0d2f5"
down_revision: Union[str, Sequence[str], None] = "b8d2f4a6c1e3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ("actors", "document_extracted_tables", "integration_audit_log")


def upgrade() -> None:
    # The models are the tables' only definition; created as defined today.
    from app.models.actor import Actor  # noqa: F401
    from app.models.document_extracted_table import DocumentExtractedTable  # noqa: F401
    from app.models.integration_audit_log import IntegrationAuditLog  # noqa: F401
    from app.database.base import Base

    from app.database import migrate as startup

    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = set(inspector.get_table_names())
    for name in TABLES:
        if name not in existing:
            Base.metadata.tables[name].create(bind=bind, checkfirst=True)

    column_maps = {
        "document_pages": startup.DOCUMENT_PAGE_COLUMNS,
        "documents": startup.DOCUMENT_COLUMNS,
        "document_metadata_fields": startup.DOCUMENT_METADATA_FIELD_COLUMNS,
        "extraction_models": startup.EXTRACTION_MODEL_COLUMNS,
        "target_corrections": startup.TARGET_CORRECTION_COLUMNS,
        "metadata_field_audit_log": startup.METADATA_FIELD_AUDIT_LOG_COLUMNS,
        "classification_audit_log": startup.ACTOR_AUDIT_LOG_COLUMNS,
        "relationship_audit_log": startup.ACTOR_AUDIT_LOG_COLUMNS,
        "extraction_jobs": startup.EXTRACTION_JOB_COLUMNS,
        "recognition_runs": startup.RECOGNITION_RUN_COLUMNS,
        "document_detected_targets": startup.DETECTED_TARGET_COLUMNS,
    }
    inspector = sa.inspect(bind)
    for table, columns in column_maps.items():
        if not inspector.has_table(table):
            continue
        have = {column["name"] for column in inspector.get_columns(table)}
        for column, column_type in columns.items():
            if column not in have:
                ddl = startup._column_ddl(column_type, bind.dialect.name)
                op.execute(sa.text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}"))


def downgrade() -> None:
    # Not dropped: on most databases these tables predate this migration.
    pass
