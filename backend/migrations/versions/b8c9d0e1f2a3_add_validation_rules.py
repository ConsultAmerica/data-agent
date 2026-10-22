"""add validation_rules (workspace batch validation rules/overrides)

Revision ID: b8c9d0e1f2a3
Revises: a7b8c9d0e1f2
Create Date: 2026-10-21 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "b8c9d0e1f2a3"
down_revision: Union[str, Sequence[str], None] = "a7b8c9d0e1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    if sa.inspect(op.get_bind()).has_table("validation_rules"):
        return
    op.create_table(
        "validation_rules",
        sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("rule_id", sa.String(length=80), nullable=False),
        sa.Column("owner_workspace", sa.String(length=128), nullable=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("rule_type", sa.String(length=30), nullable=False),
        sa.Column("field_label", sa.String(length=300), nullable=True),
        sa.Column("pattern", sa.String(length=300), nullable=True),
        sa.Column("threshold", sa.Float(), nullable=True),
        sa.Column("severity", sa.String(length=10), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("owner_workspace", "rule_id", name="uq_validation_rule_workspace_rule"),
    )
    op.create_index("ix_validation_rules_rule_id", "validation_rules", ["rule_id"])
    op.create_index("ix_validation_rules_owner_workspace", "validation_rules", ["owner_workspace"])


def downgrade() -> None:
    op.drop_index("ix_validation_rules_owner_workspace", table_name="validation_rules")
    op.drop_index("ix_validation_rules_rule_id", table_name="validation_rules")
    op.drop_table("validation_rules")
