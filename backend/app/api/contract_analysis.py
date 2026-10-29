from datetime import datetime, timezone
from typing import Any, get_args

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.document_access import can_access_document
from app.core.auth import ActorContext, get_current_actor
from app.core.observability import get_request_id
from app.database.dependencies import get_database
from app.models.classification_audit_log import ClassificationAuditLog
from app.models.document import Document
from app.models.document_metadata_field import DocumentMetadataField
from app.models.document_page import DocumentPage
from app.models.metadata_field_audit_log import DOCUMENT_EVENT_FIELD_KEY, MetadataFieldAuditLog
from app.models.extraction_model import ExtractionField
from app.models.relationship_audit_log import RelationshipAuditLog
from app.staging.document_labels import document_labels
from app.schemas.contract_analysis import (
    AcceptAllRequest,
    AnalyzeContractRequest,
    ApproveDocumentRequest,
    ApproveDocumentResponse,
    PromoteDocumentRequest,
    PromoteDocumentResponse,
    ChildRelationship,
    ChildRelationshipsResponse,
    ClassificationHistoryEntry,
    ClassificationUpdateRequest,
    ConfirmRelationshipRequest,
    ConfirmRelationshipResponse,
    ContractAnalysisResponse,
    ContractClassification,
    DetectedRelationship,
    FieldAuditEntry,
    FieldReviewRequest,
    ManualRelationshipRequest,
    MetadataFieldResult,
    RemoveRelationshipRequest,
)
from app.schemas.contract_clauses import ClauseExtractionResponse
from app.schemas.contract_signatures import (
    SignatureExtractionResponse,
)
from app.schemas.contract_tables import TableExtractionResponse
from app.schemas.structured_tables import StructuredTablesResponse
from app.services.ai_provider import AIProviderError
from app.services.ai_enrichment import start_session
from app.services.ai_provider_factory import create_ai_provider
from app.services.containers import EMAIL_ATTACHMENT_RELATIONSHIP
from app.services.contract_classifier import classify_contract
from app.services.contract_field_schema import FieldSpec
from app.services.contract_clause_extractor import (
    clause_to_result,
    extract_contract_clauses,
    get_document_clauses,
)
from app.services.contract_metadata_extractor import (
    AmbiguousMetadataFieldError,
    extract_contract_metadata,
    field_to_result,
    get_metadata_field,
    get_metadata_field_by_id,
    require_unique_metadata_field,
)
from app.services.contract_signature_extractor import (
    extract_contract_signatures,
    get_document_signatures,
    signature_to_result,
)
from app.services.contract_structured_output import (
    build_structured_output,
)
from app.services.contract_structured_table_extractor import (
    extract_document_structured_tables,
    get_document_structured_tables,
    structured_table_response_kwargs,
)
from app.services.contract_table_extractor import (
    normalize_document_tables,
)
from app.services.dashboard_stats import compute_document_status
from app.services.document_status import compute_document_status_label
from app.services.review_routing import low_risk_blockers
from app.services.relationship_detector import (
    DetectedRelationshipMatch,
    detect_relationship,
)

router = APIRouter()
settings = get_settings()


def _load_ready_document(
    database: Session, document_id: str
) -> Document:
    document = database.get(Document, document_id)

    if document is None:
        raise HTTPException(
            status_code=404,
            detail="Document not found.",
        )

    if document.processing_status not in {
        "completed",
        "completed_with_warnings",
    }:
        raise HTTPException(
            status_code=409,
            detail="Run page extraction before analyzing the contract.",
        )

    return document


def _load_pages(
    database: Session, document_id: str
) -> list[DocumentPage]:
    return list(
        database.scalars(
            select(DocumentPage)
            .where(DocumentPage.document_id == document_id)
            .order_by(DocumentPage.page_number)
        )
    )


def _build_relationship_response(
    database: Session,
    match: DetectedRelationshipMatch,
    *,
    status: str = "pending",
) -> DetectedRelationship:
    parent = database.get(Document, match.parent_document_id)

    parent_title = (
        parent.original_filename if parent else "Unknown document"
    )

    title_field = get_metadata_field(
        database,
        document_id=match.parent_document_id,
        field_key="contract_title",
    )

    if title_field and title_field.value:
        parent_title = title_field.value

    number_field = get_metadata_field(
        database,
        document_id=match.parent_document_id,
        field_key="contract_number",
    )

    return DetectedRelationship(
        parent_document_id=match.parent_document_id,
        parent_document_title=parent_title,
        parent_document_number=(
            number_field.value if number_field else None
        ),
        relationship_type=match.relationship_type,
        confidence=match.confidence,
        matched_on=match.matched_on,
        status=status,
        reasons=match.reasons,
        detection_method=match.detection_method,
    )


def _relationship_match_from_document(
    document: Document,
) -> DetectedRelationshipMatch | None:
    if (
        document.parent_document_id is None
        or document.parent_relationship_status is None
    ):
        return None

    return DetectedRelationshipMatch(
        parent_document_id=document.parent_document_id,
        relationship_type=document.parent_relationship_type or "",
        confidence=document.parent_relationship_confidence or 0.0,
        matched_on=(
            document.parent_relationship_matched_on
            or "contract_number"
        ),
        reasons=document.parent_relationship_reasons or [],
        detection_method=(
            document.parent_relationship_detection_method
            or "automatic"
        ),
    )


def _would_create_cycle(
    database: Session, *, document_id: str, proposed_parent_id: str
) -> bool:
    """True if setting document_id's parent to proposed_parent_id would
    create a cycle — walk the proposed parent's ancestor chain looking
    for document_id."""

    current_id: str | None = proposed_parent_id
    visited: set[str] = set()

    while current_id is not None:
        if current_id == document_id:
            return True

        if current_id in visited:
            break

        visited.add(current_id)

        current = database.get(Document, current_id)
        current_id = current.parent_document_id if current else None

    return False


@router.post(
    "/{document_id}/analyze-contract",
    response_model=ContractAnalysisResponse,
)
async def analyze_contract(
    document_id: str,
    payload: AnalyzeContractRequest | None = None,
    database: Session = Depends(get_database),
) -> ContractAnalysisResponse:
    document = _load_ready_document(database, document_id)
    pages = _load_pages(database, document_id)

    warnings: list[str] = []

    if not pages:
        warnings.append(
            "No extracted pages were found for this document."
        )

    extra_field_specs: list[FieldSpec] = []

    if payload and payload.extraction_model_id is not None:
        custom_fields = list(
            database.scalars(
                select(ExtractionField).where(
                    ExtractionField.model_id
                    == payload.extraction_model_id
                )
            )
        )

        extra_field_specs = [
            FieldSpec(
                group="Custom",
                key=f"custom_{field.id}",
                label=field.field_name,
                description=field.description,
                data_type=field.data_type,
            )
            for field in custom_fields
        ]

    ai_provider = start_session(
        create_ai_provider(settings), settings, database=database, document=document
    )

    try:
        classification = await classify_contract(
            pages=pages,
            ai_provider=ai_provider,
        )
    except AIProviderError as exc:
        warnings.append(f"Classification unavailable: {exc}")
        classification = ContractClassification()

    document.document_type = classification.document_type
    document.industry = classification.industry
    document.contract_side = classification.contract_side
    document.document_language = classification.language
    document.classification_confidence = classification.confidence
    database.commit()

    metadata_fields = await extract_contract_metadata(
        database=database,
        document=document,
        pages=pages,
        ai_provider=ai_provider,
        extra_field_specs=extra_field_specs,
    )

    relationship_response: DetectedRelationship | None = None
    match = detect_relationship(
        database=database,
        document=document,
        pages=pages,
    )

    # A file attached to an email stays linked to that email (a known
    # fact), not to a guessed parent contract.
    if (
        match is not None
        and document.parent_relationship_type != EMAIL_ATTACHMENT_RELATIONSHIP
    ):
        document.parent_document_id = match.parent_document_id
        document.parent_relationship_type = match.relationship_type
        document.parent_relationship_confidence = match.confidence
        document.parent_relationship_matched_on = match.matched_on
        document.parent_relationship_status = "pending"
        document.parent_relationship_reasons = match.reasons
        document.parent_relationship_detection_method = (
            match.detection_method
        )
        database.commit()

        relationship_response = _build_relationship_response(
            database, match, status="pending"
        )

    contract_title = next(
        (
            field.value
            for field in metadata_fields
            if field.field_key == "contract_title"
        ),
        None,
    )
    document.document_status = compute_document_status_label(
        document, contract_title=contract_title
    )
    database.commit()
    classification.document_status = document.document_status

    return ContractAnalysisResponse(
        document_id=document.id,
        classification=classification,
        metadata_fields=metadata_fields,
        relationship=relationship_response,
        warnings=warnings,
    )


def _staged_contract_type(database: Session, document: Document) -> str:
    """The classifier's type for a document only the staging pipeline has
    read: its staging label when that is one of the classifier's types,
    "Government Contract" for a staged contract, otherwise "Other"."""

    allowed = set(get_args(ContractClassification.model_fields["document_type"].annotation))
    labels = document_labels(database, document)
    label = labels["type_label"]
    if label in allowed:
        return label
    profile = (labels["profile_id"] or "").lower()
    if "contract" in profile or "contract" in (label or "").lower():
        return "Government Contract"
    return "Other"


@router.get(
    "/{document_id}/analyze-contract",
    response_model=ContractAnalysisResponse,
)
async def get_contract_analysis(
    document_id: str,
    database: Session = Depends(get_database),
) -> ContractAnalysisResponse:
    document = database.get(Document, document_id)

    if document is None:
        raise HTTPException(
            status_code=404,
            detail="Document not found.",
        )

    fields = list(
        database.scalars(
            select(DocumentMetadataField).where(
                DocumentMetadataField.document_id == document_id
            )
        )
    )

    # The staging pipeline extracts reviewable values without running the
    # contract classifier, so a document counts as analyzed once it has
    # values; its type then comes from the staging label the list shows.
    document_type = document.document_type
    if document_type is None and fields:
        document_type = _staged_contract_type(database, document)
    if document_type is None:
        raise HTTPException(
            status_code=404,
            detail="This document has not been analyzed yet.",
        )

    classification = ContractClassification(
        document_type=document_type,
        industry=document.industry,
        contract_side=document.contract_side or "unknown",
        language=document.document_language,
        document_status=document.document_status or "Unknown",
        confidence=document.classification_confidence or 0.0,
    )

    relationship = None
    match = _relationship_match_from_document(document)

    if match is not None:
        relationship = _build_relationship_response(
            database,
            match,
            status=document.parent_relationship_status or "pending",
        )

    return ContractAnalysisResponse(
        document_id=document.id,
        classification=classification,
        metadata_fields=[
            field_to_result(field) for field in fields
        ],
        relationship=relationship,
        warnings=[],
        **_staged_identity(database, document_id),
    )


def _staged_identity(database: Session, document_id: str) -> dict:
    """Contract number and contractor as the staging workbook has them;
    first line only (addresses follow the name). Empty when not staged."""

    try:
        from app.services.ask_engine import contract_facts

        facts = contract_facts(database, document_id)
    except Exception:  # noqa: BLE001 - the header is optional; analysis must still load
        return {}

    def first_line(*labels: str) -> str | None:
        value = facts.fact(*labels).value
        return " ".join(str(value).strip().splitlines()[0].split()) if value else None

    return {
        "staged_contract_number": first_line("Contract Number"),
        "staged_contractor": first_line("Contractor", "Contractor Name", "Offeror"),
    }


@router.post(
    "/{document_id}/confirm-relationship",
    response_model=ConfirmRelationshipResponse,
)
async def confirm_relationship(
    document_id: str,
    payload: ConfirmRelationshipRequest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> ConfirmRelationshipResponse:
    document = database.get(Document, document_id)

    if document is None:
        raise HTTPException(
            status_code=404,
            detail="Document not found.",
        )

    if (
        document.parent_document_id is None
        or document.parent_relationship_status != "pending"
    ):
        raise HTTPException(
            status_code=409,
            detail="No pending relationship to resolve for this document.",
        )

    changed_by = payload.changed_by

    if payload.action == "confirm":
        if _would_create_cycle(
            database,
            document_id=document.id,
            proposed_parent_id=document.parent_document_id,
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    "Confirming this relationship would create a "
                    "circular reference between the two documents."
                ),
            )

        previous_status = document.parent_relationship_status
        document.parent_relationship_status = "confirmed"
        document.document_status = compute_document_status_label(
            document
        )
        database.add(
            RelationshipAuditLog(
                document_id=document.id,
                action="confirm",
                previous_parent_id=document.parent_document_id,
                new_parent_id=document.parent_document_id,
                previous_relationship_type=(
                    document.parent_relationship_type
                ),
                new_relationship_type=document.parent_relationship_type,
                changed_by=changed_by,
                actor_id=actor.id,
            )
        )
        database.commit()

        match = _relationship_match_from_document(document)
        assert match is not None

        relationship = _build_relationship_response(
            database, match, status="confirmed"
        )

        return ConfirmRelationshipResponse(
            document_id=document.id,
            status="confirmed",
            relationship=relationship,
        )

    database.add(
        RelationshipAuditLog(
            document_id=document.id,
            action="reject",
            previous_parent_id=document.parent_document_id,
            new_parent_id=None,
            previous_relationship_type=document.parent_relationship_type,
            new_relationship_type=None,
            changed_by=changed_by,
            actor_id=actor.id,
        )
    )

    document.parent_relationship_status = "rejected"
    document.parent_document_id = None
    document.parent_relationship_reasons = None
    document.document_status = compute_document_status_label(document)
    database.commit()

    return ConfirmRelationshipResponse(
        document_id=document.id,
        status="rejected",
        relationship=None,
    )


@router.get(
    "/{document_id}/child-relationships",
    response_model=ChildRelationshipsResponse,
)
async def get_child_relationships(
    document_id: str,
    database: Session = Depends(get_database),
) -> ChildRelationshipsResponse:
    parent = database.get(Document, document_id)

    if parent is None:
        raise HTTPException(
            status_code=404,
            detail="Document not found.",
        )

    child_documents = list(
        database.scalars(
            select(Document).where(
                Document.parent_document_id == document_id,
                # Same owner only (workspace isolation).
                Document.owner_workspace == parent.owner_workspace
                if parent.owner_workspace is not None
                else Document.owner_workspace.is_(None),
            )
        )
    )

    children: list[ChildRelationship] = []

    for child in child_documents:
        title_field = get_metadata_field(
            database,
            document_id=child.id,
            field_key="contract_title",
        )
        number_field = get_metadata_field(
            database,
            document_id=child.id,
            field_key="contract_number",
        )

        children.append(
            ChildRelationship(
                child_document_id=child.id,
                child_document_title=(
                    title_field.value
                    if title_field and title_field.value
                    else child.original_filename
                ),
                child_document_number=(
                    number_field.value if number_field else None
                ),
                relationship_type=child.parent_relationship_type
                or "",
                confidence=child.parent_relationship_confidence
                or 0.0,
                status=child.parent_relationship_status
                or "pending",
                reasons=child.parent_relationship_reasons or [],
            )
        )

    return ChildRelationshipsResponse(
        parent_document_id=document_id,
        children=children,
    )


@router.post(
    "/{document_id}/relationship",
    response_model=DetectedRelationship,
)
async def assign_relationship(
    document_id: str,
    payload: ManualRelationshipRequest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> DetectedRelationship:
    document = database.get(Document, document_id)

    if document is None:
        raise HTTPException(
            status_code=404,
            detail="Document not found.",
        )

    if payload.parent_document_id == document_id:
        raise HTTPException(
            status_code=422,
            detail="A document cannot be its own parent.",
        )

    parent = database.get(Document, payload.parent_document_id)

    # The body names a second document: it must be reachable too, or a
    # caller could link to — and then read — another workspace's file.
    if parent is None or not can_access_document(actor, parent) or (
        parent.owner_workspace != document.owner_workspace
    ):
        raise HTTPException(
            status_code=404,
            detail="The selected parent document does not exist.",
        )

    if (
        document.parent_document_id == payload.parent_document_id
        and document.parent_relationship_status
        in {"confirmed", "manual"}
    ):
        raise HTTPException(
            status_code=409,
            detail="These documents are already linked.",
        )

    if _would_create_cycle(
        database,
        document_id=document_id,
        proposed_parent_id=payload.parent_document_id,
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "Assigning this parent would create a circular "
                "reference between the two documents."
            ),
        )

    database.add(
        RelationshipAuditLog(
            document_id=document.id,
            action="manual_assign",
            previous_parent_id=document.parent_document_id,
            new_parent_id=payload.parent_document_id,
            previous_relationship_type=document.parent_relationship_type,
            new_relationship_type=payload.relationship_type,
            changed_by=payload.changed_by,
            actor_id=actor.id,
        )
    )

    document.parent_document_id = payload.parent_document_id
    document.parent_relationship_type = payload.relationship_type
    document.parent_relationship_confidence = 1.0
    document.parent_relationship_matched_on = "contract_number"
    document.parent_relationship_status = "manual"
    document.parent_relationship_reasons = ["Manually assigned"]
    document.parent_relationship_detection_method = "manual"
    document.document_status = compute_document_status_label(document)
    database.commit()

    match = _relationship_match_from_document(document)
    assert match is not None

    return _build_relationship_response(
        database, match, status="manual"
    )


@router.delete(
    "/{document_id}/relationship",
)
async def remove_relationship(
    document_id: str,
    payload: RemoveRelationshipRequest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, str]:
    document = database.get(Document, document_id)

    if document is None:
        raise HTTPException(
            status_code=404,
            detail="Document not found.",
        )

    if document.parent_document_id is None:
        raise HTTPException(
            status_code=409,
            detail="This document has no relationship to remove.",
        )

    database.add(
        RelationshipAuditLog(
            document_id=document.id,
            action="remove",
            previous_parent_id=document.parent_document_id,
            new_parent_id=None,
            previous_relationship_type=document.parent_relationship_type,
            new_relationship_type=None,
            changed_by=payload.changed_by,
            actor_id=actor.id,
        )
    )

    document.parent_document_id = None
    document.parent_relationship_type = None
    document.parent_relationship_confidence = None
    document.parent_relationship_matched_on = None
    document.parent_relationship_status = None
    document.parent_relationship_reasons = None
    document.parent_relationship_detection_method = None
    document.document_status = compute_document_status_label(document)
    database.commit()

    return {"status": "removed"}


@router.patch(
    "/{document_id}/classification",
    response_model=ContractClassification,
)
async def update_classification(
    document_id: str,
    payload: ClassificationUpdateRequest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> ContractClassification:
    document = database.get(Document, document_id)

    if document is None:
        raise HTTPException(
            status_code=404,
            detail="Document not found.",
        )

    updates: list[tuple[str, str | None, str | None]] = []

    if (
        payload.document_type is not None
        and payload.document_type != document.document_type
    ):
        updates.append(
            (
                "document_type",
                document.document_type,
                payload.document_type,
            )
        )
        document.document_type = payload.document_type

    if (
        payload.contract_side is not None
        and payload.contract_side != document.contract_side
    ):
        updates.append(
            (
                "contract_side",
                document.contract_side,
                payload.contract_side,
            )
        )
        document.contract_side = payload.contract_side

    if (
        payload.language is not None
        and payload.language != document.document_language
    ):
        updates.append(
            (
                "language",
                document.document_language,
                payload.language,
            )
        )
        document.document_language = payload.language

    for field_changed, previous_value, new_value in updates:
        database.add(
            ClassificationAuditLog(
                document_id=document.id,
                field_changed=field_changed,
                previous_value=previous_value,
                new_value=new_value,
                changed_by=payload.changed_by,
                actor_id=actor.id,
            )
        )

    if updates:
        # A manual correction is as certain as classification gets.
        document.classification_confidence = 1.0

    title_field = get_metadata_field(
        database,
        document_id=document.id,
        field_key="contract_title",
    )
    document.document_status = compute_document_status_label(
        document,
        contract_title=title_field.value if title_field else None,
    )
    database.commit()

    return ContractClassification(
        document_type=document.document_type or "Other",
        industry=document.industry,
        contract_side=document.contract_side or "unknown",
        language=document.document_language,
        document_status=document.document_status or "Unknown",
        confidence=document.classification_confidence or 0.0,
    )


@router.get(
    "/{document_id}/classification-history",
    response_model=list[ClassificationHistoryEntry],
)
async def get_classification_history(
    document_id: str,
    database: Session = Depends(get_database),
) -> list[ClassificationHistoryEntry]:
    document = database.get(Document, document_id)

    if document is None:
        raise HTTPException(
            status_code=404,
            detail="Document not found.",
        )

    entries = list(
        database.scalars(
            select(ClassificationAuditLog)
            .where(ClassificationAuditLog.document_id == document_id)
            .order_by(ClassificationAuditLog.changed_at.desc())
        )
    )

    return [
        ClassificationHistoryEntry(
            field_changed=entry.field_changed,
            previous_value=entry.previous_value,
            new_value=entry.new_value,
            changed_by=entry.changed_by,
            changed_at=entry.changed_at,
        )
        for entry in entries
    ]


def _require_document_review_permission(actor: ActorContext) -> None:
    """Approve/promote are review mutations: same gate and permission as
    accepting a field."""

    from app.core.feature_gates import require_metadata_review_mutations_enabled

    require_metadata_review_mutations_enabled()
    if not actor.has("review.accept"):
        raise HTTPException(
            status_code=403,
            detail="Permission denied: review.accept",
        )


def _record_document_review_event(
    database: Session, *, document_id: str, action: str, actor: ActorContext
) -> None:
    database.add(
        MetadataFieldAuditLog(
            document_id=document_id,
            field_key=DOCUMENT_EVENT_FIELD_KEY,
            metadata_field_id=None,
            action=action,
            reason={"approve": "Document approved", "promote": "Document promoted"}[action],
            request_id=get_request_id(),
            actor_id=actor.id,
            actor_type=actor.actor_type,
            actor_role=actor.role,
            changed_by=actor.display_name,
        )
    )


@router.post(
    "/{document_id}/approve",
    response_model=ApproveDocumentResponse,
)
async def approve_document(
    document_id: str,
    payload: ApproveDocumentRequest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> ApproveDocumentResponse:
    _require_document_review_permission(actor)
    document = database.get(Document, document_id)

    if document is None:
        raise HTTPException(
            status_code=404,
            detail="Document not found.",
        )

    if compute_document_status(database, document) != "completed":
        raise HTTPException(
            status_code=409,
            detail=(
                "This document isn't ready to approve yet — it must "
                "be classified and every extracted field must be "
                "reviewed first."
            ),
        )

    document.approved_by = actor.display_name
    document.approved_at = datetime.now(timezone.utc)
    _record_document_review_event(
        database, document_id=document.id, action="approve", actor=actor
    )
    database.commit()

    return ApproveDocumentResponse(
        document_id=document.id,
        approved_by=document.approved_by,
        approved_at=document.approved_at,
    )


@router.post(
    "/{document_id}/promote",
    response_model=PromoteDocumentResponse,
)
async def promote_document(
    document_id: str,
    payload: PromoteDocumentRequest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> PromoteDocumentResponse:
    _require_document_review_permission(actor)
    document = database.get(Document, document_id)

    if document is None:
        raise HTTPException(
            status_code=404,
            detail="Document not found.",
        )

    if document.approved_at is None:
        raise HTTPException(
            status_code=409,
            detail=(
                "This document must be approved before it can be "
                "promoted to the repository."
            ),
        )

    document.promoted_by = actor.display_name
    document.promoted_at = datetime.now(timezone.utc)
    _record_document_review_event(
        database, document_id=document.id, action="promote", actor=actor
    )
    database.commit()

    return PromoteDocumentResponse(
        document_id=document.id,
        promoted_by=document.promoted_by,
        promoted_at=document.promoted_at,
    )


@router.get(
    "/{document_id}/structured-output",
)
async def get_structured_output(
    document_id: str,
    database: Session = Depends(get_database),
) -> dict[str, Any]:
    document = database.get(Document, document_id)

    if document is None:
        raise HTTPException(
            status_code=404,
            detail="Document not found.",
        )

    fields = list(
        database.scalars(
            select(DocumentMetadataField).where(
                DocumentMetadataField.document_id == document_id
            )
        )
    )

    if not fields:
        raise HTTPException(
            status_code=404,
            detail=(
                "No structured metadata found for this document. "
                "Run contract analysis first."
            ),
        )

    return build_structured_output(fields)


_ACTION_TO_STATUS: dict[str, str] = {
    "accept": "accepted",
    "edit": "edited",
    "reject": "rejected",
    "mark_unknown": "unknown",
}

_REVIEW_PERMISSION_BY_ACTION = {
    "accept": "review.accept",
    "edit": "review.edit",
    "reject": "review.reject",
    "mark_unknown": "review.edit",
}


def _require_review_permission(actor: ActorContext, action: str) -> None:
    from app.core.feature_gates import require_metadata_review_mutations_enabled

    require_metadata_review_mutations_enabled()
    needed = _REVIEW_PERMISSION_BY_ACTION.get(action, "review.edit")
    if not actor.has(needed):  # type: ignore[arg-type]
        raise HTTPException(
            status_code=403,
            detail=f"Permission denied: {needed}",
        )


def _apply_metadata_field_review(
    *,
    database: Session,
    document_id: str,
    field: DocumentMetadataField,
    payload: FieldReviewRequest,
    actor: ActorContext,
) -> MetadataFieldResult:
    """Shared Accept/Edit/Reject mutation — one state machine for key and id paths."""

    if payload.action == "edit" and not payload.value:
        raise HTTPException(
            status_code=400,
            detail="A value is required to edit a field.",
        )

    previous_value = field.value
    previous_status = field.review_status
    new_value = payload.value if payload.action == "edit" else field.value

    evidence = dict(field.evidence_json) if isinstance(field.evidence_json, dict) else {}
    if "machine_value" not in evidence or evidence.get("machine_value") in (None, ""):
        evidence["machine_value"] = field.original_value or previous_value
    if not field.original_value:
        field.original_value = str(evidence.get("machine_value") or previous_value or "")

    if payload.action == "edit":
        field.value = payload.value or ""
        evidence["reviewed_value"] = field.value

    field.review_status = _ACTION_TO_STATUS[payload.action]
    field.human_approved = payload.action in {"accept", "edit"}
    field.evidence_json = evidence
    display_name = payload.changed_by or actor.display_name

    database.add(
        MetadataFieldAuditLog(
            document_id=document_id,
            field_key=field.field_key,
            metadata_field_id=field.id,
            action=payload.action,
            previous_value=previous_value,
            new_value=new_value,
            previous_status=previous_status,
            new_status=field.review_status,
            reason={
                "edit": "Reviewer correction",
                "accept": "Reviewer accept",
                "reject": "Reviewer reject",
                "mark_unknown": "Marked unknown",
            }.get(payload.action),
            request_id=get_request_id(),
            actor_id=actor.id,
            actor_type=actor.actor_type,
            actor_role=actor.role,
            changed_by=display_name,
        )
    )

    database.commit()
    return field_to_result(field)


def _audit_entry(entry: MetadataFieldAuditLog) -> FieldAuditEntry:
    return FieldAuditEntry(
        action=entry.action,
        metadata_field_id=entry.metadata_field_id,
        previous_value=entry.previous_value,
        new_value=entry.new_value,
        previous_status=entry.previous_status,
        new_status=entry.new_status,
        reason=entry.reason,
        request_id=entry.request_id,
        actor_id=entry.actor_id,
        actor_type=entry.actor_type,
        actor_role=entry.actor_role,
        changed_by=entry.changed_by,
        changed_at=entry.changed_at,
    )


@router.post(
    "/{document_id}/metadata-fields/by-id/{metadata_field_id}/review",
    response_model=MetadataFieldResult,
)
async def review_metadata_field_by_id(
    document_id: str,
    metadata_field_id: int,
    payload: FieldReviewRequest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> MetadataFieldResult:
    """Accept/Edit/Reject against an exact DocumentMetadataField.id."""

    _require_review_permission(actor, payload.action)

    field = get_metadata_field_by_id(
        database,
        document_id=document_id,
        metadata_field_id=metadata_field_id,
    )
    if field is None:
        # Same wording for missing id and cross-document id — no leakage.
        raise HTTPException(
            status_code=404,
            detail="Metadata field not found.",
        )

    return _apply_metadata_field_review(
        database=database,
        document_id=document_id,
        field=field,
        payload=payload,
        actor=actor,
    )


@router.get(
    "/{document_id}/metadata-fields/by-id/{metadata_field_id}/audit-log",
    response_model=list[FieldAuditEntry],
)
async def get_field_audit_log_by_id(
    document_id: str,
    metadata_field_id: int,
    database: Session = Depends(get_database),
) -> list[FieldAuditEntry]:
    field = get_metadata_field_by_id(
        database,
        document_id=document_id,
        metadata_field_id=metadata_field_id,
    )
    if field is None:
        raise HTTPException(
            status_code=404,
            detail="Metadata field not found.",
        )

    entries = list(
        database.scalars(
            select(MetadataFieldAuditLog)
            .where(
                MetadataFieldAuditLog.document_id == document_id,
                MetadataFieldAuditLog.metadata_field_id == metadata_field_id,
            )
            .order_by(MetadataFieldAuditLog.changed_at.desc())
        )
    )
    return [_audit_entry(entry) for entry in entries]


@router.post(
    "/{document_id}/metadata-fields/{field_key}/review",
    response_model=MetadataFieldResult,
)
async def review_metadata_field(
    document_id: str,
    field_key: str,
    payload: FieldReviewRequest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> MetadataFieldResult:
    _require_review_permission(actor, payload.action)

    try:
        field = require_unique_metadata_field(
            database,
            document_id=document_id,
            field_key=field_key,
        )
    except AmbiguousMetadataFieldError as exc:
        raise HTTPException(
            status_code=409,
            detail={
                "message": (
                    "Multiple metadata rows share this field_key. "
                    "Use POST .../metadata-fields/by-id/{id}/review "
                    "with the exact metadata field id."
                ),
                "document_id": document_id,
                "field_key": field_key,
                "candidates": [
                    {
                        "id": row.id,
                        "extraction_source": row.extraction_source,
                        "review_status": row.review_status,
                        "value": row.value,
                    }
                    for row in exc.rows
                ],
            },
        ) from exc

    if field is None:
        raise HTTPException(
            status_code=404,
            detail="Metadata field not found.",
        )

    return _apply_metadata_field_review(
        database=database,
        document_id=document_id,
        field=field,
        payload=payload,
        actor=actor,
    )


@router.post(
    "/{document_id}/metadata-fields/accept-all",
    response_model=list[MetadataFieldResult],
)
async def accept_all_metadata_fields(
    document_id: str,
    payload: AcceptAllRequest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> list[MetadataFieldResult]:
    from app.core.feature_gates import require_metadata_review_mutations_enabled

    require_metadata_review_mutations_enabled()
    if not actor.has("review.accept"):
        raise HTTPException(
            status_code=403,
            detail="Permission denied: review.accept",
        )

    fields = list(
        database.scalars(
            select(DocumentMetadataField).where(
                DocumentMetadataField.document_id == document_id
            )
        )
    )

    if not fields:
        raise HTTPException(
            status_code=404,
            detail="No metadata fields found for this document.",
        )

    override_reason = (payload.override_reason or "").strip()
    if payload.include_flagged:
        if actor.role != "admin":
            raise HTTPException(
                status_code=403,
                detail="Accepting flagged values in bulk is an admin override.",
            )
        if not override_reason:
            raise HTTPException(
                status_code=400,
                detail="An override reason is required to accept flagged values in bulk.",
            )

    display_name = payload.changed_by or actor.display_name

    for field in fields:
        if field.review_status != "pending":
            continue
        if not payload.include_flagged and low_risk_blockers(field):
            # Flagged values stay pending for an individual decision.
            continue

        previous_status = field.review_status
        field.review_status = "accepted"
        field.human_approved = True

        database.add(
            MetadataFieldAuditLog(
                document_id=document_id,
                field_key=field.field_key,
                metadata_field_id=field.id,
                action="accept",
                previous_value=field.value,
                new_value=field.value,
                previous_status=previous_status,
                new_status=field.review_status,
                reason=(
                    f"Bulk accept (admin override): {override_reason}"
                    if payload.include_flagged
                    else "Bulk accept of low-risk pending fields"
                ),
                request_id=get_request_id(),
                actor_id=actor.id,
                actor_type=actor.actor_type,
                actor_role=actor.role,
                changed_by=display_name,
            )
        )

    database.commit()

    return [field_to_result(field) for field in fields]


@router.get(
    "/{document_id}/metadata-fields/{field_key}/audit-log",
    response_model=list[FieldAuditEntry],
)
async def get_field_audit_log(
    document_id: str,
    field_key: str,
    database: Session = Depends(get_database),
) -> list[FieldAuditEntry]:
    entries = list(
        database.scalars(
            select(MetadataFieldAuditLog)
            .where(
                MetadataFieldAuditLog.document_id == document_id,
                MetadataFieldAuditLog.field_key == field_key,
            )
            .order_by(MetadataFieldAuditLog.changed_at.desc())
        )
    )

    return [_audit_entry(entry) for entry in entries]


@router.post(
    "/{document_id}/extract-clauses",
    response_model=ClauseExtractionResponse,
)
async def extract_clauses(
    document_id: str,
    database: Session = Depends(get_database),
) -> ClauseExtractionResponse:
    document = _load_ready_document(database, document_id)
    pages = _load_pages(database, document_id)

    ai_provider = start_session(
        create_ai_provider(settings), settings, database=database, document=document
    )

    clauses, warnings = await extract_contract_clauses(
        database=database,
        document=document,
        pages=pages,
        ai_provider=ai_provider,
    )

    return ClauseExtractionResponse(
        document_id=document.id,
        clauses=clauses,
        warnings=warnings,
    )


@router.get(
    "/{document_id}/extract-clauses",
    response_model=ClauseExtractionResponse,
)
async def get_extracted_clauses(
    document_id: str,
    database: Session = Depends(get_database),
) -> ClauseExtractionResponse:
    document = database.get(Document, document_id)

    if document is None:
        raise HTTPException(
            status_code=404,
            detail="Document not found.",
        )

    clauses = get_document_clauses(database, document_id)

    return ClauseExtractionResponse(
        document_id=document.id,
        clauses=[clause_to_result(clause) for clause in clauses],
        warnings=[],
    )


@router.post(
    "/{document_id}/extract-tables",
    response_model=TableExtractionResponse,
)
async def extract_tables(
    document_id: str,
    database: Session = Depends(get_database),
) -> TableExtractionResponse:
    document = database.get(Document, document_id)

    if document is None:
        raise HTTPException(
            status_code=404,
            detail="Document not found.",
        )

    pages = _load_pages(database, document_id)

    tables = normalize_document_tables(
        pages, document.original_filename
    )

    return TableExtractionResponse(
        document_id=document.id,
        tables=tables,
    )


@router.post(
    "/{document_id}/extract-signatures",
    response_model=SignatureExtractionResponse,
)
async def extract_signatures(
    document_id: str,
    database: Session = Depends(get_database),
) -> SignatureExtractionResponse:
    document = _load_ready_document(database, document_id)
    pages = _load_pages(database, document_id)

    ai_provider = start_session(
        create_ai_provider(settings), settings, database=database, document=document
    )

    signatures, warnings = await extract_contract_signatures(
        database=database,
        document=document,
        pages=pages,
        ai_provider=ai_provider,
    )

    return SignatureExtractionResponse(
        document_id=document.id,
        signatures=signatures,
        warnings=warnings,
    )


@router.get(
    "/{document_id}/extract-signatures",
    response_model=SignatureExtractionResponse,
)
async def get_extracted_signatures(
    document_id: str,
    database: Session = Depends(get_database),
) -> SignatureExtractionResponse:
    document = database.get(Document, document_id)

    if document is None:
        raise HTTPException(
            status_code=404,
            detail="Document not found.",
        )

    signatures = get_document_signatures(database, document_id)

    return SignatureExtractionResponse(
        document_id=document.id,
        signatures=[
            signature_to_result(signature)
            for signature in signatures
        ],
        warnings=[],
    )


@router.post(
    "/{document_id}/extract-structured-tables",
    response_model=StructuredTablesResponse,
)
async def extract_structured_tables(
    document_id: str,
    database: Session = Depends(get_database),
) -> StructuredTablesResponse:
    document = _load_ready_document(database, document_id)
    pages = _load_pages(database, document_id)

    ai_provider = start_session(
        create_ai_provider(settings), settings, database=database, document=document
    )

    results, warnings = await extract_document_structured_tables(
        database=database,
        document=document,
        pages=pages,
        ai_provider=ai_provider,
    )

    return StructuredTablesResponse(
        document_id=document.id,
        warnings=warnings,
        **structured_table_response_kwargs(results),
    )


@router.get(
    "/{document_id}/extract-structured-tables",
    response_model=StructuredTablesResponse,
)
async def get_extracted_structured_tables(
    document_id: str,
    database: Session = Depends(get_database),
) -> StructuredTablesResponse:
    document = database.get(Document, document_id)

    if document is None:
        raise HTTPException(
            status_code=404,
            detail="Document not found.",
        )

    results = get_document_structured_tables(database, document_id)

    return StructuredTablesResponse(
        document_id=document.id,
        warnings=[],
        **structured_table_response_kwargs(results),
    )
