from fastapi.testclient import TestClient

from app.main import app
from app.services.structure_detection import DOCUMENT_FAMILIES
from app.staging.document_categories import (
    CATEGORIES,
    OTHER,
    UNCLASSIFIED,
    category_fields,
    category_for_family,
)
from app.staging.profiles import far_part_52, far_regulatory_change, xml_document
from app.staging.resolver import CORRESPONDENCE_FAMILY

client = TestClient(app)


def test_every_recognized_family_has_a_specific_category() -> None:
    families = set(DOCUMENT_FAMILIES) | {
        far_part_52.FAMILY,
        far_regulatory_change.FAMILY,
        xml_document.FAMILY,
        CORRESPONDENCE_FAMILY,
    }
    uncategorized = sorted(family for family in families if category_for_family(family) == OTHER)
    assert uncategorized == []


def test_categories_group_types_broadly() -> None:
    assert category_for_family("government_contract") == "contracts"
    assert category_for_family("correspondence") == "contracts"
    assert category_for_family("far_regulation") == "regulations"
    assert category_for_family("invoice") == "financial"
    assert category_for_family("passport") == "identity"
    assert category_for_family("generic_business") == OTHER
    assert category_for_family("something_new") == OTHER
    assert category_for_family(None) == OTHER
    # Each family belongs to one category only.
    seen: set[str] = set()
    for _key, _label, families in CATEGORIES:
        assert not (families & seen)
        seen |= families


def test_unstaged_documents_are_not_yet_classified() -> None:
    assert category_fields("invoice", classified=False) == {
        "category": UNCLASSIFIED,
        "category_label": "Not yet classified",
    }


def test_category_counts_match_category_filtered_search() -> None:
    counts = client.get("/api/documents/status-counts")
    assert counts.status_code == 200, counts.text
    body = counts.json()
    assert sum(body["by_category"].values()) == body["total"]
    assert {item["category"]: item["count"] for item in body["categories"]} == body["by_category"]

    for category in [key for key, _, _ in CATEGORIES] + [UNCLASSIFIED]:
        filtered = client.get("/api/documents/search", params={"category": category, "limit": 100})
        assert filtered.status_code == 200, filtered.text
        result = filtered.json()
        assert body["by_category"].get(category, 0) == result["total"], category
        assert all(document["category"] == category for document in result["documents"]), category


def test_status_counts_narrow_to_a_category() -> None:
    everything = client.get("/api/documents/status-counts").json()
    for category, count in everything["by_category"].items():
        narrowed = client.get("/api/documents/status-counts", params={"category": category}).json()
        assert narrowed["total"] == count, category
        # The category tabs keep showing every category's count.
        assert narrowed["by_category"] == everything["by_category"]


def test_targets_report_type_and_category_before_staging() -> None:
    # Imported here: the helper uploads through the same app client.
    from uuid import uuid4

    from tests.test_dynamic_schema_picker import upload_and_discover

    document_id = upload_and_discover(
        [
            "INVOICE",
            "Invoice Number: INV-20931",
            "Invoice Date: 2026-03-02",
            "Bill To: Acme Logistics LLC",
            "Payment Terms: Net 30",
            "Subtotal: $1,200.00",
            "Tax: $96.00",
            "Amount Due: $1,296.00",
            "Total Due: $1,296.00",
        ],
        f"invoice-{uuid4()}.pdf",
    )
    targets = client.get(f"/api/documents/{document_id}/targets").json()
    assert targets["category"] == "financial"
    assert targets["category_label"] == "Financial"
    assert targets["type_label"] == "Invoice"
    # Not staged yet: the document list still says so.
    listed = client.get("/api/documents/search", params={"category": "unclassified", "limit": 100}).json()
    assert document_id in {document["document_id"] for document in listed["documents"]}
