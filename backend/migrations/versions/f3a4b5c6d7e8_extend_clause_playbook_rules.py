"""extend clause_playbook_rules (standard / fallback text, extraction
patterns, category, agency)

Revision ID: f3a4b5c6d7e8
Revises: e2f3a4b5c6d7
Create Date: 2026-10-22 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "f3a4b5c6d7e8"
down_revision: Union[str, Sequence[str], None] = "e2f3a4b5c6d7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_COLUMNS = (
    ("standard_text", sa.Text()),
    ("fallback_text", sa.Text()),
    ("extraction_patterns", sa.JSON()),
    ("category", sa.String(length=120)),
    ("agency", sa.String(length=80)),
)


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table("clause_playbook_rules"):
        return
    existing = {column["name"] for column in inspector.get_columns("clause_playbook_rules")}
    for name, column_type in _COLUMNS:
        if name not in existing:
            op.add_column("clause_playbook_rules", sa.Column(name, column_type, nullable=True))


def downgrade() -> None:
    for name, _ in reversed(_COLUMNS):
        op.drop_column("clause_playbook_rules", name)
