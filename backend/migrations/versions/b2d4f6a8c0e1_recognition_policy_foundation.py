"""recognition foundation: document data class, provider approvals, runs

- documents.data_class / data_class_source (taxonomy §4)
- provider_approvals: which external provider may see which data class
- recognition_runs: every provider call or policy refusal (no content)

Revision ID: b2d4f6a8c0e1
Revises: a9c1e3f5b7d9
Create Date: 2026-10-26 13:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "b2d4f6a8c0e1"
down_revision: Union[str, Sequence[str], None] = "a9c1e3f5b7d9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())

    existing = {column["name"] for column in inspector.get_columns("documents")}
    for name in ("data_class", "data_class_source"):
        if name not in existing:
            op.add_column("documents", sa.Column(name, sa.String(length=20), nullable=True))

    if not inspector.has_table("provider_approvals"):
        op.create_table(
            "provider_approvals",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("provider_id", sa.String(length=40), nullable=False),
            sa.Column("data_class", sa.String(length=20), nullable=False),
            sa.Column("purpose", sa.Text(), nullable=False),
            sa.Column("region", sa.String(length=40), nullable=True),
            sa.Column("approved_by", sa.String(length=64), nullable=False),
            sa.Column("approved_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("revoked_by", sa.String(length=64), nullable=True),
            sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_provider_approvals_provider_id", "provider_approvals", ["provider_id"])

    if not inspector.has_table("recognition_runs"):
        op.create_table(
            "recognition_runs",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("run_id", sa.String(length=36), nullable=False),
            sa.Column("document_id", sa.String(length=36), nullable=True),
            sa.Column("extraction_job_id", sa.Integer(), nullable=True),
            sa.Column("provider_id", sa.String(length=40), nullable=False),
            sa.Column("model", sa.String(length=80), nullable=True),
            sa.Column("locality", sa.String(length=10), nullable=False),
            sa.Column("method", sa.String(length=40), nullable=True),
            sa.Column("status", sa.String(length=20), nullable=False),
            sa.Column("error_kind", sa.String(length=20), nullable=True),
            sa.Column("data_class", sa.String(length=20), nullable=True),
            sa.Column("policy_reason", sa.Text(), nullable=True),
            sa.Column("pipeline_version", sa.String(length=40), nullable=True),
            sa.Column("duration_ms", sa.Integer(), nullable=True),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_recognition_runs_run_id", "recognition_runs", ["run_id"])
        op.create_index("ix_recognition_runs_document_id", "recognition_runs", ["document_id"])
        op.create_index(
            "ix_recognition_runs_extraction_job_id", "recognition_runs", ["extraction_job_id"]
        )


def downgrade() -> None:
    op.drop_index("ix_recognition_runs_extraction_job_id", table_name="recognition_runs")
    op.drop_index("ix_recognition_runs_document_id", table_name="recognition_runs")
    op.drop_index("ix_recognition_runs_run_id", table_name="recognition_runs")
    op.drop_table("recognition_runs")
    op.drop_index("ix_provider_approvals_provider_id", table_name="provider_approvals")
    op.drop_table("provider_approvals")
    op.drop_column("documents", "data_class_source")
    op.drop_column("documents", "data_class")
