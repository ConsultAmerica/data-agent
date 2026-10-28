"""Approve/promote are review mutations: gated, permission-checked, and
attributed to the authenticated actor."""

from __future__ import annotations

from unittest.mock import patch
from uuid import uuid4

import fitz
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import app

client = TestClient(app)


def _upload() -> str:
    pdf = fitz.open()
    pdf.new_page().insert_text((72, 72), f"Governing Law: Delaware {uuid4()}", fontsize=10)
    content = pdf.tobytes()
    pdf.close()
    response = client.post(
        "/api/documents/upload",
        files={"file": (f"events-{uuid4()}.pdf", content, "application/pdf")},
    )
    assert response.status_code in {200, 201}, response.text
    return response.json()["document_id"]


@pytest.mark.parametrize("action", ["approve", "promote"])
def test_document_review_events_fail_closed_when_gate_disabled(action: str) -> None:
    document_id = _upload()
    gated = Settings(app_env="development", metadata_review_mutations_enabled=False)
    with patch("app.core.feature_gates.get_settings", return_value=gated):
        response = client.post(f"/api/documents/{document_id}/{action}", json={})
    assert response.status_code == 403, response.text


@pytest.mark.parametrize("action", ["approve", "promote"])
@pytest.mark.parametrize("actor_id", ["actor-viewer-default", "actor-analyst-default"])
def test_document_review_events_need_review_permission(action: str, actor_id: str) -> None:
    document_id = _upload()
    response = client.post(
        f"/api/documents/{document_id}/{action}",
        json={"changed_by": "Someone Else"},
        headers={"X-Actor-Id": actor_id},
    )
    assert response.status_code == 403, response.text
    assert "review.accept" in response.text


def test_reviewer_passes_the_permission_check() -> None:
    document_id = _upload()
    response = client.post(
        f"/api/documents/{document_id}/approve",
        json={},
        headers={"X-Actor-Id": "actor-reviewer-default"},
    )
    # Not ready to approve (nothing reviewed) — but past the permission gate.
    assert response.status_code == 409, response.text


def test_document_events_are_readable_from_the_audit_log() -> None:
    """approve/promote/delete rows must serialize through the audit APIs."""

    from app.database.session import SessionLocal
    from app.models.metadata_field_audit_log import DOCUMENT_EVENT_FIELD_KEY, MetadataFieldAuditLog

    document_id = _upload()
    database = SessionLocal()
    try:
        for action in ("approve", "promote"):
            database.add(
                MetadataFieldAuditLog(
                    document_id=document_id, field_key=DOCUMENT_EVENT_FIELD_KEY,
                    action=action, actor_id="actor-admin-default", changed_by="Dev Admin",
                )
            )
        database.commit()
    finally:
        database.close()

    log = client.get("/api/documents/audit-log", params={"document_id": document_id})
    assert log.status_code == 200, log.text
    assert {e["action"] for e in log.json()["entries"]} == {"approve", "promote"}


def test_an_unexpected_audit_action_does_not_break_the_audit_log() -> None:
    from app.database.session import SessionLocal
    from app.models.metadata_field_audit_log import MetadataFieldAuditLog

    document_id = _upload()
    database = SessionLocal()
    try:
        database.add(
            MetadataFieldAuditLog(
                document_id=document_id, field_key="note", action="comment", changed_by="someone"
            )
        )
        database.commit()
    finally:
        database.close()
    log = client.get("/api/documents/audit-log", params={"document_id": document_id})
    assert log.status_code == 200, log.text
    assert [e["action"] for e in log.json()["entries"]] == ["comment"]
