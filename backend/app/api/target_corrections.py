from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import ActorContext, get_current_actor, require_permission
from app.core.observability import get_request_id
from app.database.dependencies import get_database
from app.models.document import Document
from app.models.document_metadata_field import DocumentMetadataField
from app.models.metadata_field_audit_log import MetadataFieldAuditLog
from app.models.target_correction import TargetCorrection
from app.schemas.target_correction import (
    TargetCorrectionCreate,
    TargetCorrectionResponse,
)

router = APIRouter()

_ACTION_TO_AUDIT = {
    "edit": "edit",
    "verify": "accept",
    "reject": "reject",
}
_ACTION_REASONS = {
    "edit": "Reviewer correction",
    "verify": "Reviewer accept",
    "reject": "Reviewer reject",
}
_ACTION_PERMISSION = {
    "edit": "review.edit",
    "verify": "review.accept",
    "reject": "review.reject",
}


def _load_document_or_404(database: Session, document_id: str) -> Document:
    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    return document


@router.post(
    "/{document_id}/targets/{normalized_key}/corrections",
    response_model=TargetCorrectionResponse,
    status_code=201,
)
async def create_target_correction(
    document_id: str,
    normalized_key: str,
    request: TargetCorrectionCreate,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> TargetCorrection:
    from app.core.feature_gates import require_metadata_review_mutations_enabled

    require_metadata_review_mutations_enabled()
    _load_document_or_404(database, document_id)

    permission = _ACTION_PERMISSION[request.action]
    if not actor.has(permission):  # type: ignore[arg-type]
        raise HTTPException(
            status_code=403,
            detail=f"Permission denied: {permission}",
        )

    if request.action == "edit" and request.corrected_value is None:
        raise HTTPException(
            status_code=400,
            detail="corrected_value is required for edit actions.",
        )

    display_name = request.changed_by or actor.display_name or "reviewer"

    correction = TargetCorrection(
        document_id=document_id,
        normalized_key=normalized_key,
        action=request.action,
        original_value=request.original_value,
        corrected_value=request.corrected_value,
        evidence_snapshot=(
            request.evidence.model_dump() if request.evidence else None
        ),
        changed_by=display_name,
        actor_id=actor.id,
        reason_code=request.reason_code,
        reason_text=(request.reason_text or "").strip() or None,
    )
    database.add(correction)

    # Keep durable intelligence record in sync so Explorer/reopen see truth.
    field = database.scalar(
        select(DocumentMetadataField).where(
            DocumentMetadataField.document_id == document_id,
            DocumentMetadataField.field_key == normalized_key,
            DocumentMetadataField.extraction_source == "target",
        )
    )
    previous_value = field.value if field is not None else (
        None if request.original_value is None else str(request.original_value)
    )
    previous_status = field.review_status if field is not None else None
    new_value = previous_value
    new_status = previous_status

    if field is not None:
        if request.action == "edit" and request.corrected_value is not None:
            field.value = str(request.corrected_value)
            field.review_status = "edited"
            field.human_approved = True
            evidence = dict(field.evidence_json or {})
            if "machine_value" not in evidence and previous_value is not None:
                evidence["machine_value"] = previous_value
            evidence["reviewed_value"] = field.value
            field.evidence_json = evidence
            new_value = field.value
            new_status = field.review_status
        elif request.action == "verify":
            field.verified = True
            field.human_approved = True
            field.review_status = "accepted"
            new_value = field.value
            new_status = field.review_status
        elif request.action == "reject":
            field.human_approved = False
            field.review_status = "rejected"
            new_value = field.value
            new_status = field.review_status

    database.add(
        MetadataFieldAuditLog(
            document_id=document_id,
            field_key=normalized_key[:50],
            action=_ACTION_TO_AUDIT[request.action],
            previous_value=previous_value,
            new_value=new_value,
            previous_status=previous_status,
            new_status=new_status,
            reason=_ACTION_REASONS[request.action],
            request_id=get_request_id(),
            actor_id=actor.id,
            actor_type=actor.actor_type,
            actor_role=actor.role,
            changed_by=display_name,
        )
    )

    database.commit()
    database.refresh(correction)
    return correction


@router.get(
    "/{document_id}/corrections",
    response_model=list[TargetCorrectionResponse],
)
async def list_target_corrections(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> list[TargetCorrection]:
    _load_document_or_404(database, document_id)

    rows = database.scalars(
        select(TargetCorrection)
        .where(TargetCorrection.document_id == document_id)
        .order_by(TargetCorrection.created_at.asc())
    ).all()

    latest_by_key: dict[str, TargetCorrection] = {}
    for row in rows:
        latest_by_key[row.normalized_key] = row

    return list(latest_by_key.values())
