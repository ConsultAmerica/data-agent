"""Clause playbook: default rules evaluated against a document's extracted
clause citations, workspace overrides/custom rules, and the API."""

from __future__ import annotations

import secrets
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.api.playbook import document_router, router
from app.core.config import get_settings
from app.core.document_access import enforce_document_access
from app.database.session import SessionLocal
from app.models.clause_playbook_rule import ClausePlaybookRule
from app.models.document import Document
from app.models.document_clause_reference import DocumentClauseReference
from app.services.clause_playbook import (
    DEFAULT_RULES,
    effective_rules,
    evaluate_document,
    normalize_clause_number,
)

api = FastAPI()
api.include_router(router, prefix="/api/playbook")
api.include_router(document_router, prefix="/api/documents", dependencies=[Depends(enforce_document_access)])
client = TestClient(api)


@contextmanager
def enforced():
    settings = get_settings().model_copy(update={"rbac_enforced": True, "public_workspace_access": True})
    with patch("app.core.auth.get_settings", return_value=settings):
        yield


def _document(database, clauses: list[tuple[str, str]], owner: str | None = None) -> str:
    document_id = str(uuid4())
    database.add(
        Document(
            id=document_id,
            original_filename=f"contract-{document_id[:8]}.pdf",
            stored_filename=f"{document_id}.pdf",
            content_type="application/pdf",
            size_bytes=100,
            checksum_sha256=uuid4().hex,
            page_count=3,
            encrypted=False,
            status="ready",
            processing_status="completed",
            document_type="Government Contract",
            uploaded_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
            owner_workspace=owner,
        )
    )
    database.flush()
    for index, (number, context) in enumerate(clauses):
        database.add(
            DocumentClauseReference(
                document_id=document_id,
                row_index=index,
                clause_family="DFARS" if number.startswith("252") else "FAR",
                citation_context=context,
                clause_number=number,
                title="",
                confidence=0.9,
                evidence_json={"page_number": index + 2, "source_text": f"{number} cited"},
            )
        )
    database.commit()
    return document_id


@pytest.fixture(scope="module", autouse=True)
def _playbook_columns():
    # A test database created before the clause-library columns existed
    # keeps its old table under create_all; patch it like startup does.
    from app.database.playbook_columns import ensure_clause_playbook_rule_columns
    from app.database.session import engine

    ensure_clause_playbook_rule_columns(engine)


@pytest.fixture
def database():
    session = SessionLocal()
    session.execute(delete(ClausePlaybookRule).where(ClausePlaybookRule.owner_workspace.is_(None)))
    session.commit()
    try:
        yield session
    finally:
        session.execute(delete(ClausePlaybookRule).where(ClausePlaybookRule.owner_workspace.is_(None)))
        session.commit()
        session.close()


def _finding(result: dict, clause: str) -> dict | None:
    return next((item for item in result["findings"] if item["clause_number"] == clause), None)


def test_normalizes_clause_numbers():
    assert normalize_clause_number("FAR 52.204-30 Alternate 1") == "52.204-30"
    assert normalize_clause_number("DFARS 252.204-7012") == "252.204-7012"
    assert normalize_clause_number("552.216-75") == "552.216-75"
    assert normalize_clause_number("Section I") is None


def test_document_without_clauses_is_not_applicable(database):
    document_id = _document(database, [])
    result = evaluate_document(database, document_id, None)
    assert result["applicable"] is False
    assert result["findings"] == []


def test_required_missing_review_present_and_dod_scope(database):
    civilian = _document(database, [("52.204-25", "listing"), ("52.217-9", "listing"), ("552.204-21", "listing")])
    result = evaluate_document(database, civilian, None)
    assert result["applicable"] and not result["is_dod"]
    assert _finding(result, "52.204-25")["status"] == "satisfied"
    assert _finding(result, "52.204-25")["page"] == 2
    # GSAR 552.204-21 must not satisfy FAR 52.204-21.
    assert _finding(result, "52.204-21")["status"] == "missing"
    assert _finding(result, "52.217-9")["status"] == "present_review"
    # Review rules for absent clauses produce nothing; DoD rules skip civilian docs.
    assert _finding(result, "52.217-8") is None
    assert _finding(result, "252.204-7012") is None
    assert result["summary"]["deviations"] == sum(1 for item in result["findings"] if item["status"] != "satisfied")
    # Deviations sort before satisfied, high severity first.
    statuses = [item["status"] for item in result["findings"]]
    assert statuses.index("satisfied") > statuses.index("missing")

    # A narrative mention of a DFARS clause does not make a document DoD.
    mention = _document(database, [("52.204-25", "listing"), ("252.216-7002", "incidental")])
    assert evaluate_document(database, mention, None)["is_dod"] is False

    dod = _document(database, [("252.204-7012", "listing"), ("FAR 52.204-30 Alternate 1", "incidental")])
    dod_result = evaluate_document(database, dod, None)
    assert dod_result["is_dod"]
    assert _finding(dod_result, "252.204-7012")["status"] == "satisfied"
    assert _finding(dod_result, "252.232-7006")["status"] == "missing"


def test_overrides_custom_and_prohibited_rules(database):
    document_id = _document(database, [("52.204-25", "listing"), ("52.219-14", "listing")])
    database.add(ClausePlaybookRule(rule_id="default:52.204-25", owner_workspace=None, clause_number="52.204-25",
                                    title="Sec 889", expectation="required", severity="high", rationale="",
                                    applies_to="all", enabled=False))
    database.add(ClausePlaybookRule(rule_id="custom:x", owner_workspace=None, clause_number="52.219-14",
                                    title="Limitations on Subcontracting", expectation="prohibited", severity="high",
                                    rationale="Policy", applies_to="all", enabled=True))
    database.commit()
    rules = {rule["rule_id"]: rule for rule in effective_rules(database, None)}
    assert rules["default:52.204-25"]["source"] == "override" and not rules["default:52.204-25"]["enabled"]
    assert rules["custom:x"]["source"] == "custom"
    assert len(rules) == len(DEFAULT_RULES) + 1
    result = evaluate_document(database, document_id, None)
    assert _finding(result, "52.204-25") is None
    assert _finding(result, "52.219-14")["status"] == "present_prohibited"
    # Another workspace keeps the defaults untouched.
    assert all(rule["source"] == "default" for rule in effective_rules(database, "other-workspace"))


def test_rules_api_crud_and_document_endpoint(database):
    rules = client.get("/api/playbook/rules").json()
    assert {rule["rule_id"] for rule in rules} >= {"default:52.204-21"}

    created = client.post("/api/playbook/rules", json={"clause_number": "FAR 52.219-9", "expectation": "required",
                                                      "severity": "low", "title": "Small Business Subcontracting Plan"})
    assert created.status_code == 201, created.text
    custom_id = created.json()["rule_id"]
    assert created.json()["clause_number"] == "52.219-9"
    assert client.post("/api/playbook/rules", json={"clause_number": "nope", "expectation": "required"}).status_code == 422

    disabled = client.put("/api/playbook/rules/default:52.204-21", json={"enabled": False})
    assert disabled.status_code == 200 and disabled.json()["source"] == "override"
    assert client.delete("/api/playbook/rules/default:52.204-23").status_code == 409
    reset = client.post("/api/playbook/rules/default:52.204-21/reset")
    assert reset.json()["source"] == "default" and reset.json()["enabled"]
    assert client.delete(f"/api/playbook/rules/{custom_id}").status_code == 200
    assert client.put("/api/playbook/rules/missing", json={"enabled": False}).status_code == 404

    document_id = _document(database, [("52.204-25", "listing")])
    evaluation = client.get(f"/api/documents/{document_id}/playbook")
    assert evaluation.status_code == 200 and evaluation.json()["applicable"]
    portfolio = client.get("/api/playbook/portfolio").json()
    row = next(item for item in portfolio["documents"] if item["document_id"] == document_id)
    assert all(item["status"] != "satisfied" for item in row["findings"])
    assert portfolio["totals"]["documents"] >= 1


def test_workspace_rules_and_documents_are_isolated(database):
    a, b = {"X-Workspace-Token": secrets.token_hex(32)}, {"X-Workspace-Token": secrets.token_hex(32)}
    with enforced():
        created = client.post("/api/playbook/rules", json={"clause_number": "52.215-2", "expectation": "required"},
                              headers=a)
        assert created.status_code == 201, created.text
        rule_id = created.json()["rule_id"]
        assert any(rule["rule_id"] == rule_id for rule in client.get("/api/playbook/rules", headers=a).json())
        assert all(rule["rule_id"] != rule_id for rule in client.get("/api/playbook/rules", headers=b).json())
        assert client.delete(f"/api/playbook/rules/{rule_id}", headers=b).status_code == 404
        # No workspace token → cannot write to the shared playbook.
        assert client.post("/api/playbook/rules", json={"clause_number": "52.215-2", "expectation": "required"}).status_code == 403

        from app.core.auth import workspace_key

        owned = _document(database, [("52.204-25", "listing")], owner=workspace_key(a["X-Workspace-Token"]))
        assert client.get(f"/api/documents/{owned}/playbook", headers=a).status_code == 200
        assert client.get(f"/api/documents/{owned}/playbook", headers=b).status_code == 404
        ids_b = {row["document_id"] for row in client.get("/api/playbook/portfolio", headers=b).json()["documents"]}
        assert owned not in ids_b
        client.delete(f"/api/playbook/rules/{rule_id}", headers=a)


def test_saved_queries_crud_validation_and_isolation(database):
    from app.models.playbook_saved_query import PlaybookSavedQuery

    a, b = {"X-Workspace-Token": secrets.token_hex(32)}, {"X-Workspace-Token": secrets.token_hex(32)}
    try:
        with enforced():
            created = client.post(
                "/api/playbook/saved-queries",
                json={"name": "  Cyber  clauses ", "kind": "ask", "query": "Which contracts cite DFARS 252.204-7012?"},
                headers=a,
            )
            assert created.status_code == 201, created.text
            saved = created.json()
            assert saved["name"] == "Cyber clauses"

            assert client.post("/api/playbook/saved-queries", json={"name": "x", "kind": "nope", "query": "q"},
                               headers=a).status_code == 422
            assert client.post("/api/playbook/saved-queries", json={"name": "", "kind": "ask", "query": "q"},
                               headers=a).status_code == 422
            # No workspace token → cannot write to the shared list.
            assert client.post("/api/playbook/saved-queries",
                               json={"name": "x", "kind": "ask", "query": "q"}).status_code == 403

            listed = client.get("/api/playbook/saved-queries", headers=a).json()
            assert [row["id"] for row in listed] == [saved["id"]]
            assert client.get("/api/playbook/saved-queries?kind=extraction", headers=a).json() == []
            assert client.get("/api/playbook/saved-queries", headers=b).json() == []
            assert client.delete(f"/api/playbook/saved-queries/{saved['id']}", headers=b).status_code == 404

            updated = client.put(f"/api/playbook/saved-queries/{saved['id']}", json={"kind": "clause_search"}, headers=a)
            assert updated.status_code == 200
            assert updated.json()["kind"] == "clause_search"
            assert updated.json()["query"] == saved["query"]

            assert client.delete(f"/api/playbook/saved-queries/{saved['id']}", headers=a).status_code == 200
            assert client.get("/api/playbook/saved-queries", headers=a).json() == []
    finally:
        database.execute(delete(PlaybookSavedQuery).where(PlaybookSavedQuery.name.in_(["Cyber clauses"])))
        database.commit()


# --- clause library fields, extraction patterns, ingested verbatim text ------


def _page(database, document_id: str, number: int, text: str) -> None:
    from app.models.document_page import DocumentPage

    database.add(DocumentPage(
        document_id=document_id, page_number=number, native_text=text, final_text=text,
        has_tables=False, has_form_fields=False, is_scanned=False, text_length=len(text),
        extraction_method="native", requires_ocr=False, ocr_attempted=False, ocr_succeeded=False,
        character_count=len(text), word_count=len(text.split()), text_block_count=1, image_count=0,
        text_coverage_ratio=1.0, image_coverage_ratio=0.0, page_width=612.0, page_height=792.0,
        extraction_status="completed",
    ))
    database.commit()


def _far_record(database, document_id: str, number: str, version: str, text: str, order: int = 1) -> None:
    from app.models.document_far_record import DocumentFarRecord

    database.add(DocumentFarRecord(
        document_id=document_id, extractor_version=1, clause_key=f"FAR-{number}", basic_clause_key=f"FAR-{number}",
        source_sequence_id=str(order), source_order=order, content_type="CLAUSE_OR_PROVISION", load_eligible=True,
        far_number=number, title="Contract Terms and Conditions—Commercial Products and Commercial Services",
        version_date=version, clause_type="Clause", source_text=text, embedded_references=[],
        provenance_json={}, issues=[],
    ))
    database.commit()


def test_defaults_carry_category_agency_and_patterns(database):
    rules = {rule["rule_id"]: rule for rule in effective_rules(database, None)}
    assert all(rule["category"] for rule in rules.values())
    assert rules["default:252.204-7012"]["agency"] == "DoD"
    assert rules["default:52.204-21"]["agency"] == ""
    assert rules["default:52.204-25"]["extraction_patterns"][0]["kind"] == "phrase"
    assert rules["default:52.233-1"]["extraction_patterns"] == []  # "Disputes" alone is too generic
    assert rules["default:52.204-21"]["standard_text"] == ""


def test_pattern_validation_and_fields_round_trip(database):
    bad = client.post("/api/playbook/rules", json={
        "clause_number": "52.219-9", "expectation": "required",
        "extraction_patterns": [{"kind": "regex", "pattern": "subcontracting (plan"}],
    })
    assert bad.status_code == 422 and "not a valid regular expression" in bad.json()["detail"]
    nested = client.post("/api/playbook/rules", json={
        "clause_number": "52.219-9", "expectation": "required",
        "extraction_patterns": [{"kind": "regex", "pattern": "(plan\\s+)+x"}],
    })
    assert nested.status_code == 422 and "nests" in nested.json()["detail"]
    too_many = client.post("/api/playbook/rules", json={
        "clause_number": "52.219-9", "expectation": "required",
        "extraction_patterns": [{"kind": "phrase", "pattern": f"phrase {n}"} for n in range(11)],
    })
    assert too_many.status_code == 422
    assert client.post("/api/playbook/rules", json={
        "clause_number": "52.219-9", "expectation": "required", "agency": "x" * 81,
    }).status_code == 422

    created = client.post("/api/playbook/rules", json={
        "clause_number": "52.219-9", "expectation": "required", "category": "Socioeconomic  programs",
        "agency": "Navy", "fallback_text": "Accept a commercial plan.", "standard_text": "Custom text",
        "extraction_patterns": [{"kind": "regex", "pattern": r"subcontracting\s+plan", "note": "SB plan"}],
    })
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["category"] == "Socioeconomic programs" and body["agency"] == "Navy"
    assert body["extraction_patterns"] == [{"kind": "regex", "pattern": r"subcontracting\s+plan", "note": "SB plan"}]
    assert body["fallback_text"] == "Accept a commercial plan."

    # An override of a default keeps (and can change) the clause-library fields.
    override = client.put("/api/playbook/rules/default:52.204-25", json={"enabled": False})
    assert override.json()["source"] == "override"
    assert override.json()["category"] == "Cybersecurity & supply chain"
    assert override.json()["extraction_patterns"]
    edited = client.put("/api/playbook/rules/default:52.204-25", json={"fallback_text": "None accepted.", "agency": "DLA"})
    assert edited.json()["fallback_text"] == "None accepted." and edited.json()["agency"] == "DLA"
    assert edited.json()["enabled"] is False


def test_pattern_match_is_reported_distinctly(database):
    document_id = _document(database, [("52.204-25", "listing")])
    _page(database, document_id, 1, "Cover page")
    _page(database, document_id, 4, "The contractor shall comply with the clause\nCombating   Trafficking in\nPersons as incorporated.")
    result = evaluate_document(database, document_id, None)
    finding = _finding(result, "52.222-50")
    assert finding["status"] == "present_text_match"
    assert finding["page"] == 4
    assert "trafficking" in finding["evidence"].lower()
    assert finding["pattern_match"]["kind"] == "phrase"
    # Text matches are neither satisfied nor deviations.
    assert result["summary"]["text_matches"] >= 1
    assert result["summary"]["deviations"] == sum(
        1 for item in result["findings"] if item["status"] not in ("satisfied", "present_text_match")
    )
    # Cited clauses never fall back to text matching.
    assert _finding(result, "52.204-25")["status"] == "satisfied"
    assert _finding(result, "52.204-25")["pattern_match"] is None
    # A rule with no matching pattern stays "missing".
    assert _finding(result, "52.204-21")["status"] == "missing"


def test_custom_regex_pattern_match_and_partial_words(database):
    from app.services.clause_playbook import match_patterns

    pages = [(2, "Offeror shall submit a Small Business Subcontracting Plan."), (3, "Disputesque")]
    assert match_patterns([{"kind": "regex", "pattern": r"subcontracting\s+plan"}], pages)["page"] == 2
    # Phrases match whole words only.
    assert match_patterns([{"kind": "phrase", "pattern": "Disputes"}], pages) is None
    # A stored pattern that no longer compiles is skipped, not raised.
    assert match_patterns([{"kind": "regex", "pattern": "(oops"}], pages) is None


def test_standard_text_comes_only_from_ingested_records(database):
    # The test database persists between runs: a fresh clause number keeps
    # earlier runs' records out of this one.
    number = f"52.299-{secrets.randbelow(9000) + 1000}"
    rule = client.post("/api/playbook/rules", json={"clause_number": number, "expectation": "review"}).json()
    empty = client.get(f"/api/playbook/rules/{rule['rule_id']}/standard-text")
    assert empty.status_code == 200 and empty.json()["ingested"] is None and empty.json()["versions"] == []

    regulation = _document(database, [])
    _far_record(database, regulation, number, "(Nov 2021)", "Old text of the clause.")
    newer = _document(database, [])
    _far_record(database, newer, number, "(Dec 2022)", "New text of the clause.")
    found = client.get(f"/api/playbook/rules/{rule['rule_id']}/standard-text").json()
    assert found["ingested"]["source_text"] == "New text of the clause."
    assert found["ingested"]["version_date"] == "(Dec 2022)"
    assert found["ingested"]["document_id"] == newer
    assert [item["version_date"] for item in found["versions"]] == ["(Dec 2022)", "(Nov 2021)"]
    assert "source_text" not in found["versions"][0]

    index = client.get(f"/api/playbook/far-clauses?q={number}").json()
    entry = next(item for item in index if item["clause_number"] == number)
    assert entry["family"] == "FAR" and entry["versions"] == ["(Dec 2022)", "(Nov 2021)"]
    texts = client.get(f"/api/playbook/far-clauses/FAR {number}/texts").json()
    assert {record["source_text"] for record in texts["records"]} == {"Old text of the clause.", "New text of the clause."}
    assert client.get("/api/playbook/far-clauses/nope/texts").status_code == 422
    assert client.get("/api/playbook/rules/missing/standard-text").status_code == 404


def test_ingested_text_is_scoped_to_the_callers_workspace(database):
    from app.core.auth import workspace_key

    a, b = {"X-Workspace-Token": secrets.token_hex(32)}, {"X-Workspace-Token": secrets.token_hex(32)}
    owned = _document(database, [], owner=workspace_key(a["X-Workspace-Token"]))
    _far_record(database, owned, "252.204-7012", "(May 2024)", "Workspace A DFARS text.")
    with enforced():
        mine = client.get("/api/playbook/rules/default:252.204-7012/standard-text", headers=a).json()
        assert mine["ingested"]["source_text"] == "Workspace A DFARS text."
        theirs = client.get("/api/playbook/rules/default:252.204-7012/standard-text", headers=b).json()
        assert theirs["ingested"] is None
        listed = client.get("/api/playbook/far-clauses", headers=b).json()
        assert all(item["clause_number"] != "252.204-7012" for item in listed)
