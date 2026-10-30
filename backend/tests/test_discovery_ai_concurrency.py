"""Schema discovery's two AI calls (document family, label enrichment) run
side by side and are both bounded; neither changes which fields are found."""

from __future__ import annotations

import asyncio
import time
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.config import get_settings
from app.database.session import SessionLocal
from app.main import app
from app.models.document import Document
from app.models.document_page import DocumentPage
from app.services.ai_provider import AIProvider, DisabledAIProvider
from app.services.schema_discovery import discover_document_schema
from contract_brief_fixture import contract_brief_pdf

client = TestClient(app)


class SlowProvider(AIProvider):
    """Stands in for a provider with known latency (seconds per call)."""

    provider_id = "slow-test"

    def __init__(self, *, classify_s: float, enrich_s: float, document_type: str = "Other", confidence: float = 0.0):
        self.classify_s, self.enrich_s = classify_s, enrich_s
        self.document_type, self.confidence = document_type, confidence
        self._disabled = DisabledAIProvider()

    async def classify(self, *, page_context: str) -> dict[str, Any]:
        await asyncio.sleep(self.classify_s)
        return {"document_type": self.document_type, "industry": None, "contract_side": "unknown", "language": None, "confidence": self.confidence}

    async def enrich_schema(self, *, targets_json: str, page_context: str) -> dict[str, Any]:
        await asyncio.sleep(self.enrich_s)
        return {"enrichments": [], "warnings": []}

    async def extract(self, **kwargs):
        return await self._disabled.extract(**kwargs)

    async def extract_fields(self, **kwargs):
        return await self._disabled.extract_fields(**kwargs)

    async def extract_clauses(self, **kwargs):
        return await self._disabled.extract_clauses(**kwargs)

    async def extract_signatures(self, **kwargs):
        return await self._disabled.extract_signatures(**kwargs)

    async def extract_structured_tables(self, **kwargs):
        return await self._disabled.extract_structured_tables(**kwargs)


@pytest.fixture(scope="module")
def stored() -> tuple[Document, list[DocumentPage]]:
    response = client.post("/api/documents/upload", files={"file": ("brief-ai.pdf", contract_brief_pdf(), "application/pdf")})
    document_id = response.json()["document_id"]
    assert client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False}).status_code == 200
    database = SessionLocal()
    document = database.get(Document, document_id)
    pages = list(database.scalars(select(DocumentPage).where(DocumentPage.document_id == document_id).order_by(DocumentPage.page_number)))
    return document, pages


def _discover(stored, provider) -> tuple[float, Any]:
    document, pages = stored
    started = time.perf_counter()
    result = asyncio.run(discover_document_schema(document=document, pages=pages, ai_provider=provider))
    return time.perf_counter() - started, result


def test_family_and_enrichment_run_side_by_side(stored, monkeypatch) -> None:
    monkeypatch.setattr(get_settings(), "ai_schema_enrichment_enabled", True)
    monkeypatch.setattr(get_settings(), "ai_schema_enrichment_budget_seconds", 5.0)
    elapsed, _ = _discover(stored, SlowProvider(classify_s=0.8, enrich_s=0.8))
    # One after the other would take 1.6s or more.
    assert elapsed < 1.4, elapsed


def test_a_hanging_family_call_is_cut_at_the_budget(stored, monkeypatch) -> None:
    monkeypatch.setattr(get_settings(), "ai_schema_enrichment_budget_seconds", 0.3)
    elapsed, result = _discover(stored, SlowProvider(classify_s=30, enrich_s=0))
    assert elapsed < 2.0, elapsed
    assert result.document_family in {"unknown", "generic_business"}


def test_the_ai_family_names_the_type_without_changing_the_fields(stored, monkeypatch) -> None:
    monkeypatch.setattr(get_settings(), "ai_schema_enrichment_budget_seconds", 5.0)
    _, without_ai = _discover(stored, DisabledAIProvider())
    _, with_ai = _discover(stored, SlowProvider(classify_s=0, enrich_s=0, document_type="Government Contract", confidence=0.9))
    assert with_ai.document_family == "government_contract"
    assert sorted(t.key for t in with_ai.targets) == sorted(t.key for t in without_ai.targets)
