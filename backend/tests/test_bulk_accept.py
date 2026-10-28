"""Accept-all accepts only low-risk values; flagged values stay pending
unless an admin overrides with a reason."""

from __future__ import annotations

from uuid import uuid4

import fitz
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database.session import SessionLocal
from app.main import app
from app.models.document_metadata_field import DocumentMetadataField
from app.models.metadata_field_audit_log import MetadataFieldAuditLog

client = TestClient(app)

CLEAN = {
    "page_number": 1,
    "source_text": "Governing Law: Delaware",
    "review_decision": {"status": "ready_to_accept", "priority": "high", "reasons": []},
}


def _upload() -> str:
    pdf = fitz.open()
    pdf.new_page().insert_text((72, 72), f"Governing Law: Delaware {uuid4()}", fontsize=10)
    content = pdf.tobytes()
    pdf.close()
    response = client.post(
        "/api/documents/upload",
        files={"file": (f"bulk-{uuid4()}.pdf", content, "application/pdf")},
    )
    assert response.status_code in {200, 201}, response.text
    return response.json()["document_id"]


def _seed(document_id: str, rows: dict[str, tuple[float, dict]]) -> None:
    database = SessionLocal()
    try:
        for key, (confidence, evidence) in rows.items():
            database.add(
                DocumentMetadataField(
                    document_id=document_id,
                    field_group="Legal",
                    field_key=key,
                    label=key,
                    value="Delaware",
                    original_value="Delaware",
                    confidence=confidence,
                    extraction_method="label_value",
                    evidence_json=evidence,
                    review_status="pending",
                    extraction_source="contract",
                )
            )
        database.commit()
    finally:
        database.close()


def _statuses(document_id: str) -> dict[str, str]:
    database = SessionLocal()
    try:
        rows = database.scalars(
            select(DocumentMetadataField).where(DocumentMetadataField.document_id == document_id)
        )
        return {row.field_key: row.review_status for row in rows}
    finally:
        database.close()


def _seed_mixed(document_id: str) -> None:
    _seed(
        document_id,
        {
            "clean": (0.95, CLEAN),
            "low_confidence": (0.70, CLEAN),
            "flagged": (
                0.95,
                {**CLEAN, "review_decision": {"status": "needs_review", "reasons": ["ambiguous_candidates"]}},
            ),
            "no_evidence": (0.95, {**CLEAN, "page_number": 0, "source_text": ""}),
            "failed_validation": (0.95, {**CLEAN, "validation_status": "failed"}),
        },
    )


def test_accept_all_accepts_only_low_risk_values() -> None:
    document_id = _upload()
    _seed_mixed(document_id)

    response = client.post(f"/api/documents/{document_id}/metadata-fields/accept-all", json={})
    assert response.status_code == 200, response.text

    assert _statuses(document_id) == {
        "clean": "accepted",
        "low_confidence": "pending",
        "flagged": "pending",
        "no_evidence": "pending",
        "failed_validation": "pending",
    }


def test_flagged_values_need_admin_override_with_reason() -> None:
    document_id = _upload()
    _seed_mixed(document_id)
    url = f"/api/documents/{document_id}/metadata-fields/accept-all"

    no_reason = client.post(url, json={"include_flagged": True})
    assert no_reason.status_code == 400

    reviewer = client.post(
        url,
        json={"include_flagged": True, "override_reason": "spot-checked"},
        headers={"X-Actor-Id": "actor-reviewer-default"},
    )
    assert reviewer.status_code == 403
    assert set(_statuses(document_id).values()) == {"pending"}

    admin = client.post(url, json={"include_flagged": True, "override_reason": "spot-checked"})
    assert admin.status_code == 200, admin.text
    assert set(_statuses(document_id).values()) == {"accepted"}

    database = SessionLocal()
    try:
        reasons = set(
            database.scalars(
                select(MetadataFieldAuditLog.reason).where(
                    MetadataFieldAuditLog.document_id == document_id
                )
            )
        )
    finally:
        database.close()
    assert reasons == {"Bulk accept (admin override): spot-checked"}
