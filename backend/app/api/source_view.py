"""Structured source views for the review workspace's format viewers.

GET /{document_id}/source-view                 — which viewer, plus its content
GET /{document_id}/source-view/sheets/{index}  — one spreadsheet sheet's cells

Workspace isolation is enforced by the router dependency
(core/document_access.py); every route also needs documents.view.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from sqlalchemy.orm import Session

from app.core.auth import ActorContext, require_permission
from app.core.config import get_settings
from app.database.dependencies import get_database
from app.models.document import Document
from app.services.document_storage import DocumentStorageError, ensure_local_copy
from app.source_view import service

router = APIRouter()


def _source(database: Session, document_id: str) -> tuple[Document, Path]:
    document = database.get(Document, document_id)
    if document is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    try:
        path = ensure_local_copy(get_settings(), stored_filename=document.stored_filename)
    except DocumentStorageError as exc:
        raise HTTPException(status_code=404, detail="The source file is not available.") from exc
    return document, path


def _build(viewer: dict[str, Any], path: Path) -> dict[str, Any]:
    fmt = viewer["format"]
    kind = viewer["viewer"]
    if kind == "spreadsheet":
        return service.spreadsheet_summary(path, fmt)
    if kind == "delimited":
        return service.delimited_view(path)
    if kind == "json":
        return service.json_view(path)
    if kind == "xml":
        return service.xml_view(path)
    if kind == "word":
        return service.word_view(path)
    return {}


@router.get("/{document_id}/source-view")
async def get_source_view(
    document_id: str,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict[str, Any]:
    """The viewer for this document and the content it shows. PDF, image
    and text documents keep using the page and page-text endpoints."""

    document, path = _source(database, document_id)
    viewer = service.resolve_viewer(document.stored_filename, path)
    try:
        content = await run_in_threadpool(_build, viewer, path)
    except service.SourceViewError as exc:
        # The structured view isn't available; the page text still is.
        return {**viewer, "viewer": "text", "note": str(exc), "page_count": document.page_count}
    return {**viewer, "page_count": document.page_count, **content}


@router.get("/{document_id}/source-view/sheets/{index}")
async def get_source_sheet(
    document_id: str,
    index: int,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict[str, Any]:
    document, path = _source(database, document_id)
    viewer = service.resolve_viewer(document.stored_filename, path)
    if viewer["viewer"] != "spreadsheet":
        raise HTTPException(status_code=422, detail="The document is not a spreadsheet.")
    try:
        return await run_in_threadpool(service.spreadsheet_sheet, path, viewer["format"], index)
    except service.SourceViewError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
