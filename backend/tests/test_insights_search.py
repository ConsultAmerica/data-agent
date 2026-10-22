from __future__ import annotations

import secrets
from datetime import date, datetime, timezone
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.insights_search import router
from app.core.config import get_settings
from app.database.session import SessionLocal
from app.models.document import Document
from app.models.document_clause_reference import DocumentClauseReference
from app.models.document_page import DocumentPage
from app.services import ask_engine
from app.services.insights_search import (
    SearchFilters,
    base_clause_number,
    highlight_spans,
    search_insights,
)

api = FastAPI()
api.include_router(router, prefix="/api/search")
client = TestClient(api)

CONTRACT_TEXT = """SECTION I - CONTRACT CLAUSES
252.204-7012 Safeguarding Covered Defense Information and Cyber Incident Reporting (MAY 2024)
(c) The Contractor shall rapidly report cyber incidents to DoD within 72 hours of discovery.
52.249-2 Termination for Convenience of the Government (Fixed-Price) (APR 2012)
The Government may terminate performance of work under this contract in whole or in part.
"""

# Mentions the words many times but cites no clause.
MEMO_TEXT = """Memo on cyber incident reporting. Cyber incident reporting matters; cyber incident
reporting is discussed at length. Cyber incident reporting, cyber incident reporting."""


def _document(database, name: str, uploaded: datetime, workspace: str | None = None) -> str:
    document_id = str(uuid4())
    database.add(Document(
        id=document_id, original_filename=name, stored_filename=f"{document_id}.pdf",
        content_type="application/pdf", size_bytes=100, checksum_sha256=uuid4().hex, page_count=1,
        encrypted=False, status="ready", processing_status="completed", document_type="Government Contract",
        uploaded_at=uploaded, owner_workspace=workspace,
    ))
    return document_id


def _page(document_id: str, number: int, text: str) -> DocumentPage:
    return DocumentPage(
        document_id=document_id, page_number=number, native_text=text, final_text=text,
        has_tables=False, has_form_fields=False, is_scanned=False, text_length=len(text),
        extraction_method="native", requires_ocr=False, ocr_attempted=False, ocr_succeeded=False,
        character_count=len(text), word_count=len(text.split()), text_block_count=1, image_count=0,
        text_coverage_ratio=1.0, image_coverage_ratio=0.0, page_width=612.0, page_height=792.0,
        extraction_status="completed",
    )


def _clause(document_id: str, index: int, number: str, title: str, family: str, page: int):
    return DocumentClauseReference(
        document_id=document_id, row_index=index, clause_family=family, citation_context="listing",
        clause_number=number, title=title, confidence=0.9,
        evidence_json={"page_number": page, "source_text": f"{number} {title}"},
    )


@pytest.fixture
def corpus():
    ask_engine._chunk_cache.clear()
    database = SessionLocal()
    ids: list[str] = []
    try:
        contract = _document(database, "award.pdf", datetime(2025, 3, 1, tzinfo=timezone.utc))
        memo = _document(database, "cyber-memo.pdf", datetime(2026, 5, 1, tzinfo=timezone.utc))
        blank = _document(database, "blank-scan.pdf", datetime(2026, 6, 1, tzinfo=timezone.utc))
        ids = [contract, memo, blank]
        database.flush()
        database.add_all([
            _page(contract, 9, CONTRACT_TEXT),
            _page(memo, 1, MEMO_TEXT),
            _clause(contract, 0, "252.204-7012", "Safeguarding Covered Defense Information and Cyber Incident Reporting", "DFARS", 9),
            _clause(contract, 1, "52.249-2 Alt I", "Termination for Convenience of the Government (Fixed-Price)", "FAR", 9),
        ])
        database.commit()
        yield database, contract, memo, blank
    finally:
        for document_id in ids:
            document = database.get(Document, document_id)
            if document is not None:
                database.delete(document)
        database.commit()
        database.close()


def _scope(*ids):
    return select(Document.id).where(Document.id.in_(list(ids)))


def test_base_clause_number_drops_alternates():
    assert base_clause_number("52.249-2 Alt I") == "52.249-2"
    assert base_clause_number("252.204-7012") == "252.204-7012"


def test_highlight_offsets_cover_terms_and_clause_numbers():
    snippet = "See 252.204-7012: report Cyber incidents; cyberspace is not a match."
    spans = highlight_spans(snippet, ["cyber", "report"], ["252.204-7012"])
    assert [snippet[start:end] for start, end in spans] == ["252.204-7012", "report", "Cyber"]


def test_browse_mode_lists_everything_newest_first(corpus):
    database, contract, memo, blank = corpus
    result = search_insights(database, _scope(contract, memo, blank))
    assert [r["document_name"] for r in result["results"]] == ["blank-scan.pdf", "cyber-memo.pdf", "award.pdf"]
    assert result["total"] == 3
    assert all(r["score"] is None for r in result["results"])


def test_exact_clause_number_outranks_word_repetition(corpus):
    database, contract, memo, blank = corpus
    result = search_insights(database, _scope(contract, memo, blank), "252.204-7012 cyber incident reporting")
    names = [r["document_name"] for r in result["results"]]
    assert names[0] == "award.pdf" and "cyber-memo.pdf" in names
    top = result["results"][0]
    assert top["score"] == 1.0
    assert [c["clause_number"] for c in top["matched_clauses"]] == ["252.204-7012"]
    passage = top["passages"][0]
    assert passage["page"] == 9
    assert passage["href"].startswith(f"/documents/{contract}?view=source&page=9&hl=")
    assert "252.204-7012" in [passage["snippet"][a:b] for a, b in passage["highlights"]]


def test_alternate_suffix_still_matches_clause_number(corpus):
    database, contract, memo, blank = corpus
    result = search_insights(database, _scope(contract, memo, blank), "52.249-2")
    assert [c["clause_number"] for c in result["results"][0]["matched_clauses"]] == ["52.249-2 Alt I"]
    filtered = search_insights(database, _scope(contract, memo, blank), filters=SearchFilters(has_clauses=["52.249-2"]))
    assert [r["document_name"] for r in filtered["results"]] == ["award.pdf"]


def test_facets_ignore_their_own_filter(corpus):
    database, contract, memo, blank = corpus
    result = search_insights(
        database, _scope(contract, memo, blank), filters=SearchFilters(clause_families=["DFARS"], years=["2025"]),
    )
    assert [r["document_name"] for r in result["results"]] == ["award.pdf"]
    # The year facet ignores the year filter (only the DFARS filter applies)...
    assert {item["value"]: item["count"] for item in result["facets"]["years"]} == {"2025": 1}
    # ...and the clause-family facet ignores the clause-family filter.
    assert {item["value"] for item in result["facets"]["clause_families"]} == {"DFARS", "FAR"}
    browse = search_insights(database, _scope(contract, memo, blank), filters=SearchFilters(years=["2026"]))
    assert {item["value"]: item["count"] for item in browse["facets"]["years"]} == {"2026": 2, "2025": 1}
    assert browse["total"] == 2


def test_date_range_and_metadata_only_match(corpus):
    database, contract, memo, blank = corpus
    ranged = search_insights(
        database, _scope(contract, memo, blank),
        filters=SearchFilters(uploaded_from=date(2026, 1, 1), uploaded_to=date(2026, 5, 31)),
    )
    assert [r["document_name"] for r in ranged["results"]] == ["cyber-memo.pdf"]
    # A document without page text still matches on its name.
    by_name = search_insights(database, _scope(contract, memo, blank), "blank scan")
    assert [r["document_name"] for r in by_name["results"]] == ["blank-scan.pdf"]
    assert by_name["results"][0]["passages"] == []


def test_api_scopes_to_the_callers_workspace(corpus):
    database, contract, memo, blank = corpus
    foreign = _document(database, "foreign-cyber.pdf", datetime(2026, 1, 1, tzinfo=timezone.utc), workspace="someone-else")
    database.add(_page(foreign, 1, MEMO_TEXT))
    database.commit()
    try:
        settings = get_settings().model_copy(update={"rbac_enforced": True, "public_workspace_access": True})
        with patch("app.core.auth.get_settings", return_value=settings):
            response = client.post(
                "/api/search/insights", json={"q": "cyber incident"},
                headers={"X-Workspace-Token": secrets.token_hex(32)},
            )
        assert response.status_code == 200
        assert "foreign-cyber.pdf" not in [r["document_name"] for r in response.json()["results"]]
        assert client.post("/api/search/insights", json={"q": "x", "limit": 500}).status_code == 422
    finally:
        database.delete(database.get(Document, foreign))
        database.commit()
