"""V3 All Fields builder (docs/v3-schema-manifest.md §1).

Reuses the existing `document_metadata_fields` storage layer (gap analysis:
"the one dataset the old pipeline already does reasonably well at the
storage layer — the problem is entirely upstream, in what gets classified
as a candidate"). What changes here is the SOURCE of candidates:
GENERAL_ACCEPTED_FIELD-category `ClassifiedCandidate`s from the new
structure_classifier/candidate_router pipeline, not the old kv_* schema-
discovery stream — this is what keeps TOC lines, subsection-number
fragments, and table scaffolding out of All Fields (docs/source-to-v3-
mapping.md's confirmed root cause).

Rows are written with `extraction_source="v3"`, a new, third value
alongside the existing "contract"/"target" sources — additive, the old
sources are untouched.
"""

from __future__ import annotations

from datetime import datetime, timezone

import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.document_metadata_field import DocumentMetadataField
from app.schemas.candidate_classification import ClassifiedCandidate
from app.services.evidence_geometry import evidence_bbox

_HUMAN_LOCKED = frozenset({"edited", "accepted", "rejected"})

_SLUG_RE = re.compile(r"[^a-z0-9]+")
# Form chrome and leftover instructions are not business values. Kept
# generic — no contract-specific strings.
_CHROME_VALUES = frozenset(
    {
        "sign",
        "signature",
        "date",
        "name",
        "code",
        "item",
        "page",
        "pages",
        "check",
        "initial",
        "initials",
        "title",
        "number",
        "n/a",
        "na",
        "see",
        "united states",
        "united states of america",
        "by",
    }
)
# "Not applicable" is real information about a field, so these stay as
# values (routed to review); every other chrome word is never a value.
_PLACEHOLDER_VALUES = frozenset({"n/a", "na"})
# A list or outline enumerator on its own: "a.", "(b)", "iv.", "1)". Under a
# section heading ("REQUIRED INSURANCE") the first sub-paragraph's marker
# sits where a form value would be; it is never the value.
_OUTLINE_MARKER = re.compile(
    r"^\(?(?:[a-z]{1,2}"  # a. (b) aa.
    r"|(?=[ivxlc])c{0,3}(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})"  # a real Roman numeral: iv. xii)
    r"|\d{1,3})[.)]$",  # 1. 12)
    re.IGNORECASE,
)
_INSTRUCTIONAL_LABEL = re.compile(
    r"^(check if\b)|\(type or print\)|\(if other than",
    re.IGNORECASE,
)
_INSTRUCTION_FRAGMENT = re.compile(r"\b(such|thereof|herein|aforementioned)\b", re.IGNORECASE)


def association_is_defensible(label: str, value: str) -> bool:
    """A label/value pair is not Verified just because both strings exist.

    Recognized fields must pass their semantic validator. Unrecognized
    pairs must not be form chrome, checkbox instructions, or placeholders.
    """

    from app.services.contract_summary_fields import match_label, validate_value

    normalized_value = " ".join(value.lower().split()).strip(" .:")
    if normalized_value in _CHROME_VALUES:
        return False
    if _INSTRUCTIONAL_LABEL.search(label) and match_label(label) is None:
        return False
    if _INSTRUCTION_FRAGMENT.search(value) and not re.search(r"\d", value):
        return False
    field_key = match_label(label)
    if field_key is not None:
        return validate_value(field_key, value).is_valid
    words = re.findall(r"[A-Za-z]{4,}", value)
    digits = re.findall(r"\d{3,}", value)
    if not words and not digits and len(value.strip()) < 40:
        return False
    return True


def not_a_value(value: str) -> str | None:
    """Why a candidate value can never be a field value, or None.

    Unlike association_is_defensible (which routes doubtful pairs to a
    reviewer), these are dropped: a reviewer should never be asked to
    approve "a." or "ITEM" as a value.
    """

    text = " ".join(value.split())
    if _OUTLINE_MARKER.match(text):
        return "outline_marker"
    normalized = text.lower().strip(" .:")
    if normalized in _CHROME_VALUES and normalized not in _PLACEHOLDER_VALUES:
        return "form_chrome"
    return None


def _slug(text: str) -> str:
    slug = _SLUG_RE.sub("_", text.strip().lower()).strip("_")
    return slug or "field"


def _extraction_method_for(candidate: ClassifiedCandidate) -> str:
    # Vocabulary per docs/v3-implementation-plan.md decision #6. Every
    # candidate reaching All Fields came from deterministic geometry/text
    # classification, never AI, by construction of this pipeline.
    if candidate.region_type == "TABLE_ROW":
        return "table"
    if candidate.region_type == "FORM_FIELD_VALUE":
        return "form_field"
    if candidate.extraction_method == "ocr":
        return "ocr"
    return "native_text"


def build_all_fields(
    *, document: Document, candidates: list[ClassifiedCandidate]
) -> list[DocumentMetadataField]:
    rows: list[DocumentMetadataField] = []
    seen: set[tuple[str, str]] = set()

    for candidate in candidates:
        if candidate.category != "GENERAL_ACCEPTED_FIELD" or not candidate.value:
            continue
        label = (candidate.label or candidate.value).strip()
        value = candidate.value.strip()
        if not label or not value:
            continue
        if not_a_value(value):
            continue
        dedupe_key = (label.lower(), value.lower())
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        defensible = association_is_defensible(label, value)
        unrecognized = "unrecognized_field_vocabulary" in candidate.reason_codes
        qa_status = (
            "Verified"
            if candidate.confidence >= 0.7 and defensible and not unrecognized
            else "Needs Review"
        )

        rows.append(
            DocumentMetadataField(
                document_id=document.id,
                field_group="General",
                field_key=f"v3_{_slug(label)}",
                label=label,
                value=value,
                confidence=candidate.confidence,
                extraction_method=_extraction_method_for(candidate),
                evidence_json={
                    "page_number": candidate.source_page,
                    **evidence_bbox(candidate),
                    "source_text": candidate.evidence,
                    "category": "General",
                    "qa_status": qa_status,
                    "reason_codes": candidate.reason_codes,
                },
                review_status="pending",
                original_value=value,
                extraction_source="v3",
            )
        )

    return rows


def persist_all_fields(
    *, database: Session, document_id: str, rows: list[DocumentMetadataField]
) -> None:
    """Upsert V3 all-fields rows without wiping human review decisions."""

    existing_rows = list(
        database.scalars(
            select(DocumentMetadataField).where(
                DocumentMetadataField.document_id == document_id,
                DocumentMetadataField.extraction_source == "v3",
            )
        )
    )
    by_key = {row.field_key: row for row in existing_rows}
    seen: set[str] = set()

    for row in rows:
        seen.add(row.field_key)
        evidence = dict(row.evidence_json) if isinstance(row.evidence_json, dict) else {}
        evidence["machine_value"] = row.value
        existing = by_key.get(row.field_key)

        if existing is None:
            row.evidence_json = evidence
            database.add(row)
            continue

        prior_status = existing.review_status
        human_locked = prior_status in _HUMAN_LOCKED
        reviewed_value = existing.value

        existing.label = row.label
        existing.field_group = row.field_group
        existing.confidence = row.confidence
        existing.extraction_method = row.extraction_method
        # A row built for this run isn't flushed yet, so its column default
        # hasn't applied; stamp the refresh time instead of writing NULL.
        existing.extracted_at = row.extracted_at or datetime.now(timezone.utc)

        if not human_locked:
            existing.value = row.value
            if not existing.original_value:
                existing.original_value = row.value
            existing.evidence_json = evidence
            existing.review_status = "pending"
            existing.human_approved = False
        else:
            evidence["reviewed_value"] = reviewed_value
            evidence["prior_review_status"] = prior_status
            if str(reviewed_value or "").strip() != str(row.value or "").strip():
                existing.review_status = "pending"
                existing.human_approved = False
            else:
                existing.review_status = prior_status
                existing.human_approved = prior_status in {"accepted", "edited"}
            existing.evidence_json = evidence
            if not existing.original_value:
                existing.original_value = row.value

    for key, row in by_key.items():
        if key in seen or row.review_status in _HUMAN_LOCKED:
            continue
        database.delete(row)
