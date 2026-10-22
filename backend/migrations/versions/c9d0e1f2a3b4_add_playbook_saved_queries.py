"""add playbook_saved_queries (saved prompts / extraction criteria)

Revision ID: c9d0e1f2a3b4
Revises: b8c9d0e1f2a3
Create Date: 2026-10-22 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "c9d0e1f2a3b4"
down_revision: Union[str, Sequence[str], None] = "b8c9d0e1f2a3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("playbook_saved_queries"):
        return
    op.create_table(
        "playbook_saved_queries",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("owner_workspace", sa.String(length=128), nullable=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("kind", sa.String(length=20), nullable=False),
        sa.Column("query", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("created_by", sa.String(length=200), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_playbook_saved_queries_owner_workspace", "playbook_saved_queries", ["owner_workspace"])


def downgrade() -> None:
    op.drop_index("ix_playbook_saved_queries_owner_workspace", table_name="playbook_saved_queries")
    op.drop_table("playbook_saved_queries")
