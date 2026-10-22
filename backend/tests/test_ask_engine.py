from __future__ import annotations

import secrets

from datetime import date, datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.api.ask import router
from app.core.config import get_settings
from app.database.session import SessionLocal
from app.models.document import Document
from app.models.document_clause_reference import DocumentClauseReference
from app.models.document_page import DocumentPage
from app.services import ask_engine
from app.services.ask_engine import answer_question, chunk_page, parse_question, rank_passages

api = FastAPI()
api.include_router(router, prefix="/api/ask")
client = TestClient(api)

CONTRACT_PAGE_9 = """SECTION I - CONTRACT CLAUSES
52.204-21 Basic Safeguarding of Covered Contractor Information Systems (NOV 2021)
(a) Definitions. As used in this clause, covered contractor information system means an information system.
(b) Safeguarding requirements. The Contractor shall apply basic safeguarding requirements and procedures.
252.204-7012 Safeguarding Covered Defense Information and Cyber Incident Reporting (MAY 2024)
(c) Cyber incident reporting requirement. The Contractor shall rapidly report cyber incidents to DoD
within 72 hours of discovery of any cyber incident.
52.249-2 Termination for Convenience of the Government (Fixed-Price) (APR 2012)
The Government may terminate performance of work under this contract in whole or in part.
"""

CONTRACT_PAGE_12 = """SECTION G - CONTRACT ADMINISTRATION DATA
G.1 Invoicing. Payment requests shall be submitted electronically through Wide Area WorkFlow (WAWF).
The certificate of insurance shall provide thirty (30) days written notice to the Contracting Officer.
"""


def _document(database, name: str, workspace: str | None = None) -> str:
    document_id = str(uuid4())
    database.add(Document(
        id=document_id, original_filename=name, stored_filename=f"{document_id}.pdf",
        content_type="application/pdf", size_bytes=100, checksum_sha256=uuid4().hex, page_count=12,
        encrypted=False, status="ready", processing_status="completed", document_type="Government Contract",
        uploaded_at=datetime(2026, 9, 1, tzinfo=timezone.utc), owner_workspace=workspace,
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


def _clause(document_id: str, index: int, number: str, title: str, page: int, family: str = "FAR"):
    return DocumentClauseReference(
        document_id=document_id, row_index=index, clause_family=family, citation_context="listing",
        clause_number=number, title=title, confidence=0.9,
        evidence_json={"page_number": page, "source_text": f"{number} {title}"},
    )


class _StubFacts:
    def __init__(self, values: dict[str, tuple[str, int]]):
        self.values = values

    def fact(self, *labels):
        for label in labels:
            if label in self.values:
                value, page = self.values[label]
                return SimpleNamespace(value=value, page=page)
        return SimpleNamespace(value=None, page=None)


@pytest.fixture
def corpus():
    ask_engine._chunk_cache.clear()
    ask_engine._contract_cache.clear()
    database = SessionLocal()
    ids: list[str] = []
    try:
        contract = _document(database, "award.pdf")
        report = _document(database, "fy2025-report.pdf")
        ids = [contract, report]
        database.flush()
        database.add_all([
            _page(contract, 9, CONTRACT_PAGE_9),
            _page(contract, 12, CONTRACT_PAGE_12),
            _page(report, 1, "FY2025 Financial Report. Operating expenses were 12500000. Revenue was 42000000."),
            _clause(contract, 0, "52.204-21", "Basic Safeguarding of Covered Contractor Information Systems    NOV 2021", 9),
            _clause(contract, 1, "252.204-7012", "Safeguarding Covered Defense Information and Cyber Incident Reporting", 9, "DFARS"),
            _clause(contract, 2, "52.249-2", "Termination for Convenience of the Government (Fixed-Price)", 9),
            _clause(contract, 3, "52.222-12", "Contract Termination-Debarment            MAY 2014", 9),
            _clause(contract, 4, "252.232-7006", "Wide Area WorkFlow Payment Instructions", 12, "DFARS"),
        ])
        database.commit()
        yield database, contract, report
    finally:
        for document_id in ids:
            document = database.get(Document, document_id)
            if document is not None:
                database.delete(document)
        database.commit()
        database.close()


def _scope(*ids):
    return select(Document.id).where(Document.id.in_(list(ids)))


def test_parses_clause_numbers_shorthand_fields_and_windows():
    explicit = parse_question("Does it include DFARS 252.204-7012?")
    assert explicit.clause_numbers == ["252.204-7012"] and explicit.clause_numbers_explicit

    shorthand = parse_question("What are the cybersecurity requirements?")
    assert "252.204-7012" in shorthand.clause_numbers and not shorthand.clause_numbers_explicit
    assert shorthand.wants_clauses

    fields = parse_question("Who is the contractor and what is the award amount?")
    labels = [label for group in fields.field_groups for label, _ in group]
    assert "Contractor" in labels and "Award Amount" in labels

    window = parse_question("What obligations are due in the next 90 days?")
    assert window.obligations and window.within_days == 90

    listing = parse_question("List DFARS clauses")
    assert listing.clause_family == "DFARS"


def test_chunks_split_on_clause_boundaries_not_mid_clause():
    chunks = chunk_page("d", 9, CONTRACT_PAGE_9)
    by_clause = {number: chunk for chunk in chunks for number in chunk.clause_numbers}
    # Each clause starts its own chunk, and its subparagraphs stay with it.
    assert "72 hours" in by_clause["252.204-7012"].text
    assert "72 hours" not in by_clause["52.249-2"].text
    assert all(chunk.page == 9 for chunk in chunks)


def test_exact_clause_number_outranks_word_overlap():
    chunks = chunk_page("d", 9, CONTRACT_PAGE_9)
    ranked = rank_passages(chunks, ["safeguarding", "252.204-7012"], ["252.204-7012"], 3)
    assert "252.204-7012" in ranked[0][1].clause_numbers


def test_clause_question_cites_page_and_reports_absence(corpus):
    database, contract, report = corpus
    result = answer_question(database, _scope(contract, report), "Which contracts include DFARS 252.204-7012?")
    assert result["answer_type"] == "clauses"
    present = [m for m in result["clause_matches"] if m["present"]]
    absent = [m for m in result["clause_matches"] if not m["present"]]
    assert [m["document_name"] for m in present] == ["award.pdf"]
    assert [m["document_name"] for m in absent] == ["fy2025-report.pdf"]
    citation = result["citations"][present[0]["citation"] - 1]
    assert citation["page"] == 9
    assert citation["href"].startswith(f"/documents/{contract}?view=source&page=9")
    assert "[1]" in result["answer"]


def test_topic_question_matches_clause_titles_and_cleans_dates(corpus):
    database, contract, report = corpus
    result = answer_question(database, _scope(contract, report), "Summarize termination clauses")
    numbers = {m["clause_number"] for m in result["clause_matches"] if m["present"]}
    assert {"52.249-2", "52.222-12"} <= numbers
    titles = {m["clause_number"]: m["title"] for m in result["clause_matches"]}
    assert titles["52.222-12"] == "Contract Termination-Debarment"


def test_field_question_reads_staging_facts_with_citations(corpus):
    database, contract, report = corpus
    stub = _StubFacts({
        "Contractor": ("ACME FEDERAL LLC\n100 Main St\nAnchorage AK", 2),
        "Award Amount": ("$600,000,000.00", 2),
    })
    with patch.object(ask_engine, "_contract_data", lambda db, doc_id: stub if doc_id == contract else _StubFacts({})):
        result = answer_question(
            database, _scope(contract, report), "Who is the contractor and what is the award amount?",
            document_id=contract,
        )
    assert result["answer_type"] == "fields"
    assert result["scope"]["document_name"] == "award.pdf"
    # The sentence names the company; the fact keeps the address.
    assert "ACME FEDERAL LLC[" in result["answer"] and "Main St" not in result["answer"]
    contractor = next(f for f in result["facts"] if f["label"] == "Contractor")
    assert "Anchorage" in contractor["value"] and contractor["page"] == 2


def test_obligation_window_filters_by_due_date(corpus):
    database, contract, report = corpus
    items = [
        {"document_id": contract, "document_name": "award.pdf", "title": "File VETS-4212 report",
         "due_date": "2026-11-30", "status": "upcoming", "page": 9, "evidence": "VETS-4212"},
        {"document_id": contract, "document_name": "award.pdf", "title": "Base period ends",
         "due_date": "2028-09-28", "status": "upcoming", "page": 7, "evidence": "POP"},
    ]
    with patch("app.services.obligations.build_document_obligations",
               lambda db, doc_id, today=None: items if doc_id == contract else []):
        result = answer_question(
            database, _scope(contract, report), "What obligations are due in the next 90 days?",
            today=date(2026, 10, 21),
        )
    assert [o["title"] for o in result["obligations"]] == ["File VETS-4212 report"]
    assert result["answer"].startswith("Found 1 obligation in the next 90 days")


def test_free_text_question_falls_back_to_passages(corpus):
    database, contract, report = corpus
    result = answer_question(database, _scope(contract, report), "insurance cancellation notice")
    assert result["answer_type"] == "passages"
    assert result["passages"][0]["document_name"] == "award.pdf"
    assert result["passages"][0]["page"] == 12
    assert result["answer"].startswith("The closest match is on page 12 of award.pdf[1]")


def test_unanswerable_question_says_so(corpus):
    database, contract, report = corpus
    result = answer_question(database, _scope(contract, report), "zebra migration patterns")
    assert result["answer_type"] == "none"
    assert result["citations"] == []
    assert result["suggestions"]


def test_api_validates_question_and_hides_foreign_documents(corpus):
    database, contract, report = corpus
    assert client.post("/api/ask", json={"question": "   "}).status_code == 422
    foreign = _document(database, "foreign.pdf", workspace="someone-else")
    database.commit()
    try:
        settings = get_settings().model_copy(update={"rbac_enforced": True, "public_workspace_access": True})
        with patch("app.core.auth.get_settings", return_value=settings):
            response = client.post(
                "/api/ask", json={"question": "termination", "document_id": foreign},
                headers={"X-Workspace-Token": secrets.token_hex(32)},
            )
        assert response.status_code == 404
    finally:
        database.delete(database.get(Document, foreign))
        database.commit()


def test_unprocessed_document_says_so_instead_of_not_found(corpus):
    database, contract, report = corpus
    empty = _document(database, "debug-upload.pdf")
    database.commit()
    try:
        result = answer_question(
            database, _scope(contract, report, empty), "Which contracts include DFARS 252.204-7012?",
            document_id=empty,
        )
        assert result["unprocessed"] is True
        assert result["answer_type"] == "none"
        assert result["answer"].startswith("debug-upload.pdf has no extracted text yet")
        assert result["clause_matches"] == []
    finally:
        database.delete(database.get(Document, empty))
        database.commit()
