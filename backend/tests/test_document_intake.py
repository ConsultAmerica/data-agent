"""Intake tagging: optional batch/agency/officer/profile fields on upload,
their presence in the documents listing, and the /api/intake batch API
(status changes scoped to the caller's documents)."""

from __future__ import annotations

import secrets
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.intake import router as intake_router
from app.core.auth import workspace_key
from app.core.config import get_settings
from app.database.session import SessionLocal
from app.main import app
from app.models.document import Document
from app.models.document_intake import DocumentIntake

client = TestClient(app)

intake_api = FastAPI()
intake_api.include_router(intake_router, prefix="/api/intake")
intake_client = TestClient(intake_api)


@contextmanager
def enforced():
    settings = get_settings().model_copy(update={"rbac_enforced": True, "public_workspace_access": True})
    with patch("app.core.auth.get_settings", return_value=settings):
        yield


def _upload(data: dict | None = None) -> tuple[int, dict]:
    marker = uuid4().hex
    # Unique bytes per call: identical content would hit duplicate detection.
    content = f"Contract intake test {marker}\nAgency notice.".encode()
    response = client.post(
        "/api/documents/upload",
        files={"file": (f"intake-{marker[:8]}.txt", content, "text/plain")},
        data=data or {},
    )
    return response.status_code, response.json()


def _search_row(document_id: str, filename: str) -> dict:
    response = client.get("/api/documents/search", params={"q": filename, "limit": 100})
    assert response.status_code == 200
    rows = [row for row in response.json()["documents"] if row["document_id"] == document_id]
    assert rows, "uploaded document missing from search"
    return rows[0]


def _document(database, owner: str | None, batch_id: str, status: str = "draft") -> str:
    document_id = str(uuid4())
    database.add(
        Document(
            id=document_id,
            original_filename=f"batch-{document_id[:8]}.pdf",
            stored_filename=f"{document_id}.pdf",
            content_type="application/pdf",
            size_bytes=100,
            checksum_sha256=uuid4().hex,
            page_count=4,
            encrypted=False,
            status="ready",
            processing_status="completed",
            uploaded_at=datetime(2026, 10, 1, tzinfo=timezone.utc),
            owner_workspace=owner,
        )
    )
    database.flush()
    database.add(
        DocumentIntake(
            document_id=document_id,
            batch_id=batch_id,
            agency="GSA",
            contracting_officer="J. Doe",
            extraction_profile="auto",
            intake_status=status,
            created_by="test",
        )
    )
    database.commit()
    return document_id


def test_upload_with_intake_fields_is_listed_with_them():
    batch_id = f"b-{uuid4().hex[:12]}"
    status, body = _upload(
        {
            "batch_id": batch_id,
            "agency": "  Department of   the Navy ",
            "contracting_officer": "Jane Smith",
            "extraction_profile": "contract_v3",
        }
    )
    assert status == 201, body
    assert "Recorded intake tags" in body["pipeline_log"]

    row = _search_row(str(body["document_id"]), body["original_filename"])
    assert row["agency"] == "Department of the Navy"
    assert row["contracting_officer"] == "Jane Smith"
    assert row["batch_id"] == batch_id
    assert row["intake_status"] == "draft"

    with SessionLocal() as database:
        intake = database.get(DocumentIntake, str(body["document_id"]))
        assert intake is not None and intake.extraction_profile == "contract_v3"


def test_upload_without_intake_fields_is_unchanged():
    status, body = _upload()
    assert status == 201, body
    row = _search_row(str(body["document_id"]), body["original_filename"])
    assert row["agency"] is None
    assert row["contracting_officer"] is None
    assert row["batch_id"] is None
    assert row["intake_status"] is None
    with SessionLocal() as database:
        assert database.get(DocumentIntake, str(body["document_id"])) is None


def test_upload_rejects_unknown_profile_and_bad_batch_id():
    status, body = _upload({"extraction_profile": "not_a_profile"})
    assert status == 400
    assert "Unknown extraction profile" in body["detail"]
    status, body = _upload({"batch_id": "../etc"})
    assert status == 400


def test_config_reports_the_real_upload_limit_and_profiles():
    response = intake_client.get("/api/intake/config")
    assert response.status_code == 200
    body = response.json()
    assert body["max_upload_mb"] == get_settings().max_upload_mb
    assert body["profile_override_supported"] is False
    assert "contract_v3" in {profile["profile_id"] for profile in body["profiles"]}


def test_batch_status_changes_every_document_in_the_batch():
    batch_id = f"b-{uuid4().hex[:12]}"
    with SessionLocal() as database:
        ids = {_document(database, None, batch_id), _document(database, None, batch_id)}

    batch = intake_client.get(f"/api/intake/batches/{batch_id}").json()
    assert {row["document_id"] for row in batch["documents"]} == ids
    assert batch["intake_status"] == "draft"
    assert all(row["status"] in {"processing", "review_required", "completed", "failed"} for row in batch["documents"])

    response = intake_client.post(f"/api/intake/batches/{batch_id}/status", json={"status": "submitted"})
    assert response.status_code == 200
    assert set(response.json()["updated"]) == ids
    assert intake_client.get(f"/api/intake/batches/{batch_id}").json()["intake_status"] == "submitted"

    assert intake_client.post(f"/api/intake/batches/{batch_id}/status", json={"status": "bogus"}).status_code == 422
    assert intake_client.get(f"/api/intake/batches/b-{uuid4().hex[:12]}").status_code == 404


def test_viewer_cannot_change_batch_status():
    batch_id = f"b-{uuid4().hex[:12]}"
    with SessionLocal() as database:
        _document(database, None, batch_id)
    response = intake_client.post(
        f"/api/intake/batches/{batch_id}/status",
        json={"status": "rejected"},
        headers={"X-Actor-Id": "actor-viewer-default"},
    )
    assert response.status_code == 403


def test_batches_are_scoped_to_the_callers_workspace():
    a, b = {"X-Workspace-Token": secrets.token_hex(32)}, {"X-Workspace-Token": secrets.token_hex(32)}
    batch_id = f"b-{uuid4().hex[:12]}"
    with SessionLocal() as database:
        owned_a = _document(database, workspace_key(a["X-Workspace-Token"]), batch_id)
        owned_b = _document(database, workspace_key(b["X-Workspace-Token"]), batch_id)

    with enforced():
        rows = intake_client.get(f"/api/intake/batches/{batch_id}", headers=a).json()["documents"]
        assert [row["document_id"] for row in rows] == [owned_a]

        response = intake_client.post(
            f"/api/intake/batches/{batch_id}/status", json={"status": "rejected"}, headers=a
        )
        assert response.json()["updated"] == [owned_a]

        outsider = {"X-Workspace-Token": secrets.token_hex(32)}
        assert intake_client.get(f"/api/intake/batches/{batch_id}", headers=outsider).status_code == 404

    with SessionLocal() as database:
        assert database.get(DocumentIntake, owned_a).intake_status == "rejected"
        assert database.get(DocumentIntake, owned_b).intake_status == "draft"


def test_put_document_intake_tags_and_keeps_status():
    batch_id = f"b-{uuid4().hex[:12]}"
    with SessionLocal() as database:
        document_id = _document(database, None, batch_id, status="submitted")

    response = intake_client.put(
        f"/api/intake/documents/{document_id}",
        json={"batch_id": batch_id, "agency": "DLA", "extraction_profile": "auto"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["agency"] == "DLA"
    assert body["contracting_officer"] is None
    assert body["intake_status"] == "submitted"
    assert intake_client.get(f"/api/intake/documents/{document_id}").json()["agency"] == "DLA"

    assert intake_client.put(f"/api/intake/documents/{uuid4()}", json={"agency": "x"}).status_code == 404


def test_review_queue_skips_draft_and_rejected_batches():
    from sqlalchemy import select

    from app.api.dashboard import _review_queue_documents
    from app.core.auth import ActorContext
    from app.database.session import SessionLocal
    from app.models.document import Document
    from app.models.document_intake import DocumentIntake

    session = SessionLocal()
    try:
        documents = list(session.scalars(select(Document).limit(3)))
        if len(documents) < 3:
            pytest.skip("needs three documents in the test database")
        statuses = ["draft", "rejected", "submitted"]
        previous = {}
        for document, status in zip(documents, statuses):
            row = session.get(DocumentIntake, document.id)
            previous[document.id] = row.intake_status if row else None
            if row is None:
                session.add(DocumentIntake(document_id=document.id, batch_id="queue-test", intake_status=status))
            else:
                row.intake_status = status
        session.commit()
        actor = ActorContext(id="t", actor_type="user", role="admin", display_name="T")
        queued = {document.id for document in session.scalars(_review_queue_documents(actor))}
        assert documents[0].id not in queued
        assert documents[1].id not in queued
        assert documents[2].id in queued
    finally:
        for document_id, status in previous.items():
            row = session.get(DocumentIntake, document_id)
            if status is None:
                session.delete(row)
            else:
                row.intake_status = status
        session.commit()
        session.close()
