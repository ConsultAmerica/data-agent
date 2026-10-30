"""Increment 7.3: document classes, skills, Business Data, validation,
document dates, targeted extraction and the workspace exports — all built
from the original layout, so the UI and every export agree."""

from __future__ import annotations

import csv
import io
from datetime import date
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.classification.document_class import document_class_for_family
from app.classification.engine import detect_subtype
from app.main import app
from app.skills.business_data import build_business_data
from app.skills.dates import document_dates
from app.skills.definitions import SKILLS
from app.skills.find import find_in_document
from app.skills.validation import validation_summary
from contract_brief_fixture import contract_brief_pdf

client = TestClient(app)

# A definition can't change without a new version: update both together.
PINNED = {
    ("contract_recognition", "1.0"): "4e5000e7b9d4f208",
    ("invoice_recognition", "1.0"): "af7f3e5819647757",
    ("purchase_order_recognition", "1.0"): "210abd03ca960163",
    ("bank_statement_recognition", "1.0"): "54378dc14f508411",
    ("passport_recognition", "1.0"): "cc39d06008531b9d",
}


def test_skill_versions_are_pinned() -> None:
    assert {(s.skill_id, s.version): s.content_hash() for s in SKILLS} == PINNED


@pytest.mark.parametrize(
    ("family", "expected"),
    [
        ("government_contract", "contract"), ("sow", "contract"), ("invoice", "invoice"),
        ("purchase_order", "purchase_order"), ("bank_statement", "bank_statement"), ("statement", "bank_statement"),
        ("financial_statement", "financial_statement"), ("passport", "identity"), ("academic_transcript", "academic"),
        ("resume", "general"), ("custom:widget_log", "general"), (None, "general"),
    ],
)
def test_every_family_has_one_of_the_eight_classes(family: str | None, expected: str) -> None:
    assert document_class_for_family(family) == expected


def test_subtypes_are_read_only_from_what_the_document_states() -> None:
    assert detect_subtype("bank_statement", "Your checking account summary")[0] == "Checking Account Statement"
    assert detect_subtype("financial_statement", "Consolidated Balance Sheet as of")[0] == "Balance Sheet"
    assert detect_subtype("bank_statement", "Monthly summary")[0] is None


def _field(record_key: str, label: str, value: str, *, section: str = "S", group: str | None = None, page: int = 1,
           review: str = "Not reviewed", flags: list | None = None) -> dict:
    return {
        "kind": "field", "record_key": record_key, "label": label, "group": group, "document_value": value,
        "extracted_value": value, "effective_value": value, "evidence": f"{label} {value}", "page": page,
        "found_by": "ruled form row", "review_status": review, "flags": flags or [], "metadata": None,
        "value_type": "text",
    }


def _layout(sections: list[tuple[str, list[dict]]]) -> dict:
    return {"sections": [{"id": f"s{i}", "title": title, "page": 1, "items": items} for i, (title, items) in enumerate(sections)],
            "unplaced": []}


INVOICE = {"family": "invoice", "family_label": "Invoice", "document_class": "invoice", "document_class_label": "Invoice"}


def test_business_data_sorts_values_into_canonical_sections_and_keeps_the_rest() -> None:
    layout = _layout([("INVOICE", [
        _field("f1", "Invoice No.", "INV-1001"),
        _field("f2", "Invoice Date", "03/01/2026"),
        _field("f3", "Bill To", "Acme Corp"),
        _field("f4", "Subtotal", "$100.00"),
        _field("f5", "Sales Tax", "$8.00"),
        _field("f6", "Amount Due", "$110.00"),
        _field("f7", "Warehouse Bay", "B-12"),  # no business category
    ])])
    business = build_business_data(layout, INVOICE)
    fields = {f["key"]: f for s in business["sections"] for f in s["fields"]}
    assert fields["invoice_number"]["value"] == "INV-1001" and fields["invoice_number"]["record_key"] == "f1"
    assert fields["customer_name"]["value"] == "Acme Corp"
    assert [v["label"] for v in business["other"]["values"]] == ["Warehouse Bay"]
    # Required but absent: reported missing, never filled.
    assert fields["supplier_name"]["value"] is None and fields["supplier_name"]["validation_status"] == "missing"
    # 100 + 8 is not 110.
    [total] = [i for i in business["issues"] if i["kind"] == "incorrect_total"]
    assert set(total["record_keys"]) == {"f4", "f5", "f6"}


def test_validation_separates_conflicts_repeating_records_and_qualified_labels() -> None:
    contract = {"family": "government_contract", "document_class": "contract"}
    layout = _layout([
        ("A", [
            _field("a1", "Legal Entity", "ORBITAL FIELD SERVICES, LLC", group="1. Contractor Information"),
            _field("a2", "Abbreviated Legal Entity", "OFSL", group="1. Contractor Information"),
            _field("a3", "Contract Number", "C05550001", group="2. Contract Information"),
            _field("a4", "Contract Number", "C05550002", group="2. Contract Information"),
            _field("a5", "Date of Award", "13/45/2025", group="2. Contract Information"),
        ]),
        ("C", [_field("c1", "Contract Name", "OFS JV HORIZON"), _field("c2", "Contract Name", "OFS ACCRUALS", page=6)]),
    ])
    business = build_business_data(layout, contract)
    fields = {f["key"]: f for s in business["sections"] for f in s["fields"]}
    # "Abbreviated Legal Entity" is not the contractor's name.
    assert [c["record_key"] for c in fields["contractor_name"]["candidates"]] == ["a1"]
    assert {i["code"] for i in fields["contract_number"]["issues"]} >= {"conflicting_values"}
    assert fields["award_date"]["validation_status"] == "failed"
    # The same caption in one section: a conflict; repeated per record: not.
    assert "conflicting_values" not in {i["code"] for i in fields["contract_name"]["issues"]}
    summary = validation_summary(business, layout)
    kinds = {g["kind"] for g in summary["groups"]}
    assert {"conflicting_values", "invalid_date"} <= kinds and summary["counts"]["errors"] >= 2


def _dates(fields: list[dict], document_class: str, key_dates: list | None = None, today: date = date(2026, 6, 1)) -> dict:
    business = {"document_class": document_class, "sections": [{"fields": fields}]}
    return document_dates(business, key_dates or [], today=today, warning_days=30)


def _date_field(key: str, label: str, value: str, role: str | None) -> dict:
    return {"key": key, "label": label, "value": value, "date_role": role, "page": 2, "evidence": f"{label} {value}",
            "record_key": key}


def test_date_status_needs_an_identified_date_and_marks_inferred_ones() -> None:
    assert _dates([_date_field("x", "Expiration Date", "06/20/2026", "expiration")], "contract")["status"] == "Expiring Soon"
    assert _dates([_date_field("x", "Expiration Date", "12/31/2026", "expiration")], "contract")["status"] == "Active"
    assert _dates([_date_field("x", "Date of Expiry", "05/01/2026", "expiration")], "identity")["status"] == "Expired"
    assert _dates([], "contract")["status"] == "Unknown"
    assert _dates([_date_field("x", "Invoice Date", "03/01/2026", "issue")], "invoice")["status"] == "Not Applicable"
    # No printed expiry: the period's last end, labelled as inferred.
    result = _dates([_date_field("period_of_performance", "Period of Performance", "07/01/2025 - 06/30/2027", None)], "contract")
    assert result["status"] == "Active"
    assert result["expiration"]["basis"] == "inferred" and result["expiration"]["date"] == "2027-06-30"
    # An open period never becomes an end date.
    open_period = _dates(
        [_date_field("period_of_performance", "Period of Performance", "07/01/2025 -", None)], "contract",
        key_dates=[SimpleNamespace(kind="period_end", date=date(2025, 7, 1), label="Period", details=None, page=1, evidence_text="")],
    )
    assert open_period["status"] == "Unknown"


def test_targeted_extraction_answers_from_the_document_or_says_not_found() -> None:
    layout = _layout([("INVOICE", [_field("f1", "Invoice No.", "INV-1001", page=2), _field("f2", "VAT No", "GB123456789")])])
    business = build_business_data(layout, INVOICE)
    found = find_in_document("Extract Invoice Number", business=business, family="invoice")
    assert found["found"] and found["answers"][0]["value"] == "INV-1001" and found["answers"][0]["page"] == 2
    tax = find_in_document("Find Supplier Tax Identifier", business=business, family="invoice")
    assert tax["found"] and tax["answers"][0]["value"] == "GB123456789"
    missing = find_in_document("Extract Invoice Total", business=business, family="invoice")
    assert missing["found"] is False and missing["answers"] == []
    clauses = find_in_document(
        "Identify FAR Clauses", business=business, family="invoice",
        clause_citations=[SimpleNamespace(clause_family="FAR", clause_number="52.204-21", title="Basic Safeguarding",
                                          page_number=40, source_text="52.204-21 Basic Safeguarding")],
    )
    assert clauses["kind"] == "clauses" and clauses["answers"][0]["page"] == 40


@pytest.fixture(scope="module")
def brief_id() -> str:
    response = client.post("/api/documents/upload", files={"file": (f"brief-{uuid4().hex[:6]}.pdf", contract_brief_pdf(), "application/pdf")})
    assert response.status_code == 201, response.text
    document_id = response.json()["document_id"]
    assert client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False}).status_code == 200
    return document_id


def test_classification_correction_reorganizes_without_losing_records(brief_id: str) -> None:
    before = client.get(f"/api/documents/{brief_id}/original-structure").json()["stats"]
    state = client.get(f"/api/documents/{brief_id}/classification").json()
    assert state["review_status"] == "Not reviewed" and state["document_class_label"]
    response = client.post(
        f"/api/documents/{brief_id}/classification/decision",
        json={"action": "override", "family": "government_contract", "reason": "contract brief", "apply": False},
    )
    assert response.status_code == 200, response.text
    state = client.get(f"/api/documents/{brief_id}/classification").json()
    assert state["document_class"] == "contract" and state["review_status"] == "Confirmed"
    business = client.get(f"/api/documents/{brief_id}/business-data").json()
    assert business["skill"]["skill_id"] == "contract_recognition"
    fields = {f["key"]: f for s in business["sections"] for f in s["fields"]}
    assert fields["contractor_name"]["value"] == "ORBITAL FIELD SERVICES, LLC"
    assert fields["cage_code"]["value"] == "7QRT2"
    assert fields["exercised_value"]["value"] == "$12,345,678.90"
    assert [t["label"] for s in business["sections"] for t in s["tables"]].count("Modifications") >= 1
    # Same records as before the correction.
    assert client.get(f"/api/documents/{brief_id}/original-structure").json()["stats"] == before


def test_workspace_endpoints_and_exports(brief_id: str) -> None:
    summary = client.get(f"/api/documents/{brief_id}/validation-summary").json()
    assert set(summary["counts"]) == {"errors", "warnings", "info"}
    dates = client.get(f"/api/documents/{brief_id}/document-dates", params={"warning_days": 60}).json()
    assert dates["warning_days"] == 60 and dates["status"] in {"Active", "Expiring Soon", "Expired", "Not Applicable", "Unknown"}
    answer = client.post(f"/api/documents/{brief_id}/find", json={"query": "Extract Contract Number"}).json()
    assert answer["found"] and answer["answers"][0]["value"] == "C05550001"

    response = client.get(f"/api/documents/{brief_id}/all-fields.csv")
    assert response.status_code == 200
    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))
    # The Original Document Structure rows: the section, the field columns,
    # then item 1 with its first sub-field.
    assert rows[1] == ["Item #", "Section / Field Name", "Extracted Value", "Field Details / Sub-Attributes"]
    assert rows[2] == ["1.", "Contractor Information", "ORBITAL FIELD SERVICES, LLC", "Legal Entity"]

    structured = client.get(f"/api/documents/{brief_id}/structured.json").json()
    assert {"classification", "skill", "original_structure", "business_data", "validation", "dates"} <= set(structured)

    skills = client.get("/api/document-skills").json()
    assert [s["skill_id"] for s in skills] == [s.skill_id for s in SKILLS]
