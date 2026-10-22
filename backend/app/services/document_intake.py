"""Intake tagging: the batch, agency, contracting officer and requested
extraction profile an uploader attaches to documents, and the batch's
draft / submitted / rejected status (models/document_intake.py).

The requested profile is recorded as a hint. The staging resolver picks
the profile from the document's own evidence and has no override; a
"requested" profile is never forced onto a document.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.document_intake import INTAKE_STATUSES, DocumentIntake
from app.staging import registry

AUTO_PROFILE = "auto"
_BATCH_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_TEXT_LIMIT = 200


class IntakeValidationError(ValueError):
    pass


def _clean_text(value: str | None, label: str) -> str | None:
    if value is None:
        return None
    cleaned = " ".join(value.split())
    if not cleaned:
        return None
    if len(cleaned) > _TEXT_LIMIT:
        raise IntakeValidationError(f"{label} must be at most {_TEXT_LIMIT} characters.")
    return cleaned


def clean_batch_id(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    value = value.strip()
    if not _BATCH_ID.match(value):
        raise IntakeValidationError(
            "batch_id may contain only letters, digits, '-' and '_' (at most 64 characters)."
        )
    return value


def supported_profile_ids() -> list[str]:
    return [profile.profile_id for profile in registry.latest_profiles()]


def clean_profile(value: str | None) -> str:
    if value is None or not value.strip():
        return AUTO_PROFILE
    value = value.strip()
    if value == AUTO_PROFILE or value in supported_profile_ids():
        return value
    raise IntakeValidationError(f"Unknown extraction profile '{value}'.")


def validate_status(value: str) -> str:
    if value not in INTAKE_STATUSES:
        raise IntakeValidationError(
            f"status must be one of: {', '.join(INTAKE_STATUSES)}."
        )
    return value


class IntakeFields:
    """Validated intake fields from an upload form or request body."""

    def __init__(
        self,
        *,
        batch_id: str | None = None,
        agency: str | None = None,
        contracting_officer: str | None = None,
        extraction_profile: str | None = None,
    ) -> None:
        self.batch_id = clean_batch_id(batch_id)
        self.agency = _clean_text(agency, "Agency")
        self.contracting_officer = _clean_text(contracting_officer, "Contracting officer")
        self.extraction_profile = clean_profile(extraction_profile)

    @property
    def empty(self) -> bool:
        return (
            self.batch_id is None
            and self.agency is None
            and self.contracting_officer is None
            and self.extraction_profile == AUTO_PROFILE
        )


def upsert_intake(
    database: Session, document_id: str, fields: IntakeFields, created_by: str
) -> DocumentIntake | None:
    """Records the fields for a document; commits. No row is written when
    every field is empty. An existing row keeps its intake status (a
    document already submitted to review is not pulled back to draft)."""

    if fields.empty:
        return None
    row = database.get(DocumentIntake, str(document_id))
    if row is None:
        row = DocumentIntake(
            document_id=str(document_id),
            intake_status="draft",
            created_by=created_by,
        )
        database.add(row)
    row.batch_id = fields.batch_id
    row.agency = fields.agency
    row.contracting_officer = fields.contracting_officer
    row.extraction_profile = fields.extraction_profile
    row.updated_at = datetime.now(timezone.utc)
    database.commit()
    return row


def intake_by_document(
    database: Session, document_ids: list[str]
) -> dict[str, DocumentIntake]:
    if not document_ids:
        return {}
    rows = database.scalars(
        select(DocumentIntake).where(DocumentIntake.document_id.in_(document_ids))
    )
    return {row.document_id: row for row in rows}


def intake_summary_fields(row: DocumentIntake | None) -> dict:
    """The DocumentSummary intake keys (all None without a row)."""

    if row is None:
        return {
            "agency": None,
            "contracting_officer": None,
            "batch_id": None,
            "intake_status": None,
        }
    return {
        "agency": row.agency,
        "contracting_officer": row.contracting_officer,
        "batch_id": row.batch_id,
        "intake_status": row.intake_status,
    }
