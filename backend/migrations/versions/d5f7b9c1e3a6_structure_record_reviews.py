"""Reviews of original-structure records with no extraction row, and
the recorded versions of document skills

Revision ID: d5f7b9c1e3a6
Revises: c4e6a8b0d2f5
Create Date: 2026-10-30 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "d5f7b9c1e3a6"
down_revision: Union[str, Sequence[str], None] = "c4e6a8b0d2f5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("document_skill_versions"):
        op.create_table(
            "document_skill_versions",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("skill_id", sa.String(length=80), nullable=False),
            sa.Column("version", sa.String(length=20), nullable=False),
            sa.Column("content_hash", sa.String(length=32), nullable=False),
            sa.Column("definition", sa.JSON(), nullable=False),
            sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("skill_id", "version", name="uq_document_skill_version"),
        )
        op.create_index("ix_document_skill_versions_skill_id", "document_skill_versions", ["skill_id"])
    if inspector.has_table("structure_record_reviews"):
        return
    op.create_table(
        "structure_record_reviews",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("document_id", sa.String(length=36), sa.ForeignKey("documents.id", ondelete="CASCADE"), nullable=False),
        sa.Column("record_key", sa.String(length=300), nullable=False),
        sa.Column("record_kind", sa.String(length=10), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("original_value", sa.JSON(), nullable=True),
        sa.Column("reviewed_value", sa.JSON(), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("actor_id", sa.String(length=100), nullable=True),
        sa.Column("actor_name", sa.String(length=200), nullable=True),
        sa.Column("history", sa.JSON(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("document_id", "record_key", name="uq_structure_record_review"),
    )
    op.create_index("ix_structure_record_reviews_document_id", "structure_record_reviews", ["document_id"])


def downgrade() -> None:
    op.drop_index("ix_document_skill_versions_skill_id", table_name="document_skill_versions")
    op.drop_table("document_skill_versions")
    op.drop_index("ix_structure_record_reviews_document_id", table_name="structure_record_reviews")
    op.drop_table("structure_record_reviews")
