"""Reviewer assignments for Review Queue fields.

``router`` is mounted at /api/review-assignments. Assignees are display
names (there is no user directory); one active assignment per field, so
assigning again replaces it. Every item's document is checked against the
caller's workspace like any /{document_id} route — an unreachable document
answers 404.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.auth import ActorContext, get_current_actor, require_any_permission
from app.core.document_access import require_document_access, scope_documents
from app.database.dependencies import get_database
from app.models.document import Document
from app.models.document_metadata_field import DocumentMetadataField
from app.models.obligation_tracking import ObligationTracking
from app.models.review_assignment import ReviewAssignment, field_ref

router = APIRouter()

_can_assign = require_any_permission("review.edit", "review.accept")

MAX_ITEMS = 500


def clean_assignee(value: str | None) -> str | None:
    text = " ".join((value or "").split())
    return text[:200] or None


class AssignmentTarget(BaseModel):
    document_id: str = Field(min_length=1, max_length=36)
    metadata_field_id: int | None = None
    field_key: str = Field(min_length=1, max_length=200)


class AssignRequest(BaseModel):
    items: list[AssignmentTarget] = Field(min_length=1, max_length=MAX_ITEMS)
    assignee: str
    due_date: date | None = None

    @field_validator("assignee")
    @classmethod
    def _assignee(cls, value: str) -> str:
        cleaned = clean_assignee(value)
        if not cleaned:
            raise ValueError("An assignee name is required.")
        return cleaned


class UnassignRequest(BaseModel):
    items: list[AssignmentTarget] = Field(min_length=1, max_length=MAX_ITEMS)


def assignment_payload(row: ReviewAssignment) -> dict:
    return {
        "document_id": row.document_id,
        "metadata_field_id": row.metadata_field_id,
        "field_key": row.field_key,
        "assignee": row.assignee,
        "due_date": row.due_date.isoformat() if row.due_date else None,
        "assigned_by": row.assigned_by,
        "assigned_at": row.assigned_at.isoformat() if row.assigned_at else None,
    }


def _check_targets(database: Session, actor: ActorContext, items: list[AssignmentTarget]) -> None:
    for document_id in {item.document_id for item in items}:
        if require_document_access(database, actor, document_id) is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Document not found.")
    for item in items:
        if item.metadata_field_id is None:
            continue
        field = database.get(DocumentMetadataField, item.metadata_field_id)
        if field is None or field.document_id != item.document_id:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"Field {item.metadata_field_id} not found.")


@router.post("")
async def assign_fields(
    payload: AssignRequest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(_can_assign),
) -> dict:
    _check_targets(database, actor, payload.items)
    now = datetime.now(timezone.utc)
    saved: dict[tuple[str, str], ReviewAssignment] = {}
    for item in payload.items:
        ref = field_ref(item.metadata_field_id, item.field_key)
        key = (item.document_id, ref)
        row = saved.get(key) or database.scalar(
            select(ReviewAssignment).where(
                ReviewAssignment.document_id == item.document_id,
                ReviewAssignment.field_ref == ref,
            )
        )
        if row is None:
            row = ReviewAssignment(document_id=item.document_id, field_ref=ref)
            database.add(row)
        row.metadata_field_id = item.metadata_field_id
        row.field_key = item.field_key
        row.assignee = payload.assignee
        row.due_date = payload.due_date
        row.assigned_by = actor.display_name
        row.assigned_at = now
        saved[key] = row
    database.commit()
    return {"assigned": [assignment_payload(row) for row in saved.values()]}


@router.post("/unassign")
async def unassign_fields(
    payload: UnassignRequest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(_can_assign),
) -> dict:
    _check_targets(database, actor, payload.items)
    removed = 0
    for item in payload.items:
        removed += database.execute(
            delete(ReviewAssignment).where(
                ReviewAssignment.document_id == item.document_id,
                ReviewAssignment.field_ref == field_ref(item.metadata_field_id, item.field_key),
            )
        ).rowcount or 0
    database.commit()
    return {"unassigned": removed}


@router.get("/assignees")
async def list_assignees(
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> dict:
    """Names already used on the caller's documents (review fields and
    obligations), plus the caller's own display name."""

    visible = scope_documents(select(Document.id), actor)
    names = set(
        database.scalars(
            select(ReviewAssignment.assignee).where(ReviewAssignment.document_id.in_(visible)).distinct()
        )
    )
    names.update(
        name
        for name in database.scalars(
            select(ObligationTracking.assignee).where(ObligationTracking.document_id.in_(visible)).distinct()
        )
        if name
    )
    return {
        "assignees": sorted(names, key=str.lower),
        "current_actor": actor.display_name,
    }
