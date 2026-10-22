"""Intake batches: the documents uploaded together from the Extraction
workspace, tagged with agency / contracting officer / requested profile
(models/document_intake.py), and the batch decision — keep as draft,
reject, or submit to the review queue.

Mounted at /api/intake. Every query is scoped to the caller's documents
(core/document_access.py): a workspace caller only ever sees or changes
the documents its own workspace uploaded, even if another workspace
picked the same batch id.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import ActorContext, get_current_actor, require_any_permission, require_permission
from app.core.config import get_settings
from app.core.document_access import require_document_access, scope_documents
from app.database.dependencies import get_database
from app.models.document import Document
from app.models.document_intake import DocumentIntake
from app.services.dashboard_stats import compute_document_status
from app.services.document_intake import (
    AUTO_PROFILE,
    IntakeFields,
    IntakeValidationError,
    clean_batch_id,
)
from app.staging import registry
from app.staging.document_labels import document_labels, profile_label

router = APIRouter()

# Changing a batch's intake status sends it to (or holds it back from)
# the review queue: an uploader or a reviewer may do it.
_BATCH_DECISION = require_any_permission(
    "documents.upload", "review.accept", "review.reject"
)


class IntakeProfileOption(BaseModel):
    profile_id: str
    label: str


class IntakeConfigResponse(BaseModel):
    # The real per-file limit the upload endpoint enforces.
    max_upload_mb: int
    max_pdf_pages: int
    profiles: list[IntakeProfileOption]
    # False: a requested profile is stored as a hint; the staging resolver
    # still chooses from the document's own evidence.
    profile_override_supported: bool = False


class IntakeBatchDocument(BaseModel):
    document_id: str
    original_filename: str
    uploaded_at: datetime
    page_count: int
    size_bytes: int
    processing_status: str
    processed_page_count: int
    ocr_required_page_count: int
    ocr_completed_page_count: int
    # Computed summary status (services/dashboard_stats.py).
    status: Literal["processing", "review_required", "completed", "failed"]
    document_type: str | None = None
    profile_id: str | None = None
    profile_label: str | None = None
    agency: str | None = None
    contracting_officer: str | None = None
    extraction_profile: str
    intake_status: Literal["draft", "submitted", "rejected"]


class IntakeBatchResponse(BaseModel):
    batch_id: str
    documents: list[IntakeBatchDocument]
    # The batch's status when every document agrees, else "mixed".
    intake_status: Literal["draft", "submitted", "rejected", "mixed"]


class IntakeStatusRequest(BaseModel):
    status: Literal["draft", "submitted", "rejected"]


class IntakeStatusResponse(BaseModel):
    batch_id: str
    intake_status: Literal["draft", "submitted", "rejected"]
    updated: list[str]


class DocumentIntakeRequest(BaseModel):
    batch_id: str | None = None
    agency: str | None = None
    contracting_officer: str | None = None
    extraction_profile: str | None = None


class DocumentIntakeResponse(BaseModel):
    document_id: str
    batch_id: str | None
    agency: str | None
    contracting_officer: str | None
    extraction_profile: str
    intake_status: Literal["draft", "submitted", "rejected"]


def _batch_rows(
    database: Session, batch_id: str, actor: ActorContext
) -> list[tuple[DocumentIntake, Document]]:
    statement = scope_documents(
        select(DocumentIntake, Document)
        .join(Document, Document.id == DocumentIntake.document_id)
        .where(DocumentIntake.batch_id == batch_id)
        .order_by(Document.uploaded_at.asc()),
        actor,
    )
    return [(intake, document) for intake, document in database.execute(statement)]


def _valid_batch_id(batch_id: str) -> str:
    try:
        cleaned = clean_batch_id(batch_id)
    except IntakeValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if cleaned is None:
        raise HTTPException(status_code=422, detail="batch_id is required.")
    return cleaned


@router.get("/config", response_model=IntakeConfigResponse)
def get_intake_config(
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> IntakeConfigResponse:
    settings = get_settings()
    return IntakeConfigResponse(
        max_upload_mb=settings.max_upload_mb,
        max_pdf_pages=settings.max_pdf_pages,
        profiles=[
            IntakeProfileOption(profile_id=profile.profile_id, label=profile_label(profile.profile_id))
            for profile in registry.latest_profiles()
        ],
    )


@router.get("/batches/{batch_id}", response_model=IntakeBatchResponse)
def get_batch(
    batch_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> IntakeBatchResponse:
    batch_id = _valid_batch_id(batch_id)
    rows = _batch_rows(database, batch_id, actor)
    if not rows:
        raise HTTPException(status_code=404, detail="Batch not found.")

    documents = []
    for intake, document in rows:
        labels = document_labels(database, document)
        documents.append(
            IntakeBatchDocument(
                document_id=document.id,
                original_filename=document.original_filename,
                uploaded_at=document.uploaded_at,
                page_count=document.page_count,
                size_bytes=document.size_bytes,
                processing_status=document.processing_status,
                processed_page_count=document.processed_page_count or 0,
                ocr_required_page_count=document.ocr_required_page_count or 0,
                ocr_completed_page_count=document.ocr_completed_page_count or 0,
                status=compute_document_status(database, document),
                document_type=document.document_type,
                profile_id=labels.get("profile_id"),
                profile_label=labels.get("profile_label"),
                agency=intake.agency,
                contracting_officer=intake.contracting_officer,
                extraction_profile=intake.extraction_profile or AUTO_PROFILE,
                intake_status=intake.intake_status,
            )
        )
    statuses = {document.intake_status for document in documents}
    return IntakeBatchResponse(
        batch_id=batch_id,
        documents=documents,
        intake_status=statuses.pop() if len(statuses) == 1 else "mixed",
    )


@router.post("/batches/{batch_id}/status", response_model=IntakeStatusResponse)
def set_batch_status(
    batch_id: str,
    payload: IntakeStatusRequest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(_BATCH_DECISION),
) -> IntakeStatusResponse:
    batch_id = _valid_batch_id(batch_id)
    rows = _batch_rows(database, batch_id, actor)
    if not rows:
        raise HTTPException(status_code=404, detail="Batch not found.")

    now = datetime.now(timezone.utc)
    for intake, _document in rows:
        intake.intake_status = payload.status
        intake.updated_at = now
    database.commit()
    return IntakeStatusResponse(
        batch_id=batch_id,
        intake_status=payload.status,
        updated=[document.id for _intake, document in rows],
    )


def _intake_response(row: DocumentIntake) -> DocumentIntakeResponse:
    return DocumentIntakeResponse(
        document_id=row.document_id,
        batch_id=row.batch_id,
        agency=row.agency,
        contracting_officer=row.contracting_officer,
        extraction_profile=row.extraction_profile,
        intake_status=row.intake_status,
    )


@router.get("/documents/{document_id}", response_model=DocumentIntakeResponse)
def get_document_intake(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> DocumentIntakeResponse:
    """The document's intake tags; 404 when it was uploaded without any."""

    document = require_document_access(database, actor, document_id)
    row = database.get(DocumentIntake, document.id) if document is not None else None
    if row is None:
        raise HTTPException(status_code=404, detail="No intake record for this document.")
    return _intake_response(row)


@router.put("/documents/{document_id}", response_model=DocumentIntakeResponse)
def put_document_intake(
    document_id: str,
    payload: DocumentIntakeRequest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.upload")),
) -> DocumentIntakeResponse:
    """Tags a document after the fact — used when the upload went through
    the duplicate or PDF Portfolio follow-up, where the document only
    exists once the user has chosen. An existing row keeps its status."""

    document = require_document_access(database, actor, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    try:
        fields = IntakeFields(
            batch_id=payload.batch_id,
            agency=payload.agency,
            contracting_officer=payload.contracting_officer,
            extraction_profile=payload.extraction_profile,
        )
    except IntakeValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    row = database.get(DocumentIntake, document.id)
    if row is None:
        row = DocumentIntake(
            document_id=document.id,
            intake_status="draft",
            created_by=actor.id,
        )
        database.add(row)
    row.batch_id = fields.batch_id
    row.agency = fields.agency
    row.contracting_officer = fields.contracting_officer
    row.extraction_profile = fields.extraction_profile
    row.updated_at = datetime.now(timezone.utc)
    database.commit()
    return _intake_response(row)
