"""recognition_runs: model version and usage (pages, tokens, cost)

Revision ID: c3e5a7b9d1f2
Revises: b2d4f6a8c0e1
Create Date: 2026-10-26 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "c3e5a7b9d1f2"
down_revision: Union[str, Sequence[str], None] = "b2d4f6a8c0e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

COLUMNS = (
    sa.Column("model_version", sa.String(length=40), nullable=True),
    sa.Column("pages", sa.Integer(), nullable=True),
    sa.Column("input_tokens", sa.Integer(), nullable=True),
    sa.Column("output_tokens", sa.Integer(), nullable=True),
    sa.Column("estimated_cost_usd", sa.Float(), nullable=True),
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    existing = {column["name"] for column in inspector.get_columns("recognition_runs")}
    for column in COLUMNS:
        if column.name not in existing:
            op.add_column("recognition_runs", column)


def downgrade() -> None:
    for column in reversed(COLUMNS):
        op.drop_column("recognition_runs", column.name)
