"""Extraction review: original text, corrections, validation and overrides."""

from __future__ import annotations

from uuid import uuid4

import fitz
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database.session import SessionLocal
from app.main import app
from app.models.document_metadata_field import DocumentMetadataField
from app.models.metadata_field_audit_log import MetadataFieldAuditLog
from app.services.evidence_text import source_text_of

client = TestClient(app)

FAILURE = "candidate failed label/value validation"


def _upload() -> str:
    pdf = fitz.open()
    pdf.new_page().insert_text((72, 72), "Invoice Date: 03/14/2026", fontsize=10)
    content = pdf.tobytes()
    pdf.close()
    response = client.post(
        "/api/documents/upload",
        files={"file": (f"review-{uuid4()}.pdf", content, "application/pdf")},
    )
    assert response.status_code == 201, response.text
    return response.json()["document_id"]


def _seed(document_id: str, *, value: str, value_type: str, evidence: dict) -> int:
    database = SessionLocal()
    try:
        field = DocumentMetadataField(
            document_id=document_id,
            field_group="Invoice",
            field_key=f"invoice_date_{uuid4().hex[:6]}",
            label="Invoice Date",
            value=value,
            original_value=value,
            value_type=value_type,
            confidence=0.25,
            extraction_method="unresolved_value_region",
            evidence_json=evidence,
            review_status="pending",
            extraction_source="target",
        )
        database.add(field)
        database.commit()
        return field.id
    finally:
        database.close()


def _unresolved_evidence() -> dict:
    """What extraction stored for an unresolved value before the fix."""

    return {
        "page_number": 1,
        "source_text": FAILURE,
        "source_reference": "page 1",
        "extraction_method": "unresolved_value_region",
        "validation_status": "failed",
        "field_evidence": {"field": "invoice_date", "value": None, "consensus_reason": FAILURE},
        "validation": {"status": "failed", "checks": [], "warnings": [FAILURE]},
        "review_decision": {"status": "needs_review", "reasons": ["validation_failed"]},
        "machine_value": "",
    }


def _failed_date_evidence() -> dict:
    return {
        "page_number": 1,
        "source_text": "Invoice Date: soon",
        "source_reference": "page 1",
        "validation_status": "failed",
        "validation": {
            "status": "failed",
            "checks": [
                {"type": "data_type", "status": "failed", "detail": None},
                {"type": "format", "status": "passed", "detail": None},
            ],
            "warnings": ["Value does not look like a date."],
        },
        "review_decision": {"status": "needs_review", "reasons": ["validation_failed"]},
        "machine_value": "soon",
    }


def _review(document_id: str, field_id: int, **body):
    return client.post(
        f"/api/documents/{document_id}/metadata-fields/by-id/{field_id}/review",
        json={"changed_by": "Test Reviewer", **body},
    )


def _queue_item(field_id: int) -> dict:
    response = client.get("/api/dashboard/review-queue/fields")
    assert response.status_code == 200
    return next(item for item in response.json() if item["metadata_field_id"] == field_id)


def _audit(field_id: int) -> list[MetadataFieldAuditLog]:
    database = SessionLocal()
    try:
        return list(
            database.scalars(
                select(MetadataFieldAuditLog)
                .where(MetadataFieldAuditLog.metadata_field_id == field_id)
                .order_by(MetadataFieldAuditLog.id)
            )
        )
    finally:
        database.close()


def test_validation_message_is_never_shown_as_original_text() -> None:
    assert source_text_of(_unresolved_evidence()) == ""
    assert source_text_of({"source_text": "Invoice Date: 03/14/2026"}) == "Invoice Date: 03/14/2026"

    document_id = _upload()
    field_id = _seed(document_id, value="", value_type="date", evidence=_unresolved_evidence())
    item = _queue_item(field_id)
    assert item["source_snippet"] is None
    assert item["validation"]["status"] == "failed"
    assert item["validation"]["messages"] == [FAILURE]
    assert item["validation"]["blocking"] is True
    # No correction is invented when extraction stored none.
    assert item["validation"]["suggested_value"] is None


def test_unresolved_extraction_writes_no_source_text() -> None:
    from app.schemas.document_target import DocumentTarget
    from app.schemas.extraction_intelligence import RetrievalTrace
    from app.services.target_extraction_service import _needs_review_null_result

    result = _needs_review_null_result(
        target=DocumentTarget(id="doc:issued_by", key="issued_by", label="Issued By", target_type="field", confidence=0.8),
        page=None,
        page_number=2,
        retrieval=RetrievalTrace(target_key="issued_by"),
        reason=FAILURE,
    )
    evidence = result.evidence.model_dump()
    assert evidence["source_text"] == ""
    # The reason is still recorded where it belongs.
    assert evidence["field_evidence"]["consensus_reason"] == FAILURE
    assert result.validation.warnings == [FAILURE]


def test_blocking_validation_prevents_ordinary_approval() -> None:
    document_id = _upload()
    field_id = _seed(document_id, value="soon", value_type="date", evidence=_failed_date_evidence())

    response = _review(document_id, field_id, action="accept")
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert detail["validation"]["failed_rules"][0]["rule"] == "data_type"
    assert _queue_item(field_id)["review_status"] == "pending"
    assert _audit(field_id) == []


def test_override_requires_reason_and_is_audited() -> None:
    document_id = _upload()
    field_id = _seed(document_id, value="soon", value_type="date", evidence=_failed_date_evidence())

    assert _review(document_id, field_id, action="accept", override_reason="   ").status_code == 409

    response = _review(document_id, field_id, action="accept", override_reason="Date is printed as 'soon' on the invoice.")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["review_status"] == "accepted"
    override = body["validation"]["override"]
    assert override["reviewer"] == "Test Reviewer"
    assert override["reason"] == "Date is printed as 'soon' on the invoice."
    assert override["at"]
    assert override["failed_rules"] == ["data_type"]

    [entry] = _audit(field_id)
    assert entry.action == "override_accept"
    assert entry.changed_by == "Test Reviewer"
    assert "data_type" in entry.reason and "printed as 'soon'" in entry.reason
    assert entry.changed_at is not None


def test_save_correction_revalidates_keeps_original_and_does_not_approve() -> None:
    document_id = _upload()
    field_id = _seed(document_id, value="soon", value_type="date", evidence=_failed_date_evidence())

    response = _review(document_id, field_id, action="correct", value="03/14/2026")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["value"] == "03/14/2026"
    assert body["review_status"] == "pending"  # saved, not approved
    assert body["original_value"] == "soon"
    assert body["extracted_value"] == "soon"
    assert body["validation"]["status"] == "passed"
    assert body["validation"]["blocking"] is False

    [entry] = _audit(field_id)
    assert entry.action == "correct"
    assert entry.previous_value == "soon" and entry.new_value == "03/14/2026"
    assert entry.new_status == "pending"

    # Now an ordinary approval goes through.
    assert _review(document_id, field_id, action="accept").status_code == 200


def test_correction_that_still_fails_stays_blocking() -> None:
    document_id = _upload()
    field_id = _seed(document_id, value="soon", value_type="date", evidence=_failed_date_evidence())

    body = _review(document_id, field_id, action="correct", value="later").json()
    assert body["validation"]["status"] == "failed"
    assert body["validation"]["messages"] == ["Value does not look like a date."]
    assert _review(document_id, field_id, action="accept").status_code == 409


def test_correction_rejects_empty_and_unchanged_values() -> None:
    document_id = _upload()
    field_id = _seed(document_id, value="soon", value_type="date", evidence=_failed_date_evidence())

    assert _review(document_id, field_id, action="correct", value="  ").status_code == 400
    assert _review(document_id, field_id, action="correct", value="soon").status_code == 400
    assert _audit(field_id) == []


def test_reject_is_separate_and_never_blocked_by_validation() -> None:
    document_id = _upload()
    field_id = _seed(document_id, value="soon", value_type="date", evidence=_failed_date_evidence())

    response = _review(document_id, field_id, action="reject")
    assert response.status_code == 200
    assert response.json()["review_status"] == "rejected"
