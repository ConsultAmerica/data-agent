"""Reviewer assignments, the Review Queue's assignment/context columns and
obligation tracking (workflow status, owner, sub-tasks)."""

from __future__ import annotations

import secrets
from contextlib import contextmanager
from datetime import datetime, timezone
from unittest.mock import patch
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import delete

from app.api import dashboard, obligations
from app.api.assignments import router as assignments_router
from app.core.auth import workspace_key
from app.core.config import get_settings
from app.database.session import SessionLocal
from app.models.document import Document
from app.models.document_clause_reference import DocumentClauseReference
from app.models.document_metadata_field import DocumentMetadataField
from app.models.obligation_tracking import ObligationTracking
from app.models.review_assignment import ReviewAssignment

api = FastAPI()
api.include_router(assignments_router, prefix="/api/review-assignments")
api.include_router(dashboard.router, prefix="/api/dashboard")
api.include_router(obligations.portfolio_router, prefix="/api/obligations")
client = TestClient(api)


@contextmanager
def enforced():
    settings = get_settings().model_copy(update={"rbac_enforced": True, "public_workspace_access": True})
    with patch("app.core.auth.get_settings", return_value=settings):
        yield


def _document(database, owner: str | None = None, clauses: tuple[str, ...] = ()) -> str:
    document_id = str(uuid4())
    database.add(
        Document(
            id=document_id,
            original_filename=f"assign-{document_id[:8]}.pdf",
            stored_filename=f"{document_id}.pdf",
            content_type="application/pdf",
            size_bytes=100,
            checksum_sha256=uuid4().hex,
            page_count=2,
            encrypted=False,
            status="ready",
            processing_status="completed",
            document_type="Government Contract",
            uploaded_at=datetime(2026, 10, 2, tzinfo=timezone.utc),
            owner_workspace=owner,
        )
    )
    database.flush()
    for index, number in enumerate(clauses):
        database.add(
            DocumentClauseReference(
                document_id=document_id, row_index=index, clause_family="FAR", citation_context="listing",
                clause_number=number, title="", confidence=0.9,
                evidence_json={"page_number": 3, "source_text": f"{number} cited"},
            )
        )
    database.commit()
    return document_id


def _field(database, document_id: str, key: str, value: str, *, status: str = "pending", evidence: dict | None = None) -> int:
    row = DocumentMetadataField(
        document_id=document_id, field_group="Identifiers", field_key=key, label=key.replace("_", " ").title(),
        value=value, original_value=value, confidence=0.5, confidence_band="low", value_type="text",
        extraction_method="ai", evidence_json=evidence or {}, verified=False, review_status=status,
        extraction_source="target",
    )
    database.add(row)
    database.commit()
    return row.id


@pytest.fixture
def database():
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def _queue_item(document_id: str, key: str) -> dict:
    items = client.get("/api/dashboard/review-queue/fields").json()
    return next(item for item in items if item["document_id"] == document_id and item["field_key"] == key)


def test_assign_reassign_unassign_and_queue_columns(database):
    document_id = _document(database)
    piid = _field(database, document_id, "piid", "W912DR-26-C-0042",
                  evidence={"source_text": "Contract   No. W912DR-26-C-0042", "page_number": 1})
    _field(database, document_id, "telephone", "555-0100")
    _field(database, document_id, "contract_type", "Firm Fixed Price", status="accepted")

    item = _queue_item(document_id, "piid")
    assert item["assignee"] is None and item["due_date"] is None
    assert item["contract_type"] == "Firm Fixed Price"
    assert item["source_snippet"] == "Contract No. W912DR-26-C-0042"
    assert item["uploaded_at"].startswith("2026-10-02")
    assert _queue_item(document_id, "telephone")["source_snippet"] is None

    assigned = client.post("/api/review-assignments", json={
        "items": [
            {"document_id": document_id, "metadata_field_id": piid, "field_key": "piid"},
            {"document_id": document_id, "field_key": "telephone"},
        ],
        "assignee": "  Dana   Reyes ",
        "due_date": "2026-11-01",
    })
    assert assigned.status_code == 200, assigned.text
    assert [row["assignee"] for row in assigned.json()["assigned"]] == ["Dana Reyes", "Dana Reyes"]
    item = _queue_item(document_id, "piid")
    assert item["assignee"] == "Dana Reyes" and item["due_date"] == "2026-11-01" and item["assigned_at"]
    # Assigned by field key when the caller had no row id.
    assert _queue_item(document_id, "telephone")["assignee"] == "Dana Reyes"

    # Reassigning replaces — still one row per field.
    client.post("/api/review-assignments", json={
        "items": [{"document_id": document_id, "metadata_field_id": piid, "field_key": "piid"}],
        "assignee": "Lee",
    })
    assert database.query(ReviewAssignment).filter_by(document_id=document_id, metadata_field_id=piid).count() == 1
    item = _queue_item(document_id, "piid")
    assert item["assignee"] == "Lee" and item["due_date"] is None

    assignees = client.get("/api/review-assignments/assignees").json()
    assert {"Lee", "Dana Reyes"} <= set(assignees["assignees"])
    assert assignees["current_actor"]

    removed = client.post("/api/review-assignments/unassign", json={
        "items": [{"document_id": document_id, "metadata_field_id": piid, "field_key": "piid"}],
    })
    assert removed.json() == {"unassigned": 1}
    assert _queue_item(document_id, "piid")["assignee"] is None


def test_assignment_validation(database):
    document_id = _document(database)
    other = _document(database)
    field_id = _field(database, other, "piid", "X")
    target = {"document_id": document_id, "metadata_field_id": field_id, "field_key": "piid"}
    assert client.post("/api/review-assignments", json={"items": [target], "assignee": "   "}).status_code == 422
    assert client.post("/api/review-assignments", json={"items": [], "assignee": "A"}).status_code == 422
    # A field id from another document is not this document's field.
    assert client.post("/api/review-assignments", json={"items": [target], "assignee": "A"}).status_code == 404
    missing = {"document_id": str(uuid4()), "field_key": "piid"}
    assert client.post("/api/review-assignments", json={"items": [missing], "assignee": "A"}).status_code == 404


def test_assignments_respect_workspaces(database):
    a, b = {"X-Workspace-Token": secrets.token_hex(32)}, {"X-Workspace-Token": secrets.token_hex(32)}
    owned = _document(database, owner=workspace_key(a["X-Workspace-Token"]))
    field_id = _field(database, owned, "piid", "X")
    body = {"items": [{"document_id": owned, "metadata_field_id": field_id, "field_key": "piid"}], "assignee": "Pat"}
    with enforced():
        assert client.post("/api/review-assignments", json=body, headers=b).status_code == 404
        assert client.post("/api/review-assignments", json=body, headers=a).status_code == 200
        assert "Pat" in client.get("/api/review-assignments/assignees", headers=a).json()["assignees"]
        assert "Pat" not in client.get("/api/review-assignments/assignees", headers=b).json()["assignees"]
        assert client.post("/api/review-assignments/unassign", json={"items": body["items"]}, headers=b).status_code == 404


def test_obligation_tracking_merges_and_updates(database):
    document_id = _document(database, clauses=("52.222-37",))
    try:
        listed = client.get(f"/api/obligations?document_id={document_id}").json()
        item = next(row for row in listed["obligations"] if row["title"] == "File VETS-4212 report")
        assert item["workflow_status"] == "upcoming" and item["assignee"] is None and item["subtasks"] == []
        assert item["obligation_key"] == item["obligation_id"]
        assert listed["workflow_counts"]["upcoming"] == len(listed["obligations"])

        key = item["obligation_key"]
        url = f"/api/obligations/{document_id}/tracking/{key}"
        updated = client.put(url, json={"workflow_status": "in_review", "assignee": " Kim ",
                                        "subtasks": [{"title": "Pull hiring data", "done": True}, {"title": "File"}]})
        assert updated.status_code == 200, updated.text
        assert updated.json()["workflow_status"] == "in_review"
        assert updated.json()["assignee"] == "Kim"
        assert updated.json()["subtasks"] == [{"title": "Pull hiring data", "done": True}, {"title": "File", "done": False}]

        # Partial update keeps the rest; blank assignee clears it.
        partial = client.put(url, json={"workflow_status": "completed", "assignee": ""}).json()
        assert partial["workflow_status"] == "completed" and partial["assignee"] is None
        assert len(partial["subtasks"]) == 2

        merged = client.get(f"/api/obligations?document_id={document_id}").json()
        again = next(row for row in merged["obligations"] if row["obligation_key"] == key)
        assert again["workflow_status"] == "completed" and len(again["subtasks"]) == 2
        assert merged["workflow_counts"]["completed"] == 1

        assert client.put(url, json={"workflow_status": "done"}).status_code == 422
        assert client.put(url, json={"subtasks": [{"title": "  "}]}).status_code == 422
        assert client.put(f"/api/obligations/{document_id}/tracking/nope", json={}).status_code == 404
        assert client.put(f"/api/obligations/{uuid4()}/tracking/{key}", json={}).status_code == 404

        other = {"X-Workspace-Token": secrets.token_hex(32)}
        with enforced():
            assert client.put(url, json={"workflow_status": "upcoming"}, headers=other).status_code == 404
    finally:
        database.execute(delete(ObligationTracking).where(ObligationTracking.document_id == document_id))
        database.commit()
