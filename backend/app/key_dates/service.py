"""Persist a document's key dates and report their status.

refresh_key_dates runs when a document is staged (staging/preparation.py)
and on demand; status is computed against today on every read:

    ambiguous  a numeric date with two valid readings, not yet resolved
    expired    an expiring kind whose date has passed
    expiring   an expiring kind within KEY_DATE_EXPIRING_DAYS
    upcoming   any other date in the future
    past       any other date in the past (issue, effective, paid due date)
"""

from __future__ import annotations

from datetime import date

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.key_dates.detector import EXPIRING_KINDS, EXTRACTOR_VERSION, detect_key_dates
from app.models.document import Document
from app.models.document_key_date import DocumentKeyDate
from app.models.document_staging_workbook import DocumentStagingWorkbook


def refresh_key_dates(database: Session, document: Document) -> list[DocumentKeyDate]:
    record = database.scalars(
        select(DocumentStagingWorkbook).where(DocumentStagingWorkbook.document_id == document.id)
    ).first()
    found = detect_key_dates(database, document, profile_id=record.profile_id if record else None)
    database.execute(delete(DocumentKeyDate).where(DocumentKeyDate.document_id == document.id))
    rows = [
        DocumentKeyDate(
            document_id=document.id, kind=item.kind, date=item.date, label=item.label[:200], source=item.source,
            page=item.page, evidence_text=item.evidence, details=item.details or None,
            confidence=item.confidence, extractor_version=EXTRACTOR_VERSION,
        )
        for item in found
    ]
    database.add_all(rows)
    database.commit()
    return rows


def status_of(row: DocumentKeyDate, today: date | None = None) -> tuple[str, int]:
    from app.key_dates.lifecycle import today_in

    today = today or today_in(get_settings().lifecycle_timezone)
    days = (row.date - today).days
    # Either reading of 03/04/2026 could be right: it can't be called
    # expired or expiring until someone confirms it.
    if (row.details or {}).get("ambiguous"):
        return "ambiguous", days
    if row.kind in EXPIRING_KINDS:
        if days < 0:
            return "expired", days
        if days <= get_settings().key_date_expiring_days:
            return "expiring", days
    return ("upcoming" if days >= 0 else "past"), days


def key_dates_for(database: Session, document: Document) -> list[DocumentKeyDate]:
    rows = list(
        database.scalars(
            select(DocumentKeyDate).where(DocumentKeyDate.document_id == document.id).order_by(DocumentKeyDate.date)
        )
    )
    if rows and all(row.extractor_version == EXTRACTOR_VERSION for row in rows):
        return rows
    # Never computed (staged before key dates existed) or an older extractor.
    return refresh_key_dates(database, document)


def document_expiry(rows: list[DocumentKeyDate], today: date | None = None) -> DocumentKeyDate | None:
    """The date the document itself expires: the earliest expiring-kind date
    still ahead, else the latest one that passed."""

    ending = [row for row in rows if row.kind in EXPIRING_KINDS]
    if not ending:
        return None
    today = today or date.today()
    ahead = [row for row in ending if row.date >= today]
    return min(ahead, key=lambda r: r.date) if ahead else max(ending, key=lambda r: r.date)
