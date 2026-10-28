"""Supplier master, purchase orders and learned supplier aliases — the
reference data invoices are matched against (services/invoice_matching.py).

Loaded from the ERP (Oracle Procurement / Payables extracts) or entered by
an administrator. IDR's own guidance applies: supplier names and site
addresses must match what invoices print (a PO Box on the site record vs a
street address on the invoice weakens matching), and the PO numbers must
follow the configured formats. Global for now: there is no tenant model.
"""

from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database.base import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Supplier(Base):
    __tablename__ = "reference_suppliers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    supplier_number: Mapped[str] = mapped_column(String(60), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(240), nullable=False)
    tax_id: Mapped[str | None] = mapped_column(String(60), nullable=True, index=True)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # e.g. internal suppliers: never auto-recognized (IDR guidance).
    excluded_from_recognition: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)


class SupplierSite(Base):
    __tablename__ = "reference_supplier_sites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("reference_suppliers.id", ondelete="CASCADE"), nullable=False, index=True)
    site_code: Mapped[str] = mapped_column(String(60), nullable=False)
    address: Mapped[str] = mapped_column(Text, nullable=False)
    pay_site: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    business_unit: Mapped[str | None] = mapped_column(String(120), nullable=True)


class SupplierAlias(Base):
    """A printed supplier name that means this supplier — approved by a
    person (typically by correcting an invoice's supplier match: the
    learning loop). Retired, never deleted."""

    __tablename__ = "reference_supplier_aliases"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("reference_suppliers.id", ondelete="CASCADE"), nullable=False, index=True)
    alias: Mapped[str] = mapped_column(String(240), nullable=False, index=True)  # normalized
    alias_display: Mapped[str] = mapped_column(String(240), nullable=False)  # as printed
    source: Mapped[str] = mapped_column(String(20), nullable=False, default="manual")  # manual | correction
    source_document_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="approved")  # approved | retired
    created_by: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, default=_now)
    retired_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    retired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class PurchaseOrder(Base):
    __tablename__ = "reference_purchase_orders"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    po_number: Mapped[str] = mapped_column(String(60), nullable=False, unique=True)
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("reference_suppliers.id", ondelete="SET NULL"), nullable=True)
    business_unit: Mapped[str | None] = mapped_column(String(120), nullable=True)
    currency: Mapped[str | None] = mapped_column(String(3), nullable=True)
    amount: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="open")  # open | closed
