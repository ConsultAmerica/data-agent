"""schema & label designer: schemas, versions, events, document assignments

Revision ID: a7c9e1f3b5d8
Revises: f6b8d0e2a4c7
Create Date: 2026-10-29 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "a7c9e1f3b5d8"
down_revision: Union[str, Sequence[str], None] = "f6b8d0e2a4c7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())

    if not inspector.has_table("document_schemas"):
        op.create_table(
            "document_schemas",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("schema_key", sa.String(length=120), nullable=False),
            sa.Column("name", sa.String(length=200), nullable=False),
            sa.Column("category", sa.String(length=40), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("profile_id", sa.String(length=80), nullable=True),
            sa.Column("family", sa.String(length=80), nullable=True),
            sa.Column("is_system", sa.Boolean(), nullable=False),
            sa.Column("owner_workspace", sa.String(length=64), nullable=True),
            sa.Column("created_by", sa.String(length=120), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_document_schemas_schema_key", "document_schemas", ["schema_key"])
        op.create_index("ix_document_schemas_profile_id", "document_schemas", ["profile_id"])
        op.create_index("ix_document_schemas_owner_workspace", "document_schemas", ["owner_workspace"])

    if not inspector.has_table("document_schema_versions"):
        op.create_table(
            "document_schema_versions",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("schema_id", sa.Integer(), nullable=False),
            sa.Column("version", sa.String(length=20), nullable=False),
            sa.Column("status", sa.String(length=20), nullable=False),
            sa.Column("parent_version_id", sa.Integer(), nullable=True),
            sa.Column("definition", sa.JSON(), nullable=False),
            sa.Column("change_summary", sa.Text(), nullable=True),
            sa.Column("author", sa.String(length=120), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("submitted_by", sa.String(length=120), nullable=True),
            sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("published_by", sa.String(length=120), nullable=True),
            sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("effective_date", sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(["schema_id"], ["document_schemas.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["parent_version_id"], ["document_schema_versions.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_document_schema_versions_schema_id", "document_schema_versions", ["schema_id"])

    if not inspector.has_table("document_schema_events"):
        op.create_table(
            "document_schema_events",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("schema_id", sa.Integer(), nullable=False),
            sa.Column("version_id", sa.Integer(), nullable=True),
            sa.Column("action", sa.String(length=30), nullable=False),
            sa.Column("actor_id", sa.String(length=64), nullable=True),
            sa.Column("actor_name", sa.String(length=120), nullable=False),
            sa.Column("detail", sa.JSON(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_document_schema_events_schema_id", "document_schema_events", ["schema_id"])

    if not inspector.has_table("document_schema_assignments"):
        op.create_table(
            "document_schema_assignments",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("document_id", sa.String(length=36), nullable=False),
            sa.Column("schema_version_id", sa.Integer(), nullable=False),
            sa.Column("kind", sa.String(length=20), nullable=False),
            sa.Column("is_current", sa.Boolean(), nullable=False),
            sa.Column("assigned_by", sa.String(length=120), nullable=False),
            sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("note", sa.Text(), nullable=True),
            sa.ForeignKeyConstraint(["schema_version_id"], ["document_schema_versions.id"]),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_document_schema_assignments_document_id", "document_schema_assignments", ["document_id"])
        op.create_index(
            "ix_document_schema_assignments_schema_version_id", "document_schema_assignments", ["schema_version_id"]
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    for table in ("document_schema_assignments", "document_schema_events", "document_schema_versions", "document_schemas"):
        if inspector.has_table(table):
            op.drop_table(table)
