"""Batch validation rules: each rule type against a document's extracted
values, rule validation, workspace scoping, and the API."""

from __future__ import annotations

import secrets
from contextlib import contextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.api.validation_rules import document_router, router
from app.core.config import get_settings
from app.core.document_access import enforce_document_access
from app.database.session import SessionLocal
from app.models.document import Document
from app.models.document_staging_workbook import DocumentStagingWorkbook  # noqa: F401
from app.models.validation_rule import ValidationRule
from app.services import document_actions
from app.services.validation_rules import (
    TEMPLATES,
    RuleError,
    effective_rules,
    evaluate_document,
    evaluate_rule,
    validate_rule_payload,
)

api = FastAPI()
api.include_router(router, prefix="/api/validation-rules")
api.include_router(document_router, prefix="/api/documents", dependencies=[Depends(enforce_document_access)])
client = TestClient(api)


class StubData:
    """Stands in for document_actions' contract data: label -> (value, page)."""

    def __init__(self, facts: dict[str, tuple[str, int | None]], totals: dict | None = None):
        self.facts = {document_actions._norm(label): value for label, value in facts.items()}
        self.totals = totals or {"priced_total": None, "maximum_total": None, "funded_total": None}

    def fact(self, *labels):
        for label in labels:
            found = self.facts.get(document_actions._norm(label))
            if found:
                return SimpleNamespace(value=found[0], page=found[1])
        return SimpleNamespace(value=None, page=None)


@pytest.fixture
def stub(monkeypatch):
    data = StubData({
        "Unique Entity ID (UEI)": ("QX7LMN4TZ8K1", 1),
        "SAM UEI": ("qx7lmn4tz8k1", 9),
        "CAGE Code": ("1ABC", 1),
        "Contract Number": ("N4019223D2803", 1),
        "Award Amount": ("$600,000,000.00", 2),
        "Contractor": ("ACME LLC\n100 Main St", 2),
        "NAICS": ("236220", 3),
    }, {"priced_total": 1_000_000.0, "maximum_total": None, "funded_total": 975_000.0})
    monkeypatch.setattr(document_actions, "load_contract_data", lambda database, document_id: data)
    monkeypatch.setattr(document_actions, "funding_totals", lambda d: d.totals)
    return data


def _rule(**fields) -> dict:
    return {"rule_id": "r", "name": "Rule", "severity": "medium", **fields}


@contextmanager
def enforced():
    settings = get_settings().model_copy(update={"rbac_enforced": True, "public_workspace_access": True})
    with patch("app.core.auth.get_settings", return_value=settings):
        yield


@pytest.fixture
def database():
    session = SessionLocal()
    session.execute(delete(ValidationRule).where(ValidationRule.owner_workspace.is_(None)))
    session.commit()
    try:
        yield session
    finally:
        session.execute(delete(ValidationRule).where(ValidationRule.owner_workspace.is_(None)))
        session.commit()
        session.close()


def _document(database, owner: str | None = None) -> str:
    document_id = str(uuid4())
    database.add(Document(
        id=document_id, original_filename=f"contract-{document_id[:8]}.pdf", stored_filename=f"{document_id}.pdf",
        content_type="application/pdf", size_bytes=100, checksum_sha256=uuid4().hex, page_count=3,
        encrypted=False, status="ready", processing_status="completed", document_type="Government Contract",
        uploaded_at=datetime(2026, 10, 1, tzinfo=timezone.utc), owner_workspace=owner,
    ))
    database.commit()
    return document_id


def test_regex_rule_passes_fails_and_reports_missing(stub):
    ok = evaluate_rule(_rule(rule_type="regex", field_label="UEI|Unique Entity ID (UEI)", pattern="[A-Z0-9]{12}"), stub)
    assert ok["status"] == "pass" and ok["page"] == 1
    bad = evaluate_rule(_rule(rule_type="regex", field_label="CAGE Code", pattern="[A-Z0-9]{5}"), stub)
    assert bad["status"] == "fail" and "1ABC" in bad["detail"]
    missing = evaluate_rule(_rule(rule_type="regex", field_label="DUNS", pattern="\\d{9}"), stub)
    assert missing["status"] == "missing"
    # Only the first line is checked: a name followed by an address still matches.
    first_line = evaluate_rule(_rule(rule_type="regex", field_label="Contractor", pattern="[A-Z ]+LLC"), stub)
    assert first_line["status"] == "pass"


def test_required_field_rule(stub):
    assert evaluate_rule(_rule(rule_type="required_field", field_label="NAICS"), stub)["status"] == "pass"
    assert evaluate_rule(_rule(rule_type="required_field", field_label="Contracting Officer"), stub)["status"] == "fail"


def test_funding_gap_rule_uses_threshold_and_skips_without_funding(stub):
    over = evaluate_rule(_rule(rule_type="funding_gap", threshold=10_000.0), stub)
    assert over["status"] == "fail" and "$25,000.00" in over["detail"]
    within = evaluate_rule(_rule(rule_type="funding_gap", threshold=50_000.0), stub)
    assert within["status"] == "pass"
    stub.totals = {"priced_total": None, "maximum_total": 600_000_000.0, "funded_total": None}
    assert evaluate_rule(_rule(rule_type="funding_gap", threshold=1.0), stub)["status"] == "not_applicable"


def test_max_amount_rule(stub):
    over = evaluate_rule(_rule(rule_type="max_amount", field_label="Award Amount", threshold=1_000_000.0), stub)
    assert over["status"] == "fail" and over["value"] == "$600,000,000.00"
    under = evaluate_rule(_rule(rule_type="max_amount", field_label="Award Amount", threshold=1e9), stub)
    assert under["status"] == "pass"
    words = evaluate_rule(_rule(rule_type="max_amount", field_label="Contractor", threshold=1.0), stub)
    assert words["status"] == "not_applicable"


def test_field_match_rule_normalizes_case_and_spacing(stub):
    same = evaluate_rule(_rule(rule_type="field_match", field_label="Unique Entity ID (UEI)", pattern="SAM UEI"), stub)
    assert same["status"] == "pass"
    stub.facts[document_actions._norm("SAM UEI")] = ("ZZZZZZZZZZZZ", 9)
    differ = evaluate_rule(_rule(rule_type="field_match", field_label="Unique Entity ID (UEI)", pattern="SAM UEI"), stub)
    assert differ["status"] == "fail" and "differ" in differ["detail"]
    absent = evaluate_rule(_rule(rule_type="field_match", field_label="Unique Entity ID (UEI)", pattern="Cover UEI"), stub)
    assert absent["status"] == "missing"


def test_payload_validation():
    with pytest.raises(RuleError, match="not a valid regular expression"):
        validate_rule_payload({"name": "x", "rule_type": "regex", "field_label": "UEI", "pattern": "([A-Z"})
    with pytest.raises(RuleError, match="under 300"):
        validate_rule_payload({"name": "x", "rule_type": "regex", "field_label": "UEI", "pattern": "a" * 301})
    with pytest.raises(RuleError, match="dollar threshold"):
        validate_rule_payload({"name": "x", "rule_type": "funding_gap"})
    with pytest.raises(RuleError, match="field label"):
        validate_rule_payload({"name": "x", "rule_type": "required_field"})
    with pytest.raises(RuleError, match="name"):
        validate_rule_payload({"rule_type": "required_field", "field_label": "NAICS"})
    cleaned = validate_rule_payload({"name": " Gap ", "rule_type": "funding_gap", "threshold": "500",
                                     "field_label": "ignored", "pattern": "ignored"})
    assert cleaned["threshold"] == 500.0 and cleaned["field_label"] is None and cleaned["pattern"] is None


def test_templates_ship_disabled_so_nothing_is_checked(database, stub):
    rules = effective_rules(database, None)
    assert {rule["rule_id"] for rule in rules} >= {item.rule_id for item in TEMPLATES}
    assert not any(rule["enabled"] for rule in rules)
    result = evaluate_document(database, "any", None)
    assert result["applicable"] is False and result["results"] == []


def test_api_crud_preview_and_document_results(database, stub):
    document_id = _document(database)
    created = client.post("/api/validation-rules/rules", json={
        "name": "Award under $1M", "rule_type": "max_amount", "field_label": "Award Amount",
        "threshold": 1_000_000, "severity": "high",
    })
    assert created.status_code == 201, created.text
    rule_id = created.json()["rule_id"]
    assert created.json()["source"] == "custom"

    bad = client.post("/api/validation-rules/rules", json={"name": "x", "rule_type": "regex",
                                                           "field_label": "UEI", "pattern": "(["})
    assert bad.status_code == 400

    preview = client.post("/api/validation-rules/rules/test", json={
        "document_id": document_id, "name": "UEI", "rule_type": "regex",
        "field_label": "Unique Entity ID (UEI)", "pattern": "[A-Z0-9]{12}",
    })
    assert preview.status_code == 200 and preview.json()["status"] == "pass"

    enabled = client.put("/api/validation-rules/rules/template:funding-gap", json={"enabled": True})
    assert enabled.status_code == 200 and enabled.json()["source"] == "override" and enabled.json()["enabled"]
    assert client.delete("/api/validation-rules/rules/template:uei-format").status_code == 409

    results = client.get(f"/api/documents/{document_id}/validation").json()
    statuses = {item["rule_id"]: item["status"] for item in results["results"]}
    assert statuses == {rule_id: "fail", "template:funding-gap": "fail"}
    assert results["summary"]["fail"] == 2 and results["summary"]["high"] == 2

    reset = client.post("/api/validation-rules/rules/template:funding-gap/reset")
    assert reset.json()["source"] == "template" and not reset.json()["enabled"]
    assert client.delete(f"/api/validation-rules/rules/{rule_id}").status_code == 200
    assert client.get(f"/api/documents/{document_id}/validation").json()["applicable"] is False
    database.delete(database.get(Document, document_id))
    database.commit()


def test_workspace_rules_and_documents_are_isolated(database, stub):
    a, b = {"X-Workspace-Token": secrets.token_hex(32)}, {"X-Workspace-Token": secrets.token_hex(32)}
    payload = {"name": "NAICS present", "rule_type": "required_field", "field_label": "NAICS"}
    with enforced():
        created = client.post("/api/validation-rules/rules", json=payload, headers=a)
        assert created.status_code == 201, created.text
        rule_id = created.json()["rule_id"]
        assert any(r["rule_id"] == rule_id for r in client.get("/api/validation-rules/rules", headers=a).json())
        assert all(r["rule_id"] != rule_id for r in client.get("/api/validation-rules/rules", headers=b).json())
        assert client.delete(f"/api/validation-rules/rules/{rule_id}", headers=b).status_code == 404
        # No workspace token -> cannot write to the shared rule set.
        assert client.post("/api/validation-rules/rules", json=payload).status_code == 403

        from app.core.auth import workspace_key

        owned = _document(database, owner=workspace_key(a["X-Workspace-Token"]))
        assert client.get(f"/api/documents/{owned}/validation", headers=a).status_code == 200
        assert client.get(f"/api/documents/{owned}/validation", headers=b).status_code == 404
        preview = {**payload, "document_id": owned}
        assert client.post("/api/validation-rules/rules/test", json=preview, headers=b).status_code == 404
        client.delete(f"/api/validation-rules/rules/{rule_id}", headers=a)
    database.delete(database.get(Document, owned))
    database.commit()
