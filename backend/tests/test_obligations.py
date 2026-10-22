from datetime import date, datetime, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import delete, select

from app.api.obligations import portfolio_router, router
from app.database.session import SessionLocal
from app.main import app
from app.models.document import Document
from app.models.document_clause_reference import DocumentClauseReference
from app.models.document_contract_summary import DocumentContractSummary
from app.models.document_delivery_schedule import DocumentDeliverySchedule
from app.models.document_line_item import DocumentLineItem
from app.models.document_page import DocumentPage
from app.models.document_performance_period import DocumentPerformancePeriod
from app.models.document_staging_workbook import DocumentStagingWorkbook
from app.services.obligations import (
    build_document_obligations,
    build_portfolio_obligations,
)

TODAY = date(2026, 10, 21)
CHILD_MODELS = (
    DocumentClauseReference,
    DocumentContractSummary,
    DocumentDeliverySchedule,
    DocumentLineItem,
    DocumentPage,
    DocumentPerformancePeriod,
    DocumentStagingWorkbook,
)


def _document(database, name: str) -> str:
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
            uploaded_at=datetime(2026, 9, 1, tzinfo=timezone.utc),
        )
    )
    return document_id


@pytest.fixture
def contract():
    database = SessionLocal()
    ids: list[str] = []
    try:
        contract_id = _document(database, "contract.pdf")
        empty_id = _document(database, "memo.pdf")
        ids = [contract_id, empty_id]
        database.flush()
        database.add(DocumentContractSummary(
            document_id=contract_id, award_date="04/15/2025", base_period="5 years",
            options="1 option period(s) of 5 years", field_provenance_json={}, confidence=0.9,
        ))
        database.add(DocumentPerformancePeriod(
            document_id=contract_id, row_index=0, period_label="Base Period", start_date="2025-11-01",
            end_date="2026-11-10", confidence=0.9, evidence_json={"page_number": 4, "source_text": "Base Period 11/01/2025 - 11/10/2026"},
        ))
        database.add(DocumentPerformancePeriod(
            document_id=contract_id, row_index=1, period_label="Old Period", end_date="2024-01-01",
            confidence=0.9, evidence_json={},
        ))
        database.add(DocumentDeliverySchedule(
            document_id=contract_id, row_index=0, clin="0001", delivery_date="2026-10-01", quantity=12,
            confidence=0.8, evidence_json={"page_number": 5},
        ))
        database.add(DocumentLineItem(
            document_id=contract_id, row_index=0, clin="1001", description="Option Year 1 services",
            option_base="Option", pop_start="2027-01-01", pop_end="2027-12-31", is_maximum=False,
            confidence=0.85, evidence_json={"page_number": 3},
        ))
        for index, number in enumerate(["252.204-7012", "52.222-37", "52.222-37", "52.999-1"]):
            database.add(DocumentClauseReference(
                document_id=contract_id, row_index=index, clause_family="FAR", citation_context="listing",
                clause_number=number, title="x", confidence=0.9, evidence_json={"page_number": 9},
            ))
        database.add(DocumentPage(
            document_id=contract_id, page_number=12, page_width=612, page_height=792,
            final_text=(
                "The Contractor shall provide all management, supervision and labor necessary to perform. "
                "The Contractor shall submit the monthly status report to the COR within 10 calendar days after the end of each month. "
                "The Contractor shall notify the Contracting Officer no later than December 15, 2026, of any key personnel change."
            ),
        ))
        database.commit()
        yield database, contract_id, empty_id
    finally:
        for model in CHILD_MODELS:
            database.execute(delete(model).where(model.document_id.in_(ids)))
        database.execute(delete(Document).where(Document.id.in_(ids)))
        database.commit()
        database.close()


def _by_title(items):
    return {item["title"]: item for item in items}


def test_schedule_summary_and_clause_obligations(contract):
    database, contract_id, _ = contract
    items = _by_title(build_document_obligations(database, contract_id, today=TODAY))

    base_end = items["Base Period ends"]
    assert base_end["due_date"] == "2026-11-10"
    assert base_end["status"] == "due_soon"
    assert base_end["page"] == 4
    assert base_end["source_type"] == "schedule"

    delivery = items["Deliver CLIN 0001 (12 units)"]
    assert delivery["status"] == "overdue"
    assert delivery["category"] == "deliverable"

    option = items["Option decision for CLIN 1001"]
    assert option["responsible_party"] == "government"
    assert option["due_date"] == "2026-12-31"  # the day before the option period starts
    assert option["status"] == "upcoming"

    # Award 2025-04-15 + 5 years → last day of the base period (V3 summary
    # fallback: this document has no staging workbook).
    assert items["Base period ends"]["due_date"] == "2030-04-14"
    # Option CLINs carry the option decisions; no summary-level duplicate.
    assert "Option exercise decision" not in items

    cyber = items["Report cyber incidents to DoD"]
    assert cyber["trigger"] == "within 72 hours of discovery"
    assert cyber["source_reference"] == "DFARS 252.204-7012"
    assert cyber["status"] == "ongoing"

    vets = items["File VETS-4212 report"]
    assert vets["due_date"] == "2027-09-30"  # next Sept 30 on or after today
    assert vets["recurrence"] == "annually"
    assert sum(1 for item in items.values() if item["source_reference"] == "FAR 52.222-37") == 1

    # Lapsed milestones and unknown clauses are not obligations.
    assert "Old Period ends" not in items
    assert not any(item["source_reference"] == "FAR 52.999-1" for item in items.values())


def test_text_mining_keeps_duties_with_timing_and_skips_scope(contract):
    database, contract_id, _ = contract
    text_items = [item for item in build_document_obligations(database, contract_id, today=TODAY) if item["source_type"] == "text"]
    titles = [item["title"] for item in text_items]

    assert not any("management" in title.lower() for title in titles)
    report = next(item for item in text_items if item["title"].startswith("Submit the monthly status report"))
    assert report["recurrence"] == "monthly"
    assert report["category"] == "reporting"
    assert report["trigger"].startswith("within 10 calendar days")
    assert report["page"] == 12

    notice = next(item for item in text_items if item["title"].startswith("Notify the Contracting Officer"))
    assert notice["due_date"] == "2026-12-15"
    assert notice["category"] == "notification"
    assert notice["status"] == "upcoming"


def test_obligation_ids_are_stable(contract):
    database, contract_id, _ = contract
    first = [item["obligation_id"] for item in build_document_obligations(database, contract_id, today=TODAY)]
    second = [item["obligation_id"] for item in build_document_obligations(database, contract_id, today=TODAY)]
    assert first == second
    assert len(first) == len(set(first))


def test_portfolio_counts_and_sparse_document(contract):
    database, contract_id, empty_id = contract
    assert build_document_obligations(database, empty_id, today=TODAY) == []

    result = build_portfolio_obligations(database, select(Document.id).where(Document.id.in_([contract_id, empty_id])), today=TODAY)
    counts = result["counts"]
    assert counts["total"] == len(result["obligations"]) > 0
    assert counts["overdue"] >= 1 and counts["due_soon"] >= 1
    assert sum(counts[key] for key in ("overdue", "due_soon", "upcoming", "ongoing", "undated")) == counts["total"]
    # Most urgent first.
    assert result["obligations"][0]["status"] == "overdue"
    assert {entry["name"] for entry in result["by_category"]} >= {"deliverable", "option", "reporting"}


def test_endpoints(contract):
    _, contract_id, _ = contract
    probe = type(app)()  # a bare FastAPI app: the shared app mounts the router later
    probe.include_router(router, prefix="/api/documents")
    probe.include_router(portfolio_router, prefix="/api/obligations")
    client = TestClient(probe)

    response = client.get(f"/api/documents/{contract_id}/obligations")
    assert response.status_code == 200
    body = response.json()
    assert body["document_id"] == contract_id
    assert body["obligations"]

    assert client.get("/api/documents/missing-id/obligations").status_code == 404

    filtered = client.get("/api/obligations", params={"document_id": contract_id, "category": "option"}).json()
    assert filtered["obligations"]
    assert all(item["category"] == "option" and item["document_id"] == contract_id for item in filtered["obligations"])
    assert filtered["counts"]["total"] == len(filtered["obligations"])


def _cell(value, page=None, evidence=None):
    return SimpleNamespace(value=value, provenance=SimpleNamespace(source_page=page, evidence_text=evidence))


def _record(cells: dict):
    return SimpleNamespace(cells=cells)


def _staged_contract_workbook():
    """The shape of a persisted contract_v3 workbook (SF1442 award)."""

    summary = _record({"contract.award_date": _cell("29-Sep-2023", 1, "31C. AWARD DATE -> 29-Sep-2023"), "contract.options": _cell(None)})
    data = [
        _record({"contract.data.record_type": _cell("Field"), "contract.data.record_id": _cell("performance_start"),
                 "contract.data.value": _cell("Award", 2, "Performance Start: Award")}),
    ]
    for clin, title, page in [("0001", "Base Period - SB-DBMACC", 4), ("0002", "OPTION First Option Period", 5), ("0003", "OPTION Second Option Period", 6)]:
        data.append(_record({"contract.data.record_type": _cell("CLIN"), "contract.data.record_id": _cell(clin),
                             "contract.data.clin": _cell(clin, page), "contract.data.title": _cell(title, page, title)}))
    delivery = [
        _record({"contract.delivery.clin": _cell("0001"), "contract.delivery.delivery_date": _cell("POP 29-SEP-2023 TO 28-SEP-2028", 7, "POP 29-SEP-2023 TO 28-SEP-2028"),
                 "contract.delivery.quantity": _cell("N/A")}),
        _record({"contract.delivery.clin": _cell("0002"), "contract.delivery.delivery_date": _cell("N/A")}),
        _record({"contract.delivery.clin": _cell("0009"), "contract.delivery.delivery_date": _cell("15-Nov-2026", 8, "0009 15-NOV-2026"),
                 "contract.delivery.quantity": _cell("2")}),
    ]
    return SimpleNamespace(datasets=[
        SimpleNamespace(dataset_id="contract_summary", records=[summary]),
        SimpleNamespace(dataset_id="contract_data", records=data),
        SimpleNamespace(dataset_id="delivery_information", records=delivery),
    ])


def test_staging_workbook_is_the_primary_schedule_source(contract, monkeypatch):
    database, contract_id, _ = contract
    database.add(DocumentStagingWorkbook(document_id=contract_id, profile_id="contract_v3", profile_version=3,
                                         document_family="contract", document_family_label="Contract", resolution_reasons=[]))
    database.commit()
    import app.staging.service as staging_service

    monkeypatch.setattr(staging_service, "get_staging_workbook", lambda _db, _id: _staged_contract_workbook())
    items = build_document_obligations(database, contract_id, today=TODAY)
    by_title = _by_title(items)

    base_end = by_title["Base period ends (CLIN 0001)"]
    assert base_end["due_date"] == "2028-09-28"
    assert base_end["page"] == 7 and "POP 29-SEP-2023" in base_end["evidence"]

    first_option = by_title["Option decision for CLIN 0002"]
    assert first_option["due_date"] == "2028-09-28"  # decided before the base period ends
    assert first_option["page"] == 5
    second_option = by_title["Option decision for CLIN 0003"]
    assert second_option["due_date"] is None and second_option["trigger"]

    delivery = by_title["Deliver CLIN 0009 (2 units)"]
    assert delivery["due_date"] == "2026-11-15" and delivery["status"] == "due_soon" and delivery["page"] == 8

    # Workbook award date wins over the V3 summary's; V3 line items/delivery
    # rows for CLINs the workbook covers are not duplicated, others still count.
    assert "Base period ends" not in by_title  # base end comes from the CLIN POP
    assert "Option decision for CLIN 1001" in by_title  # V3-only CLIN kept as fallback
    assert "Deliver CLIN 0001 (12 units)" in by_title  # V3 delivery: workbook has no delivery date for 0001


def test_workbook_is_not_loaded_for_unpinned_documents(contract, monkeypatch):
    database, contract_id, _ = contract
    import app.staging.service as staging_service

    def boom(*_args):
        raise AssertionError("must not build or pin a workbook")

    monkeypatch.setattr(staging_service, "get_staging_workbook", boom)
    assert build_document_obligations(database, contract_id, today=TODAY)
