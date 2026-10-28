"""Key dates API: one document's dated events, and the portfolio view of
what has expired or expires soon (scoped to the caller's documents)."""

from __future__ import annotations

from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import ActorContext, get_current_actor, require_permission
from app.core.config import get_settings
from app.core.document_access import scope_documents
from app.database.dependencies import get_database
from app.key_dates.detector import EXPIRING_KINDS
from app.key_dates.service import document_expiry, key_dates_for, refresh_key_dates, status_of
from app.models.document import Document
from app.models.document_key_date import DocumentKeyDate

router = APIRouter()
documents_router = APIRouter()


class KeyDateOut(BaseModel):
    document_id: str
    document_name: str | None = None
    kind: str
    date: date
    label: str
    source: str
    page: int | None
    evidence_text: str | None
    confidence: float
    status: str
    days_remaining: int


class DocumentKeyDates(BaseModel):
    document_id: str
    expiry: KeyDateOut | None
    key_dates: list[KeyDateOut]


def _out(row: DocumentKeyDate, name: str | None = None) -> KeyDateOut:
    status, days = status_of(row)
    return KeyDateOut(
        document_id=row.document_id, document_name=name, kind=row.kind, date=row.date, label=row.label,
        source=row.source, page=row.page, evidence_text=row.evidence_text, confidence=row.confidence,
        status=status, days_remaining=days,
    )


@documents_router.get("/{document_id}/key-dates", response_model=DocumentKeyDates)
async def get_document_key_dates(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> DocumentKeyDates:
    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    rows = key_dates_for(database, document)
    expiry = document_expiry(rows)
    return DocumentKeyDates(
        document_id=document_id, expiry=_out(expiry) if expiry else None, key_dates=[_out(r) for r in rows]
    )


@documents_router.post("/{document_id}/key-dates/refresh", response_model=DocumentKeyDates)
async def refresh_document_key_dates(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("extraction.run")),
) -> DocumentKeyDates:
    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    rows = refresh_key_dates(database, document)
    expiry = document_expiry(rows)
    return DocumentKeyDates(
        document_id=document_id, expiry=_out(expiry) if expiry else None, key_dates=[_out(r) for r in rows]
    )


@router.get("", response_model=list[KeyDateOut])
async def list_key_dates(
    status: str | None = Query(None, pattern="^(expired|expiring|upcoming|past)$"),
    within_days: int | None = Query(None, ge=1, le=3650),
    expiring_only: bool = Query(True, description="Only expiry-type dates (expiry, validity end, termination, period end)."),
    limit: int = Query(200, ge=1, le=1000),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> list[KeyDateOut]:
    if not actor.has("documents.view"):
        raise HTTPException(status_code=403, detail="Permission denied: documents.view")
    visible = scope_documents(select(Document.id), actor)
    query = select(DocumentKeyDate, Document.original_filename).join(Document, Document.id == DocumentKeyDate.document_id).where(
        DocumentKeyDate.document_id.in_(visible)
    )
    if expiring_only:
        query = query.where(DocumentKeyDate.kind.in_(sorted(EXPIRING_KINDS)))
    if within_days is not None:
        query = query.where(DocumentKeyDate.date <= date.today() + timedelta(days=within_days))
    rows = [_out(row, name) for row, name in database.execute(query.order_by(DocumentKeyDate.date))]
    if status:
        rows = [row for row in rows if row.status == status]
    return rows[:limit]


@router.get("/settings")
async def key_date_settings(actor: ActorContext = Depends(get_current_actor)) -> dict:
    return {"expiring_within_days": get_settings().key_date_expiring_days}
