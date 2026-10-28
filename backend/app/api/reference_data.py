"""Supplier master, purchase orders and learned aliases (models/
reference_data.py), plus the reviewer's supplier correction on an invoice
— the learning loop: the printed name becomes an approved alias, so later
invoices that print it match automatically.

Loading reference data is an administrator task (`admin.integrations`);
correcting an invoice's supplier is a review action (gate + review.edit).
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import ActorContext, get_current_actor, require_permission
from app.core.observability import get_request_id
from app.database.dependencies import get_database
from app.models.document import Document
from app.models.metadata_field_audit_log import MetadataFieldAuditLog
from app.models.reference_data import PurchaseOrder, Supplier, SupplierAlias, SupplierSite
from app.services.invoice_matching import learn_supplier_alias, match_supplier

router = APIRouter()
documents_router = APIRouter()


class SiteIn(BaseModel):
    site_code: str = Field(min_length=1, max_length=60)
    address: str = Field(min_length=1, max_length=2000)
    pay_site: bool = True
    business_unit: str | None = Field(default=None, max_length=120)


class SupplierIn(BaseModel):
    supplier_number: str = Field(min_length=1, max_length=60)
    name: str = Field(min_length=1, max_length=240)
    tax_id: str | None = Field(default=None, max_length=60)
    active: bool = True
    excluded_from_recognition: bool = False
    sites: list[SiteIn] = Field(default_factory=list, max_length=200)


class SupplierOut(BaseModel):
    id: int
    supplier_number: str
    name: str
    tax_id: str | None
    active: bool
    excluded_from_recognition: bool
    sites: list[SiteIn]


class PurchaseOrderIn(BaseModel):
    po_number: str = Field(min_length=1, max_length=60)
    supplier_number: str | None = None
    business_unit: str | None = Field(default=None, max_length=120)
    currency: str | None = Field(default=None, max_length=3)
    amount: float | None = None
    status: str = Field(default="open", pattern="^(open|closed)$")


class AliasOut(BaseModel):
    id: int
    supplier_id: int
    alias_display: str
    source: str
    source_document_id: str | None
    status: str
    created_by: str
    created_at: datetime
    retired_by: str | None
    retired_at: datetime | None

    model_config = {"from_attributes": True}


def _supplier_out(database: Session, supplier: Supplier) -> SupplierOut:
    sites = database.scalars(select(SupplierSite).where(SupplierSite.supplier_id == supplier.id)).all()
    return SupplierOut(
        id=supplier.id, supplier_number=supplier.supplier_number, name=supplier.name, tax_id=supplier.tax_id,
        active=supplier.active, excluded_from_recognition=supplier.excluded_from_recognition,
        sites=[SiteIn(site_code=s.site_code, address=s.address, pay_site=s.pay_site, business_unit=s.business_unit) for s in sites],
    )


@router.get("/suppliers", response_model=list[SupplierOut])
async def list_suppliers(
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> list[SupplierOut]:
    return [_supplier_out(database, s) for s in database.scalars(select(Supplier).order_by(Supplier.name))]


@router.post("/suppliers", response_model=list[SupplierOut])
async def upsert_suppliers(
    payload: list[SupplierIn],
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("admin.integrations")),
) -> list[SupplierOut]:
    """Insert or update by supplier number; a supplier's sites are replaced."""

    saved = []
    for item in payload:
        supplier = database.scalars(select(Supplier).where(Supplier.supplier_number == item.supplier_number)).first()
        if supplier is None:
            supplier = Supplier(supplier_number=item.supplier_number, name=item.name)
            database.add(supplier)
        supplier.name, supplier.tax_id = item.name, item.tax_id
        supplier.active, supplier.excluded_from_recognition = item.active, item.excluded_from_recognition
        database.flush()
        for site in database.scalars(select(SupplierSite).where(SupplierSite.supplier_id == supplier.id)):
            database.delete(site)
        for site in item.sites:
            database.add(SupplierSite(supplier_id=supplier.id, **site.model_dump()))
        saved.append(supplier)
    database.commit()
    return [_supplier_out(database, s) for s in saved]


@router.get("/purchase-orders", response_model=list[PurchaseOrderIn])
async def list_purchase_orders(
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> list[PurchaseOrderIn]:
    numbers = {s.id: s.supplier_number for s in database.scalars(select(Supplier))}
    return [
        PurchaseOrderIn(po_number=po.po_number, supplier_number=numbers.get(po.supplier_id), business_unit=po.business_unit,
                        currency=po.currency, amount=po.amount, status=po.status)
        for po in database.scalars(select(PurchaseOrder).order_by(PurchaseOrder.po_number))
    ]


@router.post("/purchase-orders", response_model=list[PurchaseOrderIn])
async def upsert_purchase_orders(
    payload: list[PurchaseOrderIn],
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("admin.integrations")),
) -> list[PurchaseOrderIn]:
    for item in payload:
        supplier = None
        if item.supplier_number:
            supplier = database.scalars(select(Supplier).where(Supplier.supplier_number == item.supplier_number)).first()
            if supplier is None:
                raise HTTPException(status_code=400, detail=f"Unknown supplier number {item.supplier_number}.")
        po = database.scalars(select(PurchaseOrder).where(PurchaseOrder.po_number == item.po_number)).first()
        if po is None:
            po = PurchaseOrder(po_number=item.po_number)
            database.add(po)
        po.supplier_id = supplier.id if supplier else None
        po.business_unit, po.currency, po.amount, po.status = item.business_unit, item.currency, item.amount, item.status
    database.commit()
    return payload


@router.get("/supplier-aliases", response_model=list[AliasOut])
async def list_aliases(
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> list[SupplierAlias]:
    return list(database.scalars(select(SupplierAlias).order_by(SupplierAlias.id.desc())))


@router.post("/supplier-aliases/{alias_id}/retire", response_model=AliasOut)
async def retire_alias(
    alias_id: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("admin.integrations")),
) -> SupplierAlias:
    """Roll back a learned alias: later invoices stop matching through it."""

    alias = database.get(SupplierAlias, alias_id)
    if alias is None:
        raise HTTPException(status_code=404, detail="Alias not found.")
    if alias.status != "retired":
        alias.status, alias.retired_by, alias.retired_at = "retired", actor.id, datetime.now(timezone.utc)
        database.commit()
        database.refresh(alias)
    return alias


class SupplierCorrection(BaseModel):
    supplier_id: int


class SupplierCorrectionOut(BaseModel):
    printed_name: str
    supplier_number: str
    supplier_name: str
    alias_learned: bool
    status: str
    method: str | None


@documents_router.post("/{document_id}/invoice/supplier-match", response_model=SupplierCorrectionOut)
async def correct_invoice_supplier(
    document_id: str,
    payload: SupplierCorrection,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> SupplierCorrectionOut:
    """A reviewer says which master supplier this invoice is from. The
    printed name is learned as an alias (audited, retirable)."""

    from app.core.feature_gates import require_metadata_review_mutations_enabled
    from app.staging.service import get_staging_workbook

    require_metadata_review_mutations_enabled()
    if not actor.has("review.edit"):
        raise HTTPException(status_code=403, detail="Permission denied: review.edit")
    document = database.get(Document, document_id)
    supplier = database.get(Supplier, payload.supplier_id)
    if document is None or supplier is None:
        raise HTTPException(status_code=404, detail="Document or supplier not found.")
    workbook = get_staging_workbook(database, document_id)
    if workbook.profile.profile_id != "invoice":
        raise HTTPException(status_code=409, detail="Only invoices have a supplier match.")
    supplier_set = next((d for d in workbook.datasets if d.dataset_id == "supplier"), None)
    cell = supplier_set.records[0].cells.get("invoice.supplier.name") if supplier_set and supplier_set.records else None
    printed = (cell.raw_value if cell else None) or ""
    if not printed:
        raise HTTPException(status_code=409, detail="The invoice has no printed supplier name to learn from.")

    alias = learn_supplier_alias(database, printed_name=printed, supplier=supplier, actor_id=actor.id, document_id=document.id)
    database.add(
        MetadataFieldAuditLog(
            document_id=document.id, field_key="invoice.supplier", action="edit",
            previous_value=printed, new_value=f"{supplier.supplier_number} {supplier.name}",
            reason="Supplier matched by reviewer" + ("; alias learned for future invoices" if alias else ""),
            request_id=get_request_id(), actor_id=actor.id, actor_type=actor.actor_type, actor_role=actor.role,
            changed_by=actor.display_name,
        )
    )
    database.commit()
    rematch = match_supplier(database, name=printed)
    return SupplierCorrectionOut(
        printed_name=printed, supplier_number=supplier.supplier_number, supplier_name=supplier.name,
        alias_learned=alias is not None, status=rematch.status, method=rematch.method,
    )
