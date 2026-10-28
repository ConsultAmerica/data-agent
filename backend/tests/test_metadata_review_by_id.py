"""RC2-05B: unambiguous Accept/Edit/Reject by DocumentMetadataField.id."""

from __future__ import annotations

from uuid import uuid4

import fitz
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.config import get_settings
from app.database.session import SessionLocal
from app.main import app
from app.models.document_metadata_field import DocumentMetadataField
from app.models.metadata_field_audit_log import MetadataFieldAuditLog

client = TestClient(app)
# These flows review every value via accept-all; since DI-02 that
# includes flagged values only as an admin override with a reason.
ACCEPT_EVERYTHING = {"include_flagged": True, "override_reason": "test: review every value"}


def _pdf() -> bytes:
    pdf = fitz.open()
    page = pdf.new_page()
    page.insert_text((72, 72), "Governing Law: State of Delaware", fontsize=10)
    content = pdf.tobytes()
    pdf.close()
    return content


def _upload() -> str:
    response = client.post(
        "/api/documents/upload",
        files={"file": (f"byid-{uuid4()}.pdf", _pdf(), "application/pdf")},
    )
    assert response.status_code == 201, response.text
    return response.json()["document_id"]


def _seed_pair(document_id: str) -> tuple[int, int]:
    database = SessionLocal()
    try:
        a = DocumentMetadataField(
            document_id=document_id,
            field_group="Legal",
            field_key="governing_law",
            label="Governing Law",
            value="Delaware",
            original_value="Delaware",
            confidence=0.9,
            extraction_method="label_value",
            evidence_json={
                "page_number": 1,
                "source_text": "Delaware",
                "source_reference": "page 1",
                "machine_value": "Delaware",
            },
            review_status="pending",
            extraction_source="contract",
        )
        b = DocumentMetadataField(
            document_id=document_id,
            field_group="Legal",
            field_key="governing_law",
            label="Governing Law",
            value="New York",
            original_value="New York",
            confidence=0.8,
            extraction_method="label_value",
            evidence_json={
                "page_number": 2,
                "source_text": "New York",
                "source_reference": "page 2",
                "machine_value": "New York",
            },
            review_status="pending",
            extraction_source="v3",
        )
        database.add(a)
        database.add(b)
        database.commit()
        database.refresh(a)
        database.refresh(b)
        return a.id, b.id
    finally:
        database.close()


def test_duplicate_keys_reviewed_independently_by_id() -> None:
    document_id = _upload()
    id_a, id_b = _seed_pair(document_id)

    accept_a = client.post(
        f"/api/documents/{document_id}/metadata-fields/by-id/{id_a}/review",
        json={"action": "accept", "changed_by": "Reviewer"},
    )
    assert accept_a.status_code == 200, accept_a.text
    assert accept_a.json()["id"] == id_a
    assert accept_a.json()["review_status"] == "accepted"
    assert accept_a.json()["extraction_source"] == "contract"

    edit_b = client.post(
        f"/api/documents/{document_id}/metadata-fields/by-id/{id_b}/review",
        json={"action": "edit", "value": "California", "changed_by": "Reviewer"},
    )
    assert edit_b.status_code == 200, edit_b.text
    assert edit_b.json()["id"] == id_b
    assert edit_b.json()["review_status"] == "edited"
    assert edit_b.json()["value"] == "California"
    assert edit_b.json()["extracted_value"] == "New York"

    database = SessionLocal()
    try:
        rows = {
            row.id: row
            for row in database.scalars(
                select(DocumentMetadataField).where(
                    DocumentMetadataField.document_id == document_id
                )
            )
        }
        assert rows[id_a].review_status == "accepted"
        assert rows[id_a].value == "Delaware"
        assert rows[id_b].review_status == "edited"
        assert rows[id_b].value == "California"

        audits = list(
            database.scalars(
                select(MetadataFieldAuditLog).where(
                    MetadataFieldAuditLog.document_id == document_id
                )
            )
        )
        by_field = {entry.metadata_field_id: entry for entry in audits}
        assert by_field[id_a].action == "accept"
        assert by_field[id_b].action == "edit"
        assert by_field[id_b].new_value == "California"
    finally:
        database.close()


def test_field_key_path_still_returns_409_when_ambiguous() -> None:
    document_id = _upload()
    _seed_pair(document_id)
    response = client.post(
        f"/api/documents/{document_id}/metadata-fields/governing_law/review",
        json={"action": "accept", "changed_by": "Reviewer"},
    )
    assert response.status_code == 409
    assert "by-id" in response.json()["detail"]["message"]


def test_id_cannot_mutate_field_on_another_document() -> None:
    doc_a = _upload()
    doc_b = _upload()
    id_a, _ = _seed_pair(doc_a)

    response = client.post(
        f"/api/documents/{doc_b}/metadata-fields/by-id/{id_a}/review",
        json={"action": "accept", "changed_by": "Reviewer"},
    )
    assert response.status_code == 404
    assert response.json()["detail"] == "Metadata field not found."

    database = SessionLocal()
    try:
        row = database.get(DocumentMetadataField, id_a)
        assert row is not None
        assert row.review_status == "pending"
    finally:
        database.close()


def test_invalid_id_fails_safely() -> None:
    document_id = _upload()
    response = client.post(
        f"/api/documents/{document_id}/metadata-fields/by-id/999999991/review",
        json={"action": "reject", "changed_by": "Reviewer"},
    )
    assert response.status_code == 404


def test_cross_workspace_id_review_denied() -> None:
    import secrets
    from contextlib import contextmanager
    from unittest.mock import patch

    @contextmanager
    def enforced():
        settings = get_settings().model_copy(
            update={"rbac_enforced": True, "public_workspace_access": True}
        )
        with patch("app.core.auth.get_settings", return_value=settings):
            yield

    a = {"X-Workspace-Token": secrets.token_hex(32)}
    b = {"X-Workspace-Token": secrets.token_hex(32)}

    with enforced():
        upload = client.post(
            "/api/documents/upload",
            files={"file": (f"iso-{uuid4()}.pdf", _pdf(), "application/pdf")},
            headers=a,
        )
        assert upload.status_code in (200, 201), upload.text
        document_id = upload.json()["document_id"]
        id_a, _ = _seed_pair(document_id)

        denied = client.post(
            f"/api/documents/{document_id}/metadata-fields/by-id/{id_a}/review",
            json={"action": "accept", "changed_by": "Other"},
            headers=b,
        )
        assert denied.status_code in (403, 404), denied.text

        allowed = client.post(
            f"/api/documents/{document_id}/metadata-fields/by-id/{id_a}/review",
            json={"action": "accept", "changed_by": "Owner"},
            headers=a,
        )
        assert allowed.status_code == 200, allowed.text


def test_reject_by_id_preserves_semantics() -> None:
    document_id = _upload()
    id_a, id_b = _seed_pair(document_id)

    rejected = client.post(
        f"/api/documents/{document_id}/metadata-fields/by-id/{id_a}/review",
        json={"action": "reject", "changed_by": "Reviewer"},
    )
    assert rejected.status_code == 200
    assert rejected.json()["review_status"] == "rejected"

    accept_all = client.post(
        f"/api/documents/{document_id}/metadata-fields/accept-all",
        json={"changed_by": "Reviewer", **ACCEPT_EVERYTHING},
    )
    assert accept_all.status_code == 200
    by_id = {row["id"]: row for row in accept_all.json()}
    assert by_id[id_a]["review_status"] == "rejected"
    assert by_id[id_b]["review_status"] == "accepted"
