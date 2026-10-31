"""oracle mapping workspace: target catalog metadata, profile approval
status, and the mapping audit history

Revision ID: a7c9e1f3b5d7
Revises: d5f7b9c1e3a6
Create Date: 2026-10-30 23:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "a7c9e1f3b5d7"
down_revision: Union[str, Sequence[str], None] = "d5f7b9c1e3a6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _columns(inspector, table: str) -> set[str]:
    return {column["name"] for column in inspector.get_columns(table)} if inspector.has_table(table) else set()


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if "catalog" not in _columns(inspector, "oracle_templates"):
        op.add_column("oracle_templates", sa.Column("catalog", sa.JSON(), nullable=True))
    profile = _columns(inspector, "oracle_mapping_profiles")
    if "status" not in profile:
        op.add_column(
            "oracle_mapping_profiles",
            sa.Column("status", sa.String(length=20), nullable=False, server_default="draft"),
        )
        op.create_index("ix_oracle_mapping_profiles_status", "oracle_mapping_profiles", ["status"])
    for name, column in (
        ("created_by", sa.Column("created_by", sa.String(length=120), nullable=True)),
        ("approved_by", sa.Column("approved_by", sa.String(length=120), nullable=True)),
        ("approved_at", sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True)),
        ("source_document_type", sa.Column("source_document_type", sa.String(length=120), nullable=True)),
    ):
        if name not in profile:
            op.add_column("oracle_mapping_profiles", column)
    if inspector.has_table("oracle_mapping_audit_events"):
        return
    op.create_table(
        "oracle_mapping_audit_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("profile_id", sa.Integer(), nullable=True),
        sa.Column("template_id", sa.Integer(), nullable=True),
        sa.Column("profile_version", sa.Integer(), nullable=True),
        sa.Column("action", sa.String(length=40), nullable=False),
        sa.Column("actor_id", sa.String(length=64), nullable=True),
        sa.Column("actor_name", sa.String(length=120), nullable=False),
        sa.Column("owner_workspace", sa.String(length=64), nullable=True),
        sa.Column("detail", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    for column in ("profile_id", "template_id", "owner_workspace", "created_at"):
        op.create_index(f"ix_oracle_mapping_audit_events_{column}", "oracle_mapping_audit_events", [column])


def downgrade() -> None:
    op.drop_table("oracle_mapping_audit_events")
    op.drop_index("ix_oracle_mapping_profiles_status", table_name="oracle_mapping_profiles")
    for column in ("source_document_type", "approved_at", "approved_by", "created_by", "status"):
        op.drop_column("oracle_mapping_profiles", column)
    op.drop_column("oracle_templates", "catalog")
