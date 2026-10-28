"""Broad categories documents are grouped under — Contracts & Awards,
FAR & Regulations, Financial … — derived from the document family the
staging resolver recognized (never from the filename). The detailed type
(type_label) stays the document's own; a category only groups types.
"""

from __future__ import annotations

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from app.models.document import Document
from app.models.document_staging_workbook import DocumentStagingWorkbook

UNCLASSIFIED = "unclassified"
OTHER = "other"

# (category id, label, document families), in display order.
CATEGORIES: tuple[tuple[str, str, frozenset[str]], ...] = (
    (
        "contracts",
        "Contracts & Awards",
        frozenset({
            "government_contract", "contract", "master_services_agreement", "supplier_agreement",
            "sow", "amendment", "correspondence",
        }),
    ),
    (
        "procurement",
        "Procurement",
        frozenset({"procurement", "purchase_order", "quotation", "rate_card", "shipping_document"}),
    ),
    (
        "regulations",
        "FAR & Regulations",
        frozenset({"far_regulation", "far_regulatory_change", "xml_data"}),
    ),
    (
        "financial",
        "Financial",
        frozenset({
            "invoice", "credit_note", "receipt", "statement", "financial_report", "financial_statement",
            "budget", "bank_check", "tax_form", "utility_bill", "insurance_policy",
        }),
    ),
    ("identity", "Identity Documents", frozenset({"passport", "driving_licence", "identity_card"})),
    ("people", "HR & Education", frozenset({"resume", "academic_transcript", "pay_stub"})),
    (
        "technical",
        "Technical & Reports",
        frozenset({"technical_specification", "business_requirements", "research_idea", "laboratory_report"}),
    ),
    (OTHER, "Other Documents", frozenset({"generic_business", "unknown"})),
)

CATEGORY_LABELS: dict[str, str] = {key: label for key, label, _ in CATEGORIES} | {UNCLASSIFIED: "Not yet classified"}
_BY_FAMILY: dict[str, str] = {family: key for key, _, families in CATEGORIES for family in families}


def category_for_family(family: str | None) -> str:
    """The category of a resolved family; an unlisted family is Other."""

    if not family:
        return OTHER
    return _BY_FAMILY.get(family, OTHER)


def category_fields(family: str | None, *, classified: bool = True) -> dict[str, str]:
    key = category_for_family(family) if classified else UNCLASSIFIED
    return {"category": key, "category_label": CATEGORY_LABELS[key]}


def filter_by_category(query: Select, category: str) -> Select:
    """Documents whose persisted resolution falls in the category."""

    pinned = select(DocumentStagingWorkbook.document_id)
    if category == UNCLASSIFIED:
        return query.where(Document.id.not_in(pinned))
    if category == OTHER:
        families = [family for key, _, members in CATEGORIES if key != OTHER for family in members]
        return query.where(
            Document.id.in_(
                pinned.where(
                    DocumentStagingWorkbook.document_family.is_(None)
                    | DocumentStagingWorkbook.document_family.not_in(families)
                )
            )
        )
    members = next((members for key, _, members in CATEGORIES if key == category), frozenset())
    return query.where(Document.id.in_(pinned.where(DocumentStagingWorkbook.document_family.in_(members))))


def category_counts(database: Session, query: Select) -> dict[str, int]:
    """Documents per category over a (scoped, filtered) document query."""

    ids = query.with_only_columns(Document.id).order_by(None).subquery()
    total = database.scalar(select(func.count()).select_from(ids)) or 0
    rows = database.execute(
        select(DocumentStagingWorkbook.document_family, func.count())
        .where(DocumentStagingWorkbook.document_id.in_(select(ids.c.id)))
        .group_by(DocumentStagingWorkbook.document_family)
    )
    counts: dict[str, int] = {}
    pinned = 0
    for family, count in rows:
        key = category_for_family(family)
        counts[key] = counts.get(key, 0) + count
        pinned += count
    if total - pinned > 0:
        counts[UNCLASSIFIED] = total - pinned
    return counts



def ordered_counts(counts: dict[str, int]) -> list[dict]:
    """Category counts in display order with their labels, unclassified last."""

    order = [key for key, _, _ in CATEGORIES] + [UNCLASSIFIED]
    return [
        {"category": key, "label": CATEGORY_LABELS[key], "count": counts[key]}
        for key in order
        if counts.get(key)
    ]


def document_category(database: Session, document: Document) -> dict[str, str]:
    """The document's category: its persisted resolution's, or — before it
    has been staged — the resolver's current reading of it (not persisted)."""

    family = database.scalar(
        select(DocumentStagingWorkbook.document_family).where(DocumentStagingWorkbook.document_id == document.id)
    )
    if family is None:
        from app.staging.resolver import resolve_profile

        family = resolve_profile(database, document).family
    return category_fields(family)
