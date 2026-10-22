"""Field-level review queue API."""

from __future__ import annotations

from uuid import uuid4

import fitz
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.database.session import SessionLocal
from app.main import app
from app.models.document_metadata_field import DocumentMetadataField

client = TestClient(app)


def _pdf() -> bytes:
    pdf = fitz.open()
    page = pdf.new_page()
    page.insert_text((72, 72), "Contract Number: W912DR-26-C-0042", fontsize=10)
    content = pdf.tobytes()
    pdf.close()
    return content


def test_review_queue_fields_lists_pending_with_reasons() -> None:
    upload = client.post(
        "/api/documents/upload",
        files={"file": (f"rq-{uuid4()}.pdf", _pdf(), "application/pdf")},
    )
    assert upload.status_code == 201
    document_id = upload.json()["document_id"]

    database: Session = SessionLocal()
    try:
        database.add(
            DocumentMetadataField(
                document_id=document_id,
                field_group="Identifiers",
                field_key="contract_number",
                label="Contract Number",
                value="W912DR-26-C-0042",
                original_value="W912DR-26-C-0042",
                confidence=0.4,
                confidence_band="low",
                value_type="identifier",
                extraction_method="ai",
                evidence_json={
                    "page_number": 1,
                    "source_text": "Contract Number: W912DR-26-C-0042",
                    "source_reference": "page 1",
                    "review_decision": {
                        "status": "needs_review",
                        "priority": "low",
                        "reasons": ["low_confidence", "ai_escalation"],
                    },
                },
                verified=False,
                review_status="pending",
                extraction_source="target",
            )
        )
        database.commit()
    finally:
        database.close()

    response = client.get("/api/dashboard/review-queue/fields")
    assert response.status_code == 200, response.text
    items = response.json()
    match = next(
        (
            item
            for item in items
            if item["document_id"] == document_id
            and item["field_key"] == "contract_number"
        ),
        None,
    )
    assert match is not None
    assert match["decision_status"] == "needs_review"
    assert "low_confidence" in match["reasons"]
    assert match["reason_labels"]
    assert match["review_href"]
    # Row actions in the queue review the field by its persisted id.
    assert isinstance(match["metadata_field_id"], int)
    review = client.post(
        f"/api/documents/{document_id}/metadata-fields/by-id/{match['metadata_field_id']}/review",
        json={"action": "accept", "value": None, "changed_by": "queue-test"},
    )
    assert review.status_code == 200, review.text
    assert review.json()["review_status"] == "accepted"
