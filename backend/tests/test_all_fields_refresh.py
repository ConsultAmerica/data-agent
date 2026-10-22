from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import select

from app.database.session import SessionLocal
from app.models.document import Document
from app.models.document_metadata_field import DocumentMetadataField
from app.services.all_fields_builder import persist_all_fields


def _row(document_id: str, value: str) -> DocumentMetadataField:
    # Built fresh each run and never flushed, like build_all_fields_rows output.
    return DocumentMetadataField(
        document_id=document_id, field_group="General", field_key="v3_issued_by", label="Issued By",
        value=value, confidence=0.8, extraction_method="label_value", evidence_json={},
        review_status="pending", original_value=value, extraction_source="v3",
    )


def test_rerun_refreshes_existing_rows_without_null_timestamps():
    database = SessionLocal()
    document_id = str(uuid4())
    try:
        database.add(Document(
            id=document_id, original_filename="award.pdf", stored_filename=f"{document_id}.pdf",
            content_type="application/pdf", size_bytes=1, checksum_sha256=uuid4().hex, page_count=1,
            encrypted=False, status="ready", uploaded_at=datetime.now(timezone.utc),
        ))
        database.commit()
        persist_all_fields(database=database, document_id=document_id, rows=[_row(document_id, "NAVFAC")])
        database.commit()
        # Second extraction of the same document: used to fail with
        # NOT NULL constraint failed: document_metadata_fields.extracted_at.
        persist_all_fields(database=database, document_id=document_id, rows=[_row(document_id, "NAVFAC MARIANAS")])
        database.commit()
        row = database.scalars(
            select(DocumentMetadataField).where(DocumentMetadataField.document_id == document_id)
        ).one()
        assert row.value == "NAVFAC MARIANAS"
        assert row.extracted_at is not None
    finally:
        document = database.get(Document, document_id)
        if document is not None:
            database.delete(document)
            database.commit()
        database.close()
