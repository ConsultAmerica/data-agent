"""Whole-document comparison (mounted at /api/compare)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.core.auth import ActorContext, require_permission
from app.core.document_access import require_document_access
from app.database.dependencies import get_database
from app.services.document_compare import compare_documents

router = APIRouter()


# Plain function: FastAPI runs it in the thread pool, so a generic
# document's workbook build never blocks the event loop.
@router.get("")
def compare(
    left: str = Query(..., min_length=1),
    right: str = Query(..., min_length=1),
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict:
    if left == right:
        raise HTTPException(status_code=400, detail="Choose two different documents to compare.")
    for document_id in (left, right):
        # 404s a document outside the caller's workspace; None means the id
        # is not a processed document (missing, or only a staged upload).
        if require_document_access(database, actor, document_id) is None:
            raise HTTPException(status_code=404, detail="Document not found.")
    return compare_documents(database, left, right)
