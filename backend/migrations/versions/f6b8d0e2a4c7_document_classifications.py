"""document classification history (predictions and reviewer decisions)

Revision ID: f6b8d0e2a4c7
Revises: e5a7c9d1f3b6
Create Date: 2026-10-29 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "f6b8d0e2a4c7"
down_revision: Union[str, Sequence[str], None] = "e5a7c9d1f3b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("document_classifications"):
        return
    op.create_table(
        "document_classifications",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("document_id", sa.String(length=36), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("is_decision", sa.Boolean(), nullable=False),
        sa.Column("family", sa.String(length=80), nullable=False),
        sa.Column("family_label", sa.String(length=160), nullable=False),
        sa.Column("category", sa.String(length=40), nullable=False),
        sa.Column("subtype", sa.String(length=160), nullable=True),
        sa.Column("profile_id", sa.String(length=80), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("status", sa.String(length=30), nullable=False),
        sa.Column("candidates", sa.JSON(), nullable=False),
        sa.Column("evidence", sa.JSON(), nullable=False),
        sa.Column("method", sa.String(length=80), nullable=False),
        sa.Column("engine_version", sa.String(length=20), nullable=False),
        sa.Column("thresholds", sa.JSON(), nullable=False),
        sa.Column("actor_id", sa.String(length=64), nullable=True),
        sa.Column("actor_name", sa.String(length=120), nullable=True),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_document_classifications_document_id", "document_classifications", ["document_id"])
    op.create_index("ix_document_classifications_created_at", "document_classifications", ["created_at"])


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if inspector.has_table("document_classifications"):
        op.drop_table("document_classifications")
