"""Document isolation between browser workspaces (core/document_access.py),
under enforced RBAC as in production: an anonymous workspace reaches only
its own documents — knowing another document's UUID grants nothing — while
real credentials keep role-based access to everything."""

from __future__ import annotations

import re
import secrets
from contextlib import contextmanager
from unittest.mock import patch
from uuid import uuid4

import fitz
import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app

client = TestClient(app)


@contextmanager
def enforced():
    settings = get_settings().model_copy(update={"rbac_enforced": True, "public_workspace_access": True})
    with patch("app.core.auth.get_settings", return_value=settings):
        yield


def _ws() -> dict:
    return {"X-Workspace-Token": secrets.token_hex(32)}


def _pdf(text: str | None = None) -> bytes:
    pdf = fitz.open()
    page = pdf.new_page()
    page.insert_text((72, 72), text or f"Contract Number: ISO-{uuid4().hex[:10].upper()}", fontsize=10)
    page.insert_text((72, 92), "Payment Terms: Net 30", fontsize=10)
    return pdf.tobytes()


def _upload(headers: dict, content: bytes | None = None, **params) -> dict:
    response = client.post(
        "/api/documents/upload",
        params=params,
        files={"file": (f"iso-{uuid4()}.pdf", content or _pdf(), "application/pdf")},
        headers=headers,
    )
    assert response.status_code in (200, 201), response.text
    return response.json()


@pytest.fixture()
def owned():
    """Workspace A with one processed document; workspace B with none."""

    a, b = _ws(), _ws()
    with enforced():
        document_id = _upload(a)["document_id"]
        assert client.post(f"/api/documents/{document_id}/extract-pages", json={"run_ocr": False}, headers=a).status_code == 200
        yield a, b, document_id


def test_owner_reaches_its_document_and_workbook(owned):
    a, _, document_id = owned
    assert client.get(f"/api/documents/{document_id}", headers=a).status_code == 200
    assert client.get(f"/api/documents/{document_id}/staging-workbook", headers=a).status_code == 200
    assert client.get(f"/api/documents/{document_id}/pages/1/transcript", headers=a).status_code == 200


_SAMPLE = {"page_number": "1", "region_id": "r1", "field_key": "contract_number", "target_key": "t1", "clause_id": "1", "dataset_id": "all_fields", "field_id": "1"}


def test_every_document_scoped_route_refuses_another_workspace(owned):
    """Sweep the whole API: every /{document_id} route and method, called
    by workspace B with workspace A's document id, is refused (404, or 403
    where a permission check fires first) — never served."""

    _, b, document_id = owned
    paths = app.openapi()["paths"]
    checked = 0
    for path, operations in paths.items():
        if "{document_id}" not in path:
            continue
        url = path.replace("{document_id}", document_id)
        url = re.sub(r"\{(\w+)(?::[^}]*)?\}", lambda m: _SAMPLE.get(m.group(1), "1"), url)
        for method in operations:
            if method not in ("get", "post", "put", "patch", "delete"):
                continue
            response = client.request(method.upper(), url, headers=b, json={})
            assert response.status_code in (403, 404), f"{method.upper()} {path} → {response.status_code}"
            checked += 1
    assert checked >= 50


def test_listings_search_dashboard_and_hierarchy_hide_other_workspaces(owned):
    a, b, document_id = owned
    def ids(response):
        body = response.json()
        items = body if isinstance(body, list) else body.get("documents") or body.get("items") or []
        return {item.get("id") or item.get("document_id") for item in items}

    assert document_id in ids(client.get("/api/documents?limit=500", headers=a))
    assert document_id not in ids(client.get("/api/documents?limit=500", headers=b))
    assert document_id not in ids(client.get("/api/documents/search?limit=100", headers=b))
    assert document_id not in str(client.get("/api/documents/hierarchy", headers=b).json())
    assert document_id not in str(client.get("/api/documents/audit-log?limit=500", headers=b).json())
    assert document_id not in str(client.get("/api/dashboard/review-queue", headers=b).json())
    assert document_id not in str(client.get("/api/dashboard/review-queue/fields", headers=b).json())
    assert client.get("/api/dashboard/stats", headers=b).json()["total_documents"] == 0


def test_job_status_is_private_to_the_documents_workspace(owned):
    a, b, document_id = owned
    start = client.post(f"/api/documents/{document_id}/jobs/process", json={}, headers=a)
    if start.status_code != 202:
        start = client.post(f"/api/documents/{document_id}/jobs/extract", json={"target_ids": [], "use_ai_fallback": False}, headers=a)
    assert start.status_code == 202, start.text
    job_id = start.json()["id"]
    assert client.get(f"/v1/jobs/{job_id}", headers=a).status_code == 200
    assert client.get(f"/v1/jobs/{job_id}", headers=b).status_code == 404


def test_duplicate_detection_never_reveals_another_workspaces_file():
    a, b = _ws(), _ws()
    content = _pdf()
    with enforced():
        first = _upload(a, content)
        assert first["status"] != "duplicate_pending"
        second = _upload(b, content)
        # B uploads identical bytes: it gets its own document, not a hint
        # that A has the same file.
        assert second["status"] != "duplicate_pending"
        assert second.get("existing_document") is None
        assert second["document_id"] != first["document_id"]


def test_staged_upload_can_only_be_resolved_by_its_uploader():
    a, b = _ws(), _ws()
    content = _pdf()
    with enforced():
        original = _upload(a, content)
        staged = _upload(a, content)
        assert staged["status"] == "duplicate_pending"
        staged_id = staged["document_id"]
        payload = {"action": "use_existing", "existing_document_id": original["document_id"]}
        assert client.post(f"/api/documents/{staged_id}/resolve-duplicate", json=payload, headers=b).status_code == 404
        # B can't reach A's document through the body either.
        b_staged = _upload(b, content)
        b_staged_dup = _upload(b, content)
        assert b_staged_dup["status"] == "duplicate_pending"
        steal = client.post(
            f"/api/documents/{b_staged_dup['document_id']}/resolve-duplicate",
            json={"action": "use_existing", "existing_document_id": original["document_id"]},
            headers=b,
        )
        # B's own identical copy may be what it continues with — but A's
        # document is never returned for a body-supplied id.
        assert steal.status_code == 404 or steal.json()["document_id"] != original["document_id"]
        if steal.status_code == 200:
            assert steal.json()["document_id"] == b_staged["document_id"]
        assert client.post(f"/api/documents/{staged_id}/resolve-duplicate", json=payload, headers=a).status_code == 200
        assert b_staged["document_id"]


def test_cannot_link_to_another_workspaces_document(owned):
    a, b, document_id = owned
    with enforced():
        mine = _upload(b)["document_id"]
        response = client.post(
            f"/api/documents/{mine}/relationship",
            json={"parent_document_id": document_id, "changed_by": "b"},
            headers=b,
        )
    assert response.status_code == 404


def test_no_workspace_token_sees_nothing_and_real_credentials_see_everything(owned):
    _, _, document_id = owned
    assert client.get(f"/api/documents/{document_id}").status_code == 404
    assert client.get(f"/api/documents/{document_id}", headers={"X-Workspace-Token": "short"}).status_code == 404
    admin = {"Authorization": f"Bearer {get_settings().seed_service_api_key}"}
    assert client.get(f"/api/documents/{document_id}/staging-workbook", headers=admin).status_code == 200


def test_local_development_without_enforcement_is_unchanged():
    # RBAC not enforced (local default): the dev admin sees everything.
    document_id = _upload(_ws())["document_id"]
    assert client.get(f"/api/documents/{document_id}").status_code == 200
