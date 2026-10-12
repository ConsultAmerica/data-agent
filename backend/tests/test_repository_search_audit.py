from typing import Any
from unittest.mock import patch
from uuid import uuid4

import fitz
from fastapi.testclient import TestClient

from app.main import app
from app.services.ai_provider import AIProvider
from app.services.contract_field_schema import FieldSpec


client = TestClient(app)


class RepoSearchStubAIProvider(AIProvider):
    async def extract(
        self, *, instruction: str, page_context: str
    ) -> dict[str, Any]:
        return {"answer": None, "values": [], "warnings": []}

    async def classify(self, *, page_context: str) -> dict[str, Any]:
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


class HierarchyStubAIProvider(AIProvider):
    """Classifies by content, so an Amendment fixture actually
    triggers relationship detection (unlike the fixed-type stub
    above)."""

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


def analyze_with_type_detection(document_id: str) -> dict:
    with patch(
        "app.api.contract_analysis.create_ai_provider",
        return_value=HierarchyStubAIProvider(),
    ):
        response = client.post(
            f"/api/documents/{document_id}/analyze-contract"
        )

    assert response.status_code == 200, response.text

    return response.json()


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


def upload(lines: list[str], filename: str) -> str:
    response = client.post(
        "/api/documents/upload",
        files={
            "file": (filename, create_pdf(lines), "application/pdf")
        },
    )

    assert response.status_code == 201, response.text

    return response.json()["document_id"]


def extract_pages(document_id: str) -> None:
    response = client.post(
        f"/api/documents/{document_id}/extract-pages",
        json={
            "run_ocr": False,
            "page_start": None,
            "page_end": None,
            "force_reprocess": False,
        },
    )

    assert response.status_code == 200, response.text


def analyze(document_id: str) -> dict:
    with patch(
        "app.api.contract_analysis.create_ai_provider",
        return_value=RepoSearchStubAIProvider(),
    ):
        response = client.post(
            f"/api/documents/{document_id}/analyze-contract"
        )

    assert response.status_code == 200, response.text

    return response.json()


def test_search_matches_by_filename() -> None:
    unique = str(uuid4())
    document_id = upload(
        ["Contract Title: Master Services Agreement"],
        f"unique-marker-{unique}.pdf",
    )
    extract_pages(document_id)

    response = client.get(
        "/api/documents/search", params={"q": unique}
    )
    assert response.status_code == 200

    body = response.json()
    assert body["total"] == 1
    assert body["documents"][0]["document_id"] == document_id


def test_search_matches_by_contract_number() -> None:
    unique = str(uuid4()).replace("-", "")[:12]
    document_id = upload(
        [
            "Contract Title: Master Services Agreement",
            f"Contract Number: MSA-2026-{unique}",
        ],
        f"search-number-{uuid4()}.pdf",
    )
    extract_pages(document_id)
    analyze(document_id)

    response = client.get(
        "/api/documents/search", params={"q": unique}
    )
    assert response.status_code == 200

    body = response.json()
    assert body["total"] >= 1
    assert any(
        doc["document_id"] == document_id
        for doc in body["documents"]
    )


def test_search_no_query_returns_paginated_all_documents() -> None:
    upload(["Some content"], f"paginate-a-{uuid4()}.pdf")
    upload(["Some content"], f"paginate-b-{uuid4()}.pdf")

    response = client.get(
        "/api/documents/search", params={"limit": 1, "offset": 0}
    )
    assert response.status_code == 200

    body = response.json()
    assert len(body["documents"]) == 1
    assert body["total"] >= 2


def test_search_unmatched_query_returns_empty() -> None:
    response = client.get(
        "/api/documents/search",
        params={"q": f"no-such-document-{uuid4()}"},
    )
    assert response.status_code == 200

    body = response.json()
    assert body["total"] == 0
    assert body["documents"] == []


def test_global_audit_log_reflects_field_review() -> None:
    document_id = upload(
        [
            "Contract Title: Master Services Agreement",
            f"Governing Law: State of Delaware {uuid4()}",
        ],
        f"audit-{uuid4()}.pdf",
    )
    extract_pages(document_id)
    analyzed = analyze(document_id)

    first_field_key = analyzed["metadata_fields"][0]["field_key"]

    client.post(
        f"/api/documents/{document_id}/metadata-fields/"
        f"{first_field_key}/review",
        json={"action": "accept", "changed_by": "Audit Tester"},
    )

    response = client.get(
        "/api/documents/audit-log", params={"limit": 50}
    )
    assert response.status_code == 200

    body = response.json()
    assert body["total"] >= 1

    matching = [
        entry
        for entry in body["entries"]
        if entry["document_id"] == document_id
        and entry["field_key"] == first_field_key
    ]
    assert len(matching) == 1
    assert matching[0]["action"] == "accept"
    assert matching[0]["changed_by"] == "Audit Tester"
    assert matching[0]["document_filename"].startswith("audit-")


def test_global_audit_log_server_filters() -> None:
    document_id = upload(
        [
            "Contract Title: Filterable Agreement",
            f"Governing Law: State of California {uuid4()}",
        ],
        f"audit-filter-{uuid4()}.pdf",
    )
    extract_pages(document_id)
    analyzed = analyze(document_id)
    first_field_key = analyzed["metadata_fields"][0]["field_key"]

    client.post(
        f"/api/documents/{document_id}/metadata-fields/"
        f"{first_field_key}/review",
        json={"action": "accept", "changed_by": "Filter Actor"},
    )

    by_doc = client.get(
        "/api/documents/audit-log",
        params={"document_id": document_id, "limit": 20},
    )
    assert by_doc.status_code == 200
    assert all(
        entry["document_id"] == document_id for entry in by_doc.json()["entries"]
    )

    by_actor = client.get(
        "/api/documents/audit-log",
        params={"changed_by": "Filter Actor", "limit": 50},
    )
    assert by_actor.status_code == 200
    assert any(
        entry["document_id"] == document_id for entry in by_actor.json()["entries"]
    )

    by_action = client.get(
        "/api/documents/audit-log",
        params={
            "document_id": document_id,
            "action": "accept",
            "outcome": "accepted",
            "limit": 20,
        },
    )
    assert by_action.status_code == 200
    entries = by_action.json()["entries"]
    assert len(entries) >= 1
    assert all(entry["action"] == "accept" for entry in entries)

    miss = client.get(
        "/api/documents/audit-log",
        params={"document_id": document_id, "action": "reject", "limit": 20},
    )
    assert miss.status_code == 200
    assert miss.json()["entries"] == []


def test_search_returns_repository_columns() -> None:
    unique = str(uuid4())
    document_id = upload(
        [
            f"Contract Title: Marker {unique}",
            "Supplier: Acme Technologies",
            "Effective Date: January 1, 2026",
            "Expiration Date: December 31, 2027",
        ],
        f"columns-{uuid4()}.pdf",
    )
    extract_pages(document_id)
    analyze(document_id)

    response = client.get(
        "/api/documents/search", params={"q": unique}
    )
    assert response.status_code == 200
    documents = response.json()["documents"]

    match = next(
        d for d in documents if d["document_id"] == document_id
    )
    assert match["counterparty"] == "Acme Technologies"
    assert match["effective_date"] == "2026-01-01"
    assert match["expiration_date"] == "2027-12-31"


def test_search_confidence_range_filter() -> None:
    unique = str(uuid4())
    document_id = upload(
        [f"Contract Title: Marker {unique}"],
        f"confidence-{uuid4()}.pdf",
    )
    extract_pages(document_id)
    analyze(document_id)

    too_high = client.get(
        "/api/documents/search",
        params={"q": unique, "confidence_min": 0.99},
    )
    assert too_high.json()["total"] == 0

    matches = client.get(
        "/api/documents/search",
        params={"q": unique, "confidence_min": 0.5},
    )
    assert matches.json()["total"] == 1


def test_search_document_type_filter() -> None:
    unique = str(uuid4())
    document_id = upload(
        [f"Contract Title: Marker {unique}"],
        f"type-filter-{uuid4()}.pdf",
    )
    extract_pages(document_id)
    analyze(document_id)

    wrong_type = client.get(
        "/api/documents/search",
        params={"q": unique, "document_type": "NDA"},
    )
    assert wrong_type.json()["total"] == 0

    right_type = client.get(
        "/api/documents/search",
        params={
            "q": unique,
            "document_type": "Master Services Agreement",
        },
    )
    assert right_type.json()["total"] == 1


def test_document_hierarchy_includes_confirmed_parent_child() -> None:
    # Contract numbers must be purely numeric after the prefix to match
    # CONTRACT_NUMBER_PATTERN in relationship_detector.py.
    contract_number = str(uuid4().int)[:6]

    parent_id = upload(
        [
            "Contract Title: Master Services Agreement",
            f"Contract Number: MSA-2026-{contract_number}",
        ],
        f"hierarchy-parent-{uuid4()}.pdf",
    )
    extract_pages(parent_id)
    analyze_with_type_detection(parent_id)

    child_id = upload(
        [
            "Contract Title: Amendment No. 1 to Master Services Agreement",
            f"Contract Number: AMD-2026-{contract_number}",
            (
                "This Amendment is entered into pursuant to the "
                f"Master Services Agreement (MSA-2026-{contract_number})."
            ),
        ],
        f"hierarchy-child-{uuid4()}.pdf",
    )
    extract_pages(child_id)
    analyze_with_type_detection(child_id)

    client.post(
        f"/api/documents/{child_id}/confirm-relationship",
        json={"action": "confirm", "changed_by": "Contract Manager"},
    )

    response = client.get("/api/documents/hierarchy")
    assert response.status_code == 200

    roots = response.json()["roots"]
    parent_node = next(
        (r for r in roots if r["document_id"] == parent_id), None
    )
    assert parent_node is not None
    assert any(
        child["document_id"] == child_id
        for child in parent_node["children"]
    )


def test_status_counts_match_status_filtered_search() -> None:
    counts = client.get("/api/documents/status-counts")
    assert counts.status_code == 200, counts.text
    body = counts.json()

    everything = client.get("/api/documents/search", params={"limit": 1}).json()
    assert body["total"] == everything["total"]
    for status in ("review_required", "completed", "failed"):
        filtered = client.get(
            "/api/documents/search", params={"status": status, "limit": 1}
        ).json()
        assert body["by_status"].get(status, 0) == filtered["total"], status


def test_search_profile_id_and_sort_params() -> None:
    """RC2-02: profile filter + sort_by/sort_dir are accepted and scoped."""
    ascending = client.get(
        "/api/documents/search",
        params={"sort_by": "uploaded_at", "sort_dir": "asc", "limit": 5},
    )
    descending = client.get(
        "/api/documents/search",
        params={"sort_by": "uploaded_at", "sort_dir": "desc", "limit": 5},
    )
    assert ascending.status_code == 200, ascending.text
    assert descending.status_code == 200, descending.text

    updated = client.get(
        "/api/documents/search",
        params={"sort_by": "updated_at", "sort_dir": "desc", "limit": 5},
    )
    assert updated.status_code == 200, updated.text

    by_profile = client.get(
        "/api/documents/search",
        params={"profile_id": "invoice", "limit": 5},
    )
    assert by_profile.status_code == 200, by_profile.text
    for document in by_profile.json()["documents"]:
        assert document.get("profile_id") == "invoice"
