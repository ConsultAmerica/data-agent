"""RBAC + actor-aware audit + Oracle send authorization certification."""

from __future__ import annotations

from uuid import uuid4

import fitz
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.rbac import role_has_permission
from app.database.session import SessionLocal
from app.main import app
from app.models.document_metadata_field import DocumentMetadataField
from app.models.integration_audit_log import IntegrationAuditLog
from app.models.metadata_field_audit_log import MetadataFieldAuditLog
from app.core.config import get_settings

client = TestClient(app)


def _pdf() -> bytes:
    pdf = fitz.open()
    page = pdf.new_page()
    page.insert_text((72, 72), "Total Amount: $125,000", fontsize=10)
    content = pdf.tobytes()
    pdf.close()
    return content


def _upload() -> str:
    response = client.post(
        "/api/documents/upload",
        files={"file": (f"rbac-{uuid4()}.pdf", _pdf(), "application/pdf")},
    )
    assert response.status_code == 201, response.text
    return response.json()["document_id"]


def _seed_field(
    document_id: str,
    *,
    review_status: str = "edited",
    value: str = "$125,000",
    machine: str = "$120,000",
    key: str = "total_amount",
) -> None:
    database: Session = SessionLocal()
    try:
        database.add(
            DocumentMetadataField(
                document_id=document_id,
                field_group="Financial",
                field_key=key,
                label="Total Amount" if key == "total_amount" else key,
                value=value,
                original_value=machine,
                confidence=0.9,
                confidence_band="high",
                value_type="currency",
                extraction_method="label_value",
                evidence_json={
                    "page_number": 1,
                    "source_text": f"{key}: {machine}",
                    "source_reference": "page 1",
                    "machine_value": machine,
                    "validation": {"status": "passed"},
                },
                verified=True,
                review_status=review_status,
                extraction_source="target",
                human_approved=review_status in {"accepted", "edited"},
            )
        )
        database.commit()
    finally:
        database.close()


def test_role_permission_matrix() -> None:
    assert role_has_permission("admin", "oracle.send")
    assert role_has_permission("admin", "admin.users")
    assert role_has_permission("reviewer", "review.accept")
    assert not role_has_permission("reviewer", "oracle.send")
    assert role_has_permission("analyst", "extraction.run")
    assert not role_has_permission("analyst", "review.accept")
    assert role_has_permission("viewer", "documents.view")
    assert not role_has_permission("viewer", "export.read")
    assert role_has_permission("service_account", "oracle.send")


def test_viewer_cannot_export() -> None:
    document_id = _upload()
    _seed_field(document_id)
    response = client.get(
        f"/api/documents/{document_id}/export",
        headers={"X-Actor-Id": "actor-viewer-default"},
    )
    assert response.status_code == 403
    assert "export.read" in response.json()["detail"]


def test_reviewer_can_accept_but_not_oracle_send() -> None:
    document_id = _upload()
    _seed_field(document_id, review_status="pending", value="$120,000")

    accept = client.post(
        f"/api/documents/{document_id}/targets/total_amount/corrections",
        headers={"X-Actor-Id": "actor-reviewer-default"},
        json={"action": "verify", "original_value": "$120,000"},
    )
    assert accept.status_code == 201, accept.text

    database = SessionLocal()
    try:
        audit = database.scalar(
            select(MetadataFieldAuditLog).where(
                MetadataFieldAuditLog.document_id == document_id,
                MetadataFieldAuditLog.action == "accept",
            )
        )
        assert audit is not None
        assert audit.actor_id == "actor-reviewer-default"
        assert audit.actor_type == "user"
        assert audit.actor_role == "reviewer"
        assert audit.changed_by == "Default Reviewer"
    finally:
        database.close()

    send = client.post(
        f"/api/documents/{document_id}/oracle-send",
        headers={"X-Actor-Id": "actor-reviewer-default"},
        json={"confirm": True},
    )
    assert send.status_code == 403
    assert "oracle.send" in send.json()["detail"]


def test_analyst_cannot_accept() -> None:
    document_id = _upload()
    _seed_field(document_id, review_status="pending")
    response = client.post(
        f"/api/documents/{document_id}/targets/total_amount/corrections",
        headers={"X-Actor-Id": "actor-analyst-default"},
        json={"action": "verify", "original_value": "$125,000"},
    )
    assert response.status_code == 403
    assert "review.accept" in response.json()["detail"]


def test_oracle_send_requires_confirm_and_clean_authoritative_set() -> None:
    document_id = _upload()
    _seed_field(document_id, review_status="edited")
    _seed_field(
        document_id,
        key="vendor_name",
        review_status="pending",
        value="Acme",
        machine="Acme",
    )

    # Missing confirm
    missing = client.post(
        f"/api/documents/{document_id}/oracle-send",
        headers={"X-Actor-Id": "actor-admin-default"},
        json={"confirm": False},
    )
    assert missing.status_code == 400

    # Pending still present → 409
    dirty = client.post(
        f"/api/documents/{document_id}/oracle-send",
        headers={"X-Actor-Id": "actor-admin-default"},
        json={"confirm": True},
    )
    assert dirty.status_code == 409

    # Accept pending via admin, then send
    client.post(
        f"/api/documents/{document_id}/targets/vendor_name/corrections",
        headers={"X-Actor-Id": "actor-admin-default"},
        json={"action": "verify", "original_value": "Acme"},
    )

    sent = client.post(
        f"/api/documents/{document_id}/oracle-send",
        headers={"X-Actor-Id": "actor-admin-default"},
        json={"confirm": True},
    )
    assert sent.status_code == 200, sent.text
    body = sent.json()
    assert body["status"] == "simulated"
    assert body["dry_run"] is True
    assert body["actor"]["actor_id"] == "actor-admin-default"
    assert body["request_snapshot"]["authoritative_count"] == 2
    assert "total_amount" in body["request_snapshot"]["contract_header"]

    database = SessionLocal()
    try:
        row = database.scalar(
            select(IntegrationAuditLog).where(
                IntegrationAuditLog.document_id == document_id
            )
        )
        assert row is not None
        assert row.action == "dry_run"
        assert row.status == "simulated"
        assert row.actor_id == "actor-admin-default"
        assert row.actor_role == "admin"
        assert row.request_snapshot is not None
        assert row.response_snapshot is not None
        assert row.request_snapshot["contract_header"]["total_amount"] == "$125,000"
    finally:
        database.close()

    trail = client.get(
        f"/api/documents/{document_id}/integration-audit",
        headers={"X-Actor-Id": "actor-admin-default"},
    )
    assert trail.status_code == 200
    assert len(trail.json()) == 1


def test_service_account_bearer_can_send() -> None:
    document_id = _upload()
    _seed_field(document_id, review_status="accepted", value="$125,000")

    response = client.post(
        f"/api/documents/{document_id}/oracle-send",
        headers={"Authorization": f"Bearer {get_settings().seed_service_api_key}"},
        json={"confirm": True},
    )
    assert response.status_code == 200, response.text
    assert response.json()["actor"]["actor_role"] == "service_account"


def test_actors_me_and_admin_list() -> None:
    me = client.get(
        "/api/actors/me",
        headers={"X-Actor-Id": "actor-reviewer-default"},
    )
    assert me.status_code == 200
    assert me.json()["role"] == "reviewer"
    assert "review.accept" in me.json()["permissions"]

    denied = client.get(
        "/api/actors",
        headers={"X-Actor-Id": "actor-reviewer-default"},
    )
    assert denied.status_code == 403

    allowed = client.get(
        "/api/actors",
        headers={"X-Actor-Id": "actor-admin-default"},
    )
    assert allowed.status_code == 200
    roles = {row["role"] for row in allowed.json()}
    assert roles >= {"admin", "reviewer", "analyst", "viewer", "service_account"}


def test_oracle_preview_never_sets_send_allowed() -> None:
    document_id = _upload()
    _seed_field(document_id, review_status="accepted")
    preview = client.get(
        f"/api/documents/{document_id}/oracle-payload",
        headers={"X-Actor-Id": "actor-admin-default"},
    )
    assert preview.status_code == 200
    body = preview.json()
    assert body["send_allowed"] is False
    assert body["actor"]["can_send"] is True
