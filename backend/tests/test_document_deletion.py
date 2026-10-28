"""Document deletion (services/document_deletion.py): one service removes a
document and everything that belongs to it — every dependent row, its
files and its storage object — authorized per document."""

from __future__ import annotations

import secrets
from contextlib import contextmanager
from unittest.mock import patch
from uuid import uuid4

import fitz
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.core.config import get_settings
from app.database.base import Base
from app.database.session import SessionLocal
from app.main import app
from app.models.document import Document
from app.services.document_deletion import _dependent_tables
from tests.test_far_part_52 import _prepare, far_html

client = TestClient(app)


@contextmanager
def enforced():
    settings = get_settings().model_copy(update={"rbac_enforced": True, "public_workspace_access": True})
    with patch("app.core.auth.get_settings", return_value=settings):
        yield


def _pdf() -> bytes:
    pdf = fitz.open()
    pdf.new_page().insert_text((72, 72), f"Invoice Number: DEL-{uuid4().hex[:8]}", fontsize=10)
    return pdf.tobytes()


def _upload(content: bytes, name: str, kind: str, headers: dict | None = None) -> str:
    response = client.post("/api/documents/upload", files={"file": (name, content, kind)}, headers=headers or {})
    assert response.status_code == 201, response.text
    document_id = response.json()["document_id"]
    assert client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False}, headers=headers or {}).status_code == 200
    return document_id


def _rows_for(document_id: str) -> dict[str, int]:
    """Rows referencing the document, per table (directly or nested)."""

    direct, nested = _dependent_tables()
    database = SessionLocal()
    try:
        counts = {}
        for table, column in direct:
            counts[table.name] = database.scalar(select(func.count()).select_from(table).where(column == document_id)) or 0
        for table, column, parent in nested:
            owner = next(c for t, c in direct if t is parent.table)
            counts[table.name] = database.scalar(
                select(func.count()).select_from(table).where(column.in_(select(parent).where(owner == document_id)))
            ) or 0
        counts["documents"] = database.scalar(select(func.count()).select_from(Document).where(Document.id == document_id)) or 0
        return counts
    finally:
        database.close()


def test_delete_removes_the_whole_document_graph():
    document_id = _upload(far_html(), f"far-{uuid4()}.html", "text/html")
    _prepare(document_id)
    database = SessionLocal()
    stored = database.get(Document, document_id).stored_filename
    database.close()
    path = get_settings().upload_path / stored
    before = _rows_for(document_id)
    # Pages, staging resolution, FAR records … exist before.
    assert before["documents"] == 1 and before["document_pages"] > 0
    assert before["document_staging_workbooks"] == 1 and before["document_far_records"] > 0
    assert path.exists()

    with patch("app.services.document_deletion.delete_object") as remote:
        response = client.delete(f"/api/documents/{document_id}")
    assert response.status_code == 204, response.text
    remote.assert_called_once()
    assert remote.call_args.args[1] == stored

    after = _rows_for(document_id)
    assert {table: count for table, count in after.items() if count} == {}
    assert not path.exists()
    # A deleted document cannot be reopened or exported.
    assert client.get(f"/api/documents/{document_id}").status_code == 404
    assert client.get(f"/api/documents/{document_id}/staging-workbook").status_code == 404
    assert client.get(f"/api/documents/{document_id}/staging-workbook/export.xlsx").status_code == 404
    assert client.delete(f"/api/documents/{document_id}").status_code == 404


def test_every_table_referencing_documents_is_covered():
    direct, nested = _dependent_tables()
    covered = {table.name for table, _ in direct} | {table.name for table, *_ in nested}
    referencing = {
        table.name
        for table in Base.metadata.sorted_tables
        for fk in table.foreign_keys
        if fk.column.table.name == "documents" and table.name != "documents"
    }
    assert referencing <= covered


def test_bulk_delete_and_counts_update():
    ids = [_upload(_pdf(), f"bulk-{uuid4()}.pdf", "application/pdf") for _ in range(3)]
    before = client.get("/api/documents/status-counts").json()["total"]
    with patch("app.services.document_deletion.delete_object"):
        response = client.post("/api/documents/bulk-delete", json={"document_ids": ids[:2] + ["missing-id"]})
    assert response.status_code == 200, response.text
    body = response.json()
    assert sorted(body["deleted"]) == sorted(ids[:2]) and body["not_found"] == ["missing-id"]
    assert client.get("/api/documents/status-counts").json()["total"] == before - 2
    assert all(client.get(f"/api/documents/{i}").status_code == 404 for i in ids[:2])
    assert client.get(f"/api/documents/{ids[2]}").status_code == 200
    search = client.get("/api/documents/search", params={"q": "bulk-"}).json()
    assert not {d["document_id"] for d in search["documents"]} & set(ids[:2])


def test_storage_failure_is_reported_but_the_document_is_gone():
    document_id = _upload(_pdf(), f"store-{uuid4()}.pdf", "application/pdf")
    with patch("app.services.document_deletion.delete_object", side_effect=RuntimeError("storage offline")):
        body = client.post("/api/documents/bulk-delete", json={"document_ids": [document_id]}).json()
    assert body["deleted"] == [document_id] and "storage offline" in body["storage_errors"][0]
    assert client.get(f"/api/documents/{document_id}").status_code == 404


def test_workspace_deletes_only_its_own_documents():
    a = {"X-Workspace-Token": secrets.token_hex(32)}
    b = {"X-Workspace-Token": secrets.token_hex(32)}
    admin_owned = _upload(_pdf(), f"admin-{uuid4()}.pdf", "application/pdf")  # no workspace owner
    with enforced(), patch("app.services.document_deletion.delete_object"):
        mine = [_upload(_pdf(), f"ws-{uuid4()}.pdf", "application/pdf", a) for _ in range(2)]
        # Another workspace: not found, never deleted (bulk and single).
        refused = client.post("/api/documents/bulk-delete", json={"document_ids": mine}, headers=b).json()
        assert refused["deleted"] == [] and sorted(refused["not_found"]) == sorted(mine)
        assert client.delete(f"/api/documents/{mine[0]}", headers=b).status_code == 404
        # A document from before workspaces (no owner) needs a real credential.
        assert client.delete(f"/api/documents/{admin_owned}", headers=a).status_code == 404
        # No workspace token: nothing is reachable.
        assert client.post("/api/documents/bulk-delete", json={"document_ids": mine}).json()["deleted"] == []
        # The owner deletes its own.
        own = client.post("/api/documents/bulk-delete", json={"document_ids": mine}, headers=a).json()
        assert sorted(own["deleted"]) == sorted(mine)
    assert client.get(f"/api/documents/{admin_owned}").status_code == 200


def test_roles_without_delete_are_refused():
    from app.core.rbac import role_has_permission

    for role in ("viewer", "analyst", "reviewer", "service_account"):
        assert not role_has_permission(role, "documents.delete")
        assert not role_has_permission(role, "documents.delete_own")
    assert role_has_permission("admin", "documents.delete")


def test_audit_history_outlives_the_document():
    from app.models.document_metadata_field import DocumentMetadataField
    from app.models.metadata_field_audit_log import DOCUMENT_EVENT_FIELD_KEY, MetadataFieldAuditLog

    document_id = _upload(_pdf(), f"audit-{uuid4()}.pdf", "application/pdf")
    database = SessionLocal()
    try:
        database.add(
            DocumentMetadataField(
                document_id=document_id, field_group="Legal", field_key="governing_law",
                label="Governing Law", value="Delaware", original_value="Delaware",
                confidence=0.9, extraction_method="label_value",
                evidence_json={"page_number": 1, "source_text": "Delaware"},
                review_status="pending", extraction_source="contract",
            )
        )
        database.commit()
    finally:
        database.close()
    reviewed = client.post(
        f"/api/documents/{document_id}/metadata-fields/governing_law/review",
        json={"action": "accept", "changed_by": "Reviewer"},
    )
    assert reviewed.status_code == 200, reviewed.text

    with patch("app.services.document_deletion.delete_object"):
        assert client.delete(f"/api/documents/{document_id}").status_code == 204

    database = SessionLocal()
    try:
        events = database.scalars(
            select(MetadataFieldAuditLog)
            .where(MetadataFieldAuditLog.document_id == document_id)
            .order_by(MetadataFieldAuditLog.id)
        ).all()
    finally:
        database.close()
    assert [(e.field_key, e.action) for e in events] == [
        ("governing_law", "accept"),
        (DOCUMENT_EVENT_FIELD_KEY, "delete"),
    ]
    assert events[-1].actor_id == "actor-admin-default"

    # Admins still see the history, labelled as a deleted document.
    log = client.get("/api/documents/audit-log", params={"document_id": document_id})
    assert log.status_code == 200, log.text
    entries = log.json()["entries"]
    assert {e["action"] for e in entries} == {"accept", "delete"}
    assert {e["document_filename"] for e in entries} == {"Deleted document"}

    # A workspace caller never sees another (or a deleted) document's history.
    with enforced():
        hidden = client.get(
            "/api/documents/audit-log",
            params={"document_id": document_id},
            headers={"X-Workspace-Token": secrets.token_hex(32)},
        )
    assert hidden.status_code == 200, hidden.text
    assert hidden.json()["entries"] == []
