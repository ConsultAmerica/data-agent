"""The document's fields and tables in their original layout.

Workspace isolation is enforced by the router dependency
(enforce_document_access, mounted in app/main.py).
"""

from __future__ import annotations

from typing import Any, Literal

from pathlib import PurePath

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.downloads import attachment_header, excel_csv
from app.core.auth import ActorContext, get_current_actor, require_permission
from app.database.dependencies import get_database
from app.models.document import Document
from app.services.document_storage import DocumentStorageError
from app.source_structure.original_export import build_original_structure_xlsx, csv_rows
from app.source_structure.original_layout import original_layout_for
from app.source_structure.structure_review import StructureAction, review_records

router = APIRouter()


@router.get("/{document_id}/original-structure")
async def get_original_structure(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict[str, Any]:
    """Sections in document order with their fields (original labels and
    values, joined to extraction and review) and tables (printed headers,
    continued tables merged only on evidence)."""

    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    try:
        return await run_in_threadpool(original_layout_for, database, document)
    except DocumentStorageError as exc:
        raise HTTPException(status_code=409, detail=f"The source file isn't available: {exc}") from exc


@router.get("/{document_id}/original-structure/export.xlsx")
async def export_original_structure(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("export.read")),
) -> Response:
    """The Original File tab as Excel: sections, numbered items and
    printed tables in document order, every value kept as printed text."""

    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    try:
        layout = await run_in_threadpool(original_layout_for, database, document)
    except DocumentStorageError as exc:
        raise HTTPException(status_code=409, detail=f"The source file isn't available: {exc}") from exc
    name = document.original_filename or "document"
    content = await run_in_threadpool(build_original_structure_xlsx, layout)
    return Response(
        content=content,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": attachment_header(f"{PurePath(name).stem} - original file.xlsx")},
    )


class StructureReviewIn(BaseModel):
    records: list[str] = Field(min_length=1, max_length=500)
    action: StructureAction
    # A field correction; for a row, one value per column.
    value: str | None = Field(default=None, max_length=5000)
    cells: list[str] | None = Field(default=None, max_length=100)
    reason: str | None = Field(default=None, max_length=500)


@router.post("/{document_id}/original-structure/review")
def review_original_structure(
    document_id: str,
    payload: StructureReviewIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(get_current_actor),
) -> dict[str, Any]:
    """Approve, reject or correct records by key. Extracted fields are
    reviewed on their extraction row; other fields and table rows keep the
    printed value and store the decision beside it. One result per record."""

    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    try:
        layout = original_layout_for(database, document)
    except DocumentStorageError as exc:
        raise HTTPException(status_code=409, detail=f"The source file isn't available: {exc}") from exc
    results = review_records(
        database, document, layout, payload.records, payload.action,
        value=payload.value, cells=payload.cells, reason=payload.reason, actor=actor,
    )
    return {"results": results, "reviewed": sum(1 for r in results if r["ok"])}


class StructureExportIn(BaseModel):
    records: list[str] = Field(min_length=1, max_length=20000)
    format: Literal["xlsx", "csv", "json"] = "xlsx"


def selected_layout(layout: dict[str, Any], keys: set[str]) -> dict[str, Any]:
    """The layout with only the chosen fields and table rows, in place."""

    def keep(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for item in items:
            if item["kind"] == "field":
                if item["record_key"] in keys:
                    out.append(item)
                continue
            rows = [row for row in item["rows"] if row["record_key"] in keys or item["record_key"] in keys]
            if rows:
                out.append({**item, "rows": rows, "row_count": len(rows)})
        return out

    sections = [{**s, "items": keep(s["items"])} for s in layout["sections"]]
    sections = [s for s in sections if s["items"]]
    unplaced = keep(layout.get("unplaced") or [])
    fields = [i for s in sections for i in s["items"] if i["kind"] == "field"] + unplaced
    tables = [i for s in sections for i in s["items"] if i["kind"] == "table"]
    return {
        **layout, "sections": sections, "unplaced": unplaced,
        "stats": {**layout["stats"], "fields": len(fields), "blank_fields": sum(1 for f in fields if f["blank"]),
                  "tables": len(tables), "table_rows": sum(t["row_count"] for t in tables),
                  "quality": {code: sum(1 for f in fields if f.get("quality") == code) for code in layout["stats"].get("quality", {})}},
    }


@router.post("/{document_id}/original-structure/export-selected")
def export_original_structure_selection(
    document_id: str,
    payload: StructureExportIn,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("export.read")),
) -> Response:
    """Only the selected records, in the original layout: Excel or CSV with
    the Original Structure export's rows, or JSON."""

    import csv
    import io
    import json

    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    try:
        layout = original_layout_for(database, document)
    except DocumentStorageError as exc:
        raise HTTPException(status_code=409, detail=f"The source file isn't available: {exc}") from exc
    chosen = selected_layout(layout, set(payload.records))
    name = PurePath(document.original_filename or "document").stem
    if payload.format == "xlsx":
        return Response(
            content=build_original_structure_xlsx(chosen),
            media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            headers={"Content-Disposition": attachment_header(f"{name} - selected records.xlsx")},
        )
    if payload.format == "json":
        return Response(
            content=json.dumps(chosen, indent=2, default=str), media_type="application/json",
            headers={"Content-Disposition": attachment_header(f"{name} - selected records.json")},
        )
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    for row in csv_rows(chosen):
        # Spreadsheet-safe: text starting like a formula is never executed.
        writer.writerow([("'" + v) if isinstance(v, str) and v[:1] in ("=", "+", "@") else v for v in row])
    return Response(
        content=excel_csv(buffer.getvalue()), media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": attachment_header(f"{name} - selected records.csv")},
    )


@router.get("/{document_id}/original-structure/history")
def original_structure_record_history(
    document_id: str,
    record_key: str = Query(min_length=3, max_length=300),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict[str, Any]:
    """Every review decision and correction on one record, oldest first:
    the extraction row's audit log for extracted fields (each candidate),
    else the structure review and its earlier decisions. Loaded on demand
    when a record's details open."""

    from sqlalchemy import select

    from app.models.metadata_field_audit_log import MetadataFieldAuditLog
    from app.models.structure_record_review import StructureRecordReview
    from app.source_structure.structure_review import layout_records

    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    entries: list[dict[str, Any]] = []
    metadata_ids: list[int] = []
    if record_key.startswith("metadata:"):
        metadata_ids = [int(record_key.split(":", 1)[1])] if record_key.split(":", 1)[1].isdigit() else []
    elif record_key.startswith("field:"):
        try:
            record = layout_records(original_layout_for(database, document)).get(record_key)
        except DocumentStorageError:
            record = None
        item = record["item"] if record else {}
        metadata_ids = [m["id"] for m in [item.get("metadata"), *(item.get("other_metadata") or [])] if m]
    if metadata_ids:
        for row in database.scalars(
            select(MetadataFieldAuditLog)
            .where(MetadataFieldAuditLog.document_id == document_id, MetadataFieldAuditLog.metadata_field_id.in_(metadata_ids))
            .order_by(MetadataFieldAuditLog.changed_at, MetadataFieldAuditLog.id)
        ):
            entries.append({
                "action": row.action, "previous_value": row.previous_value, "new_value": row.new_value,
                "previous_status": row.previous_status, "new_status": row.new_status, "reason": row.reason,
                "by": row.changed_by, "at": row.changed_at.isoformat() if row.changed_at else None,
                "source": "extraction",
            })
    review = database.scalar(
        select(StructureRecordReview).where(
            StructureRecordReview.document_id == document_id, StructureRecordReview.record_key == record_key
        )
    )
    if review is not None:
        for earlier in review.history or []:
            entries.append({
                "action": earlier.get("status"), "previous_value": None, "new_value": earlier.get("value"),
                "previous_status": None, "new_status": earlier.get("status"), "reason": earlier.get("reason"),
                "by": earlier.get("actor"), "at": earlier.get("at"), "source": "structure",
            })
        entries.append({
            "action": review.status, "previous_value": review.original_value, "new_value": review.reviewed_value,
            "previous_status": None, "new_status": review.status, "reason": review.reason, "by": review.actor_name,
            "at": review.updated_at.isoformat() if review.updated_at else None, "source": "structure",
        })
    return {"record_key": record_key, "entries": entries}
