from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends

from app.core.auth import ActorContext, get_current_actor
from app.core.document_access import scope_documents
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.database.dependencies import get_database
from app.models.document import Document
from app.models.document_clause import DocumentClause
from app.models.document_intake import DocumentIntake
from app.models.document_metadata_field import DocumentMetadataField
from app.models.document_page import DocumentPage
from app.models.review_assignment import ReviewAssignment, field_ref
from app.schemas.dashboard import (
    DashboardStatsResponse,
    ReviewQueueEntry,
    ReviewQueueFieldItem,
)
from app.services.dashboard_stats import (
    compute_document_confidence,
    compute_document_needs_manual_review,
    compute_document_status,
    compute_review_queue_bucket,
)
from app.services.portfolio_insights import build_portfolio
from app.services.review_routing import human_reason_labels
from app.services.evidence_text import source_text_of
from app.services.review_validation import validation_summary
from app.schemas.contract_analysis import FieldValidationSummary
from app.services.reviewed_export import extracted_value_for

# Batches still being assembled, or turned away, stay out of the queue.
UNQUEUED_INTAKE_STATUSES = ("draft", "rejected")

router = APIRouter()


class ReviewQueueFieldItemDetail(ReviewQueueFieldItem):
    """A queue item plus who owns it, the document's contract type and the
    source text the value was read from (each None when not stored)."""

    assignee: str | None = None
    assigned_at: datetime | None = None
    due_date: date | None = None
    uploaded_at: datetime | None = None
    contract_type: str | None = None
    source_snippet: str | None = None
    # The machine-extracted value, kept when a reviewer corrects it.
    original_value: str | None = None
    validation: FieldValidationSummary | None = None


# Metadata keys whose value names the contract type, in preference order.
_CONTRACT_TYPE_KEYS = ("contract_type", "pricing_model")
_SNIPPET_KEYS = ("source_text", "evidence", "snippet", "text")
_SNIPPET_CHARS = 600


def _source_snippet(field: DocumentMetadataField) -> str | None:
    evidence = dict(field.evidence_json or {})
    evidence["source_text"] = source_text_of(field.evidence_json)
    for key in _SNIPPET_KEYS:
        value = evidence.get(key)
        if isinstance(value, str) and value.strip():
            text = " ".join(value.split())
            return text if len(text) <= _SNIPPET_CHARS else text[: _SNIPPET_CHARS - 1].rstrip() + "…"
    return None


def _contract_types(database: Session, document_ids: list[str]) -> dict[str, str]:
    if not document_ids:
        return {}
    found: dict[str, dict[str, str]] = {}
    for document_id, key, value in database.execute(
        select(
            DocumentMetadataField.document_id,
            DocumentMetadataField.field_key,
            DocumentMetadataField.value,
        ).where(
            DocumentMetadataField.document_id.in_(document_ids),
            DocumentMetadataField.field_key.in_(_CONTRACT_TYPE_KEYS),
            DocumentMetadataField.review_status != "rejected",
        )
    ):
        if value and value.strip():
            found.setdefault(document_id, {}).setdefault(key, value.strip())
    return {
        document_id: next(values[key] for key in _CONTRACT_TYPE_KEYS if key in values)
        for document_id, values in found.items()
    }


def _field_review_meta(field: DocumentMetadataField) -> dict:
    evidence = field.evidence_json or {}
    decision = evidence.get("review_decision") or {}
    reasons = list(decision.get("reasons") or [])
    page_number = None
    if isinstance(evidence.get("page_number"), int):
        page_number = evidence["page_number"]
    return {
        "reasons": reasons,
        "priority": decision.get("priority") or "medium",
        "decision_status": decision.get("status") or "needs_review",
        "page_number": page_number,
    }


def _review_href(document_id: str, *, field_key: str | None = None) -> str:
    base = f"/extraction/new?documentId={document_id}"
    if field_key:
        return f"{base}&focus={field_key}"
    return base


@router.get("/stats", response_model=DashboardStatsResponse)
async def get_dashboard_stats(
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> DashboardStatsResponse:
    documents = list(database.scalars(scope_documents(select(Document), actor)))
    visible = scope_documents(select(Document.id), actor)

    total_documents = len(documents)
    completed = 0
    review_required = 0
    processing = 0
    documents_requiring_manual_review = 0

    for document in documents:
        status = compute_document_status(database, document)

        if status == "completed":
            completed += 1
        elif status == "review_required":
            review_required += 1
        else:
            processing += 1

        if compute_document_needs_manual_review(database, document):
            documents_requiring_manual_review += 1

    fields = list(
        database.scalars(
            select(DocumentMetadataField).where(DocumentMetadataField.document_id.in_(visible))
        )
    )
    fields_extracted = len(fields)

    extraction_accuracy = (
        sum(field.confidence for field in fields) / len(fields)
        if fields
        else None
    )

    corrected_fields = sum(
        1
        for field in fields
        if field.review_status in {"edited", "rejected"}
    )

    human_review_rate = (
        (corrected_fields / len(fields)) * 100 if fields else None
    )

    reviewed_fields = sum(
        1 for field in fields if field.review_status != "pending"
    )

    review_completion_rate = (
        (reviewed_fields / len(fields)) * 100 if fields else None
    )

    today = datetime.now(timezone.utc).date()
    fields_extracted_today = sum(
        1
        for field in fields
        if field.extracted_at.date() == today
    )

    durations = [
        document.processing_duration_seconds
        for document in documents
        if document.processing_duration_seconds is not None
    ]

    average_processing_seconds = (
        sum(durations) / len(durations) if durations else None
    )

    pages = list(
        database.scalars(
            select(DocumentPage).where(
                DocumentPage.ocr_attempted.is_(True),
                DocumentPage.document_id.in_(visible),
            )
        )
    )

    ocr_accuracy = (
        sum(1 for page in pages if page.ocr_succeeded)
        / len(pages)
        * 100
        if pages
        else None
    )

    clause_confidences = list(
        database.scalars(
            select(DocumentClause.confidence).where(DocumentClause.document_id.in_(visible))
        )
    )

    clause_extraction_accuracy = (
        sum(clause_confidences) / len(clause_confidences)
        if clause_confidences
        else None
    )

    return DashboardStatsResponse(
        total_documents=total_documents,
        completed=completed,
        review_required=review_required,
        processing=processing,
        extraction_accuracy=extraction_accuracy,
        average_processing_seconds=average_processing_seconds,
        human_review_rate=human_review_rate,
        fields_extracted=fields_extracted,
        review_completion_rate=review_completion_rate,
        ocr_accuracy=ocr_accuracy,
        clause_extraction_accuracy=clause_extraction_accuracy,
        fields_extracted_today=fields_extracted_today,
        documents_requiring_manual_review=documents_requiring_manual_review,
    )


@router.get("/portfolio")
async def get_portfolio(
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> dict:
    """Portfolio aggregates for Analytics, Insights and Risk."""

    return build_portfolio(database, scope_documents(select(Document.id), actor))


def _review_queue_documents(actor: ActorContext):
    """Documents that belong in the review queue: everything visible except
    uploads whose batch is still a draft or was rejected (no intake row =
    uploaded outside a batch, always queued)."""

    return (
        scope_documents(select(Document), actor)
        .outerjoin(DocumentIntake, DocumentIntake.document_id == Document.id)
        .where(
            or_(
                DocumentIntake.intake_status.is_(None),
                DocumentIntake.intake_status.notin_(UNQUEUED_INTAKE_STATUSES),
            )
        )
    )


@router.get(
    "/review-queue", response_model=list[ReviewQueueEntry]
)
async def get_review_queue(
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> list[ReviewQueueEntry]:
    documents = list(
        database.scalars(
            _review_queue_documents(actor).order_by(Document.uploaded_at.desc())
        )
    )

    entries: list[ReviewQueueEntry] = []
    for document in documents:
        if compute_document_status(database, document) != "review_required":
            continue

        fields = list(
            database.scalars(
                select(DocumentMetadataField).where(
                    DocumentMetadataField.document_id == document.id
                )
            )
        )
        pending = [field for field in fields if field.review_status == "pending"]
        attention = 0
        reason_counts: dict[str, int] = {}
        for field in pending:
            meta = _field_review_meta(field)
            if meta["decision_status"] == "needs_review" or meta["reasons"]:
                attention += 1
            for reason in meta["reasons"]:
                reason_counts[reason] = reason_counts.get(reason, 0) + 1

        top_reasons = [
            reason
            for reason, _ in sorted(
                reason_counts.items(), key=lambda item: (-item[1], item[0])
            )[:3]
        ]

        entries.append(
            ReviewQueueEntry(
                document_id=document.id,
                original_filename=document.original_filename,
                document_type=document.document_type,
                confidence=compute_document_confidence(database, document),
                queue_bucket=compute_review_queue_bucket(database, document),
                uploaded_at=document.uploaded_at,
                pending_field_count=len(pending),
                attention_field_count=attention,
                top_reasons=human_reason_labels(top_reasons),
                review_href=_review_href(document.id),
            )
        )
    return entries


@router.get(
    "/review-queue/fields",
    response_model=list[ReviewQueueFieldItemDetail],
)
async def get_review_queue_fields(
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> list[ReviewQueueFieldItemDetail]:
    """Field-level Review Queue for target + contract pending items."""

    documents = {
        document.id: document
        for document in database.scalars(_review_queue_documents(actor)).all()
    }
    fields = list(
        database.scalars(
            select(DocumentMetadataField)
            .where(DocumentMetadataField.review_status == "pending")
            .order_by(DocumentMetadataField.extracted_at.desc())
        )
    )

    queued_ids = sorted({field.document_id for field in fields if field.document_id in documents})
    assignments = {
        (row.document_id, row.field_ref): row
        for row in database.scalars(
            select(ReviewAssignment).where(ReviewAssignment.document_id.in_(queued_ids))
        )
    } if queued_ids else {}
    contract_types = _contract_types(database, queued_ids)

    items: list[ReviewQueueFieldItemDetail] = []
    for field in fields:
        document = documents.get(field.document_id)
        if document is None:
            continue
        meta = _field_review_meta(field)
        assignment = assignments.get(
            (field.document_id, field_ref(field.id, field.field_key))
        ) or assignments.get((field.document_id, field_ref(None, field.field_key)))
        items.append(
            ReviewQueueFieldItemDetail(
                document_id=field.document_id,
                original_filename=document.original_filename,
                metadata_field_id=field.id,
                field_key=field.field_key,
                label=field.label,
                value=field.value,
                confidence=field.confidence,
                confidence_band=field.confidence_band,
                review_status=field.review_status,
                extraction_source=field.extraction_source,
                extraction_method=field.extraction_method,
                reasons=meta["reasons"],
                reason_labels=human_reason_labels(meta["reasons"]),
                priority=meta["priority"],
                decision_status=meta["decision_status"],
                page_number=meta["page_number"],
                review_href=_review_href(
                    field.document_id, field_key=field.field_key
                ),
                assignee=assignment.assignee if assignment else None,
                assigned_at=assignment.assigned_at if assignment else None,
                due_date=assignment.due_date if assignment else None,
                uploaded_at=document.uploaded_at,
                contract_type=contract_types.get(field.document_id),
                source_snippet=_source_snippet(field),
                original_value=extracted_value_for(field) or None,
                validation=validation_summary(field),
            )
        )

    priority_rank = {"low": 0, "medium": 1, "high": 2}
    items.sort(
        key=lambda item: (
            priority_rank.get(item.priority, 1),
            -item.confidence,
            item.original_filename,
        )
    )
    return items
