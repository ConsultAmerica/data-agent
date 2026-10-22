"""add clause_playbook_rules (workspace clause playbook rules/overrides)

Revision ID: a7b8c9d0e1f2
Revises: f2a3b4c5d6e7
Create Date: 2026-10-21 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "a7b8c9d0e1f2"
down_revision: Union[str, Sequence[str], None] = "f2a3b4c5d6e7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("clause_playbook_rules"):
        return
    op.create_table(
        "clause_playbook_rules",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("rule_id", sa.String(length=80), nullable=False),
        sa.Column("owner_workspace", sa.String(length=128), nullable=True),
        sa.Column("clause_number", sa.String(length=30), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("expectation", sa.String(length=20), nullable=False),
        sa.Column("severity", sa.String(length=10), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=False),
        sa.Column("applies_to", sa.String(length=10), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("owner_workspace", "rule_id", name="uq_clause_playbook_rule_workspace_rule"),
    )
    op.create_index("ix_clause_playbook_rules_rule_id", "clause_playbook_rules", ["rule_id"])
    op.create_index("ix_clause_playbook_rules_owner_workspace", "clause_playbook_rules", ["owner_workspace"])


def downgrade() -> None:
    op.drop_index("ix_clause_playbook_rules_owner_workspace", table_name="clause_playbook_rules")
    op.drop_index("ix_clause_playbook_rules_rule_id", table_name="clause_playbook_rules")
    op.drop_table("clause_playbook_rules")
