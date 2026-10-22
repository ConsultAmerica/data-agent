"""Whole-document compare (services/document_compare.py, api/document_compare.py)."""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.document_compare import router
from app.core.config import get_settings
from app.database.session import SessionLocal
from app.models.document import Document
from app.models.document_clause_reference import DocumentClauseReference
from app.models.document_contract_summary import DocumentContractSummary
from app.models.document_funding_line import DocumentFundingLine
from app.models.document_line_item import DocumentLineItem
from app.models.document_performance_period import DocumentPerformancePeriod
from app.services.document_compare import compare_documents, normalize_clause_number

api = FastAPI()
api.include_router(router, prefix="/api/compare")
client = TestClient(api)


def _document(database, name: str, workspace: str | None = None) -> str:
    document_id = str(uuid4())
    database.add(
        Document(
            id=document_id,
            original_filename=name,
            stored_filename=f"{document_id}.pdf",
            content_type="application/pdf",
            size_bytes=100,
            checksum_sha256=uuid4().hex,
            page_count=2,
            encrypted=False,
            status="ready",
            processing_status="completed",
            document_type="Government Contract",
            uploaded_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
            owner_workspace=workspace,
        )
    )
    return document_id


def _clause(document_id: str, index: int, number: str, title: str, effective: str | None = None):
    return DocumentClauseReference(
        document_id=document_id, row_index=index, clause_family="FAR", citation_context="listing",
        clause_number=number, title=title, effective_date=effective, confidence=0.9, evidence_json={},
    )


def _line(document_id: str, index: int, clin: str, **values):
    return DocumentLineItem(
        document_id=document_id, row_index=index, clin=clin, description=values.pop("description", "Services"),
        is_maximum=False, confidence=0.9, evidence_json={}, **values,
    )


@pytest.fixture
def pair():
    database = SessionLocal()
    ids: list[str] = []
    try:
        base = _document(database, "base-award.pdf")
        mod = _document(database, "modification-01.pdf")
        ids = [base, mod]
        database.flush()
        database.add_all([
            DocumentContractSummary(document_id=base, contract_number="W912ZZ26C0042", contractor="Acme Corp",
                                    award_date="04/15/2025", ceiling_max_aggregate="$1,000,000.00",
                                    field_provenance_json={}, confidence=0.9),
            DocumentContractSummary(document_id=mod, contract_number="W912ZZ26C0042", contractor="ACME  corp",
                                    award_date="2025-04-15", ceiling_max_aggregate="$1,250,000.00",
                                    field_provenance_json={}, confidence=0.9),
            _line(base, 0, "0001", quantity=10, unit="EA", unit_price=100.0, amount=1000.0),
            _line(base, 1, "0002", quantity=1, unit="LO", amount=500.0),
            _line(mod, 0, "0001", quantity=12, unit="EA", unit_price=100.0, amount=1200.0),
            _line(mod, 1, "0003", quantity=1, unit="LO", amount=750.0, description="Option year"),
            _clause(base, 0, "52.204-7", "System for Award Management", "OCT 2018"),
            _clause(base, 1, "52.204-7", "System for Award Management", "OCT 2018"),
            _clause(base, 2, "52.217-9", "Option to Extend the Term"),
            _clause(mod, 0, "FAR 52.204- 7", "System for Award Management", "OCT 2018"),
            _clause(mod, 1, "52.232-40", "Accelerated Payments"),
            DocumentFundingLine(document_id=base, row_index=0, acrn="AA", amount=1000.0, confidence=0.9, evidence_json={}),
            DocumentFundingLine(document_id=mod, row_index=0, acrn="AA", amount=1500.0, confidence=0.9, evidence_json={}),
            DocumentPerformancePeriod(document_id=base, row_index=0, period_label="Base Period",
                                      start_date="2025-05-01", end_date="2026-04-30", confidence=0.9, evidence_json={}),
            DocumentPerformancePeriod(document_id=mod, row_index=0, period_label="Base Period",
                                      start_date="2025-05-01", end_date="2026-05-30", confidence=0.9, evidence_json={}),
        ])
        database.commit()
        yield database, base, mod
    finally:
        for document_id in ids:
            document = database.get(Document, document_id)
            if document is not None:
                database.delete(document)
        database.commit()
        database.close()


def _rows(result: dict, section_id: str) -> dict[str, dict]:
    section = next(s for s in result["sections"] if s["section_id"] == section_id)
    return {row["key"]: row for row in section["rows"]}


def test_normalizes_clause_numbers():
    assert normalize_clause_number("FAR 52.204- 7") == "52.204-7"
    assert normalize_clause_number("DFARS 252.204-7012") == "252.204-7012"


def test_summary_ignores_formatting_and_reports_money_delta(pair):
    database, base, mod = pair
    rows = _rows(compare_documents(database, base, mod), "contract_summary")
    assert rows["contract_number"]["change"] == "unchanged"
    assert rows["contractor"]["change"] == "unchanged"  # case + whitespace only
    assert rows["award_date"]["change"] == "unchanged"  # same date, other format
    ceiling = rows["ceiling_max_aggregate"]
    assert ceiling["change"] == "changed" and ceiling["detail"] == "+$250,000.00"


def test_line_items_keyed_by_clin(pair):
    database, base, mod = pair
    rows = _rows(compare_documents(database, base, mod), "line_items")
    assert rows["0001.quantity"]["change"] == "changed"
    assert rows["0001.quantity"]["detail"] == "+2 units"
    assert rows["0001.amount"]["detail"] == "+$200.00"
    assert "0001.unit_price" not in rows or rows["0001.unit_price"]["change"] == "unchanged"
    assert rows["0002"]["change"] == "removed"
    assert rows["0003"]["change"] == "added"
    assert "Option year" in rows["0003"]["right"]


def test_clauses_dedupe_and_detect_added_removed(pair):
    database, base, mod = pair
    rows = _rows(compare_documents(database, base, mod), "clauses")
    assert rows["52.204-7"]["change"] == "unchanged"
    assert rows["52.217-9"]["change"] == "removed"
    assert rows["52.232-40"]["change"] == "added"
    assert not any("(2)" in key for key in rows)


def test_funding_periods_and_summary_counts(pair):
    database, base, mod = pair
    result = compare_documents(database, base, mod)
    assert _rows(result, "funding")["AA.amount"]["detail"] == "+$500.00"
    assert _rows(result, "performance_periods")["Base Period.end_date"]["detail"] == "+30 days"
    total = sum(len(section["rows"]) for section in result["sections"])
    assert sum(result["summary"].values()) == total
    assert result["left"]["name"] == "base-award.pdf"
    assert {s["section_id"] for s in result["sections"]} >= {"contract_summary", "line_items", "clauses", "funding"}


def test_api_compares_and_validates(pair):
    _, base, mod = pair
    response = client.get("/api/compare", params={"left": base, "right": mod})
    assert response.status_code == 200, response.text
    assert response.json()["right"]["document_id"] == mod

    assert client.get("/api/compare", params={"left": base, "right": base}).status_code == 400
    assert client.get("/api/compare", params={"left": base, "right": str(uuid4())}).status_code == 404


def test_api_hides_another_workspaces_document(pair):
    database, base, _ = pair
    foreign = _document(database, "foreign.pdf", workspace="someone-else")
    database.commit()
    settings = get_settings().model_copy(update={"rbac_enforced": True, "public_workspace_access": True})
    try:
        with patch("app.core.auth.get_settings", return_value=settings):
            response = client.get(
                "/api/compare",
                params={"left": base, "right": foreign},
                headers={"X-Workspace-Token": secrets.token_hex(32)},
            )
        assert response.status_code == 404
    finally:
        database.delete(database.get(Document, foreign))
        database.commit()
