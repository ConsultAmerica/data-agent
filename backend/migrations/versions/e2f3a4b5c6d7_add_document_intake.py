"""add document_intake (batch, agency, contracting officer, intake status)

Revision ID: e2f3a4b5c6d7
Revises: d1e2f3a4b5c6
Create Date: 2026-10-22 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "e2f3a4b5c6d7"
down_revision: Union[str, Sequence[str], None] = "d1e2f3a4b5c6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("document_intake"):
        return
    op.create_table(
        "document_intake",
        sa.Column("document_id", sa.String(length=36), nullable=False),
        sa.Column("batch_id", sa.String(length=64), nullable=True),
        sa.Column("agency", sa.String(length=200), nullable=True),
        sa.Column("contracting_officer", sa.String(length=200), nullable=True),
        sa.Column("extraction_profile", sa.String(length=80), nullable=False),
        sa.Column("intake_status", sa.String(length=20), nullable=False),
        sa.Column("created_by", sa.String(length=200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["document_id"], ["documents.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("document_id"),
    )
    op.create_index("ix_document_intake_batch_id", "document_intake", ["batch_id"])


def downgrade() -> None:
    op.drop_index("ix_document_intake_batch_id", table_name="document_intake")
    op.drop_table("document_intake")
