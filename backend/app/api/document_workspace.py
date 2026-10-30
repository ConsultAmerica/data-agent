"""The verification workspace's data, all built from one representation —
the document's original layout (app/source_structure/original_layout.py)
joined to extraction and review — so the UI tabs and every export agree:

- Business Data: values in the skill's canonical sections.
- Validation: everything that needs attention, grouped by kind.
- Dates: dates by meaning and the expiration status.
- Find: targeted extraction of one named value.
- All Extracted Fields (CSV) and Structured JSON exports.

Workspace isolation is enforced by the router dependency
(enforce_document_access, mounted in app/main.py).
"""

from __future__ import annotations

import csv
import io
from datetime import datetime
from pathlib import PurePath
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.downloads import attachment_header, excel_csv
from app.core.auth import ActorContext, require_permission
from app.core.config import get_settings
from app.database.dependencies import get_database
from app.models.document import Document
from app.services.document_storage import DocumentStorageError
from app.skills.business_data import build_business_data
from app.skills.dates import document_dates
from app.skills.definitions import SKILLS
from app.skills.find import find_in_document
from app.skills.registry import get_skill, record_skill_versions
from app.skills.validation import validation_summary
from app.source_structure.original_export import FOUND_BY_LABEL
from app.source_structure.original_layout import original_layout_for

router = APIRouter()
skills_router = APIRouter()

# The All Extracted Fields CSV, in this exact column order.
ALL_FIELDS_COLUMNS = ["Category", "Field", "Value", "Type", "Found By", "Source Page", "Evidence", "Review Status"]


def _document(database: Session, document_id: str) -> Document:
    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    return document


def workspace_context(database: Session, document: Document) -> dict[str, Any]:
    from app.api.classification import _state

    try:
        layout = original_layout_for(database, document)
    except DocumentStorageError as exc:
        raise HTTPException(status_code=409, detail=f"The source file isn't available: {exc}") from exc
    classification = _state(database, document).model_dump(mode="json")
    record_skill_versions(database)
    business = build_business_data(layout, classification)
    return {"layout": layout, "classification": classification, "business": business}


def _today() -> datetime:
    return datetime.now(ZoneInfo(get_settings().lifecycle_timezone))


def _dates(database: Session, document: Document, business: dict[str, Any], warning_days: int | None) -> dict[str, Any]:
    from app.models.document_key_date import DocumentKeyDate

    rows = list(database.scalars(select(DocumentKeyDate).where(DocumentKeyDate.document_id == document.id)))
    days = warning_days if warning_days is not None else get_settings().key_date_expiring_days
    return document_dates(business, rows, today=_today().date(), warning_days=days)


@router.get("/{document_id}/business-data")
def get_business_data(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict[str, Any]:
    """Category → type → section → field / table → record, from the
    document's skill; values no section claims are kept under "other"."""

    context = workspace_context(database, _document(database, document_id))
    return context["business"]


@router.get("/{document_id}/validation-summary")
def get_validation_summary(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict[str, Any]:
    context = workspace_context(database, _document(database, document_id))
    return validation_summary(context["business"], context["layout"])


@router.get("/{document_id}/document-dates")
def get_document_dates(
    document_id: str,
    warning_days: int | None = Query(default=None, ge=1, le=365),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict[str, Any]:
    """Dates by meaning and the expiration status; `warning_days` sets the
    Expiring Soon threshold (default: the key_date_expiring_days setting)."""

    document = _document(database, document_id)
    context = workspace_context(database, document)
    return _dates(database, document, context["business"], warning_days)


class FindIn(BaseModel):
    query: str = Field(min_length=2, max_length=200)


@router.post("/{document_id}/find")
def find_value(
    document_id: str,
    payload: FindIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict[str, Any]:
    """Answer "Extract Contract Number" / "Identify FAR Clauses" from the
    document's own printed and extracted values; never a generated value."""

    document = _document(database, document_id)
    context = workspace_context(database, document)
    citations = None
    if "clause" in payload.query.lower():
        from app.models.document_page import DocumentPage
        from app.services.clause_citation_scanner import scan_pages_for_clause_citations

        pages = list(database.scalars(
            select(DocumentPage).where(DocumentPage.document_id == document.id).order_by(DocumentPage.page_number)
        ))
        citations = scan_pages_for_clause_citations(pages=pages)
    return find_in_document(
        payload.query, business=context["business"], family=context["classification"]["family"],
        clause_citations=citations, dates=_dates(database, document, context["business"], None),
    )


def all_fields_rows(business: dict[str, Any], layout: dict[str, Any]) -> list[list[Any]]:
    """Every field value in document order, under its business category
    (or, unclaimed, its source section), with the printed label."""

    category_of: dict[str, str] = {}
    for section in business["sections"]:
        for field in section["fields"]:
            for candidate in field["candidates"]:
                category_of[candidate["record_key"]] = section["label"]
        for value in section.get("values", []):
            category_of[value["record_key"]] = section["label"]
    rows = []
    items = [(s["title"], i) for s in layout["sections"] for i in s["items"] if i["kind"] == "field"]
    items += [(None, i) for i in layout.get("unplaced") or []]
    for source, item in items:
        value = item.get("effective_value") or item.get("extracted_value") or item.get("document_value") or ""
        rows.append([
            category_of.get(item["record_key"]) or source or "Other Extracted Data",
            item["label"],
            value,
            item.get("value_type") or "text",
            FOUND_BY_LABEL.get(item.get("found_by") or "", item.get("found_by") or ""),
            item.get("page") or "",
            item.get("evidence") or "",
            item.get("review_status") or "",
        ])
    return rows


@router.get("/{document_id}/all-fields.csv")
def export_all_fields_csv(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("export.read")),
) -> Response:
    document = _document(database, document_id)
    context = workspace_context(database, document)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(ALL_FIELDS_COLUMNS)
    for row in all_fields_rows(context["business"], context["layout"]):
        # Spreadsheet-safe: text starting like a formula is never executed.
        writer.writerow([("'" + v) if isinstance(v, str) and v[:1] in ("=", "+", "@") else v for v in row])
    name = PurePath(document.original_filename or "document").stem
    return Response(
        content=excel_csv(buffer.getvalue()),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": attachment_header(f"{name} - all extracted fields.csv")},
    )


@router.get("/{document_id}/structured.json")
def export_structured_json(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("export.read")),
) -> Response:
    import json

    document = _document(database, document_id)
    context = workspace_context(database, document)
    payload = {
        "document": {"id": document.id, "name": document.original_filename, "pages": context["layout"].get("pages")},
        "classification": {k: context["classification"].get(k) for k in (
            "document_class", "document_class_label", "family", "family_label", "subtype", "confidence",
            "method", "evidence", "review_status")},
        "skill": context["business"].get("skill"),
        "original_structure": context["layout"],
        "business_data": context["business"],
        "validation": validation_summary(context["business"], context["layout"]),
        "dates": _dates(database, document, context["business"], None),
    }
    name = PurePath(document.original_filename or "document").stem
    return Response(
        content=json.dumps(payload, indent=2, default=str),
        media_type="application/json",
        headers={"Content-Disposition": attachment_header(f"{name} - structured.json")},
    )


@skills_router.get("")
def list_skills(actor: ActorContext = Depends(require_permission("documents.view"))) -> list[dict[str, Any]]:
    return [
        {"skill_id": s.skill_id, "version": s.version, "name": s.name, "document_class": s.document_class,
         "families": list(s.families), "subtypes": list(s.subtypes),
         "sections": [section.label for section in s.sections], "content_hash": s.content_hash()}
        for s in SKILLS
    ]


@skills_router.get("/{skill_id}")
def read_skill(skill_id: str, actor: ActorContext = Depends(require_permission("documents.view"))) -> dict[str, Any]:
    skill = get_skill(skill_id)
    if skill is None:
        raise HTTPException(status_code=404, detail="Skill not found.")
    return {**skill.as_dict(), "content_hash": skill.content_hash()}
