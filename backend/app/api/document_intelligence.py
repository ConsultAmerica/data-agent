"""GET /{document_id}/intelligence — what the document is and where it is
in its life: classification (with evidence, version and whether a person
must confirm it), every dated event it states, the lifecycle dates in use,
the lifecycle status, and what needs review.

Workspace isolation is enforced by the router dependency
(core/document_access.py)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.auth import ActorContext, require_permission
from app.database.dependencies import get_database
from app.key_dates.intelligence import candidate_out, kind_order, lifecycle_for
from app.key_dates.lifecycle import WARNING_PERIODS
from app.key_dates.service import key_dates_for
from app.models.document import Document

router = APIRouter()

# Classification statuses that need a person's confirmation.
_NEEDS_CONFIRMATION = {"review_required", "review_recommended"}


@router.get("/{document_id}/intelligence")
def get_document_intelligence(
    document_id: str,
    warning_days: int | None = Query(None, description="Expiring-soon window: 30, 60 or 90 days."),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict[str, Any]:
    from app.api.classification import _state as classification_state

    if warning_days is not None and warning_days not in WARNING_PERIODS:
        raise HTTPException(status_code=422, detail="warning_days must be 30, 60 or 90.")
    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")

    state = classification_state(database, document)
    rows = key_dates_for(database, document)
    lifecycle, candidates = lifecycle_for(database, document, rows, family=state.family, warning_days=warning_days)

    review = list(lifecycle.review_required)
    if state.status in _NEEDS_CONFIRMATION and not state.decided:
        review.insert(0, "Confirm the document type (classification confidence is "
                         f"{state.confidence_level}; it isn't calibrated as a probability).")
    secondary = []
    for candidate in state.candidates[1:]:
        if candidate.category != state.category and candidate.score >= 0.5 and candidate.category_label not in secondary:
            secondary.append(candidate.category_label)

    def lifecycle_date(candidate):
        return candidate_out(candidate) if candidate else None

    return {
        "document_id": document.id,
        "file_format": Path(document.stored_filename or document.original_filename).suffix.lstrip(".").lower(),
        "classification": {
            "category": state.category,
            "category_label": state.category_label,
            "document_type": state.family,
            "document_type_label": state.family_label,
            "subtype": state.subtype,
            "secondary_categories": secondary,
            "confidence": state.confidence,
            "confidence_level": state.confidence_level,
            "status": state.status,
            "evidence": state.evidence,
            "method": state.method,
            "engine_version": state.engine_version,
            "decided": state.decided,
            "decided_by": state.decided_by,
            "requires_confirmation": state.status in _NEEDS_CONFIRMATION and not state.decided,
        },
        "date_candidates": [candidate_out(c) for c in sorted(candidates, key=kind_order)],
        "lifecycle_dates": {
            "start": lifecycle_date(lifecycle.start),
            "expiration": lifecycle_date(lifecycle.end),
            "renewal": lifecycle_date(lifecycle.renewal),
            "payment_due": lifecycle_date(lifecycle.payment_due),
        },
        "lifecycle": lifecycle.as_dict(),
        "review_required": review,
    }
