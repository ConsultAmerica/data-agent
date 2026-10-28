"""document → detected family → staging profile, pinned with its version.

Signals, in order:
  0. A profile's document recognizer finding strong structural evidence
     in the document itself (e.g. FAR Part 52's Part/Subpart/clause
     heading structure) — decisive, because such text would otherwise
     read like a contract to the keyword classifier. Never the filename.
  1. Deterministic keyword family classification of the document's text
     (structure_detection.classify_document_family — no AI).
  2. When that is inconclusive, the document's existing AI classification
     (Document.document_type), if one was recorded.
  3. When still inconclusive, structural evidence the canonical pipeline
     already found: an incorporated-clause listing plus a contract number
     is a government contract.

A short letter *about* a contract (subject line, salutation, closing; no
contract structure) is correspondence, not a contract: the contract
profile finds nothing in it, so it resolves to the generic profile.

The profile is whichever registered profile claims the family; otherwise
the generic profile. A document is never forced into a profile whose
family it wasn't detected as (an invoice never becomes contract_v3).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.document_clause_reference import DocumentClauseReference
from app.models.document_contract_summary import DocumentContractSummary
from app.models.document_page import DocumentPage
from app.models.document_staging_workbook import DocumentStagingWorkbook
from app.services.structure_detection import (
    DOCUMENT_FAMILIES,
    classify_document_family,
    family_for_document_type,
)
from app.source_structure.models import StructuredSourceDocument
from app.staging import registry
from app.staging.profile import StagingProfile

_CLASSIFY_PAGE_LIMIT = 10
_MIN_CLAUSE_LISTINGS = 5
_INCONCLUSIVE = {"unknown", "generic_business"}

CORRESPONDENCE_FAMILY = "correspondence"
CORRESPONDENCE_LABEL = "Correspondence"
_LETTER_MAX_PAGES = 5
# Only families a letter about a contract is mistaken for; an invoice or
# transcript with a cover note keeps its own profile.
_LETTER_OVERRIDABLE = _INCONCLUSIVE | {"government_contract", "contract", "procurement", "amendment", "sow"}
_SUBJECT_LINE = re.compile(r"^\s*(subject|re|ref(erence)?)\s*:", re.IGNORECASE | re.MULTILINE)
_SALUTATION = re.compile(r"^\s*dear\s+\S", re.IGNORECASE | re.MULTILINE)
_CLOSING = re.compile(
    r"^\s*(respectfully(\s+(submitted|yours))?|sincerely(\s+yours)?|(best\s+|kind\s+|warm\s+)?regards"
    r"|very\s+truly\s+yours|yours\s+(truly|faithfully|sincerely)|cordially)\s*[,.]?\s*$",
    re.IGNORECASE | re.MULTILINE,
)


@dataclass
class ProfileResolution:
    profile: StagingProfile
    family: str
    family_label: str
    reasons: list[str] = field(default_factory=list)
    # True when a specific document family was established (keywords, AI
    # classification or structural evidence). False means the generic
    # fallback was chosen because nothing more specific could be shown.
    confident: bool = False


def _page_text(database: Session, document_id: str) -> str:
    pages = database.scalars(
        select(DocumentPage)
        .where(DocumentPage.document_id == document_id)
        .order_by(DocumentPage.page_number)
        .limit(_CLASSIFY_PAGE_LIMIT)
    )
    return "\n".join(page.final_text or "" for page in pages)


def _has_contract_structure(database: Session, document_id: str) -> bool:
    listings = database.scalar(
        select(func.count())
        .select_from(DocumentClauseReference)
        .where(
            DocumentClauseReference.document_id == document_id,
            DocumentClauseReference.citation_context == "listing",
        )
    )
    contract_number = database.scalar(
        select(DocumentContractSummary.contract_number).where(
            DocumentContractSummary.document_id == document_id
        )
    )
    return (listings or 0) >= _MIN_CLAUSE_LISTINGS and bool(contract_number)


def _letter_signals(database: Session, document: Document, text: str) -> list[str]:
    """Why a short document reads as a letter; empty when it does not."""

    if (document.page_count or 0) > _LETTER_MAX_PAGES:
        return []
    signals = []
    if _SUBJECT_LINE.search(text[:2000]):
        signals.append("subject line")
    if _SALUTATION.search(text):
        signals.append("salutation")
    if _CLOSING.search(text):
        signals.append("closing")
    if len(signals) < 2 or _has_contract_structure(database, document.id):
        return []
    return signals


# A document recognizer must be this sure (strong structural evidence)
# before it pre-empts keyword classification.
DOCUMENT_RECOGNITION_THRESHOLD = 0.8


def recognize_document_profile(database: Session, document: Document) -> ProfileResolution | None:
    """The profile whose document recognizer finds strong structural
    evidence in the document itself, if any (resolution step 0)."""

    best = None
    for profile in registry.latest_profiles():
        if profile.document_recognizer is None:
            continue
        recognition = profile.document_recognizer(database, document)
        if recognition.score >= DOCUMENT_RECOGNITION_THRESHOLD and (
            best is None or recognition.score > best[1].score
        ):
            best = (profile, recognition)
    if best is None:
        return None
    profile, recognition = best
    family = profile.document_families[0]
    label = DOCUMENT_FAMILIES.get(family, (profile.display_name, []))[0]
    return ProfileResolution(
        profile=profile,
        family=family,
        family_label=label,
        reasons=[
            f"Structural recognition: {profile.display_name} "
            f"(score {recognition.score:.2f}; {'; '.join(recognition.reasons)}).",
            f"{profile.display_name} profile is registered for '{label}'.",
        ],
        confident=True,
    )


def resolve_profile(database: Session, document: Document) -> ProfileResolution:
    recognized = recognize_document_profile(database, document)
    if recognized is not None:
        return recognized
    reasons: list[str] = []
    text = _page_text(database, document.id)
    family, label, confidence = classify_document_family(text)
    reasons.append(f"Keyword classification: {label} (confidence {confidence:.2f}).")

    if family in _LETTER_OVERRIDABLE:
        signals = _letter_signals(database, document, text)
        if signals:
            profile = registry.generic_profile()
            reasons.append(
                f"Letter structure ({', '.join(signals)}) and no contract structure: "
                f"correspondence, using the {profile.display_name} profile."
            )
            return ProfileResolution(
                profile=profile,
                family=CORRESPONDENCE_FAMILY,
                family_label=CORRESPONDENCE_LABEL,
                reasons=reasons,
                confident=True,
            )

    if family in _INCONCLUSIVE and document.document_type:
        mapped, mapped_label = family_for_document_type(
            document.document_type, document.classification_confidence or 0.0
        )
        if mapped not in _INCONCLUSIVE:
            family, label = mapped, mapped_label
            reasons.append(f"AI document classification: {document.document_type}.")

    if family in _INCONCLUSIVE and _has_contract_structure(database, document.id):
        family = "government_contract"
        label = DOCUMENT_FAMILIES[family][0]
        reasons.append(
            "Structural evidence: incorporated-clause listing and a contract number."
        )

    profile = registry.profile_for_family(family)
    if profile is None:
        profile = registry.generic_profile()
        if family not in _INCONCLUSIVE:
            reasons.append(
                f"No staging profile is registered for '{label}' yet; using the "
                f"{profile.display_name} profile."
            )
    else:
        reasons.append(f"{profile.display_name} profile is registered for '{label}'.")

    return ProfileResolution(
        profile=profile,
        family=family,
        family_label=label,
        reasons=reasons,
        confident=family not in _INCONCLUSIVE,
    )


RECOGNITION_THRESHOLD = 0.6


def refine_with_structure(
    resolution: ProfileResolution, structure: StructuredSourceDocument
) -> ProfileResolution:
    """For a resolution that wasn't confident, let profiles that declare a
    structural recognizer score the document's schema-neutral structure.
    The best score at or above the threshold wins; otherwise the original
    (safe, generic) resolution stands. Confident resolutions are final."""

    if resolution.confident:
        return resolution
    best = None
    for profile in registry.latest_profiles():
        if profile.recognizer is None:
            continue
        recognition = profile.recognizer(structure)
        if recognition.score >= RECOGNITION_THRESHOLD and (
            best is None or recognition.score > best[1].score
        ):
            best = (profile, recognition)
    if best is None:
        return resolution
    profile, recognition = best
    family = profile.document_families[0]
    label = DOCUMENT_FAMILIES.get(family, (profile.display_name, []))[0]
    return ProfileResolution(
        profile=profile,
        family=family,
        family_label=label,
        reasons=[
            *resolution.reasons,
            f"Structural recognition: {profile.display_name} "
            f"(score {recognition.score:.2f}; {'; '.join(recognition.reasons)}).",
        ],
        confident=True,
    )


def resolve_and_persist_profile(
    database: Session, document: Document
) -> DocumentStagingWorkbook:
    """(Re)pins the document's staging profile; commits."""

    return persist_resolution(database, document, resolve_profile(database, document))


def persist_resolution(
    database: Session, document: Document, resolution: ProfileResolution
) -> DocumentStagingWorkbook:
    record = database.scalars(
        select(DocumentStagingWorkbook).where(DocumentStagingWorkbook.document_id == document.id)
    ).first()
    if record is None:
        record = DocumentStagingWorkbook(document_id=document.id)
        database.add(record)
    record.profile_id = resolution.profile.profile_id
    record.profile_version = resolution.profile.profile_version
    record.document_family = resolution.family
    record.document_family_label = resolution.family_label
    record.resolution_reasons = resolution.reasons
    record.resolved_at = datetime.now(timezone.utc)
    if document.data_class_source != "user":
        # A person's classification stands; otherwise the profile decides.
        document.data_class = resolution.profile.data_class
        document.data_class_source = "profile"
    database.commit()
    return record
