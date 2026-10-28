"""The Type and Profile a document is listed under — from its persisted
staging resolution (document_staging_workbooks), never from its filename.

Profile is the resolved profile's professional name. Type is the document
family the resolver recorded, refined only where the profile derives a
subtype from the document's own content (an SF 1442 award's form number,
FAR clause records in an XML file). A document without a persisted
resolution has neither: it is listed as not yet staged (Reprocess).
"""

from __future__ import annotations

import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.document_page import DocumentPage
from app.models.document_staging_workbook import DocumentStagingWorkbook
from app.staging import registry
from app.staging.document_categories import category_fields

# Professional names where a profile's own display name is too terse.
_PROFILE_LABELS = {
    "contract_v3": "Government Contract",
    "generic_business_document": "Generic Document",
}
_UNKNOWN_FAMILIES = {None, "", "unknown", "generic_business"}
_FAR_CLAUSE = re.compile(r"\b52\.\d{3}-\d+\b")


def profile_label(profile_id: str) -> str:
    if profile_id in _PROFILE_LABELS:
        return _PROFILE_LABELS[profile_id]
    profile = registry.get_profile(profile_id)
    return profile.display_name if profile else profile_id.replace("_", " ").title()


def _opening_text(database: Session, document_id: str, pages: int = 4) -> str:
    texts = database.scalars(
        select(DocumentPage.final_text)
        .where(DocumentPage.document_id == document_id, DocumentPage.page_number <= pages)
        .order_by(DocumentPage.page_number)
    )
    return "\n".join(text or "" for text in texts)


def type_label(database: Session, document: Document, pin: DocumentStagingWorkbook) -> str:
    profile_id = pin.profile_id
    if profile_id == "contract_v3":
        from app.staging.profiles.contract_presentation import SF1442, contract_subtype

        if contract_subtype(_opening_text(database, document.id)) == SF1442:
            return "SF 1442 Contract Award"
        return "Government Contract"
    if profile_id == "xml_document":
        # The XML transcription lists its record groups and values.
        text = _opening_text(database, document.id, pages=1)
        if re.search(r"^Clauses \(\d+\)", text, re.M) and _FAR_CLAUSE.search(text):
            return "FAR Clause XML"
        return "XML Document"
    if profile_id == "far_part_52":
        # "FAR Part 51" — the Part the file is, from its own Part heading.
        from app.far.canonical import PROVENANCE_KEY

        heading = ((document.ingestion_provenance or {}).get(PROVENANCE_KEY) or {}).get("part_heading") or ""
        match = re.match(r"^\s*Part\s+(\d{1,2})(?!\d)", heading, re.I)
        return f"FAR Part {match.group(1)}" if match else "FAR Regulation"
    if profile_id == "generic_business_document" and pin.document_family in _UNKNOWN_FAMILIES:
        return "Generic Document"
    return pin.document_family_label or profile_label(profile_id)


def document_labels(database: Session, document: Document) -> dict:
    """Profile/type for a listing; staging_status says whether they exist."""

    pin = database.scalars(
        select(DocumentStagingWorkbook).where(DocumentStagingWorkbook.document_id == document.id)
    ).first()
    if pin is None:
        return {
            "profile_id": None,
            "profile_label": None,
            "type_label": None,
            "staging_status": "not_staged",
            **category_fields(None, classified=False),
        }
    return {
        "profile_id": pin.profile_id,
        "profile_label": profile_label(pin.profile_id),
        "type_label": type_label(database, document, pin),
        "staging_status": "staged",
        **category_fields(pin.document_family),
    }


def document_classification(database: Session, document: Document) -> dict[str, str | None]:
    """Type and category for an intake queue: the persisted resolution's
    once staged, before then the resolver's current reading of the
    document (not persisted), so a file is grouped as soon as it's read."""

    pin = database.scalars(
        select(DocumentStagingWorkbook).where(DocumentStagingWorkbook.document_id == document.id)
    ).first()
    if pin is not None:
        return {"type_label": type_label(database, document, pin), **category_fields(pin.document_family)}
    from app.staging.resolver import resolve_profile

    resolution = resolve_profile(database, document)
    label = None if resolution.family in _UNKNOWN_FAMILIES else resolution.family_label
    return {"type_label": label, **category_fields(resolution.family)}

