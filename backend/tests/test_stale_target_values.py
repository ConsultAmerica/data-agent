from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import select

from app.database.session import SessionLocal
from app.models.document import Document
from app.models.document_metadata_field import DocumentMetadataField
from app.models.metadata_field_audit_log import MetadataFieldAuditLog
from app.services.target_result_store import clear_stale_target_values


def _field(document_id: str, key: str, value: str, status: str = "pending") -> DocumentMetadataField:
    return DocumentMetadataField(
        document_id=document_id, field_group="Identifiers", field_key=key, label=key, value=value,
        confidence=0.99, extraction_method="source_evidence", evidence_json={}, verified=True,
        human_approved=status == "accepted", review_status=status, original_value=value,
        extraction_source="target",
    )


def test_clears_only_untouched_values_the_latest_run_did_not_find():
    database = SessionLocal()
    document_id = str(uuid4())
    try:
        database.add(Document(
            id=document_id, original_filename="award.pdf", stored_filename=f"{document_id}.pdf",
            content_type="application/pdf", size_bytes=1, checksum_sha256=uuid4().hex, page_count=1,
            encrypted=False, status="ready", uploaded_at=datetime.now(timezone.utc),
        ))
        database.flush()
        stale = _field(document_id, "contract_number", "assigned.")
        reviewed = _field(document_id, "solicitation_number", "N4019221R28000019", status="accepted")
        audited = _field(document_id, "order_number", "0001")
        found = _field(document_id, "award_date", "29-Sep-2023")
        database.add_all([stale, reviewed, audited, found])
        database.flush()
        database.add(MetadataFieldAuditLog(
            document_id=document_id, field_key="order_number", metadata_field_id=audited.id, action="comment", changed_by="reviewer",
        ))
        database.commit()

        cleared = clear_stale_target_values(
            database=database,
            document_id=document_id,
            unresolved_keys=["contract_number", "solicitation_number", "order_number"],
        )
        database.commit()

        left = set(database.scalars(
            select(DocumentMetadataField.field_key).where(DocumentMetadataField.document_id == document_id)
        ))
        assert cleared == 1
        # The stale machine value is gone; the reviewer's decision, the audited
        # row and the value this run did find all stay.
        assert left == {"solicitation_number", "order_number", "award_date"}
        assert clear_stale_target_values(database=database, document_id=document_id, unresolved_keys=[]) == 0
    finally:
        document = database.get(Document, document_id)
        if document is not None:
            database.delete(document)
            database.commit()
        database.close()
