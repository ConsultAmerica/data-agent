"""Obligation tracker endpoints.

`router` is mounted under /api/documents (document isolation applies to
its /{document_id} route); `portfolio_router` under /api/obligations (its
tracking route checks document access itself).
"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import ActorContext, get_current_actor, require_any_permission
from app.core.document_access import require_document_access, scope_documents
from app.database.dependencies import get_database
from app.models.document import Document
from app.models.obligation_tracking import ObligationTracking
from app.services.obligations import (
    MAX_SUBTASKS,
    WORKFLOW_STATUSES,
    build_document_obligations,
    build_portfolio_obligations,
    summarize_obligations,
    tracking_payload,
)

_can_track = require_any_permission("review.edit", "review.accept")


class Subtask(BaseModel):
    title: str = Field(max_length=200)
    done: bool = False

    @field_validator("title")
    @classmethod
    def _title(cls, value: str) -> str:
        cleaned = " ".join(value.split())
        if not cleaned:
            raise ValueError("A sub-task needs a title.")
        return cleaned


class TrackingUpdate(BaseModel):
    """Only the fields sent change; `assignee` null or blank clears it."""

    workflow_status: str | None = None
    assignee: str | None = Field(default=None, max_length=200)
    subtasks: list[Subtask] | None = Field(default=None, max_length=MAX_SUBTASKS)

    @field_validator("workflow_status")
    @classmethod
    def _status(cls, value: str | None) -> str | None:
        if value is not None and value not in WORKFLOW_STATUSES:
            raise ValueError(f"workflow_status must be one of {', '.join(WORKFLOW_STATUSES)}.")
        return value

router = APIRouter()
portfolio_router = APIRouter()


@router.get("/{document_id}/obligations")
async def get_document_obligations(
    document_id: str,
    database: Session = Depends(get_database),
) -> dict:
    if database.get(Document, document_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")
    obligations = build_document_obligations(database, document_id)
    return {"document_id": document_id, **summarize_obligations(obligations)}


@portfolio_router.get("")
async def get_portfolio_obligations(
    status_filter: str | None = Query(default=None, alias="status"),
    category: str | None = None,
    document_id: str | None = None,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> dict:
    visible = scope_documents(select(Document.id), actor)
    if document_id:
        visible = visible.where(Document.id == document_id)
    result = build_portfolio_obligations(database, visible)
    if status_filter or category:
        kept = [
            item
            for item in result["obligations"]
            if (not status_filter or item["status"] == status_filter)
            and (not category or item["category"] == category)
        ]
        result = summarize_obligations(kept)
    return result


@portfolio_router.put("/{document_id}/tracking/{obligation_key}")
async def update_obligation_tracking(
    document_id: str,
    obligation_key: str,
    payload: TrackingUpdate,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(_can_track),
) -> dict:
    if require_document_access(database, actor, document_id) is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Document not found.")
    if not any(item["obligation_id"] == obligation_key for item in build_document_obligations(database, document_id)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Obligation not found.")

    row = database.scalar(
        select(ObligationTracking).where(
            ObligationTracking.document_id == document_id,
            ObligationTracking.obligation_key == obligation_key,
        )
    )
    if row is None:
        row = ObligationTracking(document_id=document_id, obligation_key=obligation_key, workflow_status="upcoming", subtasks=[])
        database.add(row)
    sent = payload.model_fields_set
    if "workflow_status" in sent and payload.workflow_status is not None:
        row.workflow_status = payload.workflow_status
    if "assignee" in sent:
        row.assignee = " ".join((payload.assignee or "").split()) or None
    if "subtasks" in sent:
        row.subtasks = [task.model_dump() for task in payload.subtasks or []]
    row.updated_by = actor.display_name
    row.updated_at = datetime.now(timezone.utc)
    database.commit()
    database.refresh(row)
    return {"document_id": document_id, "obligation_key": obligation_key, **tracking_payload(row)}
