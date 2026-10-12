"""RC2-05: duplicate field_key must not silently redirect review mutations."""

from __future__ import annotations

from uuid import uuid4

import fitz
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.database.session import SessionLocal
from app.main import app
from app.models.document_metadata_field import DocumentMetadataField
from app.services.contract_metadata_extractor import (
    AmbiguousMetadataFieldError,
    get_metadata_field,
    require_unique_metadata_field,
)

client = TestClient(app)


def _upload() -> str:
    pdf = fitz.open()
    page = pdf.new_page()
    page.insert_text((72, 72), "Governing Law: State of Delaware", fontsize=10)
    content = pdf.tobytes()
    pdf.close()
    response = client.post(
        "/api/documents/upload",
        files={"file": (f"dup-{uuid4()}.pdf", content, "application/pdf")},
    )
    assert response.status_code == 201, response.text
    return response.json()["document_id"]


def _seed_duplicate_rows(document_id: str, field_key: str = "governing_law") -> tuple[int, int]:
    database = SessionLocal()
    try:
        a = DocumentMetadataField(
            document_id=document_id,
            field_group="Legal",
            field_key=field_key,
            label="Governing Law",
            value="Delaware",
            original_value="Delaware",
            confidence=0.9,
            extraction_method="label_value",
            evidence_json={
                "page_number": 1,
                "source_text": "Delaware",
                "source_reference": "page 1",
            },
            review_status="pending",
            extraction_source="contract",
        )
        b = DocumentMetadataField(
            document_id=document_id,
            field_group="Legal",
            field_key=field_key,
            label="Governing Law",
            value="New York",
            original_value="New York",
            confidence=0.8,
            extraction_method="label_value",
            evidence_json={
                "page_number": 2,
                "source_text": "New York",
                "source_reference": "page 2",
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


def test_require_unique_refuses_duplicate_field_key() -> None:
    document_id = _upload()
    id_a, id_b = _seed_duplicate_rows(document_id)
    assert id_a != id_b

    database = SessionLocal()
    try:
        legacy = get_metadata_field(
            database, document_id=document_id, field_key="governing_law"
        )
        assert legacy is not None

        try:
            require_unique_metadata_field(
                database, document_id=document_id, field_key="governing_law"
            )
            raise AssertionError("expected AmbiguousMetadataFieldError")
        except AmbiguousMetadataFieldError as exc:
            assert {row.id for row in exc.rows} == {id_a, id_b}
    finally:
        database.close()


def test_review_mutation_returns_409_when_field_key_is_ambiguous() -> None:
    document_id = _upload()
    id_a, id_b = _seed_duplicate_rows(document_id)

    response = client.post(
        f"/api/documents/{document_id}/metadata-fields/governing_law/review",
        json={"action": "accept", "changed_by": "Reviewer"},
    )
    assert response.status_code == 409, response.text
    body = response.json()["detail"]
    assert body["field_key"] == "governing_law"
    candidate_ids = {item["id"] for item in body["candidates"]}
    assert candidate_ids == {id_a, id_b}

    database = SessionLocal()
    try:
        rows = list(
            database.scalars(
                select(DocumentMetadataField).where(
                    DocumentMetadataField.document_id == document_id,
                    DocumentMetadataField.field_key == "governing_law",
                )
            )
        )
        assert {row.review_status for row in rows} == {"pending"}
        assert {row.value for row in rows} == {"Delaware", "New York"}
    finally:
        database.close()
