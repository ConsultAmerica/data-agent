from uuid import uuid4

import fitz
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def create_pdf(lines: list[str]) -> bytes:
    pdf = fitz.open()
    page = pdf.new_page()

    y = 72
    for line in lines:
        page.insert_text((72, y), line, fontsize=9)
        y += 14

    content = pdf.tobytes()
    pdf.close()

    return content


def upload_document(filename: str) -> str:
    upload = client.post(
        "/api/documents/upload",
        files={
            "file": (
                filename,
                create_pdf(["Contract Number: W912DR-26-C-0042"]),
                "application/pdf",
            )
        },
    )
    assert upload.status_code == 201, upload.text
    return upload.json()["document_id"]


def test_create_and_list_target_correction() -> None:
    document_id = upload_document(f"correction-{uuid4()}.pdf")

    create_response = client.post(
        f"/api/documents/{document_id}/targets/contract_number/corrections",
        json={
            "original_value": "W912DR-26-C-0042",
            "corrected_value": "W912DR-26-C-0043",
            "evidence": {
                "page_number": 1,
                "source_text": "Contract Number: W912DR-26-C-0042",
                "source_reference": "Page 1",
            },
            "changed_by": "reviewer@example.com",
        },
    )
    assert create_response.status_code == 201, create_response.text
    body = create_response.json()
    assert body["original_value"] == "W912DR-26-C-0042"
    assert body["corrected_value"] == "W912DR-26-C-0043"
    assert body["evidence_snapshot"]["page_number"] == 1

    list_response = client.get(f"/api/documents/{document_id}/corrections")
    assert list_response.status_code == 200, list_response.text
    corrections = list_response.json()
    assert len(corrections) == 1
    assert corrections[0]["normalized_key"] == "contract_number"
    assert corrections[0]["corrected_value"] == "W912DR-26-C-0043"


def test_second_edit_replaces_latest_value_but_keeps_history() -> None:
    document_id = upload_document(f"correction-history-{uuid4()}.pdf")

    client.post(
        f"/api/documents/{document_id}/targets/contract_number/corrections",
        json={
            "original_value": "W912DR-26-C-0042",
            "corrected_value": "First Correction",
        },
    )
    client.post(
        f"/api/documents/{document_id}/targets/contract_number/corrections",
        json={
            "original_value": "First Correction",
            "corrected_value": "Second Correction",
        },
    )

    list_response = client.get(f"/api/documents/{document_id}/corrections")
    corrections = list_response.json()
    assert len(corrections) == 1
    assert corrections[0]["corrected_value"] == "Second Correction"


def test_create_and_list_target_correction_defaults_action_to_edit() -> None:
    document_id = upload_document(f"correction-default-action-{uuid4()}.pdf")

    create_response = client.post(
        f"/api/documents/{document_id}/targets/contract_number/corrections",
        json={
            "original_value": "W912DR-26-C-0042",
            "corrected_value": "W912DR-26-C-0043",
        },
    )
    assert create_response.status_code == 201, create_response.text
    assert create_response.json()["action"] == "edit"


def test_mark_verified_does_not_change_the_value() -> None:
    document_id = upload_document(f"correction-verify-{uuid4()}.pdf")

    verify_response = client.post(
        f"/api/documents/{document_id}/targets/contract_number/corrections",
        json={
            "action": "verify",
            "original_value": "W912DR-26-C-0042",
            "changed_by": "reviewer@example.com",
        },
    )
    assert verify_response.status_code == 201, verify_response.text
    body = verify_response.json()
    assert body["action"] == "verify"
    assert body["original_value"] == "W912DR-26-C-0042"
    assert body["corrected_value"] is None

    list_response = client.get(f"/api/documents/{document_id}/corrections")
    corrections = list_response.json()
    assert len(corrections) == 1
    assert corrections[0]["action"] == "verify"


def test_edit_after_verify_replaces_latest_action() -> None:
    document_id = upload_document(f"correction-verify-then-edit-{uuid4()}.pdf")

    client.post(
        f"/api/documents/{document_id}/targets/contract_number/corrections",
        json={"action": "verify", "original_value": "W912DR-26-C-0042"},
    )
    client.post(
        f"/api/documents/{document_id}/targets/contract_number/corrections",
        json={
            "action": "edit",
            "original_value": "W912DR-26-C-0042",
            "corrected_value": "W912DR-26-C-0099",
        },
    )

    list_response = client.get(f"/api/documents/{document_id}/corrections")
    corrections = list_response.json()
    assert len(corrections) == 1
    assert corrections[0]["action"] == "edit"
    assert corrections[0]["corrected_value"] == "W912DR-26-C-0099"


def test_reject_records_action_and_audit_log() -> None:
    document_id = upload_document(f"correction-reject-{uuid4()}.pdf")

    reject = client.post(
        f"/api/documents/{document_id}/targets/contract_number/corrections",
        json={
            "action": "reject",
            "original_value": "W912DR-26-C-0042",
            "changed_by": "reviewer@example.com",
        },
    )
    assert reject.status_code == 201, reject.text
    assert reject.json()["action"] == "reject"

    audit = client.get("/api/documents/audit-log?limit=20")
    assert audit.status_code == 200, audit.text
    entries = audit.json()["entries"]
    match = next(
        (
            entry
            for entry in entries
            if entry["document_id"] == document_id
            and entry["field_key"] == "contract_number"
            and entry["action"] == "reject"
        ),
        None,
    )
    assert match is not None
    assert match["changed_by"] == "reviewer@example.com"
    assert match["actor_id"] == "actor-admin-default"
    assert match["actor_role"] == "admin"


def test_correction_requires_existing_document() -> None:
    response = client.post(
        f"/api/documents/{uuid4()}/targets/contract_number/corrections",
        json={"original_value": "a", "corrected_value": "b"},
    )
    assert response.status_code == 404


def test_correction_records_the_actor_and_reason() -> None:
    document_id = upload_document(f"correction-{uuid4()}.pdf")
    response = client.post(
        f"/api/documents/{document_id}/targets/contract_number/corrections",
        json={
            "original_value": "W912DR-26-C-0042",
            "corrected_value": "W912DR-26-C-0043",
            "changed_by": "any typed name",
            "reason_code": "ocr_error",
            "reason_text": "  3 read as 2  ",
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["actor_id"] == "actor-admin-default"
    assert body["reason_code"] == "ocr_error"
    assert body["reason_text"] == "3 read as 2"

    bad = client.post(
        f"/api/documents/{document_id}/targets/contract_number/corrections",
        json={"corrected_value": "x", "reason_code": "because"},
    )
    assert bad.status_code == 422
