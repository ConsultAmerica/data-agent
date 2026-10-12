"""RC2 restricted release — metadata review mutation fail-closed gate."""

from __future__ import annotations

from unittest.mock import patch
from uuid import uuid4

import fitz
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.config import Settings
from app.database.session import SessionLocal
from app.main import app
from app.models.document_metadata_field import DocumentMetadataField

client = TestClient(app)


def _upload() -> str:
    pdf = fitz.open()
    page = pdf.new_page()
    page.insert_text((72, 72), f"Governing Law: Delaware {uuid4()}", fontsize=10)
    content = pdf.tobytes()
    pdf.close()
    response = client.post(
        "/api/documents/upload",
        files={"file": (f"gate-{uuid4()}.pdf", content, "application/pdf")},
    )
    assert response.status_code in {200, 201}, response.text
    return response.json()["document_id"]


def _seed_field(document_id: str) -> tuple[int, str]:
    database = SessionLocal()
    try:
        row = DocumentMetadataField(
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
                "machine_value": "Delaware",
            },
            review_status="pending",
            extraction_source="contract",
        )
        database.add(row)
        database.commit()
        database.refresh(row)
        return row.id, row.field_key
    finally:
        database.close()


def test_ready_exposes_metadata_review_mutations_flag() -> None:
    body = client.get("/ready").json()
    assert "metadata_review_mutations_enabled" in body
    # Suite runs with APP_ENV != production and flag unset → enabled.
    assert body["metadata_review_mutations_enabled"] is True


def test_review_routes_fail_closed_when_gate_disabled() -> None:
    document_id = _upload()
    field_id, field_key = _seed_field(document_id)

    gated = Settings(
        app_env="development",
        metadata_review_mutations_enabled=False,
    )

    with patch("app.core.feature_gates.get_settings", return_value=gated):
        by_key = client.post(
            f"/api/documents/{document_id}/metadata-fields/{field_key}/review",
            json={"action": "accept", "changed_by": "Gate Tester"},
        )
        by_id = client.post(
            f"/api/documents/{document_id}/metadata-fields/by-id/{field_id}/review",
            json={"action": "accept", "changed_by": "Gate Tester"},
        )
        accept_all = client.post(
            f"/api/documents/{document_id}/metadata-fields/accept-all",
            json={"changed_by": "Gate Tester"},
        )
        corrections = client.post(
            f"/api/documents/{document_id}/targets/{field_key}/corrections",
            json={
                "action": "verify",
                "original_value": "Delaware",
                "changed_by": "Gate Tester",
            },
        )

    assert by_key.status_code == 403, by_key.text
    assert by_id.status_code == 403, by_id.text
    assert accept_all.status_code == 403, accept_all.text
    assert corrections.status_code == 403, corrections.text
    for response in (by_key, by_id, accept_all, corrections):
        assert "disabled for this release" in response.json()["detail"]

    # Field must remain pending — no mutation leaked through.
    database = SessionLocal()
    try:
        row = database.scalar(
            select(DocumentMetadataField).where(
                DocumentMetadataField.id == field_id
            )
        )
        assert row is not None
        assert row.review_status == "pending"
    finally:
        database.close()


def test_production_unset_flag_is_fail_closed() -> None:
    settings = Settings(
        app_env="production",
        metadata_review_mutations_enabled=None,
    )
    assert settings.effective_metadata_review_mutations_enabled is False


def test_production_explicit_true_allows_waiver() -> None:
    settings = Settings(
        app_env="production",
        metadata_review_mutations_enabled=True,
    )
    assert settings.effective_metadata_review_mutations_enabled is True
