"""Classification state per document: predictions, decisions, history.

A document's current classification is its latest decision (a person
confirming or changing the type) when there is one, else its latest
prediction. Rows are only added; the first prediction and every decision
stay on record, and each decision is also written to
``classification_audit_log``.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.classification_audit_log import ClassificationAuditLog
from app.models.document import Document
from app.models.document_classification import DocumentClassification
from app.services.structure_detection import DOCUMENT_FAMILIES
from app.staging import registry
from app.staging.document_categories import category_for_family

DECISION_KINDS = ("confirmation", "override")
CUSTOM_PREFIX = "custom:"


class ClassificationError(ValueError):
    """The requested decision isn't possible; the message says why."""


def history(database: Session, document_id: str) -> list[DocumentClassification]:
    return list(
        database.scalars(
            select(DocumentClassification)
            .where(DocumentClassification.document_id == document_id)
            .order_by(DocumentClassification.id)
        )
    )


def current(database: Session, document_id: str) -> DocumentClassification | None:
    rows = history(database, document_id)
    decisions = [row for row in rows if row.is_decision]
    if decisions:
        return decisions[-1]
    return rows[-1] if rows else None


def current_decision(database: Session, document_id: str) -> DocumentClassification | None:
    return database.scalars(
        select(DocumentClassification)
        .where(DocumentClassification.document_id == document_id, DocumentClassification.is_decision.is_(True))
        .order_by(DocumentClassification.id.desc())
    ).first()


def latest_prediction(database: Session, document_id: str) -> DocumentClassification | None:
    return database.scalars(
        select(DocumentClassification)
        .where(DocumentClassification.document_id == document_id, DocumentClassification.is_decision.is_(False))
        .order_by(DocumentClassification.id.desc())
    ).first()


def record_prediction(database: Session, document: Document, *, commit: bool = True) -> DocumentClassification:
    """Classifies the document and records the result — unless it matches
    the latest prediction exactly (re-runs don't pile up identical rows)."""

    from app.classification.engine import ENGINE_VERSION, predict

    prediction = predict(database, document)
    selected = prediction.selected
    candidates = [candidate.as_dict() for candidate in prediction.candidates]
    previous = latest_prediction(database, document.id)
    if (
        previous is not None
        and previous.family == selected.family
        and previous.subtype == selected.subtype
        and previous.status == prediction.status
        and previous.candidates == candidates
    ):
        return previous
    row = DocumentClassification(
        document_id=document.id,
        kind="prediction",
        is_decision=False,
        family=selected.family,
        family_label=selected.label,
        category=category_for_family(selected.family),
        subtype=selected.subtype,
        profile_id=selected.profile_id,
        confidence=round(selected.score, 3),
        status=prediction.status,
        candidates=candidates,
        evidence=list(selected.evidence),
        method=prediction.method,
        engine_version=ENGINE_VERSION,
        thresholds=prediction.thresholds,
    )
    database.add(row)
    if commit:
        database.commit()
    else:
        database.flush()
    return row


def ensure_prediction(database: Session, document: Document) -> DocumentClassification:
    return latest_prediction(database, document.id) or record_prediction(database, document)


def known_families() -> dict[str, str]:
    """Every family a person can choose: keyword families plus families
    of registered profiles (FAR, XML …) and correspondence."""

    from app.classification.engine import family_label
    from app.staging.resolver import CORRESPONDENCE_FAMILY

    families = {key: label for key, (label, _keywords) in DOCUMENT_FAMILIES.items()}
    for profile in registry.latest_profiles():
        for family in profile.document_families:
            if family not in ("unknown", "generic_business"):
                families.setdefault(family, family_label(family))
    families[CORRESPONDENCE_FAMILY] = family_label(CORRESPONDENCE_FAMILY)
    return families


def _custom_family(label: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")[:60]
    if not slug:
        raise ClassificationError("A new category needs a name.")
    return f"{CUSTOM_PREFIX}{slug}"


def decide(
    database: Session,
    document: Document,
    *,
    actor_id: str,
    actor_name: str,
    action: str,
    family: str | None = None,
    subtype: str | None = None,
    custom_label: str | None = None,
    reason: str | None = None,
) -> DocumentClassification:
    """Records a person's decision. ``confirm`` accepts the current type
    (optionally refining the subtype); ``override`` sets another known
    family, or a new category (``custom_label``) staged with the generic
    schema. Nothing extracted is deleted."""

    from app.classification.engine import SUBTYPES

    before = current(database, document.id) or ensure_prediction(database, document)
    if action == "confirm":
        chosen_family, chosen_label = before.family, before.family_label
        if chosen_family in ("unknown", "generic_business"):
            raise ClassificationError("Nothing specific was recognized to confirm; choose a document type.")
        chosen_subtype = subtype if subtype is not None else before.subtype
        kind = "confirmation"
    elif action == "override":
        families = known_families()
        if custom_label and custom_label.strip():
            chosen_label = custom_label.strip()[:160]
            chosen_family = _custom_family(chosen_label)
        elif family in families:
            chosen_family, chosen_label = family, families[family]
        else:
            raise ClassificationError(f"Unknown document type {family!r}.")
        chosen_subtype = subtype
        kind = "override"
    else:
        raise ClassificationError("Action must be 'confirm' or 'override'.")

    allowed = SUBTYPES.get(chosen_family)
    if chosen_subtype and allowed and chosen_subtype not in allowed:
        raise ClassificationError(f"{chosen_subtype!r} is not a subtype of {chosen_label}.")

    profile = registry.profile_for_family(chosen_family) or registry.generic_profile()
    row = DocumentClassification(
        document_id=document.id,
        kind=kind,
        is_decision=True,
        family=chosen_family,
        family_label=chosen_label,
        category=category_for_family(chosen_family),
        subtype=chosen_subtype or None,
        profile_id=profile.profile_id,
        confidence=None,
        status="confirmed",
        candidates=list(before.candidates or []),
        evidence=list(before.evidence or []),
        method="reviewer decision",
        engine_version=before.engine_version,
        thresholds=dict(before.thresholds or {}),
        actor_id=actor_id,
        actor_name=actor_name,
        reason=(reason or "").strip()[:2000] or None,
        created_at=datetime.now(timezone.utc),
    )
    database.add(row)
    database.add(
        ClassificationAuditLog(
            document_id=document.id,
            field_changed="document_class",
            previous_value=_describe(before)[:120],
            new_value=_describe(row)[:120],
            actor_id=actor_id,
            changed_by=actor_name,
        )
    )
    database.commit()
    database.refresh(row)
    return row


def _describe(row: DocumentClassification) -> str:
    return f"{row.family_label}{f' — {row.subtype}' if row.subtype else ''}"


def decided_subtype(database: Session, document_id: str) -> str | None:
    """A person's chosen subtype, which wins over the one read from text."""

    decision = current_decision(database, document_id)
    return decision.subtype if decision is not None else None


def presentation_subtype(database: Session, document_id: str, opening_text: str) -> str:
    """The contract presentation key (SF 1442 / OASIS+ / DoD-UCF) for the
    Contract Data columns: a person's chosen subtype first, else the form
    identifier read from the document's opening pages."""

    from app.staging.profiles.contract_presentation import DOD, OASIS, SF1442, contract_subtype

    chosen = decided_subtype(database, document_id)
    if chosen:
        return {"SF 1442 Contract Award": SF1442, "OASIS+ IDIQ": OASIS}.get(chosen, DOD)
    return contract_subtype(opening_text)

