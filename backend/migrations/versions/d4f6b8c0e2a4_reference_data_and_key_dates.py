"""supplier master, purchase orders, learned aliases; document key dates

Revision ID: d4f6b8c0e2a4
Revises: c3e5a7b9d1f2
Create Date: 2026-10-26 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "d4f6b8c0e2a4"
down_revision: Union[str, Sequence[str], None] = "c3e5a7b9d1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())

    if not inspector.has_table("reference_suppliers"):
        op.create_table(
            "reference_suppliers",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("supplier_number", sa.String(length=60), nullable=False),
            sa.Column("name", sa.String(length=240), nullable=False),
            sa.Column("tax_id", sa.String(length=60), nullable=True),
            sa.Column("active", sa.Boolean(), nullable=False),
            sa.Column("excluded_from_recognition", sa.Boolean(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("supplier_number"),
        )
        op.create_index("ix_reference_suppliers_tax_id", "reference_suppliers", ["tax_id"])

    if not inspector.has_table("reference_supplier_sites"):
        op.create_table(
            "reference_supplier_sites",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("supplier_id", sa.Integer(), nullable=False),
            sa.Column("site_code", sa.String(length=60), nullable=False),
            sa.Column("address", sa.Text(), nullable=False),
            sa.Column("pay_site", sa.Boolean(), nullable=False),
            sa.Column("business_unit", sa.String(length=120), nullable=True),
            sa.ForeignKeyConstraint(["supplier_id"], ["reference_suppliers.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_reference_supplier_sites_supplier_id", "reference_supplier_sites", ["supplier_id"])

    if not inspector.has_table("reference_supplier_aliases"):
        op.create_table(
            "reference_supplier_aliases",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("supplier_id", sa.Integer(), nullable=False),
            sa.Column("alias", sa.String(length=240), nullable=False),
            sa.Column("alias_display", sa.String(length=240), nullable=False),
            sa.Column("source", sa.String(length=20), nullable=False),
            sa.Column("source_document_id", sa.String(length=36), nullable=True),
            sa.Column("status", sa.String(length=20), nullable=False),
            sa.Column("created_by", sa.String(length=64), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("retired_by", sa.String(length=64), nullable=True),
            sa.Column("retired_at", sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(["supplier_id"], ["reference_suppliers.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_reference_supplier_aliases_supplier_id", "reference_supplier_aliases", ["supplier_id"])
        op.create_index("ix_reference_supplier_aliases_alias", "reference_supplier_aliases", ["alias"])

    if not inspector.has_table("reference_purchase_orders"):
        op.create_table(
            "reference_purchase_orders",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("po_number", sa.String(length=60), nullable=False),
            sa.Column("supplier_id", sa.Integer(), nullable=True),
            sa.Column("business_unit", sa.String(length=120), nullable=True),
            sa.Column("currency", sa.String(length=3), nullable=True),
            sa.Column("amount", sa.Float(), nullable=True),
            sa.Column("status", sa.String(length=20), nullable=False),
            sa.ForeignKeyConstraint(["supplier_id"], ["reference_suppliers.id"], ondelete="SET NULL"),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("po_number"),
        )

    if not inspector.has_table("document_key_dates"):
        op.create_table(
            "document_key_dates",
            sa.Column("id", sa.Integer(), autoincrement=True, nullable=False),
            sa.Column("document_id", sa.String(length=36), nullable=False),
            sa.Column("kind", sa.String(length=20), nullable=False),
            sa.Column("date", sa.Date(), nullable=False),
            sa.Column("label", sa.String(length=200), nullable=False),
            sa.Column("source", sa.String(length=30), nullable=False),
            sa.Column("page", sa.Integer(), nullable=True),
            sa.Column("evidence_text", sa.Text(), nullable=True),
            sa.Column("details", sa.JSON(), nullable=True),
            sa.Column("confidence", sa.Float(), nullable=False),
            sa.Column("extractor_version", sa.String(length=20), nullable=False),
            sa.Column("detected_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["document_id"], ["documents.id"], ondelete="CASCADE"),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_document_key_dates_document_id", "document_key_dates", ["document_id"])
        op.create_index("ix_document_key_dates_kind", "document_key_dates", ["kind"])
        op.create_index("ix_document_key_dates_date", "document_key_dates", ["date"])


def downgrade() -> None:
    op.drop_table("document_key_dates")
    op.drop_table("reference_purchase_orders")
    op.drop_table("reference_supplier_aliases")
    op.drop_table("reference_supplier_sites")
    op.drop_table("reference_suppliers")
