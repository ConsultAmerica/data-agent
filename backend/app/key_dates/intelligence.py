"""Document intelligence: classification, dated events and lifecycle, in
one response — built from what already exists (classification records,
key dates, human-approved metadata), never a parallel pipeline.

Extracted dates and approved dates stay separate: an approved Metadata
review value is reported as such, wins over the extracted one for the
lifecycle, and isn't touched when key dates are re-detected.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.key_dates.detector import KINDS, is_ambiguous, numeric_readings, parse_date_text
from app.key_dates.lifecycle import CONCEPTS, DateCandidate, Lifecycle, evaluate, today_in
from app.models.document import Document
from app.models.document_key_date import DocumentKeyDate
from app.models.document_metadata_field import DocumentMetadataField

# Metadata review fields that hold a lifecycle date → key-date kind.
APPROVED_FIELDS = {
    "effective_date": "effective",
    "start_date": "start",
    "award_date": "award",
    "issue_date": "issue",
    "expiration_date": "expiry",
    "expiry_date": "expiry",
    "end_date": "period_end",
    "renewal_date": "renewal",
    "termination_date": "termination",
    "due_date": "due",
    "payment_due_date": "due",
}
APPROVED_STATUSES = ("accepted", "edited")


def extracted_candidates(rows: list[DocumentKeyDate]) -> list[DateCandidate]:
    out = []
    for row in rows:
        details = row.details or {}
        out.append(DateCandidate(
            kind=row.kind, date=row.date, original_text=details.get("original_text"), source=row.source, page=row.page,
            evidence=row.evidence_text, confidence=row.confidence, ambiguous=bool(details.get("ambiguous")),
            interpretations=list(details.get("interpretations") or []), option=bool(details.get("option")),
        ))
    return out


def approved_candidates(database: Session, document_id: str) -> list[DateCandidate]:
    """Dates a person accepted or edited in Metadata review."""

    rows = database.scalars(
        select(DocumentMetadataField).where(
            DocumentMetadataField.document_id == document_id,
            DocumentMetadataField.field_key.in_(list(APPROVED_FIELDS)),
            DocumentMetadataField.review_status.in_(APPROVED_STATUSES),
        )
    )
    out = []
    for field in rows:
        kind = APPROVED_FIELDS[field.field_key]
        value = (field.value or "").strip()
        parsed, _ = parse_date_text(value, kind=kind) if value else (None, 0.0)
        evidence = field.evidence_json or {}
        out.append(DateCandidate(
            kind=kind, date=parsed, original_text=value or None, source="metadata_review",
            page=evidence.get("page_number") if isinstance(evidence, dict) else None,
            evidence=evidence.get("source_text") if isinstance(evidence, dict) else None, confidence=None,
            # A person approved the value; its reading is taken as confirmed.
            ambiguous=False,
            interpretations=[d.isoformat() for d in numeric_readings(value) if d] if is_ambiguous(value) else [],
            approved=True,
        ))
    return out


def document_family(database: Session, document: Document) -> str | None:
    from app.classification.service import current

    row = current(database, document.id)
    return row.family if row else None


def lifecycle_for(
    database: Session,
    document: Document,
    rows: list[DocumentKeyDate],
    *,
    family: str | None,
    warning_days: int | None = None,
) -> tuple[Lifecycle, list[DateCandidate]]:
    settings = get_settings()
    days = warning_days or settings.key_date_expiring_days
    candidates = extracted_candidates(rows) + approved_candidates(database, document.id)
    lifecycle = evaluate(family, candidates, today=today_in(settings.lifecycle_timezone), warning_days=days,
                         timezone=settings.lifecycle_timezone)
    return lifecycle, candidates


def candidate_out(candidate: DateCandidate) -> dict[str, Any]:
    validation = "ambiguous" if candidate.ambiguous else "valid" if candidate.date else "unreadable"
    return {
        "date_type": candidate.concept,
        "kind": candidate.kind,
        "original_text": candidate.original_text,
        # Only an unambiguous (or human-confirmed) reading is a normalized date.
        "normalized_date": candidate.date.isoformat() if candidate.date and not candidate.ambiguous else None,
        "interpretations": candidate.interpretations,
        "source": candidate.source,
        "page": candidate.page,
        "evidence_text": candidate.evidence,
        "confidence": candidate.confidence,
        "validation_status": validation,
        "review_status": "approved" if candidate.approved else "not_reviewed",
        "option_period": candidate.option,
    }


def kind_order(candidate: DateCandidate) -> tuple:
    return (candidate.date or date.max, KINDS.index(candidate.kind) if candidate.kind in KINDS else 99)


__all__ = ["CONCEPTS", "approved_candidates", "candidate_out", "document_family", "extracted_candidates", "lifecycle_for"]
