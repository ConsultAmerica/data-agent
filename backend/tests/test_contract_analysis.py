from typing import Any
from unittest.mock import patch
from uuid import uuid4

import fitz
from fastapi.testclient import TestClient

from app.main import app
from app.services.ai_provider import AIProvider
from app.services.contract_field_schema import FieldSpec


client = TestClient(app)


class StubAIProvider(AIProvider):
    """Deterministic stand-in for Gemini so tests don't need a live key."""

    async def extract(
        self, *, instruction: str, page_context: str
    ) -> dict[str, Any]:
        return {"answer": None, "values": [], "warnings": []}

    async def classify(self, *, page_context: str) -> dict[str, Any]:
        if "Amendment" in page_context:
            return {
                "document_type": "Amendment",
                "industry": "Technology",
                "contract_side": "buy_side",
                "language": "English",
                "confidence": 0.9,
            }

        return {
            "document_type": "Master Services Agreement",
            "industry": "Technology",
            "contract_side": "buy_side",
            "language": "English",
            "confidence": 0.95,
        }

    async def extract_fields(
        self, *, page_context: str, field_specs: list[FieldSpec]
    ) -> dict[str, Any]:
        return {"fields": []}

    async def extract_clauses(
        self, *, page_context: str
    ) -> dict[str, Any]:
        return {"clauses": []}

    async def extract_signatures(
        self, *, page_context: str
    ) -> dict[str, Any]:
        return {"signatures": []}

    async def extract_structured_tables(
        self, *, page_context: str, table_specs: list
    ) -> dict[str, Any]:
        return {"rows": []}


def create_pdf(lines: list[str]) -> bytes:
    pdf = fitz.open()
    page = pdf.new_page()

    y = 72
    for line in lines:
        page.insert_text((72, y), line)
        y += 20

    content = pdf.tobytes()
    pdf.close()

    return content


def unique_contract_number(prefix: str = "MSA") -> str:
    unique = uuid4().int
    return f"{prefix}-{2000 + unique % 200}-{100000 + unique % 900000}"


def upload_and_extract(lines: list[str], filename: str) -> str:
    response = client.post(
        "/api/documents/upload",
        files={
            "file": (filename, create_pdf(lines), "application/pdf")
        },
    )

    assert response.status_code == 201, response.text
    document_id = response.json()["document_id"]

    extraction = client.post(
        f"/api/documents/{document_id}/extract-pages",
        json={
            "run_ocr": False,
            "page_start": None,
            "page_end": None,
            "force_reprocess": False,
        },
    )

    assert extraction.status_code == 200, extraction.text

    return document_id


def analyze(document_id: str) -> dict:
    with patch(
        "app.api.contract_analysis.create_ai_provider",
        return_value=StubAIProvider(),
    ):
        response = client.post(
            f"/api/documents/{document_id}/analyze-contract"
        )

    assert response.status_code == 200, response.text

    return response.json()


def test_metadata_extraction_deterministic_fields() -> None:
    contract_number = unique_contract_number()

    document_id = upload_and_extract(
        [
            "Contract Title: Master Services Agreement",
            f"Contract Number: {contract_number}",
            "Governing Law: State of Delaware",
            "Effective Date: January 1, 2026",
        ],
        f"msa-{uuid4()}.pdf",
    )

    result = analyze(document_id)

    fields_by_key = {
        field["field_key"]: field
        for field in result["metadata_fields"]
    }

    assert fields_by_key["contract_title"]["value"] == (
        "Master Services Agreement"
    )
    assert (
        fields_by_key["contract_number"]["value"] == contract_number
    )
    assert fields_by_key["governing_law"]["extraction_method"] == (
        "label_value"
    )
    # Dates are normalized to ISO format.
    assert fields_by_key["effective_date"]["value"] == "2026-01-01"

    assert result["classification"]["document_type"] == (
        "Master Services Agreement"
    )
    assert result["relationship"] is None


def test_naics_code_field_normalized_via_code_pattern() -> None:
    document_id = upload_and_extract(
        [
            "Contract Title: Government Services Agreement",
            "NAICS Code: 541511",
        ],
        f"naics-{uuid4()}.pdf",
    )

    result = analyze(document_id)

    fields_by_key = {
        field["field_key"]: field
        for field in result["metadata_fields"]
    }

    assert fields_by_key["naics_code"]["value"] == "541511"
    assert fields_by_key["naics_code"]["field_group"] == "Government"


def test_relationship_detection_and_confirm() -> None:
    contract_number = unique_contract_number()

    msa_id = upload_and_extract(
        [
            "Contract Title: Master Services Agreement",
            f"Contract Number: {contract_number}",
        ],
        f"msa-{uuid4()}.pdf",
    )
    analyze(msa_id)

    amendment_id = upload_and_extract(
        [
            "Contract Title: Amendment No. 2 to Master Services Agreement",
            f"Contract Number: {unique_contract_number('AMD')}",
            (
                "This Amendment is entered into pursuant to the "
                f"Master Services Agreement ({contract_number})."
            ),
        ],
        f"amendment-{uuid4()}.pdf",
    )
    result = analyze(amendment_id)

    relationship = result["relationship"]

    assert relationship is not None
    assert relationship["parent_document_id"] == msa_id
    assert relationship["matched_on"] == "contract_number"
    assert relationship["confidence"] >= 0.9
    assert relationship["status"] == "pending"

    confirm_response = client.post(
        f"/api/documents/{amendment_id}/confirm-relationship",
        json={"action": "confirm"},
    )

    assert confirm_response.status_code == 200
    body = confirm_response.json()
    assert body["status"] == "confirmed"
    assert body["relationship"]["parent_document_id"] == msa_id


def test_relationship_reject_clears_parent() -> None:
    contract_number = unique_contract_number()

    msa_id = upload_and_extract(
        [
            "Contract Title: Master Services Agreement",
            f"Contract Number: {contract_number}",
        ],
        f"msa-{uuid4()}.pdf",
    )
    analyze(msa_id)

    amendment_id = upload_and_extract(
        [
            "Contract Title: Amendment No. 3 to Master Services Agreement",
            f"Contract Number: {unique_contract_number('AMD')}",
            (
                "This Amendment is entered into pursuant to the "
                f"Master Services Agreement ({contract_number})."
            ),
        ],
        f"amendment-{uuid4()}.pdf",
    )
    result = analyze(amendment_id)

    assert result["relationship"] is not None

    reject_response = client.post(
        f"/api/documents/{amendment_id}/confirm-relationship",
        json={"action": "reject"},
    )

    assert reject_response.status_code == 200
    body = reject_response.json()
    assert body["status"] == "rejected"
    assert body["relationship"] is None

    # Resolving again should now report nothing pending.
    second_reject = client.post(
        f"/api/documents/{amendment_id}/confirm-relationship",
        json={"action": "reject"},
    )

    assert second_reject.status_code == 409


def test_child_relationships_lists_confirmed_and_pending_children() -> None:
    contract_number = unique_contract_number()

    msa_id = upload_and_extract(
        [
            "Contract Title: Master Services Agreement",
            f"Contract Number: {contract_number}",
        ],
        f"msa-{uuid4()}.pdf",
    )
    analyze(msa_id)

    no_children_yet = client.get(
        f"/api/documents/{msa_id}/child-relationships"
    )
    assert no_children_yet.status_code == 200
    assert no_children_yet.json()["children"] == []

    amendment_id = upload_and_extract(
        [
            "Contract Title: Amendment No. 4 to Master Services Agreement",
            f"Contract Number: {unique_contract_number('AMD')}",
            (
                "This Amendment is entered into pursuant to the "
                f"Master Services Agreement ({contract_number})."
            ),
        ],
        f"amendment-{uuid4()}.pdf",
    )
    analyze(amendment_id)

    client.post(
        f"/api/documents/{amendment_id}/confirm-relationship",
        json={"action": "confirm"},
    )

    response = client.get(f"/api/documents/{msa_id}/child-relationships")
    assert response.status_code == 200

    body = response.json()
    assert body["parent_document_id"] == msa_id
    assert len(body["children"]) == 1

    child = body["children"][0]
    assert child["child_document_id"] == amendment_id
    assert child["status"] == "confirmed"
    assert child["relationship_type"] == "amendment_of"


def test_approve_document_requires_full_review() -> None:
    contract_number = unique_contract_number()

    document_id = upload_and_extract(
        [
            "Contract Title: Master Services Agreement",
            f"Contract Number: {contract_number}",
            "Governing Law: State of Delaware",
        ],
        f"msa-{uuid4()}.pdf",
    )
    analyze(document_id)

    blocked = client.post(
        f"/api/documents/{document_id}/approve",
        json={"changed_by": "Consult America"},
    )
    assert blocked.status_code == 409

    fields = client.get(
        f"/api/documents/{document_id}/analyze-contract"
    ).json()["metadata_fields"]

    for field in fields:
        review = client.post(
            f"/api/documents/{document_id}/metadata-fields/"
            f"{field['field_key']}/review",
            json={"action": "accept", "changed_by": "Consult America"},
        )
        assert review.status_code == 200

    approved = client.post(
        f"/api/documents/{document_id}/approve",
        json={"changed_by": "Consult America"},
    )
    assert approved.status_code == 200

    body = approved.json()
    assert body["document_id"] == document_id
    assert body["approved_by"] == "Consult America"
    assert body["approved_at"]

    detail = client.get(f"/api/documents/{document_id}")
    assert detail.status_code == 200
    assert detail.json()["approved_by"] == "Consult America"


def test_promote_document_requires_approval_first() -> None:
    document_id = upload_and_extract(
        [
            "Contract Title: Master Services Agreement",
            f"Contract Number: {unique_contract_number()}",
        ],
        f"promote-{uuid4()}.pdf",
    )
    analyze(document_id)

    blocked = client.post(
        f"/api/documents/{document_id}/promote",
        json={"changed_by": "Consult America"},
    )
    assert blocked.status_code == 409

    fields = client.get(
        f"/api/documents/{document_id}/analyze-contract"
    ).json()["metadata_fields"]

    for field in fields:
        client.post(
            f"/api/documents/{document_id}/metadata-fields/"
            f"{field['field_key']}/review",
            json={"action": "accept", "changed_by": "Consult America"},
        )

    # Still blocked — approved, but not yet promoted, must not imply
    # repository membership.
    still_blocked = client.post(
        f"/api/documents/{document_id}/promote",
        json={"changed_by": "Consult America"},
    )
    assert still_blocked.status_code == 409

    approved = client.post(
        f"/api/documents/{document_id}/approve",
        json={"changed_by": "Consult America"},
    )
    assert approved.status_code == 200

    search_before = client.get(
        "/api/documents/search", params={"q": document_id}
    ).json()
    assert search_before["documents"] == [] or all(
        doc["repository_status"] != "repository"
        for doc in search_before["documents"]
    )

    promoted = client.post(
        f"/api/documents/{document_id}/promote",
        json={"changed_by": "Consult America"},
    )
    assert promoted.status_code == 200

    body = promoted.json()
    assert body["document_id"] == document_id
    assert body["promoted_by"] == "Consult America"
    assert body["promoted_at"]

    detail = client.get(f"/api/documents/{document_id}")
    assert detail.status_code == 200
    assert detail.json()["promoted_by"] == "Consult America"


def test_promote_unknown_document_returns_404() -> None:
    response = client.post(
        "/api/documents/not-a-real-id/promote",
        json={"changed_by": "Consult America"},
    )

    assert response.status_code == 404


def test_section_citation_detected() -> None:
    document_id = upload_and_extract(
        [
            "6.2 Payment Terms",
            "Payment Terms: Net 30",
        ],
        f"section-{uuid4()}.pdf",
    )

    result = analyze(document_id)

    fields_by_key = {
        field["field_key"]: field
        for field in result["metadata_fields"]
    }

    payment_terms = fields_by_key["payment_terms"]
    assert payment_terms["value"] == "Net 30"
    assert payment_terms["evidence"]["section"] == (
        "Section 6.2 — Payment Terms"
    )


def test_structured_output_typed_and_nested() -> None:
    document_id = upload_and_extract(
        [
            "Contract Value: $1,250,000.00",
            "Auto Renewal: Automatic",
            "Renewal Period: 12 months",
            "Termination Notice: 90 days notice",
        ],
        f"structured-{uuid4()}.pdf",
    )

    analyze(document_id)

    response = client.get(
        f"/api/documents/{document_id}/structured-output"
    )

    assert response.status_code == 200
    body = response.json()

    assert body["contract_value"] == 1250000.0
    assert isinstance(body["contract_value"], float)

    assert "auto_renewal" not in body
    assert "renewal_period" not in body
    assert "termination_notice" not in body

    assert body["renewal"] == {
        "type": "automatic",
        "period_months": 12,
        "notice_days": 90,
    }


def test_structured_output_requires_prior_analysis() -> None:
    document_id = upload_and_extract(
        ["Contract Title: Unanalyzed Document"],
        f"unanalyzed-{uuid4()}.pdf",
    )

    response = client.get(
        f"/api/documents/{document_id}/structured-output"
    )

    assert response.status_code == 404


def test_get_analysis_reads_back_persisted_state() -> None:
    document_id = upload_and_extract(
        [
            "Contract Title: Master Services Agreement",
            f"Contract Number: {unique_contract_number()}",
        ],
        f"readback-{uuid4()}.pdf",
    )

    computed = analyze(document_id)

    response = client.get(
        f"/api/documents/{document_id}/analyze-contract"
    )

    assert response.status_code == 200
    read_back = response.json()

    assert read_back["classification"]["document_type"] == (
        computed["classification"]["document_type"]
    )

    computed_by_key = {
        f["field_key"]: f for f in computed["metadata_fields"]
    }
    read_back_by_key = {
        f["field_key"]: f for f in read_back["metadata_fields"]
    }

    assert computed_by_key.keys() == read_back_by_key.keys()
    for key, field in computed_by_key.items():
        assert read_back_by_key[key]["value"] == field["value"]
        assert read_back_by_key[key]["review_status"] == "pending"
        assert (
            read_back_by_key[key]["original_value"]
            == field["value"]
        )


def test_get_analysis_before_analyzing_returns_404() -> None:
    document_id = upload_and_extract(
        ["Contract Title: Never Analyzed"],
        f"never-analyzed-{uuid4()}.pdf",
    )

    response = client.get(
        f"/api/documents/{document_id}/analyze-contract"
    )

    assert response.status_code == 404


def test_get_analysis_counts_staged_values_as_analyzed() -> None:
    """The staging pipeline stores reviewable values without classifying the
    document; the review page must open them, not say "not analyzed"."""

    from app.database.session import SessionLocal
    from app.models.document_metadata_field import DocumentMetadataField

    document_id = upload_and_extract(
        ["Contract Number: W91ZZZ26C0042"],
        f"staged-only-{uuid4()}.pdf",
    )
    with SessionLocal() as database:
        database.add(
            DocumentMetadataField(
                document_id=document_id, field_group="Identification", field_key="contract_number",
                label="Contract Number", value="W91ZZZ26C0042", confidence=0.85,
                extraction_method="deterministic", evidence_json={}, verified=False,
                human_approved=False, review_status="pending", original_value="W91ZZZ26C0042",
                extraction_source="staging",
            )
        )
        database.commit()

    response = client.get(f"/api/documents/{document_id}/analyze-contract")

    assert response.status_code == 200
    body = response.json()
    assert [field["value"] for field in body["metadata_fields"]] == ["W91ZZZ26C0042"]
    assert body["classification"]["document_type"]


def test_accept_single_field() -> None:
    document_id = upload_and_extract(
        [
            "Contract Title: Master Services Agreement",
            "Governing Law: State of Delaware",
        ],
        f"accept-{uuid4()}.pdf",
    )

    analyze(document_id)

    response = client.post(
        f"/api/documents/{document_id}"
        "/metadata-fields/governing_law/review",
        json={"action": "accept", "changed_by": "Asif Kamran"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["field_key"] == "governing_law"
    assert body["review_status"] == "accepted"
    assert body["value"] == "State of Delaware"

    # Other fields remain pending.
    read_back = client.get(
        f"/api/documents/{document_id}/analyze-contract"
    ).json()

    by_key = {
        f["field_key"]: f for f in read_back["metadata_fields"]
    }
    assert by_key["governing_law"]["review_status"] == "accepted"
    assert by_key["contract_title"]["review_status"] == "pending"


def test_edit_field_preserves_original_value_and_logs_audit() -> None:
    document_id = upload_and_extract(
        ["Payment Terms: Net 45"],
        f"edit-{uuid4()}.pdf",
    )

    analyze(document_id)

    response = client.post(
        f"/api/documents/{document_id}"
        "/metadata-fields/payment_terms/review",
        json={
            "action": "edit",
            "value": "Net 30",
            "changed_by": "Asif Kamran",
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["review_status"] == "edited"
    assert body["value"] == "Net 30"
    assert body["original_value"] == "Net 45"

    audit = client.get(
        f"/api/documents/{document_id}"
        "/metadata-fields/payment_terms/audit-log"
    ).json()

    assert len(audit) == 1
    assert audit[0]["action"] == "edit"
    assert audit[0]["previous_value"] == "Net 45"
    assert audit[0]["new_value"] == "Net 30"
    assert audit[0]["changed_by"] == "Asif Kamran"


def test_edit_field_requires_a_value() -> None:
    document_id = upload_and_extract(
        ["Payment Terms: Net 45"],
        f"edit-missing-value-{uuid4()}.pdf",
    )

    analyze(document_id)

    response = client.post(
        f"/api/documents/{document_id}"
        "/metadata-fields/payment_terms/review",
        json={"action": "edit", "changed_by": "Asif Kamran"},
    )

    assert response.status_code == 400


def test_reject_and_mark_unknown() -> None:
    document_id = upload_and_extract(
        [
            "Contract Title: Master Services Agreement",
            "Governing Law: State of Delaware",
        ],
        f"reject-{uuid4()}.pdf",
    )

    analyze(document_id)

    reject_response = client.post(
        f"/api/documents/{document_id}"
        "/metadata-fields/governing_law/review",
        json={"action": "reject", "changed_by": "Asif Kamran"},
    )
    assert reject_response.json()["review_status"] == "rejected"

    unknown_response = client.post(
        f"/api/documents/{document_id}"
        "/metadata-fields/contract_title/review",
        json={"action": "mark_unknown", "changed_by": "Asif Kamran"},
    )
    assert unknown_response.json()["review_status"] == "unknown"


def test_review_unknown_field_returns_404() -> None:
    document_id = upload_and_extract(
        ["Contract Title: Master Services Agreement"],
        f"review-missing-{uuid4()}.pdf",
    )

    analyze(document_id)

    response = client.post(
        f"/api/documents/{document_id}"
        "/metadata-fields/not_a_real_field/review",
        json={"action": "accept", "changed_by": "Asif Kamran"},
    )

    assert response.status_code == 404


def test_accept_all_only_touches_pending_fields() -> None:
    document_id = upload_and_extract(
        [
            "Contract Title: Master Services Agreement",
            "Governing Law: State of Delaware",
            "Payment Terms: Net 30",
        ],
        f"accept-all-{uuid4()}.pdf",
    )

    analyzed = analyze(document_id)
    assert len(analyzed["metadata_fields"]) >= 3

    # Reject one field first — accept-all must not override it.
    client.post(
        f"/api/documents/{document_id}"
        "/metadata-fields/governing_law/review",
        json={"action": "reject", "changed_by": "Asif Kamran"},
    )

    response = client.post(
        f"/api/documents/{document_id}/metadata-fields/accept-all",
        json={"changed_by": "Asif Kamran"},
    )

    assert response.status_code == 200
    body = response.json()

    by_key = {field["field_key"]: field for field in body}
    assert by_key["governing_law"]["review_status"] == "rejected"
    assert by_key["contract_title"]["review_status"] == "accepted"


def test_document_status_computed_for_original_and_amendment() -> None:
    msa_id = upload_and_extract(
        ["Contract Title: Master Services Agreement"],
        f"status-msa-{uuid4()}.pdf",
    )
    result = analyze(msa_id)
    assert result["classification"]["document_status"] == "Original"

    amendment_id = upload_and_extract(
        ["Contract Title: Amendment No. 9 to Master Services Agreement"],
        f"status-amd-{uuid4()}.pdf",
    )
    result = analyze(amendment_id)
    assert result["classification"]["document_status"] == "Amendment"


def test_update_classification_records_audit_history() -> None:
    document_id = upload_and_extract(
        ["Contract Title: Master Services Agreement"],
        f"reclassify-{uuid4()}.pdf",
    )
    analyze(document_id)

    response = client.patch(
        f"/api/documents/{document_id}/classification",
        json={
            "document_type": "NDA",
            "changed_by": "Compliance Reviewer",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["document_type"] == "NDA"
    assert body["confidence"] == 1.0

    history = client.get(
        f"/api/documents/{document_id}/classification-history"
    )
    assert history.status_code == 200
    entries = history.json()
    assert len(entries) == 1
    assert entries[0]["field_changed"] == "document_type"
    assert entries[0]["previous_value"] == (
        "Master Services Agreement"
    )
    assert entries[0]["new_value"] == "NDA"
    assert entries[0]["changed_by"] == "Compliance Reviewer"

    # A no-op update (same value) must not add another audit row.
    client.patch(
        f"/api/documents/{document_id}/classification",
        json={"document_type": "NDA", "changed_by": "Compliance Reviewer"},
    )
    history_after = client.get(
        f"/api/documents/{document_id}/classification-history"
    )
    assert len(history_after.json()) == 1


def test_relationship_detection_includes_reasons() -> None:
    contract_number = unique_contract_number()

    msa_id = upload_and_extract(
        [
            "Contract Title: Master Services Agreement",
            f"Contract Number: {contract_number}",
        ],
        f"reasons-msa-{uuid4()}.pdf",
    )
    analyze(msa_id)

    amendment_id = upload_and_extract(
        [
            "Contract Title: Amendment No. 5 to Master Services Agreement",
            f"Contract Number: {unique_contract_number('AMD')}",
            (
                "This Amendment is entered into pursuant to the "
                f"Master Services Agreement ({contract_number})."
            ),
        ],
        f"reasons-amd-{uuid4()}.pdf",
    )
    result = analyze(amendment_id)

    reasons = result["relationship"]["reasons"]
    assert "Matching contract number" in reasons
    assert "Explicit agreement reference" in reasons
    assert result["relationship"]["detection_method"] == "automatic"


def test_manual_relationship_assignment() -> None:
    parent_id = upload_and_extract(
        ["Contract Title: Master Services Agreement"],
        f"manual-parent-{uuid4()}.pdf",
    )
    analyze(parent_id)

    child_id = upload_and_extract(
        ["Contract Title: Unrelated Standalone Document"],
        f"manual-child-{uuid4()}.pdf",
    )
    analyze(child_id)

    response = client.post(
        f"/api/documents/{child_id}/relationship",
        json={
            "parent_document_id": parent_id,
            "relationship_type": "amendment_of",
            "changed_by": "Contract Manager",
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["parent_document_id"] == parent_id
    assert body["status"] == "manual"
    assert body["detection_method"] == "manual"

    children = client.get(
        f"/api/documents/{parent_id}/child-relationships"
    )
    assert any(
        child["child_document_id"] == child_id
        for child in children.json()["children"]
    )

    remove = client.request(
        "DELETE",
        f"/api/documents/{child_id}/relationship",
        json={"changed_by": "Contract Manager"},
    )
    assert remove.status_code == 200


def test_relationship_rejects_self_reference() -> None:
    document_id = upload_and_extract(
        ["Contract Title: Standalone Document"],
        f"self-ref-{uuid4()}.pdf",
    )
    analyze(document_id)

    response = client.post(
        f"/api/documents/{document_id}/relationship",
        json={
            "parent_document_id": document_id,
            "changed_by": "Contract Manager",
        },
    )
    assert response.status_code == 422


def test_relationship_rejects_circular_chain() -> None:
    doc_a = upload_and_extract(
        ["Contract Title: Document A"],
        f"cycle-a-{uuid4()}.pdf",
    )
    analyze(doc_a)

    doc_b = upload_and_extract(
        ["Contract Title: Document B"],
        f"cycle-b-{uuid4()}.pdf",
    )
    analyze(doc_b)

    # A -> B
    first = client.post(
        f"/api/documents/{doc_a}/relationship",
        json={
            "parent_document_id": doc_b,
            "changed_by": "Contract Manager",
        },
    )
    assert first.status_code == 200

    # B -> A would close the loop; must be rejected.
    second = client.post(
        f"/api/documents/{doc_b}/relationship",
        json={
            "parent_document_id": doc_a,
            "changed_by": "Contract Manager",
        },
    )
    assert second.status_code == 409


def test_relationship_rejects_duplicate_link() -> None:
    parent_id = upload_and_extract(
        ["Contract Title: Master Services Agreement"],
        f"dup-parent-{uuid4()}.pdf",
    )
    analyze(parent_id)

    child_id = upload_and_extract(
        ["Contract Title: Standalone Document"],
        f"dup-child-{uuid4()}.pdf",
    )
    analyze(child_id)

    first = client.post(
        f"/api/documents/{child_id}/relationship",
        json={
            "parent_document_id": parent_id,
            "changed_by": "Contract Manager",
        },
    )
    assert first.status_code == 200

    second = client.post(
        f"/api/documents/{child_id}/relationship",
        json={
            "parent_document_id": parent_id,
            "changed_by": "Contract Manager",
        },
    )
    assert second.status_code == 409
