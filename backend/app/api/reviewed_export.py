"""Reviewed-value export and Oracle payload preview / send APIs."""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.downloads import attachment_header
from app.core.auth import ActorContext, require_permission
from app.core.config import get_settings
from app.core.observability import get_request_id
from app.database.dependencies import get_database
from app.models.document import Document
from app.models.document_metadata_field import DocumentMetadataField
from app.models.document_page import DocumentPage
from app.models.integration_audit_log import IntegrationAuditLog
from app.services.reviewed_export import (
    build_document_export,
    build_export_csv,
    build_export_xlsx,
    build_fields_wide_csv,
    build_line_items_csv,
    build_normalized_document,
    build_oracle_payload_preview,
)
from app.models.document_extracted_table import DocumentExtractedTable

router = APIRouter()


class OracleSendRequest(BaseModel):
    """Explicit confirmation is required — preview alone never sends."""

    confirm: bool = Field(
        ...,
        description="Must be true to authorize the send.",
    )


def _load_document_or_404(database: Session, document_id: str) -> Document:
    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    return document


def _load_fields(database: Session, document_id: str) -> list[DocumentMetadataField]:
    return list(
        database.scalars(
            select(DocumentMetadataField)
            .where(DocumentMetadataField.document_id == document_id)
            .order_by(DocumentMetadataField.id.asc())
        )
    )


def _load_page_text_by_number(
    database: Session, document_id: str
) -> dict[int, str]:
    """Best-effort section lookup source — cheap enough to always load,
    and missing pages simply mean no section gets attached, not an error."""

    rows = database.scalars(
        select(DocumentPage).where(DocumentPage.document_id == document_id)
    )
    return {row.page_number: row.final_text or "" for row in rows}


@router.get("/{document_id}/export")
async def export_document_json(
    document_id: str,
    authoritative_only: bool = Query(False),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("export.read")),
) -> dict:
    """Rich JSON export with extracted_value + effective value + review_status."""

    if authoritative_only and not actor.has("export.authoritative"):
        raise HTTPException(
            status_code=403,
            detail="Permission denied: export.authoritative",
        )

    document = _load_document_or_404(database, document_id)
    fields = _load_fields(database, document_id)
    if not fields:
        raise HTTPException(
            status_code=404,
            detail="No metadata fields found for this document.",
        )
    return build_document_export(
        document=document,
        fields=fields,
        authoritative_only=authoritative_only,
    )


@router.get("/{document_id}/normalized")
async def get_normalized_document(
    document_id: str,
    authoritative_only: bool = Query(False),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("export.read")),
) -> dict:
    """The canonical {document_id, fields, tables} record — the same
    source CSV/XLSX/UI already read from, reshaped for API consumers."""

    if authoritative_only and not actor.has("export.authoritative"):
        raise HTTPException(
            status_code=403,
            detail="Permission denied: export.authoritative",
        )

    document = _load_document_or_404(database, document_id)
    fields = _load_fields(database, document_id)
    tables = list(
        database.scalars(
            select(DocumentExtractedTable)
            .where(DocumentExtractedTable.document_id == document_id)
            .order_by(DocumentExtractedTable.id.asc())
        )
    )
    return build_normalized_document(
        document=document,
        fields=fields,
        tables=tables,
        authoritative_only=authoritative_only,
    )


@router.get("/{document_id}/export.csv")
async def export_document_csv(
    document_id: str,
    authoritative_only: bool = Query(False),
    format: str = Query(
        "wide",
        description="wide = field columns as headers (business); long = field/value rows (legacy).",
    ),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("export.read")),
) -> Response:
    """Business CSV — wide dataset by default (field names as columns)."""

    if authoritative_only and not actor.has("export.authoritative"):
        raise HTTPException(
            status_code=403,
            detail="Permission denied: export.authoritative",
        )

    document = _load_document_or_404(database, document_id)
    fields = _load_fields(database, document_id)
    if not fields:
        raise HTTPException(
            status_code=404,
            detail="No metadata fields found for this document.",
        )
    if format == "long":
        page_text_by_number = _load_page_text_by_number(database, document_id)
        csv_body = build_export_csv(
            fields,
            authoritative_only=authoritative_only,
            page_text_by_number=page_text_by_number,
        )
    else:
        csv_body = build_fields_wide_csv(
            fields, authoritative_only=authoritative_only
        )
    filename = f"{document.original_filename.rsplit('.', 1)[0]}-fields.csv"
    return Response(
        content=csv_body,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": attachment_header(filename),
        },
    )


@router.get("/{document_id}/export/line-items.csv")
async def export_line_items_csv(
    document_id: str,
    table_key: str | None = Query(
        None,
        description="Which detected table to export; defaults to the "
        "table with the most rows when the document has several.",
    ),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("export.read")),
) -> Response:
    """One line-item/CLIN table as its own rectangular CSV — real
    repeating rows, never document-level columns."""

    document = _load_document_or_404(database, document_id)
    tables = list(
        database.scalars(
            select(DocumentExtractedTable)
            .where(DocumentExtractedTable.document_id == document_id)
            .order_by(DocumentExtractedTable.id.asc())
        )
    )
    if not tables:
        raise HTTPException(
            status_code=404,
            detail="No line-item tables found for this document.",
        )
    csv_body = build_line_items_csv(tables, table_key=table_key)
    if not csv_body:
        raise HTTPException(
            status_code=404,
            detail=f"No table found for table_key={table_key!r}.",
        )
    filename = f"{document.original_filename.rsplit('.', 1)[0]}-line-items.csv"
    return Response(
        content=csv_body,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": attachment_header(filename),
        },
    )


@router.get("/{document_id}/export.xlsx")
async def export_document_xlsx(
    document_id: str,
    authoritative_only: bool = Query(False),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("export.read")),
) -> Response:
    """Complete Excel workbook: Document, Fields, tables, Source Evidence."""

    if authoritative_only and not actor.has("export.authoritative"):
        raise HTTPException(
            status_code=403,
            detail="Permission denied: export.authoritative",
        )

    document = _load_document_or_404(database, document_id)
    fields = _load_fields(database, document_id)
    if not fields:
        raise HTTPException(
            status_code=404,
            detail="No metadata fields found for this document.",
        )
    tables = list(
        database.scalars(
            select(DocumentExtractedTable)
            .where(DocumentExtractedTable.document_id == document_id)
            .order_by(DocumentExtractedTable.id.asc())
        )
    )
    page_text_by_number = _load_page_text_by_number(database, document_id)
    body = build_export_xlsx(
        document=document,
        fields=fields,
        tables=tables,
        authoritative_only=authoritative_only,
        page_text_by_number=page_text_by_number,
    )
    filename = f"{document.original_filename.rsplit('.', 1)[0]}-export.xlsx"
    return Response(
        content=body,
        media_type=(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ),
        headers={
            "Content-Disposition": attachment_header(filename),
        },
    )


@router.get("/{document_id}/oracle-payload")
async def oracle_payload_preview(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("oracle.preview")),
) -> dict:
    """Preview Oracle payload from authoritative fields only."""

    document = _load_document_or_404(database, document_id)
    fields = _load_fields(database, document_id)
    if not fields:
        raise HTTPException(
            status_code=404,
            detail="No metadata fields found for this document.",
        )
    settings = get_settings()
    preview = build_oracle_payload_preview(
        document=document,
        fields=fields,
        dry_run=bool(settings.oracle_dry_run),
    )
    preview["oracle_scope"] = _scope(database, document_id)
    # Send gate: preview never authorizes send by itself.
    preview["send_allowed"] = False
    preview["actor"] = {
        "actor_id": actor.id,
        "actor_type": actor.actor_type,
        "actor_role": actor.role,
        "can_send": actor.has("oracle.send"),
    }
    return preview


def _scope(database: Session, document_id: str) -> dict:
    from app.classification.service import current
    from app.services.reviewed_export import oracle_scope

    row = current(database, document_id)
    return oracle_scope(row.family if row is not None else None)


@router.post("/{document_id}/oracle-send")
async def oracle_send(
    document_id: str,
    payload: OracleSendRequest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("oracle.send")),
) -> dict:
    """Explicit Oracle send — requires permission, authoritative payload, confirm.

    1. Actor has ``oracle.send``
    2. Payload contains only accepted/edited effective values (no pending/rejected)
    3. ``confirm: true`` at send time

    Persists the exact request snapshot + simulated response for audit.
    """

    if not payload.confirm:
        raise HTTPException(
            status_code=400,
            detail="Explicit confirmation required: set confirm=true.",
        )

    document = _load_document_or_404(database, document_id)
    fields = _load_fields(database, document_id)
    if not fields:
        raise HTTPException(
            status_code=404,
            detail="No metadata fields found for this document.",
        )

    settings = get_settings()
    preview = build_oracle_payload_preview(
        document=document,
        fields=fields,
        dry_run=bool(settings.oracle_dry_run),
    )

    scope = _scope(database, document_id)
    if not scope["applicable"]:
        raise HTTPException(status_code=409, detail=scope["reason"])

    if preview["authoritative_count"] == 0:
        raise HTTPException(
            status_code=409,
            detail="No accepted/edited fields available to send.",
        )

    if preview["skipped_count"] > 0:
        raise HTTPException(
            status_code=409,
            detail=(
                "Payload still includes non-authoritative fields in the "
                "document review set. Accept or reject all pending fields "
                "before sending."
            ),
            # Note: skipped are excluded from contract_header; we still
            # require a clean document so pending data cannot leak later.
        )

    # Snapshot that was authorized for send (authoritative fields only).
    send_snapshot = {
        **preview,
        "mode": "send",
        "send_allowed": True,
        "confirmed_at": datetime.now(timezone.utc).isoformat(),
        "actor": {
            "actor_id": actor.id,
            "actor_type": actor.actor_type,
            "actor_role": actor.role,
            "display_name": actor.display_name,
        },
    }

    if settings.oracle_dry_run:
        response_snapshot = {
            "status": "simulated",
            "code": "ORA-200-OK-DRY-RUN",
            "message": (
                "Oracle dry-run: payload validated and audited; "
                "no external call made (oracle_dry_run=true)."
            ),
            "accepted_fields": preview["authoritative_count"],
        }
        action = "dry_run"
        status = "simulated"
    else:
        # Live HTTP to Oracle is intentionally not wired yet — refuse
        # rather than silently invent a success when dry_run is off.
        response_snapshot = {
            "status": "not_configured",
            "code": "ORA-NOT-CONFIGURED",
            "message": (
                "Live Oracle send is not configured. "
                "Set oracle_dry_run=true for simulated send, or wire "
                "the Fusion client before disabling dry-run."
            ),
        }
        database.add(
            IntegrationAuditLog(
                document_id=document_id,
                integration="oracle",
                action="send",
                status="rejected",
                request_snapshot=send_snapshot,
                response_snapshot=response_snapshot,
                actor_id=actor.id,
                actor_type=actor.actor_type,
                actor_role=actor.role,
                changed_by=actor.display_name,
                request_id=get_request_id(),
                detail="Live Oracle endpoint not configured",
            )
        )
        database.commit()
        raise HTTPException(
            status_code=501,
            detail=response_snapshot["message"],
        )

    audit = IntegrationAuditLog(
        document_id=document_id,
        integration="oracle",
        action=action,
        status=status,
        request_snapshot=send_snapshot,
        response_snapshot=response_snapshot,
        actor_id=actor.id,
        actor_type=actor.actor_type,
        actor_role=actor.role,
        changed_by=actor.display_name,
        request_id=get_request_id(),
        detail="Oracle dry-run send audited",
    )
    database.add(audit)
    database.commit()
    database.refresh(audit)

    return {
        "document_id": document_id,
        "integration_audit_id": audit.id,
        "status": status,
        "dry_run": True,
        "request_snapshot": send_snapshot,
        "response_snapshot": response_snapshot,
        "actor": {
            "actor_id": actor.id,
            "actor_type": actor.actor_type,
            "actor_role": actor.role,
        },
    }


@router.get("/{document_id}/integration-audit")
async def list_integration_audit(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("oracle.preview")),
) -> list[dict]:
    _load_document_or_404(database, document_id)
    rows = database.scalars(
        select(IntegrationAuditLog)
        .where(IntegrationAuditLog.document_id == document_id)
        .order_by(IntegrationAuditLog.id.desc())
    ).all()
    return [
        {
            "id": row.id,
            "integration": row.integration,
            "action": row.action,
            "status": row.status,
            "actor_id": row.actor_id,
            "actor_type": row.actor_type,
            "actor_role": row.actor_role,
            "changed_by": row.changed_by,
            "request_id": row.request_id,
            "request_snapshot": row.request_snapshot,
            "response_snapshot": row.response_snapshot,
            "created_at": row.created_at,
            "detail": row.detail,
        }
        for row in rows
    ]
