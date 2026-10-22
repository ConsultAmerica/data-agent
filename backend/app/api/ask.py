"""DataoAI (mounted at /api/ask)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import ActorContext, require_permission
from app.core.document_access import require_document_access, scope_documents
from app.database.dependencies import get_database
from app.models.document import Document
from app.services.ask_engine import answer_question

router = APIRouter()


class AskRequest(BaseModel):
    question: str = Field(..., min_length=1, max_length=1000)
    document_id: str | None = None


# Plain function: FastAPI runs it in the thread pool, so loading workbooks
# and page text never blocks the event loop.
@router.post("")
def ask(
    payload: AskRequest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict:
    question = payload.question.strip()
    if not question:
        raise HTTPException(status_code=422, detail="Ask a question.")
    if payload.document_id and require_document_access(database, actor, payload.document_id) is None:
        raise HTTPException(status_code=404, detail="Document not found.")
    visible = scope_documents(select(Document.id), actor)
    return answer_question(database, visible, question, document_id=payload.document_id)
