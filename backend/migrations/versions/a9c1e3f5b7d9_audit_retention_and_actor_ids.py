"""audit trails outlive their documents; actor ids on audits and corrections

- Drops the documents foreign key from the four audit logs so deleting a
  document no longer cascades away its history (DI-02, B-009).
- Adds actor_id to classification_audit_log and relationship_audit_log.
- Adds actor_id, reason_code, reason_text to target_corrections.

Revision ID: a9c1e3f5b7d9
Revises: f3a4b5c6d7e8
Create Date: 2026-10-26 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "a9c1e3f5b7d9"
down_revision: Union[str, Sequence[str], None] = "f3a4b5c6d7e8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

AUDIT_TABLES = (
    "metadata_field_audit_log",
    "classification_audit_log",
    "relationship_audit_log",
    "integration_audit_log",
)

NEW_COLUMNS = {
    "classification_audit_log": [sa.Column("actor_id", sa.String(length=64), nullable=True)],
    "relationship_audit_log": [sa.Column("actor_id", sa.String(length=64), nullable=True)],
    "target_corrections": [
        sa.Column("actor_id", sa.String(length=64), nullable=True),
        sa.Column("reason_code", sa.String(length=40), nullable=True),
        sa.Column("reason_text", sa.Text(), nullable=True),
    ],
}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # SQLite here never enforces foreign keys (and can't drop one without a
    # table rebuild); the model no longer declares them, so only real
    # constraints on other dialects need dropping.
    if bind.dialect.name != "sqlite":
        for table in AUDIT_TABLES:
            if not inspector.has_table(table):
                continue
            for fk in inspector.get_foreign_keys(table):
                if fk.get("referred_table") == "documents" and fk.get("name"):
                    op.drop_constraint(fk["name"], table, type_="foreignkey")

    for table, columns in NEW_COLUMNS.items():
        if not inspector.has_table(table):
            continue
        existing = {column["name"] for column in inspector.get_columns(table)}
        for column in columns:
            if column.name not in existing:
                op.add_column(table, column)
        if "actor_id" not in existing:
            op.create_index(f"ix_{table}_actor_id", table, ["actor_id"])


def downgrade() -> None:
    # Columns only. The documents foreign keys are not restored: audit rows
    # of already-deleted documents would violate them.
    for table, columns in NEW_COLUMNS.items():
        op.drop_index(f"ix_{table}_actor_id", table_name=table)
        for column in reversed(columns):
            op.drop_column(table, column.name)
