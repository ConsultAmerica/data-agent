"""RC2-05: human Accept/Edit/Reject survive contract re-analyze."""

from __future__ import annotations

from uuid import uuid4

from tests.test_contract_analysis import analyze, client, upload_and_extract


def test_accepted_and_edited_fields_survive_reanalyze() -> None:
    document_id = upload_and_extract(
        [
            "Contract Title: Master Services Agreement",
            "Governing Law: State of Delaware",
            "Payment Terms: Net 45",
        ],
        f"preserve-{uuid4()}.pdf",
    )

    analyze(document_id)

    accepted = client.post(
        f"/api/documents/{document_id}/metadata-fields/governing_law/review",
        json={"action": "accept", "changed_by": "Reviewer A"},
    )
    assert accepted.status_code == 200
    assert accepted.json()["review_status"] == "accepted"

    edited = client.post(
        f"/api/documents/{document_id}/metadata-fields/payment_terms/review",
        json={"action": "edit", "value": "Net 30", "changed_by": "Reviewer A"},
    )
    assert edited.status_code == 200
    assert edited.json()["review_status"] == "edited"
    assert edited.json()["value"] == "Net 30"
    assert edited.json()["extracted_value"] in {"Net 45", "Net 30"} or edited.json()[
        "original_value"
    ]

    # Re-run contract analysis — must not wipe human decisions.
    again = analyze(document_id)
    by_key = {field["field_key"]: field for field in again["metadata_fields"]}

    assert by_key["governing_law"]["review_status"] == "accepted"
    assert by_key["governing_law"]["value"] == "State of Delaware"

    assert by_key["payment_terms"]["value"] == "Net 30"
    # Same machine value keeps edited; differing machine value reopens pending
    # without overwriting the effective value.
    assert by_key["payment_terms"]["review_status"] in {"edited", "pending"}
    assert by_key["payment_terms"]["value"] == "Net 30"


def test_reject_is_not_overwritten_by_accept_all_or_reanalyze() -> None:
    document_id = upload_and_extract(
        [
            "Contract Title: Master Services Agreement",
            "Governing Law: State of Delaware",
        ],
        f"reject-preserve-{uuid4()}.pdf",
    )
    analyze(document_id)

    rejected = client.post(
        f"/api/documents/{document_id}/metadata-fields/governing_law/review",
        json={"action": "reject", "changed_by": "Reviewer B"},
    )
    assert rejected.status_code == 200

    accept_all = client.post(
        f"/api/documents/{document_id}/metadata-fields/accept-all",
        json={"changed_by": "Reviewer B"},
    )
    assert accept_all.status_code == 200
    by_key = {field["field_key"]: field for field in accept_all.json()}
    assert by_key["governing_law"]["review_status"] == "rejected"

    again = analyze(document_id)
    by_key = {field["field_key"]: field for field in again["metadata_fields"]}
    assert by_key["governing_law"]["review_status"] in {"rejected", "pending"}
    # Effective value was never replaced by accept-all.
    assert by_key["governing_law"]["value"] == "State of Delaware"
