"""Agent action catalog: deterministic reports over persisted extraction."""

import sys
import types
from types import SimpleNamespace
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api import document_actions as actions_api
from app.core.auth import ActorContext, get_current_actor
from app.database.session import SessionLocal
from app.models.document import Document
from app.models.document_clause_reference import DocumentClauseReference
from app.models.document_contract_summary import DocumentContractSummary
from app.models.document_funding_line import DocumentFundingLine
from app.models.document_line_item import DocumentLineItem
from app.models.document_metadata_field import DocumentMetadataField
from app.services import document_actions
from app.services.document_actions import (
    ACTION_CATALOG,
    UnknownActionError,
    available_actions,
    render_csv,
    render_markdown,
    run_action,
)

OBLIGATIONS = [
    {"obligation_id": "o1", "title": "Monthly status report", "category": "reporting", "responsible_party": "Contractor",
     "due_date": "2026-11-01", "recurrence": "monthly", "trigger": None, "status": "upcoming",
     "source_type": "text", "source_reference": "C.5", "page": 7, "evidence": "shall submit a monthly status report"},
    {"obligation_id": "o2", "title": "Kickoff deliverable", "category": "deliverable", "responsible_party": "Contractor",
     "due_date": "2026-01-15", "recurrence": None, "trigger": "after award", "status": "overdue",
     "source_type": "structured", "source_reference": None, "page": 3, "evidence": None},
]

PLAYBOOK = {
    "document_id": None,
    "applicable": True,
    "findings": [
        {"rule_id": "r1", "clause_number": "252.204-7012", "title": "Safeguarding Covered Defense Information",
         "expectation": "required", "severity": "high", "status": "missing", "rationale": "CUI handling", "page": None, "evidence": None},
        {"rule_id": "r2", "clause_number": "52.204-7", "title": "System for Award Management",
         "expectation": "required", "severity": "medium", "status": "satisfied", "rationale": None, "page": 2, "evidence": "52.204-7"},
    ],
    "summary": {"high": 1, "medium": 0, "low": 0, "satisfied": 1, "deviations": 1},
}


@pytest.fixture(autouse=True)
def no_workbook(monkeypatch):
    """V3-table tests run without a staging workbook (the fallback path);
    the workbook-first tests install their own."""

    monkeypatch.setattr(document_actions._ContractData, "_load_workbook", staticmethod(lambda database, document_id: None))


@pytest.fixture
def services(monkeypatch):
    """Stand-ins for the obligations / playbook services, so these tests
    don't depend on those modules."""

    obligations = types.ModuleType("app.services.obligations")
    obligations.build_document_obligations = lambda database, document_id, today=None: [dict(o, document_id=document_id) for o in OBLIGATIONS]
    playbook = types.ModuleType("app.services.clause_playbook")
    playbook.evaluate_document = lambda database, document_id, workspace: dict(PLAYBOOK, document_id=document_id)
    monkeypatch.setitem(sys.modules, "app.services.obligations", obligations)
    monkeypatch.setitem(sys.modules, "app.services.clause_playbook", playbook)


def _document(database, name: str) -> str:
    document_id = str(uuid4())
    database.add(Document(
        id=document_id, original_filename=name, stored_filename=f"{document_id}.pdf",
        content_type="application/pdf", size_bytes=100, checksum_sha256=uuid4().hex, page_count=4,
        encrypted=False, status="ready", processing_status="completed",
        uploaded_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
    ))
    database.flush()
    return document_id


@pytest.fixture
def contract():
    database = SessionLocal()
    document_id = _document(database, "N40192-award.pdf")
    database.add(DocumentContractSummary(
        document_id=document_id, contract_number="N4019223D2803", agency_office=None, contractor="Acme JV",
        award_date="04/15/2025", ceiling_max_aggregate="Ceiling $1,000.00 total", minimum_guarantee="$2,500.00 minimum",
        field_provenance_json={"Contract Number": {"page": 1}, "Ceiling / Max Aggregate": {"page": 11}}, confidence=0.9,
    ))
    for index, (clin, amount, maximum) in enumerate([("0001", 600.0, False), ("0002", 400.0, False), ("0003", 5000.0, True)]):
        database.add(DocumentLineItem(
            document_id=document_id, row_index=index, clin=clin, description=f"Item {clin}", amount=amount,
            is_maximum=maximum, confidence=0.9, evidence_json={"page_number": 3},
        ))
    database.add(DocumentFundingLine(document_id=document_id, row_index=0, clin="00001", acrn="AA", amount=300.0,
                                     confidence=0.9, evidence_json={"page_number": 4}))
    database.add(DocumentClauseReference(document_id=document_id, row_index=0, clause_family="FAR", citation_context="listing",
                                         clause_number="52.204-7", title="SAM", confidence=0.9, evidence_json={"page_number": 2}))
    database.add(DocumentClauseReference(document_id=document_id, row_index=1, clause_family="FAR", citation_context="listing",
                                         clause_number="52.204-7", title="SAM", confidence=0.9, evidence_json={"page_number": 5}))
    database.add(DocumentMetadataField(document_id=document_id, field_group="award", field_key="award_date", label="Award Date",
                                       value="04/15/2025", original_value="04/15/2025", confidence=0.4,
                                       review_status="pending", evidence_json={"page_number": 1}))
    database.commit()
    try:
        yield database, document_id
    finally:
        database.delete(database.get(Document, document_id))
        database.commit()
        database.close()


def _section(result, heading):
    return next(section for section in result["sections"] if section["heading"] == heading)


def test_catalog_lists_every_action_with_availability(contract, services):
    database, document_id = contract
    catalog = available_actions(database, document_id)
    assert [item["action_id"] for item in catalog] == [action["action_id"] for action in ACTION_CATALOG]
    assert all(item["available"] for item in catalog)


def test_unknown_action_and_document_raise(contract):
    database, document_id = contract
    with pytest.raises(UnknownActionError):
        run_action(database, document_id, "nope")
    with pytest.raises(ValueError):
        run_action(database, str(uuid4()), "executive_summary")


def test_executive_summary_reports_only_persisted_values(contract, services):
    database, document_id = contract
    result = run_action(database, document_id, "executive_summary")
    identification = {fact["label"]: fact for fact in _section(result, "Contract identification")["facts"]}
    assert identification["Contract Number"] == {"label": "Contract Number", "value": "N4019223D2803", "page": 1}
    # Not extracted -> left empty, never filled in.
    assert identification["Issuing Office / Agency"]["value"] is None
    glance = {fact["label"]: fact["value"] for fact in _section(result, "At a glance")["facts"]}
    assert glance["CLINs / line items"] == "3"
    assert glance["Priced total"] == "$1,000.00"  # the not-to-exceed CLIN is not a price
    assert glance["Funded total"] == "$300.00"
    assert glance["FAR clauses"] == "1"  # duplicates of one clause count once
    upcoming = _section(result, "Upcoming obligations")["rows"]
    assert upcoming[0]["title"] == "Kickoff deliverable"  # overdue first
    playbook = {fact["label"]: fact["value"] for fact in _section(result, "Clause playbook")["facts"]}
    assert playbook["Deviations"] == "1"


def test_risk_register_ranks_by_severity_and_cites_sources(contract, services):
    database, document_id = contract
    result = run_action(database, document_id, "risk_register")
    rows = _section(result, "Risks")["rows"]
    severities = [row["severity"] for row in rows]
    assert severities == sorted(severities, key={"high": 0, "medium": 1, "low": 2}.get)
    sources = {row["source"] for row in rows}
    assert {"Playbook deviation", "Missing key field", "Funding gap", "Obligation", "Low-confidence field"} <= sources
    assert any(row["risk"].startswith("Missing key field: Issuing Office / Agency") for row in rows)
    assert any("CLIN 0002" in row["risk"] and row["severity"] == "high" for row in rows)  # priced, unfunded
    assert any(row["risk"].startswith("Overdue obligation: Kickoff deliverable") for row in rows)
    low = next(row for row in rows if row["source"] == "Low-confidence field")
    assert low["page"] == 1 and low["severity"] == "medium"
    # Satisfied playbook findings are not risks.
    assert not any("52.204-7 " in row["risk"] for row in rows)


def test_funding_reconciliation_flags_per_clin(contract, services):
    database, document_id = contract
    result = run_action(database, document_id, "funding_reconciliation")
    by_clin = {row["clin"]: row for row in _section(result, "By CLIN")["rows"]}
    assert by_clin["0001"]["flag"] == "Partially funded"  # "00001" funding matches CLIN "0001"
    assert by_clin["0001"]["difference"] == "$-300.00"
    assert by_clin["0002"]["flag"] == "Unfunded"
    assert by_clin["0003"]["flag"] == "Not-to-exceed only"
    totals = {fact["label"]: fact for fact in _section(result, "Totals")["facts"]}
    assert totals["Funding coverage"]["value"] == "30.0%"
    assert totals["Ceiling / Max Aggregate"]["page"] == 11
    flags = [row["risk"] for row in _section(result, "Flags")["rows"]]
    assert any("below the minimum guarantee" in flag for flag in flags)


def test_clause_gap_report_groups_findings(contract, services):
    database, document_id = contract
    result = run_action(database, document_id, "clause_gap_report")
    assert _section(result, "Missing required clauses")["rows"][0]["clause_number"] == "252.204-7012"
    assert _section(result, "Satisfied")["rows"][0]["page"] == 2
    assert _section(result, "Prohibited clauses present")["rows"] == []


def test_reports_degrade_without_sibling_services(contract, monkeypatch):
    database, document_id = contract
    monkeypatch.setitem(sys.modules, "app.services.obligations", None)  # import -> ImportError
    monkeypatch.setitem(sys.modules, "app.services.clause_playbook", None)
    result = run_action(database, document_id, "executive_summary")
    assert len(result["warnings"]) == 2
    catalog = {item["action_id"]: item for item in available_actions(database, document_id)}
    assert catalog["clause_gap_report"]["available"] is False
    assert catalog["obligations_register"]["available"] is False
    assert run_action(database, document_id, "obligations_register")["sections"] == []


def test_renderers(contract, services):
    database, document_id = contract
    result = run_action(database, document_id, "obligations_register")
    text = render_csv(result)
    assert "Obligation,Category,Responsible party" in text
    assert "Monthly status report" in text
    markdown = render_markdown(result)
    assert markdown.startswith("# Obligations register")
    assert "| Monthly status report | reporting |" in markdown


def test_router_json_and_downloads(contract, services):
    database, document_id = contract
    app = FastAPI()
    app.include_router(actions_api.router, prefix="/api/documents")
    app.dependency_overrides[get_current_actor] = lambda: ActorContext(
        id="t", actor_type="user", role="admin", display_name="Test")
    client = TestClient(app)

    catalog = client.get(f"/api/documents/{document_id}/actions")
    assert catalog.status_code == 200 and len(catalog.json()) == len(ACTION_CATALOG)

    report = client.get(f"/api/documents/{document_id}/actions/risk_register")
    assert report.status_code == 200 and report.json()["document_name"] == "N40192-award.pdf"

    csv_response = client.get(f"/api/documents/{document_id}/actions/risk_register?format=csv")
    assert csv_response.headers["content-type"].startswith("text/csv")
    assert 'filename="N40192-award-risk_register.csv"' in csv_response.headers["content-disposition"]

    md_response = client.get(f"/api/documents/{document_id}/actions/executive_summary?format=md")
    assert md_response.text.startswith("# Executive summary")

    assert client.get(f"/api/documents/{document_id}/actions/nope").status_code == 404
    assert client.get(f"/api/documents/{uuid4()}/actions").status_code == 404


def test_generic_document_summary_uses_staging_workbook(services, monkeypatch):
    database = SessionLocal()
    document_id = _document(database, "memo.pdf")
    database.commit()
    try:
        monkeypatch.setattr(document_actions, "_workbook_sections",
                            lambda workbook: ([{"heading": "Document", "kind": "facts", "facts": []}], []))
        result = run_action(database, document_id, "executive_summary")
        headings = [section["heading"] for section in result["sections"]]
        assert headings[0] == "Document"
        assert "Contract identification" not in headings and "Clause playbook" not in headings
        catalog = {item["action_id"]: item for item in available_actions(database, document_id)}
        assert catalog["funding_reconciliation"]["available"] is False
        assert catalog["clause_gap_report"]["available"] is False
    finally:
        database.delete(database.get(Document, document_id))
        database.commit()
        database.close()


# --- staging workbook first ----------------------------------------------------


def _cell(field, label, value, page=None):
    return SimpleNamespace(canonical_field=field, display_label=label, value=value,
                           provenance=SimpleNamespace(source_page=page) if page else None)


def _record(*cells):
    return SimpleNamespace(cells={cell.canonical_field: cell for cell in cells})


def _dataset(dataset_id, records):
    return SimpleNamespace(dataset_id=dataset_id, records=records)


def _overview(label, value, page=None):
    return _record(_cell("contract.overview.label", "Field", label),
                   _cell("contract.overview.value", "Value", value, page))


def _contract_workbook():
    """The shape of a persisted contract_v3 workbook (SF 1442 award)."""

    lines = [
        _record(_cell("contract.line.item_number", "ITEM NO", clin, page),
                _cell("contract.line.description", "SUPPLIES/SERVICES", f"{title}\nFFP\nlong text", page),
                _cell("contract.line.amount", "MAX AMOUNT", amount, page))
        for clin, title, amount, page in [
            ("0001", "Base Period - SB-DBMACC", "$600,000,000.00 NTE", 4),
            ("0002", "OPTION First Option Period", "NSP", 5),
        ]
    ]
    return SimpleNamespace(
        profile=SimpleNamespace(profile_id="contract_v3"),
        datasets=[
            _dataset("contract_overview", [
                _overview("Contract Number", "N4019223D2803", 1),
                _overview("Award Date", "29-Sep-2023", 2),
                _overview("Issued By", "COMMANDING OFFICER - NAVFAC MARIANAS", 1),
                _overview("Contractor", "CHUGACH CONSOLIDATED SOLUTIONS, LLC", 2),
                _overview("Award Amount", "$600,000,000.00", 2),
                _overview("Minimum Guarantee", "$25,000", 3),
                _overview("NAICS", "236220", 3),
                _overview("FAR Clauses", "131"),
                _overview("DFARS Clauses", "52"),
            ]),
            _dataset("contract_summary", [_record(
                _cell("contract.contract_number", "Contract Number", "N4019223D2803", 1),
                _cell("contract.contract_vehicle", "Contract Vehicle", "SB-DBMACC", 4),
            )]),
            _dataset("line_items", lines),
            _dataset("funding", []),
            _dataset("performance_delivery", [_record(_cell("contract.performance.clin", "CLIN", "0001", 4))] * 4),
        ],
    )


@pytest.fixture
def staged_contract(monkeypatch):
    database = SessionLocal()
    document_id = _document(database, "SF1442 Award_N4019223D2803.pdf")
    # A stale V3 summary disagreeing with the workbook: the workbook wins,
    # V3 fills only what the workbook lacks (Base Period).
    database.add(DocumentContractSummary(
        document_id=document_id, contract_number="WRONG-V3", contractor=None, award_date=None,
        base_period="Five years", field_provenance_json={"Base Period": {"page": 9}}, confidence=0.6,
    ))
    database.add(DocumentLineItem(document_id=document_id, row_index=0, clin="9999", description="V3 only",
                                  amount=1.0, is_maximum=False, confidence=0.5, evidence_json={}))
    database.commit()
    monkeypatch.setattr(document_actions._ContractData, "_load_workbook",
                        staticmethod(lambda db, doc_id: _contract_workbook()))
    try:
        yield database, document_id
    finally:
        database.delete(database.get(Document, document_id))
        database.commit()
        database.close()


def test_executive_summary_reads_the_persisted_staging_workbook_first(staged_contract, services):
    database, document_id = staged_contract
    result = run_action(database, document_id, "executive_summary")
    identification = {fact["label"]: fact for fact in _section(result, "Contract identification")["facts"]}
    assert identification["Contract Number"]["value"] == "N4019223D2803"  # not the stale V3 value
    assert identification["Contract Number"]["page"] == 1
    assert identification["Issuing Office / Agency"]["value"] == "COMMANDING OFFICER - NAVFAC MARIANAS"
    assert identification["Contractor"] == {"label": "Contractor", "value": "CHUGACH CONSOLIDATED SOLUTIONS, LLC", "page": 2}
    assert identification["Award Date"]["value"] == "29-Sep-2023"
    assert identification["NAICS"]["value"] == "236220"
    assert identification["Contract Vehicle"]["value"] == "SB-DBMACC"
    value_term = {fact["label"]: fact for fact in _section(result, "Value and term")["facts"]}
    assert value_term["Award Amount"] == {"label": "Award Amount", "value": "$600,000,000.00", "page": 2}
    assert value_term["Base Period"] == {"label": "Base Period", "value": "Five years", "page": 9}  # V3 fallback
    glance = {fact["label"]: fact["value"] for fact in _section(result, "At a glance")["facts"]}
    assert glance["CLINs / line items"] == "2"  # workbook CLINs; V3 line items unused
    assert glance["Priced total"] is None
    assert glance["Not-to-exceed (maximum) total"] == "$600,000,000.00"
    assert glance["FAR clauses"] == "131" and glance["DFARS clauses"] == "52"
    assert glance["Performance / delivery records"] == "4"


def test_risk_register_key_fields_and_funding_use_the_workbook(staged_contract, services):
    database, document_id = staged_contract
    rows = _section(run_action(database, document_id, "risk_register"), "Risks")["rows"]
    assert not any(row["source"] == "Missing key field" for row in rows)
    # No funding records at all is not "every CLIN unfunded".
    assert not any(row["source"] == "Funding gap" for row in rows)


def test_funding_reconciliation_uses_workbook_line_items(staged_contract, services):
    database, document_id = staged_contract
    catalog = {item["action_id"]: item for item in available_actions(database, document_id)}
    assert catalog["funding_reconciliation"]["available"]
    result = run_action(database, document_id, "funding_reconciliation")
    rows = {row["clin"]: row for row in _section(result, "By CLIN")["rows"]}
    assert set(rows) == {"0001", "0002"}
    assert rows["0001"]["flag"] == "Not-to-exceed only"
    assert rows["0001"]["stated"] == "$600,000,000.00 NTE"
    assert rows["0001"]["description"] == "Base Period - SB-DBMACC"
    assert rows["0001"]["page"] == 4
    assert rows["0002"]["flag"] == "No price stated" and rows["0002"]["stated"] == "NSP"
    totals = {fact["label"]: fact for fact in _section(result, "Totals")["facts"]}
    assert totals["Award Amount"]["value"] == "$600,000,000.00"
    assert totals["Minimum Guarantee"] == {"label": "Minimum Guarantee", "value": "$25,000", "page": 3}
    assert any("No funding records" in warning for warning in result["warnings"])


def test_risk_register_includes_failed_validation_rules(contract, services, monkeypatch):
    database, document_id = contract
    validation = types.ModuleType("app.services.validation_rules")
    validation.evaluate_document = lambda database, document_id, workspace, data=None: {
        "document_id": document_id, "applicable": True,
        "results": [
            {"rule_id": "r1", "name": "UEI is 12 characters", "rule_type": "regex", "severity": "high",
             "status": "fail", "detail": "UEI “1ABC” does not match [A-Z0-9]{12}.", "value": "1ABC", "page": 1},
            {"rule_id": "r2", "name": "NAICS present", "rule_type": "required_field", "severity": "low",
             "status": "pass", "detail": "NAICS is present.", "value": "236220", "page": 3},
        ],
        "summary": {"fail": 1, "missing": 0, "pass": 1},
    }
    monkeypatch.setitem(sys.modules, "app.services.validation_rules", validation)
    rows = _section(run_action(database, document_id, "risk_register"), "Risks")["rows"]
    failed = [row for row in rows if row["source"] == "Validation rule"]
    assert len(failed) == 1
    assert failed[0]["risk"] == "Validation rule failed: UEI is 12 characters"
    assert failed[0]["severity"] == "high" and failed[0]["page"] == 1 and failed[0]["evidence"] == "1ABC"
