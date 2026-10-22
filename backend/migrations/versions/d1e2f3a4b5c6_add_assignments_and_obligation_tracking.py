"""add review_assignments and obligation_tracking

Revision ID: d1e2f3a4b5c6
Revises: c9d0e1f2a3b4
Create Date: 2026-10-22 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "d1e2f3a4b5c6"
down_revision: Union[str, Sequence[str], None] = "c9d0e1f2a3b4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("review_assignments"):
        op.create_table(
            "review_assignments",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("document_id", sa.String(length=36), nullable=False),
            sa.Column("metadata_field_id", sa.Integer(), nullable=True),
            sa.Column("field_key", sa.String(length=200), nullable=False),
            sa.Column("field_ref", sa.String(length=220), nullable=False),
            sa.Column("assignee", sa.String(length=200), nullable=False),
            sa.Column("due_date", sa.Date(), nullable=True),
            sa.Column("assigned_by", sa.String(length=200), nullable=False),
            sa.Column("assigned_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["document_id"], ["documents.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("document_id", "field_ref", name="uq_review_assignments_document_field"),
        )
        op.create_index("ix_review_assignments_document_id", "review_assignments", ["document_id"])
    if not inspector.has_table("obligation_tracking"):
        op.create_table(
            "obligation_tracking",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("document_id", sa.String(length=36), nullable=False),
            sa.Column("obligation_key", sa.String(length=64), nullable=False),
            sa.Column("workflow_status", sa.String(length=20), nullable=False),
            sa.Column("assignee", sa.String(length=200), nullable=True),
            sa.Column("subtasks", sa.JSON(), nullable=False),
            sa.Column("updated_by", sa.String(length=200), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["document_id"], ["documents.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("document_id", "obligation_key", name="uq_obligation_tracking_document_key"),
        )
        op.create_index("ix_obligation_tracking_document_id", "obligation_tracking", ["document_id"])


def downgrade() -> None:
    op.drop_index("ix_obligation_tracking_document_id", table_name="obligation_tracking")
    op.drop_table("obligation_tracking")
    op.drop_index("ix_review_assignments_document_id", table_name="review_assignments")
    op.drop_table("review_assignments")
