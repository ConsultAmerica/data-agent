"""Contract Insights Search (mounted at /api/search)."""

from __future__ import annotations

from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import ActorContext, require_permission
from app.core.document_access import scope_documents
from app.database.dependencies import get_database
from app.models.document import Document
from app.services.insights_search import MAX_LIMIT, SearchFilters, search_insights

router = APIRouter()


class InsightsFilters(BaseModel):
    document_types: list[str] = Field(default_factory=list)
    families: list[str] = Field(default_factory=list)
    statuses: list[str] = Field(default_factory=list)
    clause_families: list[str] = Field(default_factory=list)
    has_clauses: list[str] = Field(default_factory=list)
    years: list[str] = Field(default_factory=list)
    uploaded_from: date | None = None
    uploaded_to: date | None = None


class InsightsRequest(BaseModel):
    q: str = Field("", max_length=1000)
    filters: InsightsFilters = Field(default_factory=InsightsFilters)
    sort: Literal["relevance", "newest"] = "relevance"
    limit: int = Field(20, ge=1, le=MAX_LIMIT)
    offset: int = Field(0, ge=0)


# Plain function: FastAPI runs it in the thread pool, so reading page text
# and workbooks never blocks the event loop.
@router.post("/insights")
def insights(
    payload: InsightsRequest,
    database: Session = Depends(get_database),
    actor: ActorContext = Depends(require_permission("documents.view")),
) -> dict:
    visible = scope_documents(select(Document.id), actor)
    return search_insights(
        database,
        visible,
        q=payload.q,
        filters=SearchFilters(**payload.filters.model_dump()),
        sort=payload.sort,
        limit=payload.limit,
        offset=payload.offset,
    )
