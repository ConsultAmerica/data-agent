"""oracle import templates and mapping profiles

Revision ID: e5a7c9d1f3b6
Revises: d4f6b8c0e2a4
Create Date: 2026-10-28 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "e5a7c9d1f3b6"
down_revision: Union[str, Sequence[str], None] = "d4f6b8c0e2a4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())

    if not inspector.has_table("oracle_templates"):
        op.create_table(
            "oracle_templates",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("object_name", sa.String(length=120), nullable=False),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("filename", sa.String(length=255), nullable=False),
            sa.Column("file_format", sa.String(length=10), nullable=False),
            sa.Column("original_bytes", sa.LargeBinary(), nullable=False),
            sa.Column("checksum_sha256", sa.String(length=64), nullable=False),
            sa.Column("sheet_name", sa.String(length=120), nullable=True),
            sa.Column("technical_row", sa.Integer(), nullable=False),
            sa.Column("label_row", sa.Integer(), nullable=True),
            sa.Column("columns", sa.JSON(), nullable=False),
            sa.Column("warnings", sa.JSON(), nullable=False),
            sa.Column("environment", sa.String(length=120), nullable=True),
            sa.Column("status", sa.String(length=20), nullable=False),
            sa.Column("owner_workspace", sa.String(length=64), nullable=True),
            sa.Column("uploaded_by", sa.String(length=120), nullable=False),
            sa.Column("uploaded_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_oracle_templates_object_name", "oracle_templates", ["object_name"])
        op.create_index("ix_oracle_templates_checksum_sha256", "oracle_templates", ["checksum_sha256"])
        op.create_index("ix_oracle_templates_owner_workspace", "oracle_templates", ["owner_workspace"])

    if not inspector.has_table("oracle_mapping_profiles"):
        op.create_table(
            "oracle_mapping_profiles",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("template_id", sa.Integer(), nullable=False),
            sa.Column("name", sa.String(length=200), nullable=False),
            sa.Column("staging_profile_id", sa.String(length=80), nullable=True),
            sa.Column("row_dataset", sa.String(length=120), nullable=True),
            sa.Column("mappings", sa.JSON(), nullable=False),
            sa.Column("key_columns", sa.JSON(), nullable=False),
            sa.Column("parent", sa.JSON(), nullable=True),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("history", sa.JSON(), nullable=False),
            sa.Column("owner_workspace", sa.String(length=64), nullable=True),
            sa.Column("updated_by", sa.String(length=120), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("notes", sa.Text(), nullable=True),
            sa.ForeignKeyConstraint(["template_id"], ["oracle_templates.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_oracle_mapping_profiles_template_id", "oracle_mapping_profiles", ["template_id"])
        op.create_index(
            "ix_oracle_mapping_profiles_staging_profile_id", "oracle_mapping_profiles", ["staging_profile_id"]
        )
        op.create_index("ix_oracle_mapping_profiles_owner_workspace", "oracle_mapping_profiles", ["owner_workspace"])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("oracle_mapping_profiles"):
        op.drop_table("oracle_mapping_profiles")
    if inspector.has_table("oracle_templates"):
        op.drop_table("oracle_templates")
