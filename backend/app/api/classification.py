"""Document classification: review state, decisions, queue, type registry.

Reading needs ``documents.view``; re-running the classifier needs
``extraction.run``; confirming or changing a type is a review action
(``review.accept``, behind the review-mutation gate). Document routes are
mounted with document isolation. A decision never deletes extracted data:
re-staging rebuilds the workbook from the stored extraction under the
chosen schema, and the earlier prediction and decisions stay in history.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.classification.engine import SUBTYPES
from app.classification.service import (
    ClassificationError,
    current,
    decide,
    history,
    known_families,
    latest_prediction,
    record_prediction,
)
from app.core.auth import ActorContext, require_permission
from app.core.config import get_settings
from app.core.document_access import scope_documents
from app.core.feature_gates import require_metadata_review_mutations_enabled
from app.database.dependencies import get_database
from app.models.document import Document
from app.models.document_classification import DocumentClassification
from app.models.document_staging_workbook import DocumentStagingWorkbook
from app.models.oracle_template import OracleMappingProfile
from app.staging import registry
from app.staging.document_categories import CATEGORIES, CATEGORY_LABELS, category_for_family
from app.staging.document_labels import profile_label

router = APIRouter()
documents_router = APIRouter()

ConfidenceLevel = Literal["high", "medium", "low", "none"]


class Candidate(BaseModel):
    family: str
    label: str
    category: str
    category_label: str
    profile_id: str
    subtype: str | None = None
    score: float
    evidence: list[str] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)


class Event(BaseModel):
    id: int
    kind: str
    family: str
    family_label: str
    subtype: str | None
    confidence: float | None
    status: str
    method: str
    actor_name: str | None
    reason: str | None
    created_at: datetime


class State(BaseModel):
    document_id: str
    family: str
    family_label: str
    category: str
    category_label: str
    subtype: str | None
    subtypes: list[str]
    profile_id: str
    profile_label: str
    confidence: float | None
    confidence_level: ConfidenceLevel
    status: str
    method: str
    evidence: list[str]
    candidates: list[Candidate]
    thresholds: dict[str, float]
    engine_version: str
    decided: bool
    decided_by: str | None
    predicted: Event | None
    history: list[Event]
    # The schema currently staged differs from the classification: re-extract.
    staged_profile_id: str | None
    needs_restage: bool
    # Saved Oracle mappings made for a different document type than this one.
    mappings_to_review: list[dict]


class DecisionIn(BaseModel):
    action: Literal["confirm", "override"]
    family: str | None = Field(default=None, max_length=80)
    subtype: str | None = Field(default=None, max_length=160)
    custom_label: str | None = Field(default=None, max_length=160)
    reason: str | None = Field(default=None, max_length=2000)
    # Re-stage now with the chosen schema ("Re-extract using selected schema").
    apply: bool = True


class TypeOption(BaseModel):
    family: str
    label: str
    profile_id: str
    profile_label: str
    subtypes: list[str]
    datasets: list[dict]


class CategoryOption(BaseModel):
    category: str
    label: str
    types: list[TypeOption]


class QueueItem(BaseModel):
    document_id: str
    original_filename: str
    page_count: int
    family_label: str
    subtype: str | None
    category_label: str
    confidence: float | None
    status: str
    top_alternatives: list[Candidate]
    classified_at: datetime


def _level(confidence: float | None, status: str) -> ConfidenceLevel:
    if confidence is None:
        return "none"
    settings = get_settings()
    if confidence >= settings.classification_high_confidence:
        return "high"
    if confidence >= settings.classification_low_confidence:
        return "medium"
    return "low"


def _event(row: DocumentClassification) -> Event:
    return Event(
        id=row.id, kind=row.kind, family=row.family, family_label=row.family_label, subtype=row.subtype,
        confidence=row.confidence, status=row.status, method=row.method, actor_name=row.actor_name,
        reason=row.reason, created_at=row.created_at,
    )


def _document_or_404(database: Session, document_id: str) -> Document:
    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    return document


def _state(database: Session, document: Document) -> State:
    row = current(database, document.id) or record_prediction(database, document)
    prediction = latest_prediction(database, document.id)
    pin = database.scalars(
        select(DocumentStagingWorkbook).where(DocumentStagingWorkbook.document_id == document.id)
    ).first()
    staged = pin.profile_id if pin else None
    needs_restage = pin is not None and (pin.profile_id != row.profile_id or pin.document_family != row.family)
    mappings = []
    if staged and row.profile_id != staged:
        for profile in database.scalars(
            select(OracleMappingProfile).where(OracleMappingProfile.staging_profile_id == staged)
        ):
            mappings.append({"id": profile.id, "name": profile.name, "staging_profile_id": profile.staging_profile_id})
    confidence = row.confidence if not row.is_decision else (prediction.confidence if prediction else None)
    return State(
        document_id=document.id,
        family=row.family,
        family_label=row.family_label,
        category=category_for_family(row.family),
        category_label=CATEGORY_LABELS[category_for_family(row.family)],
        subtype=row.subtype,
        subtypes=list(SUBTYPES.get(row.family, ())),
        profile_id=row.profile_id,
        profile_label=profile_label(row.profile_id),
        confidence=confidence,
        confidence_level=_level(confidence, row.status),
        status=row.status,
        method=row.method,
        evidence=list(row.evidence or []),
        candidates=[Candidate(**c) for c in (row.candidates or [])],
        thresholds=dict(row.thresholds or {}),
        engine_version=row.engine_version,
        decided=row.is_decision,
        decided_by=row.actor_name if row.is_decision else None,
        predicted=_event(prediction) if prediction else None,
        history=[_event(r) for r in reversed(history(database, document.id))],
        staged_profile_id=staged,
        needs_restage=needs_restage,
        mappings_to_review=mappings,
    )


@documents_router.get("/{document_id}/classification", response_model=State)
def get_classification(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> State:
    return _state(database, _document_or_404(database, document_id))


@documents_router.post("/{document_id}/classification/classify", response_model=State)
def reclassify(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("extraction.run")),
) -> State:
    """Runs the classifier again on the stored pages (a decision stays in force)."""

    document = _document_or_404(database, document_id)
    record_prediction(database, document)
    return _state(database, document)


@documents_router.post(
    "/{document_id}/classification/decision",
    response_model=State,
    dependencies=[Depends(require_metadata_review_mutations_enabled)],
)
async def decide_classification(
    document_id: str,
    payload: DecisionIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("review.accept")),
) -> State:
    document = _document_or_404(database, document_id)
    try:
        decide(
            database, document, actor_id=actor.id, actor_name=actor.display_name, action=payload.action,
            family=payload.family, subtype=payload.subtype, custom_label=payload.custom_label, reason=payload.reason,
        )
    except ClassificationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if payload.apply:
        from app.staging.preparation import prepare_staging

        await run_in_threadpool(prepare_staging, database, document)
    return _state(database, document)


@router.get("/types", response_model=list[CategoryOption])
def list_types(
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> list[CategoryOption]:
    """The schema registry as people choose from it: category → document
    type → its staging schema (profile), subtypes and datasets."""

    families = known_families()
    by_category: dict[str, list[TypeOption]] = {key: [] for key, _, _ in CATEGORIES}
    for family, label in sorted(families.items(), key=lambda item: item[1]):
        profile = registry.profile_for_family(family) or registry.generic_profile()
        by_category.setdefault(category_for_family(family), []).append(
            TypeOption(
                family=family,
                label=label,
                profile_id=profile.profile_id,
                profile_label=profile_label(profile.profile_id),
                subtypes=list(SUBTYPES.get(family, ())),
                datasets=[
                    {"dataset_id": d.dataset_id, "display_name": d.display_name, "cardinality": d.cardinality,
                     "fields": len(d.fields)}
                    for d in profile.datasets
                ],
            )
        )
    return [
        CategoryOption(category=key, label=CATEGORY_LABELS[key], types=by_category.get(key, []))
        for key, _, _ in CATEGORIES
        if by_category.get(key)
    ]


@router.get("/queue", response_model=list[QueueItem])
def classification_queue(
    status: Literal["review_required", "review_recommended", "pending"] = "pending",
    limit: int = 100,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> list[QueueItem]:
    """Documents whose current classification needs a person ("pending" =
    required or recommended), most uncertain first."""

    wanted = {"review_required", "review_recommended"} if status == "pending" else {status}
    latest = (
        select(DocumentClassification.document_id, func.max(DocumentClassification.id).label("id"))
        .group_by(DocumentClassification.document_id)
        .subquery()
    )
    rows = database.execute(
        scope_documents(
            select(DocumentClassification, Document)
            .join(latest, latest.c.id == DocumentClassification.id)
            .join(Document, Document.id == DocumentClassification.document_id),
            actor,
        )
    ).all()
    items: list[QueueItem] = []
    for row, document in rows:
        state = current(database, document.id) if row.is_decision is False else row
        state = state or row
        if state.status not in wanted:
            continue
        items.append(
            QueueItem(
                document_id=document.id,
                original_filename=document.original_filename,
                page_count=document.page_count or 0,
                family_label=state.family_label,
                subtype=state.subtype,
                category_label=CATEGORY_LABELS[category_for_family(state.family)],
                confidence=state.confidence,
                status=state.status,
                top_alternatives=[Candidate(**c) for c in (state.candidates or [])[1:3]],
                classified_at=state.created_at,
            )
        )
    items.sort(key=lambda item: (item.status != "review_required", item.confidence or 0.0))
    return items[: max(1, min(limit, 500))]
