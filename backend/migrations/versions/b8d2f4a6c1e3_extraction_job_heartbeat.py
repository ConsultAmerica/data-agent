"""extraction_jobs.heartbeat_at: detect a job lost with its worker

Revision ID: b8d2f4a6c1e3
Revises: a7c9e1f3b5d8
Create Date: 2026-10-29 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "b8d2f4a6c1e3"
down_revision: Union[str, Sequence[str], None] = "a7c9e1f3b5d8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    columns = {column["name"] for column in sa.inspect(op.get_bind()).get_columns("extraction_jobs")}
    if "heartbeat_at" not in columns:
        op.add_column("extraction_jobs", sa.Column("heartbeat_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("extraction_jobs", "heartbeat_at")
