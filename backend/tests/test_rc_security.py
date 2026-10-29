"""Release-candidate security checks — measurable, route-level.

Covers: RBAC on real routes, upload sanitization, CORS production shape,
audit actor/request context, log sanitization (no document text).
"""

from __future__ import annotations

from io import BytesIO
from unittest.mock import patch
from uuid import uuid4

import fitz
from fastapi.testclient import TestClient

from app.core.auth import hash_api_key
from app.core.config import Settings, get_settings
from app.core.observability import _sanitize, log_event
from app.database.session import SessionLocal
from app.main import app
from app.models.actor import Actor
from app.models.document_extracted_table import DocumentExtractedTable
from app.models.document_metadata_field import DocumentMetadataField
from app.models.metadata_field_audit_log import MetadataFieldAuditLog
from app.services.file_upload import sanitize_display_filename
from sqlalchemy import select

client = TestClient(app)


def _pdf() -> bytes:
    pdf = fitz.open()
    page = pdf.new_page()
    page.insert_text((72, 72), "SECRET CLAUSE TEXT SHOULD NEVER LOG", fontsize=10)
    content = pdf.tobytes()
    pdf.close()
    return content


def test_production_cors_excludes_lan_debug_origins() -> None:
    settings = Settings(
        app_env="production",
        debug=False,
        frontend_url="https://data-agent-ca.vercel.app",
    )
    origins = settings.cors_origins
    assert "https://data-agent-ca.vercel.app" in origins
    # The production domain, even when FRONTEND_URL doesn't list it.
    assert "https://dataomatix.com" in origins
    assert "https://www.dataomatix.com" in origins
    assert "http://192.168.0.193:3000" not in origins
    assert "http://127.0.0.1:3001" not in origins


def test_path_traversal_filename_sanitized() -> None:
    cleaned = sanitize_display_filename(
        "../../etc/passwd\x00<script>.pdf", extension=".pdf"
    )
    assert ".." not in cleaned
    assert "/" not in cleaned
    assert "\\" not in cleaned
    assert "\x00" not in cleaned
    assert cleaned.endswith(".pdf")
    assert "<" not in cleaned


def test_reject_executable_upload() -> None:
    response = client.post(
        "/api/documents/upload",
        files={
            "file": (
                "malware.exe",
                b"MZ\x90\x00not-a-pdf",
                "application/octet-stream",
            )
        },
    )
    assert response.status_code in {400, 415, 422}
    # Must not create a stored document row for executables.
    assert "document_id" not in (response.json() if response.headers.get("content-type", "").startswith("application/json") else {})


def test_rbac_viewer_blocked_on_oracle_and_corrections() -> None:
    upload = client.post(
        "/api/documents/upload",
        files={"file": (f"rc-{uuid4()}.pdf", _pdf(), "application/pdf")},
    )
    assert upload.status_code == 201
    document_id = upload.json()["document_id"]

    database = SessionLocal()
    try:
        database.add(
            DocumentMetadataField(
                document_id=document_id,
                field_group="Identifiers",
                field_key="contract_number",
                label="Contract Number",
                value="X",
                original_value="X",
                confidence=0.9,
                confidence_band="high",
                value_type="identifier",
                extraction_method="label_value",
                evidence_json={"page_number": 1, "source_text": "X", "source_reference": "p1"},
                verified=True,
                review_status="pending",
                extraction_source="target",
            )
        )
        database.commit()
    finally:
        database.close()

    headers = {"X-Actor-Id": "actor-viewer-default"}
    export = client.get(f"/api/documents/{document_id}/export", headers=headers)
    assert export.status_code == 403

    correction = client.post(
        f"/api/documents/{document_id}/targets/contract_number/corrections",
        headers=headers,
        json={"action": "verify", "original_value": "X"},
    )
    assert correction.status_code == 403

    oracle = client.get(
        f"/api/documents/{document_id}/oracle-payload",
        headers=headers,
    )
    assert oracle.status_code == 403


def test_audit_includes_actor_and_request_id() -> None:
    upload = client.post(
        "/api/documents/upload",
        files={"file": (f"rc-audit-{uuid4()}.pdf", _pdf(), "application/pdf")},
    )
    document_id = upload.json()["document_id"]
    database = SessionLocal()
    try:
        database.add(
            DocumentMetadataField(
                document_id=document_id,
                field_group="Financial",
                field_key="total_amount",
                label="Total Amount",
                value="$1",
                original_value="$1",
                confidence=0.9,
                confidence_band="high",
                value_type="currency",
                extraction_method="label_value",
                evidence_json={"page_number": 1, "source_text": "$1", "source_reference": "p1"},
                verified=True,
                review_status="pending",
                extraction_source="target",
            )
        )
        database.commit()
    finally:
        database.close()

    response = client.post(
        f"/api/documents/{document_id}/targets/total_amount/corrections",
        headers={"X-Actor-Id": "actor-reviewer-default"},
        json={
            "action": "edit",
            "original_value": "$1",
            "corrected_value": "$2",
            "changed_by": "RC Reviewer",
        },
    )
    assert response.status_code == 201
    assert response.headers.get("x-request-id")

    database = SessionLocal()
    try:
        row = database.scalar(
            select(MetadataFieldAuditLog).where(
                MetadataFieldAuditLog.document_id == document_id,
                MetadataFieldAuditLog.action == "edit",
            )
        )
        assert row is not None
        assert row.actor_id == "actor-reviewer-default"
        assert row.actor_role == "reviewer"
        assert row.request_id
        assert row.changed_by == "RC Reviewer"
    finally:
        database.close()


def test_log_sanitize_strips_document_text(caplog) -> None:
    clean = _sanitize(
        {
            "event": "extract",
            "source_text": "SECRET CLAUSE TEXT SHOULD NEVER LOG",
            "final_text": "full page body",
            "prompt": "system prompt leak",
            "page_number": 3,
            "document_id": "abc",
        }
    )
    assert "source_text" not in clean
    assert "final_text" not in clean
    assert "prompt" not in clean
    assert clean["page_number"] == 3
    assert clean["document_id"] == "abc"

    with caplog.at_level("INFO", logger="dataomatix.obs"):
        log_event(
            "test_event",
            source_text="SECRET CLAUSE TEXT SHOULD NEVER LOG",
            page=1,
        )
    joined = " ".join(record.getMessage() for record in caplog.records)
    assert "SECRET CLAUSE" not in joined


def test_frontend_public_env_has_no_secret_keys() -> None:
    """Guardrail: client env example must only expose NEXT_PUBLIC_ / URLs."""

    from pathlib import Path

    example = Path(__file__).resolve().parents[2] / "frontend" / ".env.example"
    text = example.read_text(encoding="utf-8")
    for banned in (
        "API_KEY",
        "SERVICE_ROLE",
        "SECRET",
        "PASSWORD",
        "PRIVATE_KEY",
    ):
        # Allow comments that mention keys conceptually; ban assignments.
        for line in text.splitlines():
            stripped = line.strip()
            if stripped.startswith("#") or not stripped:
                continue
            assert banned not in stripped.upper() or stripped.upper().startswith(
                "NEXT_PUBLIC_"
            ), f"Suspicious frontend env line: {stripped}"


def test_rbac_enforced_blocks_spoofed_admin_on_export() -> None:
    upload = client.post(
        "/api/documents/upload",
        files={"file": (f"rc-spoof-{uuid4()}.pdf", _pdf(), "application/pdf")},
    )
    document_id = upload.json()["document_id"]
    enforced = get_settings().model_copy(
        update={"rbac_enforced": True, "public_workspace_access": False}
    )
    with patch("app.core.auth.get_settings", return_value=enforced):
        response = client.get(
            f"/api/documents/{document_id}/export",
            headers={"X-Actor-Id": "actor-admin-default"},
        )
    assert response.status_code == 401


def test_rbac_enforced_csv_xlsx_line_items_require_real_auth() -> None:
    """P0 regression for the previously-reported "Export Excel failed
    (401)" bug: CSV/XLSX/line-items must use the exact same auth gate as
    the JSON export that already worked — 401 unauthenticated, 200 with a
    real credential, for every export format, not just JSON."""

    upload = client.post(
        "/api/documents/upload",
        files={"file": (f"rc-export-auth-{uuid4()}.pdf", _pdf(), "application/pdf")},
    )
    document_id = upload.json()["document_id"]

    database = SessionLocal()
    try:
        database.add(
            DocumentMetadataField(
                document_id=document_id,
                field_group="Header",
                field_key="contract_number",
                label="Contract Number",
                value="47QRCA25DSF07",
                original_value="47QRCA25DSF07",
                confidence=0.9,
                value_type="text",
                extraction_method="layout",
                evidence_json={"page_number": 1, "source_text": "Contract Number: 47QRCA25DSF07"},
                verified=True,
                review_status="accepted",
                extraction_source="target",
            )
        )
        database.add(
            DocumentExtractedTable(
                document_id=document_id,
                target_key="clins",
                display_name="CLINs",
                columns_json=["clin", "description", "amount"],
                rows_json=[{"clin": "0001", "description": "Labor", "amount": "1000"}],
                pages_json=[1],
                extraction_method="layout",
                confidence=0.88,
            )
        )
        raw_key = f"rc-service-key-{uuid4()}"
        database.add(
            Actor(
                id=f"actor-rc-export-service-{uuid4()}",
                actor_type="service",
                display_name="RC Export Service",
                role="admin",
                api_key_hash=hash_api_key(raw_key),
                active=True,
            )
        )
        database.commit()
    finally:
        database.close()

    endpoints = [
        f"/api/documents/{document_id}/export.csv",
        f"/api/documents/{document_id}/export.xlsx",
        f"/api/documents/{document_id}/normalized",
        f"/api/documents/{document_id}/export/line-items.csv",
    ]

    enforced = get_settings().model_copy(
        update={"rbac_enforced": True, "public_workspace_access": False}
    )
    with patch("app.core.auth.get_settings", return_value=enforced):
        for path in endpoints:
            unauthenticated = client.get(path)
            assert unauthenticated.status_code == 401, path

            authenticated = client.get(
                path, headers={"Authorization": f"Bearer {raw_key}"}
            )
            assert authenticated.status_code == 200, (path, authenticated.text)


def test_v3_endpoints_reject_unauthenticated_when_rbac_enforced() -> None:
    """Release-blocking regression: a fully unauthenticated caller — no
    Authorization header, no X-Actor-Id — must never reach another
    actor's canonical V3 document data merely by knowing a document_id.
    Confirmed via a live production probe that these routes previously
    reached the database lookup (404 "not found") with zero credentials
    instead of ever raising 401/403; gated the same way reviewed_export.py
    already gates its own CSV/XLSX/JSON surface."""

    upload = client.post(
        "/api/documents/upload",
        files={"file": (f"rc-v3-auth-{uuid4()}.pdf", _pdf(), "application/pdf")},
    )
    document_id = upload.json()["document_id"]

    database = SessionLocal()
    try:
        raw_key = f"rc-v3-service-key-{uuid4()}"
        database.add(
            Actor(
                id=f"actor-rc-v3-service-{uuid4()}",
                actor_type="service",
                display_name="RC V3 Export Service",
                role="admin",
                api_key_hash=hash_api_key(raw_key),
                active=True,
            )
        )
        database.commit()
    finally:
        database.close()

    endpoints = [
        f"/api/documents/{document_id}/v3",
        f"/api/documents/{document_id}/v3/all-fields.csv",
        f"/api/documents/{document_id}/v3/export.xlsx",
        f"/api/documents/{document_id}",
    ]

    enforced = get_settings().model_copy(
        update={"rbac_enforced": True, "public_workspace_access": False}
    )
    with patch("app.core.auth.get_settings", return_value=enforced):
        for path in endpoints:
            unauthenticated = client.get(path)
            assert unauthenticated.status_code == 401, (
                f"{path} must reject an unauthenticated caller under "
                f"enforced RBAC, got {unauthenticated.status_code}"
            )

            authenticated = client.get(
                path, headers={"Authorization": f"Bearer {raw_key}"}
            )
            assert authenticated.status_code == 200, (path, authenticated.text)


def test_v3_endpoints_still_open_in_local_dev_default() -> None:
    """The permission gate must not regress local/dev usability: with
    RBAC not enforced (this app's default outside production), the
    existing dev-fallback admin actor still resolves and these routes
    keep working exactly as they did before this fix, unauthenticated."""

    upload = client.post(
        "/api/documents/upload",
        files={"file": (f"rc-v3-dev-{uuid4()}.pdf", _pdf(), "application/pdf")},
    )
    document_id = upload.json()["document_id"]

    for path in (
        f"/api/documents/{document_id}/v3",
        f"/api/documents/{document_id}/v3/all-fields.csv",
        f"/api/documents/{document_id}/v3/export.xlsx",
        f"/api/documents/{document_id}",
    ):
        response = client.get(path)
        assert response.status_code == 200, (path, response.text)
