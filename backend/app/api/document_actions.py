"""Agent action catalog API — one-click reports over a document.

Mounted under /api/documents with document-isolation enforced at the
router level (core/document_access.py). Reports are read-only views of the
persisted extraction, so reading them needs documents.view.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from app.api.downloads import attachment_header, excel_csv
from app.core.auth import ActorContext, require_permission
from app.core.document_access import workspace_scoped
from app.database.dependencies import get_database
from app.services.document_actions import (
    UnknownActionError,
    available_actions,
    render_csv,
    render_markdown,
    run_action,
)

router = APIRouter()


@router.get("/{document_id}/actions")
def list_document_actions(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> list[dict]:
    try:
        return available_actions(database, document_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.get("/{document_id}/actions/{action_id}", response_model=None)
def run_document_action(
    document_id: str,
    action_id: str,
    format: Literal["json", "csv", "md"] = Query("json"),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict | Response:
    workspace = actor.workspace if workspace_scoped(actor) else None
    try:
        result = run_action(database, document_id, action_id, workspace)
    except UnknownActionError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown action: {action_id}") from exc
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if format == "json":
        return result

    stem = Path(result["document_name"] or document_id).stem or document_id
    filename = f"{stem}-{action_id}.{format}"
    if format == "csv":
        content, media_type = excel_csv(render_csv(result)), "text/csv; charset=utf-8"
    else:
        content, media_type = render_markdown(result).encode("utf-8"), "text/markdown; charset=utf-8"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": attachment_header(filename)},
    )
