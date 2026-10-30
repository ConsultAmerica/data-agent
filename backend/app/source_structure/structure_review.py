"""Approve, reject or correct records of the original layout.

A field matched to an extraction row is reviewed on that row through the
metadata review state machine (same permissions, validation gate and audit
log), so the decision reaches staging and Oracle mapping. A printed field
nothing extracted, and a table row, are reviewed in StructureRecordReview:
the printed value stays as it is and a correction is stored beside it.

Selecting records never reviews them; only an explicit action does.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import ActorContext
from app.models.document import Document
from app.models.document_metadata_field import DocumentMetadataField
from app.models.structure_record_review import StructureRecordReview

StructureAction = Literal["accept", "reject", "correct", "reset", "add_row"]

# The metadata review action each structure action runs.
_METADATA_ACTION = {"accept": "accept", "reject": "reject", "correct": "correct"}
_STATUS = {"accept": "accepted", "reject": "rejected", "correct": "edited"}


def layout_records(layout: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Every reviewable record of a layout by its key: fields and rows."""

    records: dict[str, dict[str, Any]] = {}
    sections = [*layout["sections"], {"items": layout.get("unplaced") or []}]
    for section in sections:
        for item in section["items"]:
            if item["kind"] == "field":
                records[item["record_key"]] = {"kind": "field", "item": item}
            else:
                records[item["record_key"]] = {"kind": "table", "item": item}
                for row in item["rows"]:
                    records[row["record_key"]] = {"kind": "row", "item": row, "table": item}
    return records


def _add_row(
    database: Session, document: Document, key: str, table: dict[str, Any], cells: list[str] | None,
    reason: str | None, actor: ActorContext,
) -> dict[str, Any]:
    """A row the printed table is missing, entered by a reviewer. It is
    marked Added and still needs approval like any other row."""

    from uuid import uuid4

    from app.api.contract_analysis import _require_review_permission

    _require_review_permission(actor, "correct")
    if document.approved_at is not None:
        raise HTTPException(status_code=409, detail="This document has been approved, so its values are locked.")
    if not cells or len(cells) != len(table["headers"]) or not any(str(c).strip() for c in cells):
        raise HTTPException(status_code=400, detail="A new row needs one value per column, and at least one value.")
    now = datetime.now(timezone.utc)
    row_key = f"{key}:added:{now.strftime('%Y%m%d%H%M%S')}{uuid4().hex[:6]}"
    database.add(StructureRecordReview(
        document_id=document.id, record_key=row_key, record_kind="row", status="added", original_value=None,
        reviewed_value=[str(c) for c in cells], reason=reason, actor_id=actor.id, actor_name=actor.display_name,
        history=[], updated_at=now,
    ))
    database.commit()
    return {"record_key": row_key, "ok": True, "stored_on": "structure", "review_status": "added"}


def _decide(
    database: Session,
    document: Document,
    key: str,
    record: dict[str, Any],
    action: StructureAction,
    value: str | None,
    cells: list[str] | None,
    reason: str | None,
    actor: ActorContext,
) -> dict[str, Any]:
    item = record["item"]
    metadata = item.get("metadata") if record["kind"] == "field" else None
    if metadata:
        from app.api.contract_analysis import _apply_metadata_field_review, _require_review_permission
        from app.schemas.contract_analysis import FieldReviewRequest

        if action == "reset":
            raise HTTPException(status_code=400, detail="An extracted field's review is changed in Metadata review.")
        _require_review_permission(actor, _METADATA_ACTION[action])
        row = database.get(DocumentMetadataField, metadata["id"])
        if row is None or row.document_id != document.id:
            raise HTTPException(status_code=404, detail="Metadata field not found.")
        result = _apply_metadata_field_review(
            database=database,
            document_id=document.id,
            field=row,
            payload=FieldReviewRequest(
                action=_METADATA_ACTION[action], value=value, changed_by=actor.display_name or "reviewer",
                override_reason=reason,
            ),
            actor=actor,
        )
        return {"record_key": key, "ok": True, "stored_on": "metadata", "review_status": result.review_status}

    from app.api.contract_analysis import _require_review_permission

    _require_review_permission(actor, "reject" if action == "reject" else ("accept" if action == "accept" else "correct"))
    if document.approved_at is not None and action in ("correct", "reset"):
        raise HTTPException(status_code=409, detail="This document has been approved, so its values are locked.")
    added = bool(item.get("added"))
    # An added row has no printed value; its cells are the reviewer's.
    original: Any = None if added else (item.get("document_value") if record["kind"] == "field" else list(item["cells"]))
    reviewed: Any = None
    if action == "correct":
        if record["kind"] == "field":
            if not (value or "").strip():
                raise HTTPException(status_code=400, detail="A value is required to correct a field.")
            reviewed = value
        else:
            if not cells or len(cells) != len(item["cells"]):
                raise HTTPException(status_code=400, detail="A row correction needs one value per column.")
            reviewed = [str(c) for c in cells]
        if reviewed == (list(item["cells"]) if added else original):
            raise HTTPException(status_code=400, detail="The corrected value is the same as the printed value.")

    existing = database.scalar(
        select(StructureRecordReview).where(
            StructureRecordReview.document_id == document.id, StructureRecordReview.record_key == key
        )
    )
    now = datetime.now(timezone.utc)
    if action == "reset":
        if existing is not None and not added:
            database.delete(existing)
        database.commit()
        return {"record_key": key, "ok": True, "stored_on": "structure", "review_status": None}
    if existing is None:
        existing = StructureRecordReview(
            document_id=document.id, record_key=key, record_kind=record["kind"], original_value=original, history=[]
        )
        database.add(existing)
    else:
        existing.history = [*(existing.history or []), {
            "status": existing.status, "value": existing.reviewed_value, "reason": existing.reason,
            "actor": existing.actor_name, "at": existing.updated_at.isoformat() if existing.updated_at else None,
        }]
    existing.status = _STATUS[action]
    # Approving after a correction keeps the corrected value (it is what is
    # approved); the full sequence of decisions is in history.
    if action == "correct":
        existing.reviewed_value = reviewed
    existing.original_value = original
    existing.reason = reason
    existing.actor_id = actor.id
    existing.actor_name = actor.display_name
    existing.updated_at = now
    database.commit()
    return {"record_key": key, "ok": True, "stored_on": "structure", "review_status": existing.status}


def review_records(
    database: Session,
    document: Document,
    layout: dict[str, Any],
    keys: list[str],
    action: StructureAction,
    *,
    value: str | None,
    cells: list[str] | None,
    reason: str | None,
    actor: ActorContext,
) -> list[dict[str, Any]]:
    """One result per key; a record that can't be reviewed reports why and
    leaves the others unaffected."""

    records = layout_records(layout)
    results = []
    for key in dict.fromkeys(keys):
        record = records.get(key)
        if record is None:
            results.append({"record_key": key, "ok": False, "error": "This record is no longer in the document layout."})
            continue
        if (action == "add_row") != (record["kind"] == "table"):
            results.append({"record_key": key, "ok": False,
                            "error": "Rows are added to a table; tables are reviewed row by row."})
            continue
        try:
            if action == "add_row":
                results.append(_add_row(database, document, key, record["item"], cells, reason, actor))
                continue
            results.append(_decide(database, document, key, record, action, value, cells, reason, actor))
        except HTTPException as exc:
            if exc.status_code == 403:
                raise
            database.rollback()
            detail = exc.detail.get("message") if isinstance(exc.detail, dict) else exc.detail
            results.append({"record_key": key, "ok": False, "error": str(detail)})
    return results
