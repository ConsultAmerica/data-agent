"""Short production smoke for P0 hardening deploy."""

from __future__ import annotations

import json
import time
import uuid

import fitz
import httpx

BASE = "https://data-agent-backend-qbmc.onrender.com"


def main() -> None:
    client = httpx.Client(base_url=BASE, timeout=180.0)

    print("1) GET /health")
    response = client.get("/health")
    print(response.status_code, response.headers.get("x-request-id"), response.json())
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "dataomatix"}
    assert response.headers.get("x-request-id")

    print("2) GET /ready")
    response = client.get("/ready")
    print(response.status_code, response.headers.get("x-request-id"))
    body = response.json()
    print(
        json.dumps(
            {key: body.get(key) for key in ("status", "service", "checks", "ai")},
            indent=2,
        )[:900]
    )
    assert response.status_code == 200
    assert body["status"] == "ready"
    assert body["checks"]["database"]["status"] == "ok"
    assert "storage" in body["checks"]
    assert "ai" in body

    marker = f"SMOKE-{uuid.uuid4().hex[:8].upper()}"
    pdf = fitz.open()
    page = pdf.new_page()
    page.insert_text((72, 72), f"Contract Number: {marker}", fontsize=10)
    page.insert_text((72, 92), "Payment Terms: Net 30", fontsize=10)
    page.insert_text((72, 112), "Effective Date: 2026-01-15", fontsize=10)
    pdf_bytes = pdf.tobytes()
    pdf.close()

    print("3) Upload")
    response = client.post(
        "/api/documents/upload",
        files={"file": (f"{marker}.pdf", pdf_bytes, "application/pdf")},
    )
    print(response.status_code, response.headers.get("x-request-id"))
    response.raise_for_status()
    document_id = response.json()["document_id"]
    print("document_id", document_id)

    print("4) extract-pages")
    response = client.post(
        f"/api/documents/{document_id}/extract-pages",
        json={
            "run_ocr": False,
            "page_start": None,
            "page_end": None,
            "force_reprocess": False,
        },
    )
    print(response.status_code)
    response.raise_for_status()

    print("5) discover-schema")
    response = client.post(f"/api/documents/{document_id}/discover-schema")
    print(response.status_code, response.headers.get("x-request-id"))
    response.raise_for_status()
    targets = response.json()["targets"]
    print("targets", len(targets), "sample keys", [item["key"] for item in targets[:5]])
    assert targets
    assert all(" " not in item["key"] for item in targets)
    assert all("topmostSubform" not in item["key"] for item in targets)

    field_ids = [
        item["id"]
        for item in targets
        if item.get("target_type") != "table" and item.get("source_examples")
    ][:10]
    assert field_ids, "expected evidence-backed fields"

    print("6) extract job")
    response = client.post(
        f"/api/documents/{document_id}/jobs/extract",
        json={"target_ids": field_ids, "use_ai_fallback": True},
    )
    print(response.status_code)
    response.raise_for_status()
    job_id = response.json()["id"]
    job = None
    for _ in range(120):
        job = client.get(f"/v1/jobs/{job_id}").json()
        if job["status"] in ("complete", "failed"):
            break
        time.sleep(1)
    assert job and job["status"] == "complete", job
    scalars = job["result"]["scalars"]
    print("scalars", len(scalars), "unresolved", job["result"].get("unresolved_targets"))
    assert scalars
    for item in scalars[:3]:
        print(
            " -",
            item.get("normalized_key"),
            item.get("extraction_method"),
            "retrieval" in item,
            "confidence_detail" in item,
            "validation" in item,
        )
        assert item.get("retrieval")
        assert item.get("confidence_detail")
        assert item.get("validation")
        assert item.get("evidence", {}).get("page_number")

    deterministic = next(
        (item for item in scalars if item.get("extraction_method") != "ai"),
        scalars[0],
    )
    print(
        "7) deterministic sample",
        deterministic["normalized_key"],
        deterministic["extraction_method"],
        deterministic["retrieval"].get("deterministic_status"),
    )

    ai_item = next(
        (
            item
            for item in scalars
            if item.get("extraction_method") == "ai"
            or (item.get("retrieval") or {}).get("ai_fallback_required")
        ),
        None,
    )
    print(
        "8) AI-escalated sample",
        None
        if not ai_item
        else (
            ai_item["normalized_key"],
            ai_item["extraction_method"],
            ai_item["retrieval"].get("ai_fallback_required"),
        ),
    )

    print("9) source render")
    response = client.get(
        f"/api/documents/{document_id}/pages/{deterministic['page']}/render",
        params={"highlight": str(deterministic["value"])[:80]},
    )
    print(
        response.status_code,
        response.headers.get("content-type"),
        "req",
        response.headers.get("x-request-id"),
    )
    assert response.status_code == 200

    print("10) reopen extract-results")
    response = client.get(f"/api/documents/{document_id}/extract-results")
    print(response.status_code, response.headers.get("x-request-id"))
    response.raise_for_status()
    reopen = response.json()["scalars"]
    assert reopen
    match = next(
        item
        for item in reopen
        if item["normalized_key"] == deterministic["normalized_key"]
    )
    assert (
        match["confidence_detail"]["signals"]
        == deterministic["confidence_detail"]["signals"]
    )
    assert match["validation"]["checks"] == deterministic["validation"]["checks"]
    assert (
        match["retrieval"]["selected_pages"]
        == deterministic["retrieval"]["selected_pages"]
    )
    print("reopen metadata OK")
    print("SMOKE PASS", marker, document_id)


if __name__ == "__main__":
    main()
