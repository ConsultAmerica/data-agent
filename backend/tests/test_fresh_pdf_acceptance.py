"""Fresh-PDF production acceptance flow (API-level E2E).

Upload → page extract → schema (human-readable only) → Select All /
Extract Selected at 1/10/50/51/100+ → no raw XFA paths → Source
Verification page+highlight → Verify/Edit → Repository promote →
Field Explorer inputs via analyze-contract → simulated Render restart
(local file wipe + remote restore) → reopen source verification.

Batching must stay invisible: one jobs/extract call, one complete result.
"""

from __future__ import annotations

import re
import time
from typing import Any
from unittest.mock import patch
from uuid import uuid4

import fitz
import pytest
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.main import app
from app.services.ai_provider import AIProvider
from app.services.contract_field_schema import FieldSpec
from app.services.generic_kv_scanner import is_internal_form_name

client = TestClient(app)
# These flows review every value via accept-all; since DI-02 that
# includes flagged values only as an admin override with a reason.
ACCEPT_EVERYTHING = {"include_flagged": True, "override_reason": "test: review every value"}

INTERNAL_LEAK_RE = re.compile(
    r"topmostSubform|Page\d+\[|PG\d+[A-Z]|TextField|CheckBox|\[[0-9]+\]",
    re.IGNORECASE,
)


class AcceptanceAIProvider(AIProvider):
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
            "confidence": 0.94,
        }

    async def extract_fields(
        self, *, page_context: str, field_specs: list[FieldSpec]
    ) -> dict[str, Any]:
        fields = []
        for spec in field_specs:
            if spec.key == "payment_terms" and "Net 30" in page_context:
                fields.append(
                    {
                        "field_key": "payment_terms",
                        "value": "Net 30",
                        "confidence": 0.91,
                        "page_number": 1,
                        "source_text": "Payment Terms: Net 30",
                    }
                )
            if spec.key == "contract_number" and "ACC-" in page_context:
                match = re.search(r"ACC-[0-9A-F-]+", page_context)
                if match:
                    fields.append(
                        {
                            "field_key": "contract_number",
                            "value": match.group(0),
                            "confidence": 0.93,
                            "page_number": 1,
                            "source_text": f"Contract Number: {match.group(0)}",
                        }
                    )
        return {"fields": fields}

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


def _assert_no_internal_leak(text: str) -> None:
    assert not is_internal_form_name(text), text
    assert INTERNAL_LEAK_RE.search(text) is None, text


def create_acceptance_pdf(*, field_count: int, marker: str) -> bytes:
    """Multi-page PDF with enough Label: Value pairs for Select All sizes."""

    pdf = fitz.open()
    lines_per_page = 40
    line_index = 0

    # Always include explorer/source-verification anchors on page 1.
    page = pdf.new_page()
    y = 56
    page.insert_text((72, y), f"Contract Number: {marker}", fontsize=9)
    y += 14
    page.insert_text((72, y), "Payment Terms: Net 30", fontsize=9)
    y += 14
    page.insert_text((72, y), "Effective Date: 2026-01-15", fontsize=9)
    y += 14
    line_index = 3

    while line_index < field_count:
        if (line_index - 3) % lines_per_page == 0 and line_index > 3:
            page = pdf.new_page()
            y = 56
        page.insert_text(
            (72, y),
            f"Field Label {line_index:03d}: Value-{line_index:03d}",
            fontsize=9,
        )
        y += 14
        line_index += 1

    content = pdf.tobytes()
    pdf.close()
    return content


def upload_extract_discover(pdf_bytes: bytes, filename: str) -> str:
    upload = client.post(
        "/api/documents/upload",
        files={"file": (filename, pdf_bytes, "application/pdf")},
    )
    assert upload.status_code == 201, upload.text
    document_id = upload.json()["document_id"]

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

    with patch(
        "app.api.universal_extraction.create_ai_provider",
        return_value=AcceptanceAIProvider(),
    ):
        discover = client.post(
            f"/api/documents/{document_id}/discover-schema"
        )
    assert discover.status_code == 200, discover.text
    return document_id


def discover_targets(document_id: str) -> list[dict]:
    response = client.get(f"/api/documents/{document_id}/targets")
    assert response.status_code == 200, response.text
    return response.json()["targets"]


def selectable_field_ids(targets: list[dict]) -> list[str]:
    ids: list[str] = []
    for target in targets:
        label = target.get("label") or ""
        key = target.get("key") or ""
        _assert_no_internal_leak(label)
        _assert_no_internal_leak(key)
        if target.get("target_type") == "table":
            continue
        ids.append(target["id"])
    return ids


def ensure_target_count(document_id: str, needed: int) -> list[str]:
    targets = discover_targets(document_id)
    ids = selectable_field_ids(targets)
    next_index = 0
    while len(ids) < needed:
        response = client.post(
            f"/api/documents/{document_id}/targets/custom",
            json={"label": f"Extra Business Field {next_index}"},
        )
        assert response.status_code == 201, response.text
        ids.append(response.json()["id"])
        next_index += 1
    return ids[:needed]


def run_extract_job(document_id: str, target_ids: list[str]) -> dict:
    """One job for any N — batching must be invisible to the caller."""

    start = client.post(
        f"/api/documents/{document_id}/jobs/extract",
        json={"target_ids": target_ids, "use_ai_fallback": False},
    )
    assert start.status_code == 202, start.text
    job_id = start.json()["id"]

    job = None
    for _ in range(80):
        job = client.get(f"/v1/jobs/{job_id}").json()
        if job["status"] in ("complete", "failed"):
            break
        time.sleep(0.05)

    assert job is not None
    assert job["status"] == "complete", job
    assert job["result"] is not None
    return job["result"]


def assert_clean_extract_result(result: dict, expected_count: int) -> None:
    scalars = result["scalars"]
    unresolved = result["unresolved_targets"]
    assert len(scalars) + len(unresolved) == expected_count

    for scalar in scalars:
        _assert_no_internal_leak(str(scalar.get("target") or ""))
        _assert_no_internal_leak(str(scalar.get("normalized_key") or ""))
        value = scalar.get("value")
        if isinstance(value, str):
            assert "topmostSubform" not in value

    for item in unresolved:
        text = item if isinstance(item, str) else str(item)
        _assert_no_internal_leak(text)


@pytest.mark.parametrize("count", [1, 10, 50, 51, 117])
def test_select_all_extract_counts_feel_like_one_action(count: int) -> None:
    marker = f"ACC-{uuid4()}"
    document_id = upload_extract_discover(
        create_acceptance_pdf(field_count=max(count, 12), marker=marker),
        f"accept-{count}-{uuid4()}.pdf",
    )

    target_ids = ensure_target_count(document_id, count)
    result = run_extract_job(document_id, target_ids)
    assert_clean_extract_result(result, count)


def test_fresh_pdf_full_acceptance_flow() -> None:
    marker = f"ACC-{uuid4()}"
    pdf_bytes = create_acceptance_pdf(field_count=55, marker=marker)
    filename = f"fresh-accept-{uuid4()}.pdf"
    document_id = upload_extract_discover(pdf_bytes, filename)

    # Schema: human-readable only
    targets = discover_targets(document_id)
    assert targets, "expected discovered targets"
    for target in targets:
        _assert_no_internal_leak(target["label"])
        _assert_no_internal_leak(target["key"])

    field_ids = selectable_field_ids(targets)
    assert len(field_ids) >= 1

    # Soft miss for irrelevant business field (not a system failure)
    custom = client.post(
        f"/api/documents/{document_id}/targets/custom",
        json={"label": "Irrelevant Board Resolution Date"},
    )
    assert custom.status_code == 201, custom.text
    missing_id = custom.json()["id"]

    soft = run_extract_job(document_id, [missing_id])
    assert soft["scalars"] == [] or all(
        s.get("value") in (None, "", "Not found", "not present")
        for s in soft["scalars"]
    )
    assert len(soft["unresolved_targets"]) + len(soft["scalars"]) == 1

    # Extract a real field for source verification
    result = run_extract_job(document_id, field_ids[:10])
    assert_clean_extract_result(result, min(10, len(field_ids)))
    assert result["scalars"], "expected at least one resolved scalar"

    scalar = next(
        (s for s in result["scalars"] if s.get("value")),
        result["scalars"][0],
    )
    page_number = int(scalar["page"])
    highlight = str(
        scalar.get("evidence", {}).get("source_text")
        or scalar.get("value")
        or marker
    )

    render = client.get(
        f"/api/documents/{document_id}/pages/{page_number}/render",
        params={"highlight": highlight[:80]},
    )
    assert render.status_code == 200, render.text
    body = render.json()
    assert body["page_number"] == page_number
    assert body["image_data_url"].startswith("data:image/png;base64,")
    # Exact-page evidence: highlight present when the value is on-page
    if marker in highlight or str(scalar.get("value")) in highlight:
        assert body["highlight"] is not None

    # Verify + Edit
    key = scalar["normalized_key"]
    verify = client.post(
        f"/api/documents/{document_id}/targets/{key}/corrections",
        json={
            "action": "verify",
            "original_value": scalar.get("value"),
            "corrected_value": scalar.get("value"),
            "changed_by": "acceptance@example.com",
        },
    )
    assert verify.status_code == 201, verify.text

    edit = client.post(
        f"/api/documents/{document_id}/targets/{key}/corrections",
        json={
            "action": "edit",
            "original_value": scalar.get("value"),
            "corrected_value": f"{scalar.get('value')} (corrected)",
            "changed_by": "acceptance@example.com",
        },
    )
    assert edit.status_code == 201, edit.text

    # Source health available while file is present
    detail = client.get(f"/api/documents/{document_id}")
    assert detail.status_code == 200
    assert detail.json()["source_status"] == "available"

    # Analyze → Field Explorer inputs
    with patch(
        "app.api.contract_analysis.create_ai_provider",
        return_value=AcceptanceAIProvider(),
    ):
        analysis = client.post(
            f"/api/documents/{document_id}/analyze-contract"
        )
    assert analysis.status_code == 200, analysis.text
    fields = analysis.json()["metadata_fields"]
    payment = next(
        (f for f in fields if f["field_key"] == "payment_terms"), None
    )
    assert payment is not None
    assert payment["value"] == "Net 30"

    # Reject then accept a field (review actions work)
    reject = client.post(
        f"/api/documents/{document_id}/metadata-fields/payment_terms/review",
        json={
            "action": "reject",
            "changed_by": "acceptance@example.com",
        },
    )
    assert reject.status_code == 200, reject.text

    accept_all = client.post(
        f"/api/documents/{document_id}/metadata-fields/accept-all",
        json={"changed_by": "acceptance@example.com", **ACCEPT_EVERYTHING},
    )
    assert accept_all.status_code == 200, accept_all.text

    # Repository persistence
    approve = client.post(
        f"/api/documents/{document_id}/approve",
        json={"changed_by": "acceptance@example.com"},
    )
    assert approve.status_code == 200, approve.text
    promote = client.post(
        f"/api/documents/{document_id}/promote",
        json={"changed_by": "acceptance@example.com"},
    )
    assert promote.status_code == 200, promote.text

    search = client.get(
        "/api/documents/search",
        params={"q": filename.split(".")[0], "limit": 25},
    )
    assert search.status_code == 200, search.text
    docs = search.json()["documents"]
    match = next(
        (d for d in docs if d["document_id"] == document_id), None
    )
    assert match is not None
    assert match["repository_status"] == "repository"
    assert match["source_status"] == "available"

    # Simulated Render restart: wipe local cache, restore from "Supabase"
    settings = get_settings()
    stored = client.get(f"/api/documents/{document_id}").json()
    # stored_filename isn't on UploadedDocumentResponse — load from disk listing
    from app.database.session import SessionLocal
    from app.models.document import Document

    database = SessionLocal()
    try:
        document = database.get(Document, document_id)
        assert document is not None
        stored_filename = document.stored_filename
        local_path = settings.upload_path / stored_filename
        assert local_path.exists()
        original_bytes = local_path.read_bytes()
        local_path.unlink()
        assert not local_path.exists()
    finally:
        database.close()

    # Without remote backup → missing source
    missing_render = client.get(
        f"/api/documents/{document_id}/pages/1/render"
    )
    assert missing_render.status_code == 422
    assert "re-upload" in missing_render.json()["detail"].lower()

    missing_detail = client.get(f"/api/documents/{document_id}")
    assert missing_detail.json()["source_status"] == "missing"

    integrity = client.get("/api/system/storage-integrity")
    assert integrity.status_code == 200
    integrity_body = integrity.json()
    assert integrity_body["missing"] >= 1
    assert any(
        row["document_id"] == document_id
        for row in integrity_body["missing_sample"]
    )

    # With remote restore → source verification works again
    with patch(
        "app.services.document_storage.download_object",
        return_value=original_bytes,
    ), patch(
        "app.services.document_storage.object_exists",
        return_value=True,
    ):
        restored = client.get(
            f"/api/documents/{document_id}/pages/{page_number}/render",
            params={"highlight": highlight[:80]},
        )
        assert restored.status_code == 200, restored.text
        assert restored.json()["page_number"] == page_number
        assert (
            client.get(f"/api/documents/{document_id}").json()[
                "source_status"
            ]
            == "available"
        )
